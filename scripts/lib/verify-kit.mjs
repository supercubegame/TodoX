// 快闸门的共享工具：断言原语、文件读取、注释剥离器、workflow 解析器。
//
// ============================================================================
// **为什么这些东西从 verify.mjs 里搬出来了。**
//
// 那个文件长到 72190 字节，而我的写入通道只能整文件替换。2026-08-16 同一个
// 瓶颈一天内咬了三次：
//   1. 备份仓那边，一次「只想补个括号」把四个集合清成了空数组。
//   2. 这边，一条正则里的 `\\.` 写成了模板字符串里的单反斜杠,字面变成
//      `emails*!=s*`，那条断言永远匹配不上。**产品没问题，说谎的是尺子。**
//   3. 紧接着修那一行时，文件直接被写截断（62568 -> 47435 字节）。
//
// **三次之后再试第四次就不是谨慎，是侥幸主义。** 正确动作是把「一次必须写出
// 多少」降下来 —— 和备份仓拆 manifest、拆 verify.mjs 用的是同一套做法。
//
// **拆的规矩（一万字节买来的教训）：第一推只搬不改。** 判据是
// `scripts/manifest.json` 里那个 `fast: 59` 一字不改，而且 59 条清单逐条同名。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

export const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));

// 哨兵密钥：每次运行随机生成。写死一个密钥形状的字面量会被那条扫描抓到，
// 而那时说谎的是夹具不是扫描。
export const SENTINEL = 'todox-sentinel-' + crypto.randomBytes(16).toString('hex');
process.env.TODOX_SENTINEL_SECRET = SENTINEL;

// ---------------------------------------------------------------- 断言小工具
export function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  throw e;
}
export function expectEq(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label} 不符`, `期望: ${JSON.stringify(expected)}\n实际: ${JSON.stringify(actual)}`);
  }
}
export function expectTrue(cond, label, evidence) { if (!cond) fail(label, evidence); }
export function expectThrows(fn, code, label) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) fail(`${label}：本该抛错却没有`, '没有抛出任何异常 —— 这条断言如果一直不红，说明校验根本没生效');
  if (err.code !== code) fail(`${label}：错误码不对`, `期望 ${code}，实际 ${err.code}｜${err.message}`);
  return err;
}
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.getOwnPropertyNames(o)) deepFreeze(o[k]);
  }
  return o;
}
export { isDeepStrictEqual };

export function readIfExists(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(`文件不存在: ${rel}`, `绝对路径: ${p}`);
  return fs.readFileSync(p, 'utf8');
}
export function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (['node_modules', '.git', 'dist', 'installers', 'artifacts'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// 正则转义。把从配置里读出来的字面量拼进正则之前必须过一遍，否则邮箱里的 `.`
// 和 `+` 会变成元字符 —— 那样断言会在一个「看起来匹配了」的地方悄悄放宽。
export function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 密钥扫描只看文本文件。截图进仓库之后，二进制里凑巧出现一段密钥形状的字节
// 就会给出一条谁也看不懂的偶发红，而它防的东西（把密钥藏进 PNG）不现实。
const BINARY_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.asar', '.icns'];
export function isTextFile(f) { return !BINARY_EXT.includes(path.extname(f).toLowerCase()); }

// 字符级扫描器，不用正则。用正则剥注释会在字符串里出现 // 或 /* 的时候整段吃掉
// 代码 —— 那不是「少抓几个」，是让整类输入凭空消失。
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// HTML 注释。index.html 里也有说明文字，同一个洞。
export function stripHtmlComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 读源码找关键词的断言，一律走这里,**只看会执行的代码**。
//
// 2026-08-14 实测：剥注释这件事这个仓库已经做对过两次（src/core 的纯度扫描、
// workflow 的 YAML 扫描），但**没有传染到「读 main.js / preload / index.html
// 找关键词」这一类**。同一个形状第三次出现，而这次一口气有四条断言中招。
//
// 反过来那一侧也错：负向断言「不许出现 resizable: false」会被一句注释误报成红。
// 剥注释同时修好两侧。
// ---------------------------------------------------------------------------
const CODE_CACHE = new Map();
export function codeOf(rel) {
  if (CODE_CACHE.has(rel)) return CODE_CACHE.get(rel);
  const raw = readIfExists(rel);
  const ext = path.extname(rel).toLowerCase();
  const stripped = ext === '.html' ? stripHtmlComments(raw) : stripComments(raw);
  // 解析式断言先证明解析成功：剥成空字符串的话，后面每条「里面有没有 X」
  // 都会变成「没有」—— 那是假红，而假红会让人去改产品迁就尺子。
  expectTrue(stripped.trim().length > 0, `剥注释后 ${rel} 空了 —— 扫描器坏了`, `原文 ${raw.length} 字节`);
  expectTrue(stripped.length > raw.length * 0.3, `剥注释把 ${rel} 剥掉了太多`, `${raw.length} -> ${stripped.length} 字节`);
  CODE_CACHE.set(rel, stripped);
  return stripped;
}

// 让四条源码断言共用一个「关键词都在」的检查器，好让变异体自证证的是真货。
export function missingNeedles(code, needles) { return needles.filter(s => !code.includes(s)); }

// ---------------------------------------------------------------- 核心与夹具
let core = null;
export function getCore() {
  if (!core) core = require(path.join(ROOT, 'src', 'core', 'store.js'));
  return core;
}
let hist = null;
export function getHist() {
  if (!hist) hist = require(path.join(ROOT, 'src', 'core', 'history.js'));
  return hist;
}
let seedCounter = 0;
export function ctx(now) {
  seedCounter += 1;
  return { id: `fix-${seedCounter}`, now: now == null ? 1000 + seedCounter : now };
}
export function sample() {
  const c = getCore();
  let s = c.createState();
  s = c.addTodo(s, { title: '买牛奶', notes: '低脂', priority: 'high' }, { id: 'a', now: 100 });
  s = c.addTodo(s, { title: '写周报', notes: '周五之前', priority: 'normal' }, { id: 'b', now: 200 });
  s = c.addTodo(s, { title: 'Apple 派', notes: '', priority: 'low' }, { id: 'c', now: 300 });
  return s;
}

// ---------------------------------------------------------------- workflow 扫描器
// 每个函数都吃 text 参数：四条流水线共用同一套扫描器。以前只扫 verify.yml，
// 那样 release.yml 可以自由地长出一个没有 pipefail 的 tee 而没人看得见 ——
// 模板级的修复不会自己跳文件传染。
//
// 这张表是手写的，那就是漏继承的下一个藏身处：再加一份 workflow 而忘了登记，
// 它就完全在扫描范围之外。所以有一条断言让**目录本身成为期望**：实际存在的
// 文件集合必须等于这张表。实测有效 —— 加 mirror.yml 那次就是它当场抓住的。
export const WF = {
  verify: { path: '.github/workflows/verify.yml', text: null, bare: null },
  release: { path: '.github/workflows/release.yml', text: null, bare: null },
  screenshots: { path: '.github/workflows/screenshots.yml', text: null, bare: null },
  mirror: { path: '.github/workflows/mirror.yml', text: null, bare: null }
};
export function wf(key) {
  if (WF[key].text == null) WF[key].text = readIfExists(WF[key].path);
  return WF[key].text;
}

// YAML 版的剥注释。实测踩过：workflow 里一句说明注释里写着 stdout-<slug>.log，
// 于是「日志名集合等于 GATES」那条断言的实际集合里多出一个字面量 <slug>。
// **扫描器该先剥注释**，而不是反过来去改注释迁就扫描器（那是拿产品迁就尺子）。
//
// 引号感知，而且只把「行首或前面是空白」的 # 当注释起点 —— YAML 本身就是
// 这个规矩，URL 片段和 foo#bar 这类写法不该被切掉。
export function stripYamlComments(text) {
  return text.split('\n').map(line => {
    let out = '';
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quote) { out += c; if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; out += c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      out += c;
    }
    return out;
  }).join('\n');
}

// 剥掉注释的那份，给「集合相等」和「配置里有没有 X」类断言用。
// **剥完先自证**：剥成空字符串的话，后面每条集合断言都会免费通过（空集合等于空集合）。
export function bare(key) {
  if (WF[key].bare == null) {
    const stripped = stripYamlComments(wf(key));
    for (const need of ['jobs:', 'runs-on:', 'uses:']) {
      expectTrue(stripped.includes(need), `剥注释后 ${WF[key].path} 里连 ${need} 都没了`,
        `原文 ${wf(key).length} 字节 -> 剥后 ${stripped.length} 字节，扫描器坏了`);
    }
    const lines = stripped.split('\n').filter(l => l.trim() !== '').length;
    expectTrue(lines >= 20, `剥注释后 ${WF[key].path} 只剩 ${lines} 行非空内容，扫描器坏了`);
    WF[key].bare = stripped;
  }
  return WF[key].bare;
}

export function onBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.trimEnd() === 'on:');
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && /^\S/.test(l)) break;
    out.push(l);
  }
  return out;
}

// 注意：一个 job 之前的注释块会被算进**上一个** job 的 lines 里。所以任何
// 「这个 job 的文本里不该出现 X」的断言都必须去读具体那一行（needs / uses），
// 不能对整段做子串匹配。实测踩过：attest 之前那段说明注释里反复提到 attest，
// 于是「summary 的 needs 里不许有 attest」误报成环。
export function jobBlocks(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.trimEnd() === 'jobs:');
  if (start < 0) fail('workflow 里找不到顶层 jobs:', text.slice(0, 400));
  const jobs = new Map();
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { cur = { name: m[1], lines: [], at: i + 1 }; jobs.set(m[1], cur); continue; }
    if (line.trim() !== '' && /^\S/.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  for (const j of jobs.values()) j.text = j.lines.join('\n');
  return jobs;
}
export function needsOf(job) {
  const line = job.lines.find(l => l.trim().startsWith('needs:'));
  if (!line) return null;
  return line.replace(/.*\[/, '').replace(/\].*/, '').split(',').map(s => s.trim()).filter(Boolean);
}

// job 级 if 只出现在缩进 4 空格的位置。step 级的 if 缩进更深，不算。
export function jobLevelIfs(job) {
  return job.lines.filter(l => /^ {4}if:/.test(l)).map(l => l.trim());
}

export function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(l); continue; }
      const ind = l.length - l.replace(/^\s+/, '').length;
      if (ind <= indent) break;
      body.push(l);
    }
    blocks.push({ line: i + 1, body: body.join('\n') });
  }
  return blocks;
}

// 「某段脚本里必须出现 X」这类断言，必须先把那段切出来再找 —— 否则它退化成
// 「整个文件里存在 X」，而同一个文件里到处都有 `exit 1` 这种东西。
// 顺手剔掉 shell 注释行：run 块内部的 `# ...` 是文档，不是会执行的语句。
export function blocksContaining(text, needle) {
  return runBlocks(text)
    .filter(b => b.body.includes(needle))
    .map(b => ({
      line: b.line,
      code: b.body.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    }));
}

export function matrixSlugs(text) {
  return [...text.matchAll(/^\s*slug:\s*([A-Za-z0-9_-]+)\s*$/gm)].map(m => m[1]);
}

// ${{matrix.slug}} 一律写成不带空格的形式，这样 token 里不含空白，扫描器可以
// 用「非空白直到 .log」切出来。带空格的写法会把这条扫描悄悄变成零命中。
export function expandMatrix(text, token) {
  if (!token.includes('${{')) return [token];
  if (!token.includes('${{matrix.slug}}')) {
    fail('workflow 里出现了扫描器不认识的表达式',
      `token: ${token}（matrix.slug 必须写成不带空格的 \${{matrix.slug}}）`);
  }
  return matrixSlugs(text).map(s => token.split('${{matrix.slug}}').join(s));
}

// 只吃剥过注释的文本。说明注释里提到一个产物名或日志名是文档，不是配置。
export function tokenSet(key, re) {
  const text = bare(key);
  const out = new Set();
  for (const m of text.matchAll(re)) for (const v of expandMatrix(text, m[1])) out.add(v);
  return out;
}

export const RE_REPORT = /name:\s*(report-[^\s]+)/g;
export const RE_STDOUT = /stdout-([^\s`'"]+?)\.log/g;

// 从 AGENTS.md 拆到 docs/PITFALLS.md 的两节。它们的性质和别的不一样：随经验
// 单调增长的档案，而 AGENTS.md 是每次都要读进上下文的指令。混在一起会让
// 200 行上限反复顶格，然后有人去调宽它 —— 而调宽一条上限就是把断言改成装饰。
export const MOVED_SECTIONS = ['## 闸门红了先查夹具', '## 测不出来的'];
