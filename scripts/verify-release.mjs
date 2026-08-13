#!/usr/bin/env node
// 发布资产校验闸门：把 Release 从 GitHub API **读回来**，断言用户真的下载得到。
//
// 为什么不满足于「发布那步退出码是 0」：那是在验证自己的录音。发布 action 报成功
// 而资产传了一半、或者传成了 0 字节、或者 mac 只出了一个架构 —— 这些在 job 面板上
// 全都是绿的。读回来的资产列表不会说谎。
//
// 这也是「正向痕迹」那条规矩的实例：「没有坏消息」和「压根没发出去」长得一模一样，
// 所以要去外部确认一个带时间戳的真实痕迹，而不是读配置确认「发布步骤还在」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const TAG = `v${PKG.version}`;
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const MIN_BYTES = 30 * 1024 * 1024;

// 和 verify-dist.mjs 的 PLAN 是一组：改一个必须重算另一个（见 AGENTS.md）。
const EXPECT = [
  { name: 'Linux', exts: ['.appimage', '.deb'], count: 2 },
  { name: 'macOS', exts: ['.dmg', '.zip'], count: 4 },
  { name: 'Windows', exts: ['.exe', '.zip'], count: 2 }
];
const EXPECT_TOTAL = 8;

const report = new Report('发布资产校验闸门');
let release = null;
let assets = [];

function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = String(evidence);
  throw e;
}
function mb(n) { return `${(n / 1024 / 1024).toFixed(1)}MB`; }
function names() { return assets.map(a => `${a.name} ${mb(a.size)} [${a.state}]`).join('\n'); }

async function getJSON(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'todox-release-gate' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let last = null;
  // 偶发网络错误不该被当成「发布失败」。重试之后仍然拿不到，才算数。
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`.slice(0, 500));
      return { status: res.status, body: await res.json() };
    } catch (err) {
      last = err;
      if (attempt < 4) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  fail(`读 GitHub API 失败（重试 4 次）: ${url}`, last && last.message);
}

const CHECKS = [
  ['Release 真的存在（从 API 读回来，不是读配置）', async () => {
    if (!REPO) fail('拿不到 GITHUB_REPOSITORY', '这条闸门只在 CI 里有意义');
    const r = await getJSON(`${API}/repos/${REPO}/releases/tags/${TAG}`);
    if (r.status === 404) {
      fail(`按 tag ${TAG} 读不到任何 Release`, '发布那步大概根本没跑，或者跑了但没建出 Release。注意：这里**不**标「未确认」就放过 —— 发布本来就是这次要做的事，没做成就是失败。');
    }
    release = r.body;
    assets = release.assets || [];
    return `${TAG}｜${release.html_url}｜${assets.length} 个资产`;
  }],

  ['Release 不是草稿，tag 与 package.json 版本一致', async () => {
    if (release.draft === true) fail('Release 还是草稿状态，用户看不到', `${release.html_url}`);
    if (release.tag_name !== TAG) fail('tag 对不上', `期望 ${TAG}，实际 ${release.tag_name}`);
    return `tag=${release.tag_name}，draft=false，prerelease=${release.prerelease}`;
  }],

  ['三平台的资产各自齐全（等号，不是下限）', async () => {
    const problems = [];
    for (const p of EXPECT) {
      const hit = assets.filter(a => p.exts.some(e => a.name.toLowerCase().endsWith(e)));
      const missing = p.exts.filter(e => !hit.some(a => a.name.toLowerCase().endsWith(e)));
      if (missing.length > 0) problems.push(`${p.name} 缺少 ${missing.join(',')}`);
    }
    if (problems.length > 0) fail('有平台的资产缺失', `${problems.join('\n')}\n\n实际资产:\n${names()}`);
    if (assets.length !== EXPECT_TOTAL) {
      fail(`资产总数不对：期望 ${EXPECT_TOTAL}，实际 ${assets.length}`, `${names()}\n（等号断言：多传了 blockmap 之类的东西，或者少了一个架构，都要红）`);
    }
    return `${assets.length} 个资产，Linux/macOS/Windows 三组扩展名齐全`;
  }],

  ['每个资产状态是 uploaded 且体积合理', async () => {
    const notUploaded = assets.filter(a => a.state !== 'uploaded').map(a => `${a.name} [${a.state}]`);
    if (notUploaded.length > 0) fail('有资产没有真正上传完', notUploaded.join('\n'));
    const small = assets.filter(a => a.size <= MIN_BYTES).map(a => `${a.name} = ${mb(a.size)}`);
    if (small.length > 0) fail(`有资产小于 ${mb(MIN_BYTES)}，不像装了 Electron 运行时`, small.join('\n'));
    return assets.map(a => `${a.name} ${mb(a.size)}`).join('、');
  }],

  ['0 字节资产数为 0，且没有重名（负向孪生）', async () => {
    const zero = assets.filter(a => a.size === 0).map(a => a.name);
    if (zero.length > 0) fail('存在 0 字节资产', zero.join('\n'));
    const seen = new Set();
    const dup = [];
    for (const a of assets) { if (seen.has(a.name)) dup.push(a.name); seen.add(a.name); }
    if (dup.length > 0) fail('存在重名资产', dup.join('\n'));
    const total = assets.reduce((n, a) => n + a.size, 0);
    return `0 字节资产 0 个、重名 0 个，合计 ${mb(total)}`;
  }],

  ['自检：本次实际执行的检查数等于清单数', async () => {
    const actual = report.checks.length + 1;
    if (actual !== CHECKS.length) fail('执行的检查数与清单不符', `实际 ${actual}，清单 ${CHECKS.length}`);
    if (CHECKS.length !== MANIFEST.release) fail('清单数与 manifest.json 不符', `CHECKS ${CHECKS.length}，manifest ${MANIFEST.release}`);
    return `${actual} 条，等号断言`;
  }]
];

let fatal = null;
for (let i = 0; i < CHECKS.length; i += 1) {
  const [title, fn] = CHECKS[i];
  const isSelfCheck = i === CHECKS.length - 1;
  if (fatal && !isSelfCheck) {
    report.skip(title, `读不到 Release，后面的断言没有前提（跳过一律算失败）：${fatal}`);
    continue;
  }
  const entry = await report.checkAsync(title, fn);
  if (!entry.ok && i === 0) fatal = entry.detail;
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, 'release-assets');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
