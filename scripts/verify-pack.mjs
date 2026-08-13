#!/usr/bin/env node
// 打包闸门：在三个平台各自的 runner 上真的打一次包。
//
// 为什么不满足于「package.json 里配了三个 target」：那条静态断言在打包完全
// 坏掉的时候也会通过 —— 它是空断言。这里验的是真实产物：目录在不在、
// 字节数够不够、app.asar 有没有真的生成。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Report, GATES } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));

const SLUG = process.env.TODOX_PACK_SLUG || '';
const known = GATES.map(g => g.slug).filter(s => s.startsWith('pack-'));
if (!known.includes(SLUG)) {
  process.stderr.write(`TODOX_PACK_SLUG 必须是 ${known.join(' / ')} 之一，实际是 ${JSON.stringify(SLUG)}\n`);
  process.exit(2);
}
const EXPECT_DIR_PREFIX = { 'pack-linux': 'linux-unpacked', 'pack-mac': 'mac', 'pack-win': 'win-unpacked' }[SLUG];

const report = new Report(GATES.find(g => g.slug === SLUG).label);
let build = null;

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
function tail(s, n = 60) { return String(s || '').trimEnd().split('\n').slice(-n).join('\n'); }

const CHECKS = [
  ['electron-builder --dir 构建成功', () => {
    build = spawnSync('npx electron-builder --dir', {
      cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    });
    const out = `${build.stdout || ''}\n${build.stderr || ''}`;
    if (build.status !== 0) fail(`electron-builder 退出码 ${build.status}`, tail(out, 80));
    return `退出码 0，输出 ${out.split('\n').length} 行`;
  }],

  ['产物目录存在且总字节数 > 50MB（验真实产物）', () => {
    if (!fs.existsSync(DIST)) fail('dist 目录不存在', `期望 ${DIST}`);
    const dirs = fs.readdirSync(DIST, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    const hit = dirs.find(d => d === EXPECT_DIR_PREFIX || d.startsWith(EXPECT_DIR_PREFIX + '-'));
    if (!hit) fail(`找不到 ${EXPECT_DIR_PREFIX}* 产物目录`, `dist 下只有: ${dirs.join(', ') || '（空）'}`);
    const files = walk(path.join(DIST, hit));
    const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    if (bytes <= 50 * 1024 * 1024) fail('产物体积明显不对，Electron 运行时应该在里面', `${hit}: ${files.length} 个文件，共 ${bytes} 字节`);
    return `${hit}：${files.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }],

  ['app.asar 真的生成了且不是空壳', () => {
    const asar = walk(DIST).filter(f => path.basename(f) === 'app.asar');
    if (asar.length === 0) fail('产物里没有 app.asar', `dist 下共 ${walk(DIST).length} 个文件`);
    const size = fs.statSync(asar[0]).size;
    if (size < 20 * 1024) fail('app.asar 太小，业务代码大概没打进去', `${path.relative(ROOT, asar[0])} = ${size} 字节`);
    return `${path.relative(ROOT, asar[0])}，${(size / 1024).toFixed(1)} KB`;
  }],

  ['自检：本次实际执行的检查数等于清单数', () => {
    const actual = report.checks.length + 1;
    if (actual !== CHECKS.length) fail('执行的检查数与清单不符', `实际 ${actual}，清单 ${CHECKS.length}`);
    if (CHECKS.length !== MANIFEST.pack) fail('清单数与 manifest.json 不符', `CHECKS ${CHECKS.length}，manifest ${MANIFEST.pack}`);
    return `${actual} 条，等号断言`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, SLUG);
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
