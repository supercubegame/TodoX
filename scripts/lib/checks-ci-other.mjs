// CI 配置自审：release / screenshots / mirror 三条流水线，共 7 条。
// **标题与判据逐字未改。**
import {
  WF, wf, bare, jobBlocks, jobLevelIfs, onBlock, matrixSlugs, blocksContaining,
  tokenSet, RE_REPORT, RE_STDOUT, reEscape, expectEq, expectTrue
} from './verify-kit.mjs';
import { RELEASE_GATES, SHOTS_GATES, MIRROR_GATES } from './report.mjs';

export const CI_OTHER_CHECKS = [
  ['CI：release 只在 release/** 上触发，而 verify 覆盖所有分支（双向）', () => {
    const on = onBlock(wf('release'));
    expectTrue(on.length > 0, 'release.yml 里解析不到 on: 块 —— 是扫描器坏了，不是配置对了', wf('release').slice(0, 300));
    const branches = on.filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(branches, ["branches: ['release/**']"], 'release.yml 的分支过滤');
    expectTrue(on.some(l => l.trim() === 'workflow_dispatch:'), 'release.yml 没有手动触发的口子', on.join('\n'));
    expectTrue(!on.some(l => /pull_request|schedule/.test(l)), 'release.yml 挂上了不该挂的事件', on.join('\n'));
    const vb = onBlock(wf('verify')).filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(vb, ["branches: ['**']"], 'verify.yml 的分支过滤');
    return "release 只认 release/**（不挂 main，不挂 **），verify 仍覆盖 ** —— 该跑不跑要红，不该跑却跑了也要红";
  }],

  ['CI：screenshots 的触发范围与回写循环守卫（身份判断，不是提交信息字符串）', () => {
    const text = bare('screenshots');
    const on = onBlock(wf('screenshots'));
    expectTrue(on.length > 0, 'screenshots.yml 里解析不到 on: 块 —— 扫描器坏了', wf('screenshots').slice(0, 300));
    const branches = on.filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(branches, ["branches: ['docs/**', 'shots/**']"], 'screenshots.yml 的分支过滤');
    expectTrue(on.some(l => l.trim() === 'workflow_dispatch:'), 'screenshots.yml 没有手动触发的口子', on.join('\n'));
    const jobs = jobBlocks(text);
    expectTrue(jobs.has('shots'), 'screenshots.yml 里没有 shots job', [...jobs.keys()].join(','));
    const j = jobs.get('shots');
    expectEq(jobLevelIfs(j), [], 'shots job 上的 job 级 if');
    expectTrue(j.text.includes('contents: write'), 'shots job 没有 contents: write，回写会直接失败', j.text.slice(0, 400));
    const configured = /git config user\.email '([^']+)'/.exec(text);
    expectTrue(Boolean(configured), '扫不到回写步骤里配置的 committer 邮箱 —— 是扫描器坏了，不是配置对了', j.text.slice(0, 600));
    const email = configured[1];
    expectTrue(email.includes('@'), '回写配置的 committer 邮箱不是邮箱形状', email);
    // **双反斜杠是承重的。** 2026-08-16 这一行在一次整文件重写里被写成单反斜杠，
    // 正则字面变成 `emails*!=s*`，那条断言永远匹配不上 —— 产品没问题，说谎的是尺子。
    const guard = new RegExp(`head_commit\\.committer\\.email\\s*!=\\s*'${reEscape(email)}'`);
    expectTrue(guard.test(text), '回写守卫比较的邮箱与 git config 配的那个不一致',
      `git config 配的是 ${email}\n两处必须逐字相同，否则守卫会哑 —— 而哑掉的表现是自触发循环，不是红。`);
    expectTrue(text.includes("github.actor != 'github-actions[bot]'"), '缺第二层 actor 守卫', j.text.slice(0, 800));
    expectTrue(text.includes("steps.gate.outcome == 'success'"), '回写没有挂在截图闸门的结果上 —— 闸门红的时候会把黑图钉进仓库', j.text.slice(0, 800));
    const SKIP_MARK = ['[skip', ' ci]'].join('');
    expectTrue(!text.includes(SKIP_MARK), '那个提交信息里的跳过标记回来了',
      '留着它身份守卫永远走不到，于是没法区分「它在守」和「它是空的」。守卫已经改成身份判断，字符串那条要删干净。');
    return `只认 docs/** 与 shots/**，job 无条件执行；守卫 = 闸门绿 + committer 不是 ${email} + actor 不是 bot（两处邮箱逐字相同），字符串守卫已删净`;
  }],

  ['CI：screenshots 的产物名与 stdout 日志集合等于 SHOTS_GATES', () => {
    const names = tokenSet('screenshots', RE_REPORT);
    const wantNames = new Set(SHOTS_GATES.map(g => `report-${g.slug}`));
    expectEq([...names].sort(), [...wantNames].sort(), '产物名集合');
    const slugs = tokenSet('screenshots', RE_STDOUT);
    const wantSlugs = new Set(SHOTS_GATES.map(g => g.slug));
    expectEq([...slugs].sort(), [...wantSlugs].sort(), 'stdout 日志 slug 集合');
    return `${names.size} 个产物 + ${slugs.size} 条日志，与 SHOTS_GATES 完全相等`;
  }],

  // 这条断言的前一版**是装饰**，实测确认过：原文是
  // `text.includes('MIRROR_TOKEN:-') && text.includes('exit 1')`,两个子串各自在
  // 整个文件里找，而末尾那个「闸门失败则失败」步骤本来就有一行 `run: exit 1`。
  // 把守卫里的 exit 1 换成 echo（恰好就是它唯一要防的静默跳过），照样全绿。
  ['CI：mirror 的触发范围、令牌守卫（块内断言 + 变异体自证）与源 SHA 痕迹', () => {
    const text = wf('mirror');
    const on = onBlock(text);
    expectTrue(on.length > 0, 'mirror.yml 里解析不到 on: 块 —— 扫描器坏了', text.slice(0, 300));
    const branches = on.filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(branches, ['branches: [main]'], 'mirror.yml 的分支过滤');
    expectTrue(on.some(l => l.trim() === 'workflow_dispatch:'), 'mirror.yml 没有手动触发的口子', on.join('\n'));
    const jobs = jobBlocks(text);
    expectTrue(jobs.has('sync'), 'mirror.yml 里没有 sync job', [...jobs.keys()].join(','));
    expectEq(jobLevelIfs(jobs.get('sync')), [], 'sync job 上的 job 级 if');

    const guardBlocks = blocksContaining(text, 'MIRROR_TOKEN:-');
    expectEq(guardBlocks.length, 1, '含 ${MIRROR_TOKEN:-} 的 run 块个数（0 说明守卫没了，多个说明有重复实现）');
    expectTrue(/(^|\n)\s*exit 1\b/.test(guardBlocks[0].code),
      `mirror.yml 第 ${guardBlocks[0].line} 行那个令牌守卫块里没有 exit 1`,
      '令牌缺失时必须让整个 job 红。静默跳过就等于「以为同步了，其实什么都没发生」，\n' +
      '而那和「同步成功」在面板上长得一模一样。\n' +
      '注意：文件别处的 exit 1（比如末尾那个「闸门失败则失败」步骤）不算 —— \n' +
      '这条断言的前一版就是被那个字面量满足的，实测两个变异体都活了下来。');

    const shaBlocks = blocksContaining(text, '${GITHUB_SHA:0:7}');
    expectTrue(shaBlocks.length >= 1, '同步的提交信息里没有源 SHA',
      '那是审计唯一能区分「同步成功」与「镜像早就停在旧内容上」的凭据');
    expectTrue(shaBlocks.some(b => b.code.includes('git commit')), '源 SHA 不在真的建提交的那个块里',
      '写在别处（比如一句 echo）的话，公开仓那边的提交信息里其实没有它');

    expectTrue(text.includes('git push --force'), 'mirror.yml 不是强推 —— 公开仓可能留下私有历史', text.slice(0, 400));

    const guardCheck = t => {
      const bs = blocksContaining(t, 'MIRROR_TOKEN:-');
      return bs.length === 1 && /(^|\n)\s*exit 1\b/.test(bs[0].code);
    };
    expectTrue(guardCheck(text), '检查器在真文本上应该通过 —— 否则下面两个变异体的判红没有意义');
    const silent = text.replace(/(\n\s*)exit 1(\n\s*fi)/, "$1echo '没令牌，跳过同步'$2");
    expectTrue(silent !== text, '构造「静默跳过」变异体时没替换到任何东西 —— 夹具坏了，不是产品对了');
    expectTrue(!guardCheck(silent), '把守卫里的 exit 1 换成 echo 之后检查器居然没判红 —— 那这条还是装饰',
      '静默跳过是这条断言唯一要防的东西');
    const noGuard = text.split('\n').filter(l => !l.includes('MIRROR_TOKEN:-')).join('\n');
    expectTrue(!guardCheck(noGuard), '守卫整个删掉之后检查器没判红');

    const names = tokenSet('mirror', RE_REPORT);
    expectEq([...names].sort(), MIRROR_GATES.map(g => `report-${g.slug}`).sort(), '产物名集合');
    const slugs = tokenSet('mirror', RE_STDOUT);
    expectEq([...slugs].sort(), MIRROR_GATES.map(g => g.slug).sort(), 'stdout 日志 slug 集合');
    return `只认 main；令牌守卫在第 ${guardBlocks[0].line} 行那个块内部真的有 exit 1（两个变异体都被抓住：` +
      `换成静默跳过、整块删掉）；源 SHA 在 git commit 的那个块里；强推在；产物名与 MIRROR_GATES 相等`;
  }],

  ['CI：release 的三平台 matrix 与 RELEASE_GATES 的 dist-* 一一对应', () => {
    const slugs = matrixSlugs(bare('release')).slice().sort();
    const want = RELEASE_GATES.map(g => g.slug).filter(s => s.startsWith('dist-')).sort();
    expectEq(slugs, want, 'matrix slug 集合');
    const oses = [...bare('release').matchAll(/^\s*- os:\s*([^\s]+)\s*$/gm)].map(m => m[1]);
    expectEq(oses.length, 3, 'runner 数量');
    expectEq(new Set(oses).size, 3, '互不相同的 runner 数量');
    return `${slugs.join(' / ')} 跑在 ${oses.join(' / ')} 上 —— 少一个平台就红，不是「至少三个」`;
  }],

  ['CI：release 的产物名与 stdout 日志集合都等于 RELEASE_GATES', () => {
    const names = tokenSet('release', RE_REPORT);
    const wantNames = new Set(RELEASE_GATES.map(g => `report-${g.slug}`));
    expectEq([...names].sort(), [...wantNames].sort(), '产物名集合');
    const slugs = tokenSet('release', RE_STDOUT);
    const wantSlugs = new Set(RELEASE_GATES.map(g => g.slug));
    expectEq([...slugs].sort(), [...wantSlugs].sort(), 'stdout 日志 slug 集合');
    return `${names.size} 个产物 + ${slugs.size} 条日志，与 RELEASE_GATES 完全相等`;
  }],

  ['CI：release 的每个 job 要么无条件执行，要么显式 always()（枚举即期望）', () => {
    const jobs = jobBlocks(bare('release'));
    expectTrue(jobs.size >= 5, 'release.yml 的 job 数量少于预期 —— 是扫描器坏了，不是配置对了', [...jobs.keys()].join(','));
    const ALWAYS = ['verify', 'summary'];
    for (const n of ALWAYS) expectTrue(jobs.has(n), `release.yml 里没有 ${n} job`, [...jobs.keys()].join(','));
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
  }]
];
