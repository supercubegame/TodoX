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
// 名字只能证明「有个叫这个名的文件」，摘要能证明「就是刚打出来的那一份字节」。
// 这是「验最终产物，不验接口被调用过」的同一条规矩。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report } from './lib/report.mjs';
import { MIRROR_REPO } from './lib/mirror.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));
const SRC_REPO = process.env.GITHUB_REPOSITORY || 'supercubegame/TodoX';
const TAG = process.env.TODOX_RELEASE_TAG || '';
// 和 verify-dist.mjs 的 PLAN、verify-release.mjs 的 EXPECT_TOTAL、release.yml 的
// 「发布前清点资产」是一组。改一个必须重算另外三个（见 AGENTS.md）。
const EXPECT_TOTAL = 8;
const MIN_BYTES = 30 * 1024 * 1024;

if (TAG === '') {
  process.stderr.write('TODOX_RELEASE_TAG 是空的 —— 不知道该核对哪个 Release\n');
  process.exit(2);
}

const report = new Report('公开仓 Release 同步校验');
const state = { src: null, mirror: null };

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

function gh(args, label) {
  const r = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) fail(`${label}：gh 起不来`, String(r.error.message));
  if (r.status !== 0) fail(`${label}：gh 退出码 ${r.status}`, tailOf(`${r.stdout || ''}\n${r.stderr || ''}`));
  return r.stdout || '';
}

// 读服务端那份，不读本地。本地那些文件是我刚上传的东西，读它等于自己给自己打分。
function readRelease(repo, label) {
  const raw = gh(['api', `repos/${repo}/releases/tags/${TAG}`], label);
  const rel = JSON.parse(raw);
  expectTrue(Array.isArray(rel.assets), `${label}：assets 不是数组`, raw.slice(0, 400));
  return {
    tag: rel.tag_name,
    draft: rel.draft,
    prerelease: rel.prerelease,
    url: rel.html_url,
    assets: rel.assets.map(a => ({
      name: a.name,
      size: a.size,
      state: a.state,
      // GitHub 现在会给出 "sha256:..." 形式的摘要。缺失时下面那条断言会红,
      // 而不是静默降级成「只比名字」。
      digest: a.digest || null
    }))
  };
}

const CHECKS = [
  ['读到私有仓这个 tag 的真实资产（先证明解析成功）', () => {
    state.src = readRelease(SRC_REPO, '读取源 Release');
    expectEq(state.src.tag, TAG, '源 Release 的 tag');
    expectEq(state.src.assets.length, EXPECT_TOTAL, '源 Release 的资产数');
    const bad = state.src.assets.filter(a => a.state !== 'uploaded').map(a => `${a.name}: ${a.state}`);
    expectEq(bad, [], '源 Release 里未完成上传的资产');
    return `${SRC_REPO} ${TAG}：${EXPECT_TOTAL} 个资产，合计 ${mb(state.src.assets.reduce((n, a) => n + a.size, 0))}`;
  }],

  ['读到公开仓同 tag 的真实资产', () => {
    state.mirror = readRelease(MIRROR_REPO, '读取镜像 Release');
    expectEq(state.mirror.tag, TAG, '镜像 Release 的 tag');
    expectTrue(state.mirror.draft === false, '镜像 Release 还是草稿 —— 别人下载不到', JSON.stringify(state.mirror, null, 2));
    expectTrue(state.mirror.prerelease === false, '镜像 Release 被标成了预发布', JSON.stringify({ prerelease: state.mirror.prerelease }));
    return `${MIRROR_REPO} ${TAG}：${state.mirror.assets.length} 个资产，已正式发布`;
  }],

  ['两边的资产名集合完全相等（等号 + 负向孪生）', () => {
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

  ['每个资产的 state 是 uploaded，体积都超过 30MB', () => {
    const bad = state.mirror.assets.filter(a => a.state !== 'uploaded').map(a => `${a.name}: ${a.state}`);
    expectEq(bad, [], '未完成上传的资产');
    const sized = state.mirror.assets.slice().sort((x, y) => x.size - y.size);
    const small = sized.filter(a => a.size <= MIN_BYTES).map(a => `${a.name}: ${mb(a.size)}`);
    expectEq(small, [], `小于 ${mb(MIN_BYTES)} 的资产`);
    return `最小 ${sized[0].name} = ${mb(sized[0].size)}，合计 ${mb(sized.reduce((n, a) => n + a.size, 0))}`;
  }],

  // 这条是这整个 job 的意义所在。没有它，「同步坏了但公开仓留着上一版」会全绿。
  ['每个资产的 sha256 与私有仓逐一相同（正向痕迹）', () => {
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
