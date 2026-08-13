#!/usr/bin/env node
// 安装包闸门：在三个平台各自的 runner 上打**真安装包**（不是 --dir）。
//
// 和 verify-pack.mjs 的区别：那条只证明「能打出一棵目录树」，这条要证明
// 「用户能下载到的那个文件真的存在、体积对、名字里的版本号是这一版」。
//
// 这条闸门同时是发布清单的**唯一**来源：它把够格的产物复制进 installers/，
// workflow 只上传那个目录。这样「发布了什么」由断言决定，而不是由一个
// dist/* 通配符决定 —— 后者会顺手把 .blockmap 和 latest.yml 一起发出去，
// 然后「资产数量」那条等号断言就永远对不上。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report, RELEASE_GATES } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'installers');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 每个平台该产出哪些扩展名、共几个文件。数量是**等号**：多一个少一个都要红，
// 否则「mac 只出了 arm64」这种事会安静地溜过去，直到某个用 Intel Mac 的人
// 下载了才发现。
const PLAN = {
  'dist-linux': { flags: ['--linux', '--x64'], exts: ['.AppImage', '.deb'], count: 2 },
  'dist-mac': { flags: ['--mac', '--arm64', '--x64'], exts: ['.dmg', '.zip'], count: 4 },
  'dist-win': { flags: ['--win', '--x64'], exts: ['.exe', '.zip'], count: 2 }
};

// 实测最小的产物在 70MB 上下（Electron 运行时就这么大），地板设 30MB 留三倍
// 余量。这个阈值只用来抓「打出来是个空壳」，不是体积基准。
const MIN_BYTES = 30 * 1024 * 1024;

const SLUG = process.env.TODOX_DIST_SLUG || '';
if (!Object.prototype.hasOwnProperty.call(PLAN, SLUG)) {
  process.stderr.write(`TODOX_DIST_SLUG 必须是 ${Object.keys(PLAN).join(' / ')} 之一，实际是 ${JSON.stringify(SLUG)}\n`);
  process.exit(2);
}
const plan = PLAN[SLUG];
const label = RELEASE_GATES.find(g => g.slug === SLUG).label;
const report = new Report(label);

function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = String(evidence);
  throw e;
}
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function tailOf(s, n = 60) { return String(s || '').trimEnd().split('\n').slice(-n).join('\n'); }
function mb(n) { return `${(n / 1024 / 1024).toFixed(1)}MB`; }

// dist 顶层那些够格当安装包的文件。只看顶层：mac 的 .app 里面全是 .zip 之类的
// 内部文件，递归下去会把它们也算进来。
function installers() {
  if (!fs.existsSync(DIST)) return [];
  return fs.readdirSync(DIST, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.join(DIST, e.name))
    .filter(f => plan.exts.some(ext => f.toLowerCase().endsWith(ext.toLowerCase())))
    .sort();
}

let built = null;

const CHECKS = [
  ['electron-builder 打出真安装包（不是 --dir）', () => {
    const cmd = `npx electron-builder ${plan.flags.join(' ')} --publish never`;
    built = spawnSync(cmd, {
      cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    });
    const out = `${built.stdout || ''}\n${built.stderr || ''}`;
    if (built.status !== 0) fail(`electron-builder 退出码 ${built.status}`, `命令: ${cmd}\n${tailOf(out, 80)}`);
    return `${cmd} -> 退出码 0`;
  }],

  ['产物扩展名齐全且数量恰好等于计划数', () => {
    const files = installers();
    const all = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
    const gotExts = [...new Set(files.map(f => path.extname(f).toLowerCase()))].sort();
    const wantExts = [...new Set(plan.exts.map(e => e.toLowerCase()))].sort();
    if (JSON.stringify(gotExts) !== JSON.stringify(wantExts)) {
      fail('产物扩展名与计划不符', `期望 ${wantExts.join(',')}\n实际 ${gotExts.join(',') || '（一个都没有）'}\ndist 顶层: ${all.join(', ') || '（空）'}`);
    }
    if (files.length !== plan.count) {
      fail(`产物数量不对：期望 ${plan.count} 个，实际 ${files.length} 个`, `实际: ${files.map(f => path.basename(f)).join('\n')}\n（等号断言：少一个架构也要红）`);
    }
    return `${files.length} 个：${files.map(f => path.basename(f)).join('、')}`;
  }],

  [`每个安装包都大于 ${mb(MIN_BYTES)}`, () => {
    const files = installers();
    if (files.length === 0) fail('没有任何安装包可量', 'dist 顶层空的 —— 上一条应该已经红了');
    const small = files.filter(f => fs.statSync(f).size <= MIN_BYTES)
      .map(f => `${path.basename(f)} = ${mb(fs.statSync(f).size)}`);
    if (small.length > 0) fail('有安装包小得不像装了 Electron 运行时', small.join('\n'));
    const sizes = files.map(f => `${path.basename(f)} ${mb(fs.statSync(f).size)}`);
    return sizes.join('、');
  }],

  ['dist 里没有 0 字节文件（负向孪生）', () => {
    const all = walk(DIST);
    if (all.length === 0) fail('dist 下一个文件都没有 —— 是构建没产出，不是「很干净」', DIST);
    const empty = all.filter(f => fs.statSync(f).size === 0).map(f => path.relative(ROOT, f));
    if (empty.length > 0) fail('存在 0 字节产物', empty.join('\n'));
    return `${all.length} 个文件，0 字节的有 0 个`;
  }],

  ['文件名带本版号，且复制进 installers/ 后逐字节对得上', () => {
    const files = installers();
    const noVersion = files.filter(f => !path.basename(f).includes(PKG.version)).map(f => path.basename(f));
    if (noVersion.length > 0) fail(`文件名里没有版本号 ${PKG.version}`, `${noVersion.join('\n')}\n（打出来的可能是缓存里的旧版本）`);
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const bad = [];
    for (const f of files) {
      const dest = path.join(OUT, path.basename(f));
      fs.copyFileSync(f, dest);
      const a = fs.statSync(f).size;
      const b = fs.statSync(dest).size;
      if (a !== b || b === 0) bad.push(`${path.basename(f)}: 源 ${a} 字节 -> 目标 ${b} 字节`);
    }
    if (bad.length > 0) fail('复制到 installers/ 后字节数对不上', bad.join('\n'));
    const total = fs.readdirSync(OUT).length;
    if (total !== plan.count) fail('installers/ 里的文件数不对', `期望 ${plan.count}，实际 ${total}`);
    return `${total} 个文件带版本号 ${PKG.version}，复制后字节数逐一相等`;
  }],

  ['自检：本次实际执行的检查数等于清单数', () => {
    const actual = report.checks.length + 1;
    if (actual !== CHECKS.length) fail('执行的检查数与清单不符', `实际 ${actual}，清单 ${CHECKS.length}`);
    if (CHECKS.length !== MANIFEST.dist) fail('清单数与 manifest.json 不符', `CHECKS ${CHECKS.length}，manifest ${MANIFEST.dist}`);
    return `${actual} 条，等号断言`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, SLUG);
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
