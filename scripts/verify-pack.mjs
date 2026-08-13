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

// 只对**可识别的网络错误**重试。无条件重试会把「产品真的坏了」也拖成三倍
// 时间，还会掩盖偶发性的真实 bug —— 「上游挂了」和「代码编不过」必须分开。
// 实测踩到的那次是 electron zip 下载 connection reset by peer。
const TRANSIENT = [
  'connection reset by peer',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'unexpected EOF',
  'read: connection',
  'TLS handshake',
  'i/o timeout',
  'net/http: TLS',
  '503 Service Unavailable',
  '429 Too Many Requests'
];
const MAX_ATTEMPTS = 3;

const report = new Report(GATES.find(g => g.slug === SLUG).label);
const attempts = [];

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
function transientReason(out) { return TRANSIENT.find(sig => out.includes(sig)) || null; }
function sleepSync(ms) {
  // 闸门是同步流程，这里不引入 async。忙等这点时间无所谓。
  const until = Date.now() + ms;
  while (Date.now() < until) { /* 等退避 */ }
}

const CHECKS = [
  ['electron-builder --dir 构建成功', () => {
    let lastOut = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const build = spawnSync('npx electron-builder --dir', {
        cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
      });
      lastOut = `${build.stdout || ''}\n${build.stderr || ''}`;
      if (build.status === 0) {
        attempts.push(`第 ${attempt} 次成功`);
        // 重试成功也要留痕迹。否则「一次就过」和「第三次才过」在报告上长得
        // 一样，上游在慢慢变差就看不见了。
        return `退出码 0，输出 ${lastOut.split('\n').length} 行（${attempts.join('；')}）`;
      }
      const reason = transientReason(lastOut);
      attempts.push(`第 ${attempt} 次失败${reason ? `（网络：${reason}）` : '（非网络）'}`);
      if (!reason) {
        fail(`electron-builder 退出码 ${build.status}，且不是可识别的网络错误`,
          `${attempts.join('；')}\n不重试是有意的：产品编译不过就该第一次红，别拖三轮。\n\n${tail(lastOut, 80)}`);
      }
      if (attempt < MAX_ATTEMPTS) sleepSync(5000 * attempt);
    }
    fail(`electron-builder 连续 ${MAX_ATTEMPTS} 次都失败`,
      `${attempts.join('；')}\n每次都是可识别的网络错误 —— 这次没有验证到打包本身，` +
      `不能当成「产品坏了」，也不能当成通过。\n\n${tail(lastOut, 80)}`);
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
    return `${actual} 条，等号断言｜构建尝试：${attempts.join('；') || '（没跑到）'}`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, SLUG);
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
