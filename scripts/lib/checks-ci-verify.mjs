// CI 配置自审：workflow 登记、pipefail、回写引用、gates、verify 那几条，共 8 条。
// **标题与判据逐字未改。**
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, WF, wf, bare, jobBlocks, needsOf, jobLevelIfs, runBlocks, tokenSet,
  RE_REPORT, RE_STDOUT, readIfExists, MANIFEST, expectEq, expectTrue
} from './verify-kit.mjs';
import { GATES } from './report.mjs';
import { writebackRefProblems, pinGuardSelfProof, SAMPLE_COUNT as PIN_GUARD_SAMPLES } from './pin-guard.mjs';

export const CI_VERIFY_CHECKS = [
  ['CI：.github/workflows 下每一份 workflow 都被扫描器登记（目录即期望）', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const actual = fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort();
    expectTrue(actual.length > 0, '一份 workflow 文件都没扫到 —— 是扫描器坏了，不是配置对了', `目录: ${dir}`);
    const registered = Object.values(WF).map(w => path.basename(w.path)).sort();
    expectEq(actual, registered, '已登记的 workflow 集合');
    for (const key of Object.keys(WF)) {
      expectTrue(wf(key).length > 0, `${WF[key].path} 是空文件`);
      bare(key);
    }
    const kept = Object.keys(WF).map(k => `${path.basename(WF[k].path)} ${wf(k).length}->${bare(k).length}`);
    return `${actual.length} 份 workflow 全部在扫描范围内，剥注释后都自证通过：${kept.join('，')}`;
  }],

  ['CI：所有 workflow 里出现 tee 的脚本块都设置了 pipefail', () => {
    let totalRun = 0;
    let totalTee = 0;
    const bad = [];
    for (const key of Object.keys(WF)) {
      const blocks = runBlocks(wf(key));
      expectTrue(blocks.length > 0, `${WF[key].path} 里一个 run: | 块都没扫到 —— 是扫描器坏了，不是配置对了`, wf(key).slice(0, 400));
      const tee = blocks.filter(b => b.body.includes('tee '));
      expectTrue(tee.length > 0, `${WF[key].path} 里没有任何 tee 块 —— 那报告缺失时评论里就没有日志尾巴了`);
      totalRun += blocks.length;
      totalTee += tee.length;
      for (const b of tee) if (!b.body.includes('pipefail')) bad.push(`${WF[key].path} 第 ${b.line} 行的 run 块`);
    }
    expectEq(bad, [], '缺 pipefail 的 tee 块');
    return `${Object.keys(WF).length} 份 workflow、${totalRun} 个 run 块，其中 ${totalTee} 个用了 tee，全部带 pipefail（否则闸门红了 job 照样绿）`;
  }],

  // 判词住在 pin-guard.mjs 里（唯一一份实现 + 9 个自证）。这里只负责把已经切好的
  // summary job 文本传过去 —— 解析器留在 kit，否则这个仓库就多一处 report.mjs
  // 那种分叉，而 promote-guard.mjs 的文件头就为这件事写着一段。
  ['CI：回写 job 用共享 workflow、跟随 main、四份跟同一个、 本地零 steps，含 pin-guard 自证', () => {
    const entries = [];
    for (const key of Object.keys(WF)) {
      const jobs = jobBlocks(bare(key));
      const j = jobs.get('summary');
      expectTrue(Boolean(j), `${WF[key].path} 里没有 summary job —— 送不出结论的闸门等于没跑`, [...jobs.keys()].join(','));
      entries.push({
        path: WF[key].path,
        summaryText: j.text,
        hasLocalSteps: j.lines.some(l => l.trim() === 'steps:')
      });
    }
    const live = writebackRefProblems(entries).problems;
    expectEq(live, [], '回写引用的判词');

    const proof = pinGuardSelfProof();
    const bad = proof.filter(p => !p.ok);
    expectEq(proof.length, PIN_GUARD_SAMPLES, 'pin-guard 的样本数');
    expectEq(bad, [], 'pin-guard 自证里失败的样本');
    return `${entries.length} 份 workflow 全部跟随 main、本地零 steps｜pin-guard ${proof.length}/${proof.length} 自证通过（只翻一半 / 空输入都会红）`;
  }],

  ['CI：gates 引用真实的 needs.<job>.result 且与 needs 一致', () => {
    const summary = [];
    for (const key of Object.keys(WF)) {
      const jobs = jobBlocks(bare(key));
      const j = jobs.get('summary');
      const needs = needsOf(j);
      expectTrue(needs !== null, `${WF[key].path} 的 summary 没有 needs`, j.text.slice(0, 400));
      const gatesLine = j.lines.find(l => l.trim().startsWith('gates:'));
      expectTrue(Boolean(gatesLine), `${WF[key].path} 的 summary 没有 gates 输入`, j.text.slice(0, 400));
      const refs = [...gatesLine.matchAll(/needs\.([A-Za-z0-9_-]+)\.result/g)].map(m => m[1]);
      expectEq(refs.slice().sort(), needs.slice().sort(), `${WF[key].path} 的 gates 引用的 job 集合`);
      for (const n of needs) expectTrue(jobs.has(n), `${WF[key].path} 的 needs 里 ${n} 不是真实存在的 job`, [...jobs.keys()].join(','));
      expectTrue(!/"result"\s*:\s*"(success|failure)"/.test(gatesLine), `${WF[key].path} 的 gates 里写了硬编码的结果字面量`, gatesLine);
      summary.push(`${key}=[${needs.join(',')}]`);
    }
    return `${summary.join('｜')}，全部引用真实 result，没有硬编码`;
  }],

  ['CI：verify 上传的 report-* 产物集合与 GATES 一致', () => {
    const names = tokenSet('verify', RE_REPORT);
    const want = new Set(GATES.map(g => `report-${g.slug}`));
    expectEq([...names].sort(), [...want].sort(), '产物名集合');
    return `${names.size} 个产物名与 GATES 一一对应（扫的是剥掉注释的那份）`;
  }],

  ['CI：verify 的 stdout-<slug>.log 集合与 GATES 一致', () => {
    const slugs = tokenSet('verify', RE_STDOUT);
    const want = new Set(GATES.map(g => g.slug));
    expectEq([...slugs].sort(), [...want].sort(), 'stdout 日志 slug 集合');
    return `${slugs.size} 条日志与 GATES 一一对应，composer 不会去找一个没人产出的 slug`;
  }],

  ['CI：verify 的每个 job 要么无条件执行，要么显式 always()（枚举即期望）', () => {
    const jobs = jobBlocks(bare('verify'));
    expectTrue(jobs.size >= 6, 'verify.yml 的 job 数量少于预期 —— 是扫描器坏了，不是配置对了', [...jobs.keys()].join(','));
    const ALWAYS = ['summary', 'attest'];
    for (const n of ALWAYS) expectTrue(jobs.has(n), `verify.yml 里没有 ${n} job`, [...jobs.keys()].join(','));
    const problems = [];
    for (const [name, j] of jobs) {
      const ifs = jobLevelIfs(j);
      if (ALWAYS.includes(name)) {
        if (!ifs.some(l => /^if:\s*always\(\)$/.test(l))) problems.push(`${name} 应该带 if: always()，实际：${ifs.join(' / ') || '（没有任何 if）'}`);
      } else if (ifs.length > 0) {
        problems.push(`${name} 不该有 job 级 if，实际：${ifs.join(' / ')}`);
      }
    }
    expectEq(problems, [], 'job 条件的问题');
    const plain = [...jobs.keys()].filter(n => !ALWAYS.includes(n));
    return `${jobs.size} 个 job：${plain.join(' / ')} 无条件执行，${ALWAYS.join(' / ')} 带 always() —— 新加 job 会自动落进这条断言`;
  }],

  ['CI：verify 有回写送达核对 job，marker 两处一致且不占用报告命名空间', () => {
    const text = bare('verify');
    const jobs = jobBlocks(text);
    const j = jobs.get('attest');
    expectTrue(Boolean(j), 'verify.yml 里没有 attest job —— 回写坏掉时没有任何东西在喊', [...jobs.keys()].join(','));
    const needs = needsOf(j);
    expectTrue(needs !== null && needs.includes('summary'), 'attest 必须 needs summary —— 评论还没写就去找它，等的是时序不是真相', j.text.slice(0, 300));
    expectTrue(j.text.includes('scripts/attest-comment.mjs'), 'attest job 没有真的执行核对脚本', j.text.slice(0, 400));
    const summaryNeeds = needsOf(jobs.get('summary')) || [];
    expectTrue(!summaryNeeds.includes('attest'), 'summary 的 needs 里出现了 attest —— 那是个环', summaryNeeds.join(','));
    const markerLine = /marker:\s*'([^']+)'/.exec(jobs.get('summary').text);
    expectTrue(Boolean(markerLine), '扫不到 summary 的 marker —— 是扫描器坏了，不是配置对了', jobs.get('summary').text.slice(0, 400));
    const script = readIfExists('scripts/attest-comment.mjs');
    expectTrue(script.includes(`'${markerLine[1]}'`), 'attest 脚本里的 marker 与 workflow 不一致',
      `workflow: ${markerLine[1]}\n核对脚本里找不到这个字面量。两处必须逐字相同。`);
    expectTrue(!tokenSet('verify', RE_STDOUT).has('attest'), 'attest 的日志占用了 stdout-<slug>.log 命名空间（那个集合由 GATES 定义）');
    expectTrue(!tokenSet('verify', RE_REPORT).has('report-attest'), 'attest 的产物占用了 report-* 命名空间（同上）');
    expectTrue(j.text.includes('attest.log'), 'attest 没有把输出 tee 成日志 —— 失败时读不到原因');
    expectTrue(MANIFEST.attest > 0, 'manifest 里没有登记 attest 的条数', JSON.stringify(MANIFEST));
    return `attest needs [${needs.join(',')}]，执行 attest-comment.mjs（${MANIFEST.attest} 条核对），marker ${markerLine[1]} 两处一致，未占用 report-* / stdout-*`;
  }]
];
