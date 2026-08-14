#!/usr/bin/env node
// 公开镜像的审计闸门（外加两条不属于镜像、但必须住在这里的断言）。
//
// **它不看本地暂存目录。** 暂存目录是我自己算出来的，验它等于验一段拷贝逻辑。
// 这里回头去读公开仓**真实的树**,因为这件事最像成功的失败是「推上去了，
// 但推的是错的东西」，而那从私有仓内部完全看不出来。
//
// 四类断言：
//   - 正向：该有的文件都在（README / LICENSE / src 里每个真实文件 / 三张截图）
//   - 负向孪生：.github、scripts、test、AGENTS.md、CLAUDE.md 出现 0 次
//     ,这一侧是整件事的全部意义。正向那侧在同步完全没生效时也会通过，
//     因为公开仓上一次的内容还在那儿。
//   - 历史：HEAD 只有一个提交。把私有历史一起推上去，等于什么都没隐藏,
//     而文件树看起来会完全正确。
//   - **正向痕迹：那个提交必须是本次同步产生的。** 这条差点被漏掉，而它
//     是唯一能区分「同步成功」和「早就不同步了」的东西:推送失败时审计
//     读到的是上一次留下的内容，前三类断言会全部通过。第一次运行会红
//     （仓库是空的），之后就再也不会红。带时间戳的外部痕迹才承重。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report } from './lib/report.mjs';
import {
  MIRROR_REPO, ALLOW_TOP, DENY_PATHS, REQUIRE_FILES,
  DENY_SCRIPT_KEYS, DENY_DEV_DEPS, isDenied, topOf
} from './lib/mirror.mjs';
import { promotionGuardProblems, promotionSelfProofProblems } from './lib/promote-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));
const SRC_SHA = process.env.GITHUB_SHA || '';
const SRC_REPO = process.env.GITHUB_REPOSITORY || 'supercubegame/TodoX';
// 和 verify-dist.mjs 的 PLAN、verify-release.mjs、verify-release-mirror.mjs、
// release.yml 里三处清点是一组。改一个必须重算其余的（见 AGENTS.md）。
const EXPECT_TOTAL = 8;
const report = new Report('公开镜像同步');

const state = { tree: null, commits: null };

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

// 用 gh api 读公开仓。这里**故意**不用本地 git,本地那份是我刚推上去的东西，
// 读它等于自己给自己打分。要的是服务端那份。
function gh(args, label) {
  const r = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) fail(`${label}：gh 起不来`, String(r.error.message));
  if (r.status !== 0) fail(`${label}：gh 退出码 ${r.status}`, tailOf(`${r.stdout || ''}\n${r.stderr || ''}`));
  return r.stdout || '';
}

// 语义版本比较。只比 x.y.z 三段，够用了。
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

const CHECKS = [
  ['拿到了公开仓真实的文件树（先证明解析成功）', () => {
    // 解析式的断言要先证明解析成功：空树会让下面的负向断言全部免费通过。
    const raw = gh(['api', `repos/${MIRROR_REPO}/git/trees/main?recursive=1`], '读取镜像文件树');
    const parsed = JSON.parse(raw);
    expectTrue(Array.isArray(parsed.tree), 'tree 不是数组', raw.slice(0, 400));
    expectTrue(parsed.truncated !== true, '文件树被截断了,这次读到的不是全部内容，负向断言不成立', JSON.stringify({ truncated: parsed.truncated, n: parsed.tree.length }));
    state.tree = parsed.tree.filter(e => e.type === 'blob').map(e => e.path);
    expectTrue(state.tree.length > 0, '公开仓里一个文件都没有,同步压根没生效', raw.slice(0, 400));
    return `${MIRROR_REPO} 共 ${state.tree.length} 个文件`;
  }],

  ['该有的文件全部就位（正向）', () => {
    const missing = REQUIRE_FILES.filter(f => !state.tree.includes(f));
    expectEq(missing, [], '缺失的文件');
    return `${REQUIRE_FILES.length} 个必需文件全部存在`;
  }],

  ['禁止的路径出现 0 次（负向孪生,这是整件事的意义）', () => {
    const leaked = state.tree.filter(isDenied);
    expectEq(leaked, [], '泄漏到公开仓的路径');
    return `${DENY_PATHS.join(' / ')} 在 ${state.tree.length} 个文件里出现 0 次`;
  }],

  ['顶层条目全在白名单内（防新增目录默认泄漏）', () => {
    const tops = [...new Set(state.tree.map(topOf))].sort();
    const stray = tops.filter(t => !ALLOW_TOP.includes(t));
    expectEq(stray, [], '白名单之外的顶层条目');
    return `顶层：${tops.join(', ')}`;
  }],

  ['公开仓的 package.json 没有指向 scripts/ 的命令', () => {
    const raw = gh(['api', `repos/${MIRROR_REPO}/contents/package.json`, '--jq', '.content'], '读取镜像 package.json');
    const text = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
    const pkg = JSON.parse(text);
    expectTrue(pkg.name === 'todox', 'package.json 解析出来不是 todox,读到的可能是别的东西', text.slice(0, 300));
    const badScripts = Object.keys(pkg.scripts || {}).filter(k => DENY_SCRIPT_KEYS.includes(k));
    expectEq(badScripts, [], '仍然指向 scripts/ 的命令');
    const badDeps = Object.keys(pkg.devDependencies || {}).filter(k => DENY_DEV_DEPS.includes(k));
    expectEq(badDeps, [], '不该出现的开发依赖');
    expectTrue(Boolean(pkg.scripts && pkg.scripts.start), '连 npm start 都没了,裁剪裁过头了', JSON.stringify(pkg.scripts));
    return `保留 ${Object.keys(pkg.scripts).join(' / ')}，版本 ${pkg.version}`;
  }],

  ['历史是干净的：main 上只有一个提交', () => {
    const raw = gh(['api', `repos/${MIRROR_REPO}/commits?sha=main&per_page=100`, '--jq', '[.[] | {sha: .sha[0:7], msg: .commit.message | split("\n")[0]}]'], '读取镜像提交历史');
    state.commits = JSON.parse(raw);
    expectTrue(state.commits.length > 0, '一个提交都读不到', raw.slice(0, 300));
    expectEq(state.commits.length, 1, '公开仓的提交数');
    return `单个提交 ${state.commits[0].sha}：${state.commits[0].msg}`;
  }],

  // 没有这一条，整个审计就是个假绿：推送失败时上面每一条都读的是上一次同步
  // 留下的内容,文件树正确、负向断言通过、历史也只有一个提交。
  ['公开仓上那个提交就是本次同步产生的（正向痕迹）', () => {
    expectTrue(SRC_SHA !== '', '拿不到 GITHUB_SHA，无法确认镜像是否为本次同步', '这条断言在 CI 之外没有意义,不能当成通过');
    const short = SRC_SHA.slice(0, 7);
    const msg = state.commits[0].msg;
    expectTrue(
      msg.includes(short),
      '公开仓上的提交不是本次同步产生的,镜像很可能早就停在旧内容上了',
      `期望提交信息里含源 SHA ${short}\n实际提交信息: ${msg}\n` +
      '「没有坏消息」和「早就不同步了」长得一模一样。推送真的失败时，上面每一条\n' +
      '断言都会读到上一次留下的内容并全部通过 —— 只有这条会红。'
    );
    return `镜像提交信息含源 SHA ${short}，确认是这一次推上去的`;
  }],

  ['截图不是空文件（验产物，不验路径存在）', () => {
    const shots = state.tree.filter(p => p.startsWith('docs/screenshots/') && p.endsWith('.png'));
    expectEq(shots.length, 3, '截图数量');
    const sizes = [];
    for (const p of shots) {
      const raw = gh(['api', `repos/${MIRROR_REPO}/contents/${p}`, '--jq', '.size'], `读取 ${p} 的体积`);
      const size = Number(String(raw).trim());
      expectTrue(Number.isFinite(size) && size > 5000, `${p} 只有 ${size} 字节，像是空图`, '路径存在证明不了内容对,这里验的是服务端报的真实体积');
      sizes.push(`${path.basename(p)} ${(size / 1024).toFixed(0)}KB`);
    }
    return sizes.join('，');
  }],

  // 这条跟镜像没关系，但它必须住在一个「每次推 main 都跑、而且能上网」的地方,
  // 快闸门是零依赖离线的，看不到「已经发过什么版本」。
  //
  // 同一个毛病犯了两次：v1.0.0 的 deb 修复只活在 release 分支上没回 main；
  // v1.0.1 的版本号也只在 release 分支上 bump。形状一样,发布分支上的改动
  // 没有回流，而 main 看起来完全正常。犯两次的规矩就该变成断言。
  ['main 的版本号不低于最新已发布的 tag（发布分支必须回流）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const raw = gh(['api', `repos/${SRC_REPO}/releases?per_page=100`, '--jq', '[.[] | select(.draft == false) | .tag_name]'], '读取已发布的 tag');
    const tags = JSON.parse(raw);
    if (tags.length === 0) return `还没有任何正式发布，main 上是 ${pkg.version}`;
    const latest = tags.slice().sort(cmpSemver).pop();
    expectTrue(
      cmpSemver(pkg.version, latest) >= 0,
      `main 的版本号（${pkg.version}）低于已发布的 ${latest}`,
      `已发布的 tag: ${tags.join(', ')}\n` +
      '说明发布分支上的改动没有回流到 main。下一次从 main 切发布分支会重复上一版的号，\n' +
      '或者重踩上一版已经修过的坑 —— 而 main 本身看起来完全正常。'
    );
    return `main ${pkg.version} >= 最新发布 ${latest}（共 ${tags.length} 个正式发布）`;
  }],

  // ==========================================================================
  // 这条也跟镜像没关系，住在这里的理由是**时机**。
  //
  // 同一个守卫在 verify-release-mirror.mjs 里也有一条，那边能**拦住发布**
  // （它红 -> 转正那一步的 if 不成立 -> 压根不会转正），那是它最值钱的地方。
  // 但发版可能几周一次,中间那几周没有任何东西看着这段守卫。这条补的就是那几周。
  //
  // **而它上线第一天就证明了自己**：搬过来之后在 main 上第一次跑就红了 ——
  // 抓到的是**自己那个变异体造错了**（改到了 publish job）。发布侧那份代码
  // 一模一样，如果没搬过来，这个错要等到下次真发版才会现形。
  //
  // 检查器、变异体、自证循环全在 scripts/lib/promote-guard.mjs，**两处调同一份**。
  // ==========================================================================
  ['release.yml 转正那一块仍有一条会返回退出码的读回断言（块内检查 + 变异体自证）', () => {
    const rel = path.join('.github', 'workflows', 'release.yml');
    const rawWf = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expectEq(promotionGuardProblems(rawWf, EXPECT_TOTAL), [], `${rel} 转正那一块的守卫`);
    const proof = promotionSelfProofProblems(rawWf, EXPECT_TOTAL);
    expectEq(proof.problems, [], '变异体自证');
    expectEq(proof.oldBlind.length, 2, '能从「全文找 exit 1」眼皮底下走过去的变异体个数');
    return `转正那一块读回了 isDraft / isLatest / 资产数，块内有 exit 1（第 ${proof.exitAt + 1} 行），` +
      `资产数比较在第 ${proof.eqAt + 1} 行、值为 ${EXPECT_TOTAL}｜${proof.mutants.length} 个变异体全被抓到，` +
      `每个都断言过「改动落在转正那一块里面」，其中 2 个能骗过「全文找 exit 1」的写法`;
  }],

  // 这条原来写的是「report.checks.length + 1 === CHECKS.length」—— 两个数会
  // **一起变**，所以加一条少一条它都不会红。**那是一条和自己比的等号断言，**
  // **形状上就是空的。** 别的闸门都钉在 scripts/manifest.json 上，只有这条漏了,
  // 又一次「模板级的修复没有自己传染」。
  ['自检：执行条数等于清单登记的条数（钉在 manifest 上，不是和自己比）', () => {
    const actual = report.checks.length + 1;
    expectEq(actual, CHECKS.length, '本次执行的检查数');
    expectEq(CHECKS.length, MANIFEST.mirror, 'scripts/manifest.json 里登记的条数');
    return `${actual} 条，等号断言（登记值 ${MANIFEST.mirror}）`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, 'mirror');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
