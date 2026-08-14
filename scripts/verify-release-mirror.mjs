#!/usr/bin/env node
// 公开仓 Release 的同步校验。
//
// 私有仓转 private 之后，公开下载得从 todox-desktop 的 Release 走。所以八个
// 安装包必须同步过去 —— 而这件事最像成功的失败又是同一个形状：
//
//   **同步坏掉时，公开仓上留着上一版的八个资产。** 数量对、名字对（如果版本号
//   没变的话）、state 全是 uploaded。审计全绿，而这次一个字节都没送出去。
//
// 所以正向痕迹用 **sha256 摘要**：逐个比对私有仓与公开仓同名资产的 digest。
// 名字只能证明「有个叫这个名的文件」，摘要能证明「就是刚打出来的那份字节」。
//
// **审计时公开仓的 Release 必须还是草稿。** 顺序是：建草稿 -> 上传 -> 审计 ->
// 通过了才转正。第一版写反了，结果那次失败留下一个「对外可见但 0 个资产」的
// Release,那正是我在私有仓那条链路上防住、却在这条上重犯的错。
//
// **而那条顺序断言带来一个自己造出来的盲区**：既然审计时必须还是草稿，这个脚本
// 这辈子都不可能断言「已经对外可见」那个终态。原来那一段只有一句读回来打印,
// 打印了没人解析。倒数第二条检查因此改成守 workflow 的结构：转正那一块里必须有
// 一条**会返回退出码**的读回断言。**那个检查器住在 scripts/lib/promote-guard.mjs**,
// verify-mirror.mjs 也调它（那边每次推 main 都跑，补的是「两次发版之间的几周」）。
// 一份实现两处调用 —— report.mjs 已经因为各留一份而真的分叉过。
//
// **倒数第三条是覆盖缺口的解药**：前面每条都只看「当次这个 tag」，所以旁边躺一个
// 上一轮失败留下的空发布是完全隐形的。往外部系统写东西的审计，除了「我这次
// 写对了吗」，还要问「那个系统里现在有没有不该存在的东西」。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report } from './lib/report.mjs';
import { MIRROR_REPO } from './lib/mirror.mjs';
import { promotionGuardProblems, promotionMutants, PROMOTE_MARK } from './lib/promote-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));
const SRC_REPO = process.env.GITHUB_REPOSITORY || 'supercubegame/TodoX';
const TAG = process.env.TODOX_RELEASE_TAG || '';
// 和 verify-dist.mjs 的 PLAN、verify-release.mjs、verify-mirror.mjs、release.yml 的
// 两处清点是一组。改一个必须重算其余的（见 AGENTS.md）。
// **release.yml 转正那一块里的 `-eq 8` 不用靠人记**：倒数第二条检查会把它
// 解析出来和这里的 EXPECT_TOTAL 比。
const EXPECT_TOTAL = 8;
const MIN_BYTES = 30 * 1024 * 1024;

// electron-builder 给 NSIS 安装包的文件名带空格。GitHub 上传时会把空格换成点，
// 所以两边的**资产名**都是 TodoX.Setup.x.y.z.exe,但本地文件名是带空格的，
// 而 `gh release upload $(find ...)` 不加引号就会把它词分割成三个参数。
// 那次 upload 立刻失败，而症状是「公开仓一个资产都没有」。
const SPACEY_ASSET = /^TodoX\.Setup\..*\.exe$/;

if (TAG === '') {
  process.stderr.write('TODOX_RELEASE_TAG 是空的 —— 不知道该核对哪个 Release\n');
  process.exit(2);
}

const report = new Report('公开仓 Release 同步校验');
const state = { src: null, mirror: null, mirrorAll: null };

function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  throw e;
}
function expectEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) fail(`${label} 不符`, `期望: ${b}\n实际: ${a}`);
}
function expectTrue(cond, label, evidence) { if (!cond) fail(label, evidence); }
function tailOf(s, n = 40) { return String(s || '').trimEnd().split('\n').slice(-n).join('\n'); }
function mb(n) { return `${(n / 1024 / 1024).toFixed(1)} MB`; }

// 级联守卫。前一条失败时，后面几条会拿 null 去取属性，报出一串
// 「Cannot read properties of null」—— 那是噪音，不是根因，而报告的价值就在于
// 「只看这条评论能不能定位根因」。依赖顺序上的失败要归因到最前面那个。
function requireLoaded(which, value, firstCheck) {
  expectTrue(value !== null && value !== undefined, `${which}还没读到，这条无从谈起`,
    `根因在前面那条「${firstCheck}」,先看它的证据，别在这里找。`);
  return value;
}

// 空集合守卫。第一版没有它，资产为空时脚本崩在 sized[0].name，于是两条断言的
// 说明变成「Cannot read properties of undefined」—— 同样不是能定位根因的证据。
function requireAssets(which, list) {
  expectTrue(list.length > 0, `${which}一个资产都没有,后面每条比对都无从谈起`,
    `这通常是上传那步整体失败（比如带空格的文件名被词分割），不是「少了几个」。\n` +
    `先看同步那一步的日志尾巴。`);
  return list;
}

function gh(args, label) {
  const r = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) fail(`${label}：gh 起不来`, String(r.error.message));
  if (r.status !== 0) fail(`${label}：gh 退出码 ${r.status}`, tailOf(`${r.stdout || ''}\n${r.stderr || ''}`));
  return r.stdout || '';
}

function shape(rel) {
  return {
    tag: rel.tag_name,
    draft: rel.draft,
    prerelease: rel.prerelease,
    url: rel.html_url,
    assets: (rel.assets || []).map(a => ({
      name: a.name,
      size: a.size,
      state: a.state,
      // GitHub 会给出 "sha256:..." 形式的摘要。缺失时下面那条断言会红,
      // 而不是静默降级成「只比名字」。
      digest: a.digest || null
    }))
  };
}

// **按 tag 直接取是不行的。** `GET /releases/tags/{tag}` 对草稿返回 404,
// 草稿还没有 tag ref。而镜像那边是「先建草稿、审计通过才转正」，所以这里
// 必须走列表按 tag_name 找。列表端点对有推送权限的令牌会返回草稿，
// 而且带 digest 字段（`gh release view --json` 不带）。
//
// 这个坑的形状值得记：**审计的读取路径本身也有前提**，而那个前提被我上一轮
// 改发布顺序时弄坏了。闸门红了先查夹具。
function listReleases(repo, label) {
  const raw = gh(['api', `repos/${repo}/releases?per_page=100`], label);
  const list = JSON.parse(raw);
  expectTrue(Array.isArray(list), `${label}：返回的不是数组`, raw.slice(0, 400));
  expectTrue(list.length > 0, `${label}：${repo} 上一个 Release 都没有`, '同步那步大概整体没跑起来');
  return list;
}
function pickTag(list, repo, label) {
  const hit = list.find(r => r.tag_name === TAG);
  expectTrue(Boolean(hit), `${label}：${repo} 上找不到 ${TAG}`,
    `现有 tag：${list.map(r => `${r.tag_name}${r.draft ? '(草稿)' : ''}`).join(', ')}`);
  return shape(hit);
}

const CHECKS = [
  ['读到私有仓这个 tag 的真实资产（先证明解析成功）', () => {
    const list = listReleases(SRC_REPO, '读取源 Release');
    state.src = pickTag(list, SRC_REPO, '读取源 Release');
    expectEq(state.src.tag, TAG, '源 Release 的 tag');
    requireAssets('私有仓 Release 上', state.src.assets);
    expectEq(state.src.assets.length, EXPECT_TOTAL, '源 Release 的资产数');
    const bad = state.src.assets.filter(a => a.state !== 'uploaded').map(a => `${a.name}: ${a.state}`);
    expectEq(bad, [], '源 Release 里未完成上传的资产');
    return `${SRC_REPO} ${TAG}：${EXPECT_TOTAL} 个资产，合计 ${mb(state.src.assets.reduce((n, a) => n + a.size, 0))}`;
  }],

  ['读到公开仓同 tag 的资产，且它还是草稿（转正在审计之后）', () => {
    state.mirrorAll = listReleases(MIRROR_REPO, '读取镜像 Release');
    state.mirror = pickTag(state.mirrorAll, MIRROR_REPO, '读取镜像 Release');
    expectEq(state.mirror.tag, TAG, '镜像 Release 的 tag');
    requireAssets('公开仓 Release 上', state.mirror.assets);
    // 顺序断言：审计跑的时候它必须还没对外可见。写反了就会留下一个
    // 「对外可见但资产不全」的 Release —— 从外面看和正常的一模一样。
    expectTrue(state.mirror.draft === true, '镜像 Release 在审计之前就已经转正了,顺序错了',
      `期望 draft=true，实际 draft=${state.mirror.draft}\n` +
      '正确顺序：建草稿 -> 上传 -> 审计通过 -> 才 --draft=false。');
    return `${MIRROR_REPO} ${TAG}：${state.mirror.assets.length} 个资产，仍是草稿（等审计放行）`;
  }],

  ['两边的资产名集合完全相等（等号 + 负向孪生）', () => {
    requireLoaded('公开仓 Release', state.mirror, '读到公开仓同 tag 的资产');
    const src = state.src.assets.map(a => a.name).sort();
    const dst = state.mirror.assets.map(a => a.name).sort();
    const missing = src.filter(n => !dst.includes(n));
    const extra = dst.filter(n => !src.includes(n));
    expectEq(missing, [], '公开仓缺失的资产');
    // 负向那侧：多出来的也要红。上一版残留、或者手工传错的文件都在这里现形。
    expectEq(extra, [], '公开仓多出来的资产');
    expectEq(dst.length, EXPECT_TOTAL, '公开仓的资产数');
    return `${EXPECT_TOTAL} 个资产名逐一对上，两侧都没有多余`;
  }],

  // 这条守一次真实失败：本地文件名 `TodoX Setup 1.0.2.exe` 带空格，
  // `gh release upload $(find ...)` 不加引号会把它词分割成三个参数，
  // upload 整体失败 —— 症状是「公开仓一个资产都没有」，看不出是空格的事。
  ['带空格的安装包也上传成功了（曾被词分割整体吃掉）', () => {
    requireLoaded('公开仓 Release', state.mirror, '读到公开仓同 tag 的资产');
    const hit = state.mirror.assets.filter(a => SPACEY_ASSET.test(a.name));
    expectTrue(hit.length === 1, '公开仓上找不到 NSIS 安装包（本地文件名带空格的那个）',
      `实际资产名：${state.mirror.assets.map(a => a.name).join(', ')}\n` +
      '本地文件名是 `TodoX Setup <版本>.exe`，GitHub 上传时把空格换成点。\n' +
      '它整个消失通常意味着上传命令没给文件名加引号。');
    expectTrue(hit[0].size > MIN_BYTES, `${hit[0].name} 只有 ${mb(hit[0].size)}`, JSON.stringify(hit[0]));
    return `${hit[0].name}，${mb(hit[0].size)}`;
  }],

  ['每个资产的 state 是 uploaded，体积都超过 30MB', () => {
    requireLoaded('公开仓 Release', state.mirror, '读到公开仓同 tag 的资产');
    const bad = state.mirror.assets.filter(a => a.state !== 'uploaded').map(a => `${a.name}: ${a.state}`);
    expectEq(bad, [], '未完成上传的资产');
    const sized = state.mirror.assets.slice().sort((x, y) => x.size - y.size);
    const small = sized.filter(a => a.size <= MIN_BYTES).map(a => `${a.name}: ${mb(a.size)}`);
    expectEq(small, [], `小于 ${mb(MIN_BYTES)} 的资产`);
    return `最小 ${sized[0].name} = ${mb(sized[0].size)}，合计 ${mb(sized.reduce((n, a) => n + a.size, 0))}`;
  }],

  // 这条是这整个 job 的意义所在。没有它，「同步坏了但公开仓留着上一版」会全绿。
  ['每个资产的 sha256 与私有仓逐一相同（正向痕迹）', () => {
    requireLoaded('公开仓 Release', state.mirror, '读到公开仓同 tag 的资产');
    const srcMap = new Map(state.src.assets.map(a => [a.name, a.digest]));
    const noDigest = state.mirror.assets.filter(a => !a.digest).map(a => a.name);
    // 摘要缺失不许静默降级成「只比名字」—— 那样这条断言就变成空的了。
    expectEq(noDigest, [], '公开仓这些资产没有摘要，无法证明字节一致');
    const srcNoDigest = [...srcMap.entries()].filter(([, d]) => !d).map(([n]) => n);
    expectEq(srcNoDigest, [], '私有仓这些资产没有摘要');
    const diffs = [];
    for (const a of state.mirror.assets) {
      const want = srcMap.get(a.name);
      if (want !== a.digest) diffs.push(`${a.name}\n  源: ${want}\n  镜像: ${a.digest}`);
    }
    expectTrue(diffs.length === 0, `${diffs.length} 个资产的字节内容与私有仓不一致`,
      `${diffs.join('\n')}\n\n` +
      '这通常意味着公开仓上挂的是**上一次发布**残留的文件：数量对、名字对、\n' +
      'state 也是 uploaded —— 只有摘要能看出来它不是这次打的那一份。');
    const sample = state.mirror.assets[0];
    return `${EXPECT_TOTAL} 个摘要逐一相同（例：${sample.name} ${String(sample.digest).slice(0, 23)}…）`;
  }],

  // **覆盖缺口的解药。** 上面每一条都只看「当次这个 tag」，所以公开仓里躺一个
  // 上一轮失败留下的空发布是完全隐形的 —— 实测真的躺了一个。
  // 对下载的人来说，一个 0 资产的正式发布就是一个死链。
  ['公开仓没有 0 资产的正式发布（负向孪生，扫全部而不只是当次）', () => {
    requireLoaded('公开仓 Release 列表', state.mirrorAll, '读到公开仓同 tag 的资产');
    const empty = state.mirrorAll
      .filter(r => r.draft === false && (r.assets || []).length === 0)
      .map(r => `${r.tag_name}（${r.html_url}）`);
    expectTrue(empty.length === 0, `公开仓上有 ${empty.length} 个 0 资产的正式发布 —— 对下载的人是死链`,
      `${empty.join('\n')}\n\n` +
      '前面每条断言都只看当次这个 tag，所以这类残留是隐形的。\n' +
      '删掉那个发布（以及它的 tag）即可。草稿不算 —— 草稿本身就在喊「没完成」。');
    const drafts = state.mirrorAll.filter(r => r.draft === true).length;
    return `${state.mirrorAll.length} 个发布里 0 个空的正式发布（其中 ${drafts} 个草稿，不算）`;
  }],

  // ==========================================================================
  // 这条补的是这个脚本**自己造出来的**盲区：上面第 2 条断言「审计时必须还是
  // 草稿」，副作用是这个脚本永远跑在转正之前，所以「现在对外可见吗」它断言不了。
  //
  // 运行时的断言在 release.yml 那一块里（读回来、比四个字段、五次不满足就
  // exit 1）。**这里守的是它还在** —— 删掉它，一个字符都不会有别的东西红。
  //
  // 时机上这条比 verify-mirror 那条值钱：这个闸门红 -> 转正那一步的 if 不成立
  // -> 压根不会转正。所以「读回断言被删掉」会在转正**之前**被拦住。
  // 而 verify-mirror 那条补的是另一段时间：两次发版之间的那几周。
  //
  // **检查器和变异体都在 scripts/lib/promote-guard.mjs，两处调同一份。**
  // ==========================================================================
  ['转正那一块里有一条会返回退出码的读回断言（块内检查 + 变异体自证）', () => {
    const rel = path.join('.github', 'workflows', 'release.yml');
    const rawWf = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expectEq(promotionGuardProblems(rawWf, EXPECT_TOTAL), [], `${rel} 转正那一块的守卫`);

    const m = promotionMutants(rawWf);
    expectTrue(m.located, '在 release.yml 里定位不到读回来那一段 —— 变异体造不出来，这条自证就是空的',
      `ok=0 第 ${m.from + 1} 行，收尾 echo 第 ${m.to + 1} 行，块内 exit 1 第 ${m.exitAt + 1} 行`);

    const oldBlind = [];
    for (const mut of m.mutants) {
      // 先证明变异体是像样的：真的改动了，而且**转正本身还在做**。
      expectTrue(mut.text !== rawWf, `变异体「${mut.name}」没有真的改动文件 —— 那它证明不了任何事`);
      expectTrue(mut.text.includes(PROMOTE_MARK), `变异体「${mut.name}」把转正本身也删了 —— 那不是这条断言要抓的坏`);
      const got = promotionGuardProblems(mut.text, EXPECT_TOTAL);
      expectTrue(got.length >= 1, `变异体「${mut.name}」没被守卫抓到`, `守卫返回：${JSON.stringify(got)}`);
      if (mut.changedLines !== null) {
        const base = rawWf.split('\n');
        const n = mut.text.split('\n').filter((l, i) => l !== base[i]).length;
        expectEq(n, mut.changedLines, `变异体「${mut.name}」改动的行数`);
      }
      if (mut.oldWouldPass === null) continue;
      // 旧写法（在**整个文件**里找 exit 1）会不会放过它 —— 把「为什么必须块内」
      // 也钉进断言，否则半年后有人图省事又改回全文搜索。
      const oldPasses = /(^|\s)exit 1(\s|$)/.test(mut.text);
      expectEq(oldPasses, mut.oldWouldPass, `变异体「${mut.name}」在「全文找 exit 1」那种写法下的结果`);
      if (oldPasses) oldBlind.push(mut.name);
    }
    expectEq(oldBlind.length, 2, '能从「全文找 exit 1」眼皮底下走过去的变异体个数');
    expectTrue(m.mutants[0].text.includes('未配置 MIRROR_TOKEN'), '变异体 A 不该动到令牌守卫那一段');

    return `转正那一块读回了 isDraft / isLatest / 资产数，块内有 exit 1（第 ${m.exitAt + 1} 行），` +
      `资产数 ${EXPECT_TOTAL} 与 EXPECT_TOTAL 一致｜${m.mutants.length} 个变异体全被抓到，` +
      `其中 2 个能骗过「全文找 exit 1」的写法｜检查器与变异体来自 lib/promote-guard.mjs（verify-mirror 调同一份）`;
  }],

  ['自检：本次实际执行的检查数等于清单数', () => {
    const actual = report.checks.length + 1;
    expectEq(actual, CHECKS.length, '本次执行的检查数');
    expectEq(CHECKS.length, MANIFEST.releaseMirror, 'manifest.json 里登记的条数');
    return `${actual} 条，等号断言`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, 'release-mirror');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
