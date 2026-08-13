#!/usr/bin/env node
// 事后核对：那条回写评论**真的送达了吗**。
//
// 为什么需要它：钉住共享 workflow 的 SHA 只解决「上游悄悄变了」，不解决
// 「这一次到底送出去了没有」。回写通道是整套流水线里最安静的失效点 ——
// 实测发生过一次：两条闸门全绿，负责回写的 job 挂在拉代码那步，**那次提交
// 上一条评论都没有**。从外面看仓库是「跑过了」。
//
// 而这条核对自己不能依赖评论：它红的时候，提交上会留一个红勾。那是外部
// 观察者能看到的东西，不需要先读到评论才知道评论没来。
//
// 三个关键设计：
//   1. **两条通道都查。** 有 PR 时共享 workflow 写 PR 评论，没有时写 commit
//      评论。只查一条的话，另一条坏掉时这条核对会安静地通过。
//   2. **钉在本次运行上。** 「存在一条带 marker 的评论」是幂等写入的经典假绿:
//      上一次留下的评论完全满足它。所以要求正文里含本次短 SHA **和** run id。
//   3. **轮询，而不是睡一觉。** 评论接口有可见性延迟，直接查会偶发红在时序上。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));

// 这个字符串和 verify.yml 里 summary 的 marker 是一组。快闸门有一条断言
// 逐字核对两处相等 —— 改了一处而没改另一处，核对会去找一个没人写的 marker。
const MARKER = '<!-- todox-verify -->';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || '';
const SHA = process.env.GITHUB_SHA || '';
const RUN_ID = process.env.GITHUB_RUN_ID || '';
const TOKEN = process.env.GITHUB_TOKEN || '';

const TIMEOUT_MS = 120000;
const POLL_MS = 6000;

const results = [];
function record(title, ok, detail, evidence) {
  results.push({ title, ok: Boolean(ok), skipped: false, detail: String(detail == null ? '' : detail), evidence: evidence == null ? null : String(evidence) });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${title}\n      ${String(detail).split('\n')[0]}\n`);
  if (!ok && evidence) process.stdout.write(String(evidence).split('\n').map(l => '      | ' + l).join('\n') + '\n');
}
function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = String(evidence);
  throw e;
}
function expectTrue(cond, label, evidence) { if (!cond) fail(label, evidence); }
async function step(title, fn) {
  try { record(title, true, await fn()); return true; }
  catch (err) { record(title, false, err && err.message ? err.message : String(err), err && err.evidence); return false; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 只对可识别的瞬时错误重试。403 / 404 是权限或路径问题，重试三次只会把
// 一个清楚的错误拖成三倍时间。
async function api(pathname) {
  const url = `${API}${pathname}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res = null;
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${TOKEN}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'todox-attest'
        }
      });
    } catch (e) {
      if (attempt === 3) fail(`请求 ${pathname} 连续 3 次网络失败`, `最后一次: ${e.message}\n这次没有核对到任何东西 —— 不能当成通过。`);
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 200) return res.json();
    const body = (await res.text()).slice(0, 600);
    if (res.status >= 500 || res.status === 429) {
      if (attempt === 3) fail(`请求 ${pathname} 连续 3 次都是 ${res.status}`, body);
      await sleep(2000 * attempt);
      continue;
    }
    fail(`请求 ${pathname} 返回 ${res.status}`, `${body}\n5xx / 429 才重试；这个状态码是权限或路径的问题，重试只会掩盖它。`);
  }
  return null;
}

// 两条通道各自返回「带指定 marker 的评论」。抽成一个函数是为了让下面那条
// 自证能拿同一份实现去查一个不存在的 marker。
async function findMarked(marker) {
  const out = { pr: [], commit: [], prNumbers: [] };
  const pulls = await api(`/repos/${REPO}/commits/${SHA}/pulls`);
  for (const pr of Array.isArray(pulls) ? pulls : []) {
    out.prNumbers.push(pr.number);
    const comments = await api(`/repos/${REPO}/issues/${pr.number}/comments?per_page=100`);
    for (const c of Array.isArray(comments) ? comments : []) {
      if (String(c.body || '').includes(marker)) out.pr.push({ ...c, pr: pr.number });
    }
  }
  const commitComments = await api(`/repos/${REPO}/commits/${SHA}/comments?per_page=100`);
  for (const c of Array.isArray(commitComments) ? commitComments : []) {
    if (String(c.body || '').includes(marker)) out.commit.push(c);
  }
  return out;
}

let found = null;

const STEPS = [
  ['环境齐全：仓库 / SHA / run id / 令牌都在（否则本次没有核对任何东西）', async () => {
    const missing = [];
    if (!REPO) missing.push('GITHUB_REPOSITORY');
    if (!SHA) missing.push('GITHUB_SHA');
    if (!RUN_ID) missing.push('GITHUB_RUN_ID');
    if (!TOKEN) missing.push('GITHUB_TOKEN');
    expectTrue(missing.length === 0, `缺少 ${missing.join(' / ')}`,
      '缺了就红，不许静默跳过：跳过和「评论确实送到了」在面板上长得一模一样。');
    expectTrue(/^[0-9a-f]{40}$/.test(SHA), 'GITHUB_SHA 不是 40 位 SHA', SHA);
    return `${REPO} @ ${SHA.slice(0, 7)}，run ${RUN_ID}`;
  }],

  ['回写评论真的存在：两条通道（PR 与 commit）都查过（轮询到出现）', async () => {
    const deadline = Date.now() + TIMEOUT_MS;
    let last = null;
    let rounds = 0;
    while (Date.now() < deadline) {
      rounds += 1;
      last = await findMarked(MARKER);
      // 轮询条件必须是布尔。返回计数的话 0 会被当成「还没成立」等到超时,
      // 那是同一个夹具坑的另一种写法。
      if (last.pr.length + last.commit.length > 0) break;
      await sleep(POLL_MS);
    }
    found = last;
    const total = last.pr.length + last.commit.length;
    expectTrue(total > 0,
      `等了 ${(TIMEOUT_MS / 1000).toFixed(0)} 秒，${SHA.slice(0, 7)} 上没有任何带 marker 的回写评论`,
      `marker: ${MARKER}\n查过的 PR: ${last.prNumbers.length > 0 ? last.prNumbers.join(', ') : '（这个提交上没有 PR）'}\n` +
      'PR 通道 0 条，commit 通道 0 条。\n' +
      '这正是「送不出结论的闸门等于没跑」那一条：闸门可能全绿，而结论没有任何人读得到。\n' +
      '先去看 summary 那个 job 的日志，问题在回写链路，不在闸门。');
    const ch = last.pr.length > 0 ? `PR #${last.pr[0].pr}` : 'commit';
    return `第 ${rounds} 轮找到，落在 ${ch} 通道（PR ${last.pr.length} 条 / commit ${last.commit.length} 条）`;
  }],

  ['钉在本次运行：评论正文里含本次短 SHA 与本次 run id（不是上一次留下的）', async () => {
    expectTrue(found !== null, '上一条没找到评论，这条无法判定 —— 根因看上面那条');
    const all = [...found.pr, ...found.commit];
    const short = SHA.slice(0, 7);
    // 「存在一条带 marker 的评论」是幂等写入的经典假绿：上一次留下的那条
    // 完全满足它，而这一次可能一个字节都没送出去。
    const hit = all.find(c => String(c.body).includes(short) && String(c.body).includes(RUN_ID));
    expectTrue(Boolean(hit),
      '找到了带 marker 的评论，但它不是本次运行写的',
      `期望正文里同时含 \`${short}\` 与 run id ${RUN_ID}。\n` +
      all.map(c => `- ${c.html_url} 更新于 ${c.updated_at}，正文前 160 字：${String(c.body).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') +
      '\n这条断言就是为这个假绿写的：回写失败时读到的是上一次留下的评论。');
    return `${hit.html_url} 含 ${short} 与 run ${RUN_ID}，更新于 ${hit.updated_at}`;
  }],

  ['同一通道里 marker 只出现一次（marker 的全部意义是不刷屏）', async () => {
    expectTrue(found !== null, '上面没找到评论，这条无法判定');
    // 不断言「总数恰好 1」：共享 workflow 是二选一投递，硬写 1 会在两条通道
    // 都合法命中时给出一条假红。真正要守的是**每条通道内部**不重复 ——
    // 实测中 commit 那条支路曾经无条件新建，同一个提交上跑两次就留两条。
    expectTrue(found.pr.length <= 1, `PR 通道里有 ${found.pr.length} 条带 marker 的评论`, found.pr.map(c => c.html_url).join('\n'));
    expectTrue(found.commit.length <= 1, `commit 通道里有 ${found.commit.length} 条带 marker 的评论`, found.commit.map(c => c.html_url).join('\n'));
    return `PR ${found.pr.length} 条 / commit ${found.commit.length} 条，两条通道都没有重复`;
  }],

  ['评论不是空壳：带结论行、逐项表格，且如果是降级版本会自己说明', async () => {
    expectTrue(found !== null, '上面没找到评论，这条无法判定');
    const body = String([...found.pr, ...found.commit][0].body);
    // 一条只说「跑完了」的评论等于没有报告。这里验它真的带着能定位根因的结构。
    expectTrue(/项检查通过/.test(body), '评论里没有「N/M 项检查通过」这行结论', body.slice(0, 400));
    expectTrue(body.includes('| --- |'), '评论里没有逐项表格 —— 那就只剩一句话，定位不到根因', body.slice(0, 400));
    expectTrue(/快闸门/.test(body), '评论里连快闸门这一节都没有，像是降级或占位版本', body.slice(0, 600));
    const degraded = /降级/.test(body);
    return `${body.length} 字节，含结论行 + 逐项表格 + 快闸门一节${degraded ? '｜注意：这条评论自称是降级版本' : ''}`;
  }],

  ['自证：同一套查找器在一个不存在的 marker 上必须找到 0 条（负向孪生）', async () => {
    // 上面每条都是「找到了就通过」。如果查找器有 bug，永远返回非空，
    // 那几条会全部免费通过。这条强制它在一个必然不存在的 marker 上返回空。
    const bogus = `<!-- todox-attest-bogus-${SHA.slice(0, 12)}-${RUN_ID} -->`;
    const none = await findMarked(bogus);
    expectTrue(none.pr.length + none.commit.length === 0,
      '查找器在一个不存在的 marker 上也找到了评论 —— 上面几条断言全是装饰',
      `bogus marker: ${bogus}\nPR ${none.pr.length} 条 / commit ${none.commit.length} 条`);
    // 反面：真 marker 那次必须是非空的，否则这条自证可能只是「查找器永远返回空」。
    expectTrue(found !== null && found.pr.length + found.commit.length > 0, '真 marker 那次是空的，这条自证说明不了任何事');
    return `不存在的 marker → 0 条；真 marker → ${found.pr.length + found.commit.length} 条。查找器两侧都被走到过`;
  }],

  ['自检：本次实际执行的核对数等于清单数', async () => {
    const actual = results.length + 1;
    expectTrue(actual === STEPS.length, `执行的核对数与清单不符：实际 ${actual}，清单 ${STEPS.length}`);
    expectTrue(STEPS.length === MANIFEST.attest, `清单数与 manifest.json 不符：STEPS ${STEPS.length}，manifest ${MANIFEST.attest}`);
    const titles = results.map(r => r.title);
    expectTrue(titles.filter((t, i) => titles.indexOf(t) !== i).length === 0, '有重复的核对标题');
    return `${actual} 条，等号断言`;
  }]
];

let ok = true;
for (const [title, fn] of STEPS) {
  const passed = await step(title, fn);
  if (!passed) ok = false;
}

// 这份报告**不进** report-<slug> 命名空间：它不是一条被合成进那条评论的闸门
// （它跑在评论写完之后）。占用那个命名空间会让快闸门那两条「产物名与 GATES
// 相等」的断言红在命名上，而那是假红。
fs.mkdirSync(ARTIFACTS, { recursive: true });
fs.writeFileSync(path.join(ARTIFACTS, 'attest.json'), JSON.stringify({
  name: '回写送达核对',
  total: results.length,
  passed: results.filter(r => r.ok).length,
  failed: results.filter(r => !r.ok).length,
  ok,
  sha: SHA,
  runId: RUN_ID,
  generatedAt: new Date().toISOString(),
  checks: results
}, null, 2));

process.stdout.write(`\n共执行 ${results.length} 条核对，通过 ${results.filter(r => r.ok).length}，失败 ${results.filter(r => !r.ok).length}\n`);
if (!ok) {
  process.stdout.write('\n注意：这条 job 红了**不**代表闸门红了。它说的是「结论没有如实送达」,\n');
  process.stdout.write('而那件事的后果更大：闸门可能全绿，只是没有人（和没有 agent）读得到。\n');
}
process.exit(ok ? 0 : 1);
