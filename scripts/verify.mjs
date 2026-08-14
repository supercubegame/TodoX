#!/usr/bin/env node
// 快闸门：零依赖，几十秒出结果。断言纯核心的真实行为 + 一批静态不变量 +
// CI 配置自审（假绿、沉默通道、清单漂移、触发策略、回写钉住）。
//
// 每一条断言都问过同一个问题：如果这个功能完全没实现，这条会不会失败？
// 不会失败的就是空断言，不许留在这里。
//
// 第二个自问同样重要：**我在乎的属性里，有哪一个完全没有断言在看？**
// 覆盖缺口和空断言在报告上长得一模一样 —— 都是全绿。
//
// 第三个自问是 2026-08-14 复核 PITFALLS「测不出来的」时加上的：**那一节里
// 每一条「这个验不了」，我真的试过吗？** 那次抓到一条假结论（多屏坐标）。
// 手法是造变异体，不是读代码判断。
//
// 第四个自问同一天下午加的，它比前三个更便宜也更狠：**把这条断言要守的东西
// 故意改坏一次，它会红吗？** 那半天用它抓到五条装饰,一条在 workflow 扫描
// （令牌守卫），四条在「读源码找关键词」那一类（全都没剥注释）。
//
// **静态扫描类的断言最容易变成装饰**，而它们的坏法只有两种：
//   1. 子串在文件里存在，但不在该在的位置上（切段解决）
//   2. 子串只存在于注释里（剥注释解决）
// 两种都会让「这段里必须有 X」免费通过，而漏报只是一直绿着。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { Report, GATES, RELEASE_GATES, SHOTS_GATES, MIRROR_GATES } from './lib/report.mjs';
import { SHOTS, SHOT_DIR, MIN_BYTES } from './lib/shots.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));

// 哨兵密钥：每次运行随机生成。写死一个密钥形状的字面量会被下面那条扫描抓到，
// 而那时说谎的是夹具不是扫描。
const SENTINEL = 'todox-sentinel-' + crypto.randomBytes(16).toString('hex');
process.env.TODOX_SENTINEL_SECRET = SENTINEL;

// ---------------------------------------------------------------- 断言小工具
function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  throw e;
}
function expectEq(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label} 不符`, `期望: ${JSON.stringify(expected)}\n实际: ${JSON.stringify(actual)}`);
  }
}
function expectTrue(cond, label, evidence) { if (!cond) fail(label, evidence); }
function expectThrows(fn, code, label) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) fail(`${label}：本该抛错却没有`, '没有抛出任何异常 —— 这条断言如果一直不红，说明校验根本没生效');
  if (err.code !== code) fail(`${label}：错误码不对`, `期望 ${code}，实际 ${err.code}｜${err.message}`);
  return err;
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.getOwnPropertyNames(o)) deepFreeze(o[k]);
  }
  return o;
}
function readIfExists(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(`文件不存在: ${rel}`, `绝对路径: ${p}`);
  return fs.readFileSync(p, 'utf8');
}
function walk(dir, out = []) {
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
function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 密钥扫描只看文本文件。截图进仓库之后，二进制里凑巧出现一段密钥形状的字节
// 就会给出一条谁也看不懂的偶发红 —— 而它防的东西（把密钥藏进 PNG）不现实。
const BINARY_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.zip', '.asar', '.icns'];
function isTextFile(f) { return !BINARY_EXT.includes(path.extname(f).toLowerCase()); }

// 字符级扫描器，不用正则。用正则剥注释会在字符串里出现 // 或 /* 的时候整段吃掉
// 代码 —— 那不是「少抓几个」，是让整类输入凭空消失。
function stripComments(src) {
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
function stripHtmlComments(src) {
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
// 找关键词」这一类**。同一个形状第三次出现，而这次一口气有四条断言中招：
// 把那些关键词的真实调用全删掉、只在一句说明注释里提到它们，四条全都照样绿。
//
// 反过来那一侧也错：负向断言「不许出现 resizable: false」会被一句
// 「注意：绝对不要写成 resizable: false」的注释误报成红。剥注释同时修好两侧。
//
// **模板级的修复不会自己传染。** 修好一处之后要主动去找同一个形状的其它地方,
// 这已经是这条经验在本仓库的第四次应验（前三次：workflow 登记表、job 条件
// 名单、截图产物名对齐）。
// ---------------------------------------------------------------------------
const CODE_CACHE = new Map();
function codeOf(rel) {
  if (CODE_CACHE.has(rel)) return CODE_CACHE.get(rel);
  const raw = readIfExists(rel);
  const ext = path.extname(rel).toLowerCase();
  const stripped = ext === '.html' ? stripHtmlComments(raw) : stripComments(raw);
  // 解析式断言先证明解析成功：剥成空字符串的话，后面每条「里面有没有 X」
  // 都会变成「没有」—— 那是假红，而假红会让人去改产品迁就尺子。
  expectTrue(stripped.trim().length > 0, `剥注释后 ${rel} 空了 —— 扫描器坏了`,
    `原文 ${raw.length} 字节`);
  expectTrue(stripped.length > raw.length * 0.3, `剥注释把 ${rel} 剥掉了太多`,
    `${raw.length} -> ${stripped.length} 字节`);
  CODE_CACHE.set(rel, stripped);
  return stripped;
}

// 让四条源码断言共用一个「关键词都在」的检查器，好让变异体自证证的是真货。
function missingNeedles(code, needles) { return needles.filter(s => !code.includes(s)); }

// ---------------------------------------------------------------- 核心与夹具
let core = null;
function getCore() {
  if (!core) core = require(path.join(ROOT, 'src', 'core', 'store.js'));
  return core;
}
let hist = null;
function getHist() {
  if (!hist) hist = require(path.join(ROOT, 'src', 'core', 'history.js'));
  return hist;
}
let seedCounter = 0;
function ctx(now) { seedCounter += 1; return { id: `fix-${seedCounter}`, now: now == null ? 1000 + seedCounter : now }; }
function sample() {
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
// 模板级的修复不会自己跨文件传染。
//
// 这张表是手写的，那就是漏继承的下一个藏身处：再加一份 workflow 而忘了登记，
// 它就完全在扫描范围之外，可以自由长出假绿。所以下面有一条断言让**目录本身
// 成为期望**：实际存在的文件集合必须等于这张表。实测有效 —— 加 mirror.yml 那次
// 就是它当场抓住的。
const WF = {
  verify: { path: '.github/workflows/verify.yml', text: null, bare: null },
  release: { path: '.github/workflows/release.yml', text: null, bare: null },
  screenshots: { path: '.github/workflows/screenshots.yml', text: null, bare: null },
  mirror: { path: '.github/workflows/mirror.yml', text: null, bare: null }
};
function wf(key) {
  if (WF[key].text == null) WF[key].text = readIfExists(WF[key].path);
  return WF[key].text;
}
// 剥掉注释的那份，给「集合相等」和「配置里有没有 X」类断言用。
// **剥完先自证**：剥成空字符串的话，后面每条集合断言都会免费通过（空集合等于空集合）。
function bare(key) {
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

// YAML 版的剥注释。实测踩过：workflow 里一句说明注释里写着 stdout-<slug>.log，
// 于是「日志名集合等于 GATES」那条断言的实际集合里多出一个字面量 <slug>——
// 和纯度扫描第一次被自己的「别往里塞 Date.now()」注释抓到，是同一个形状。
// **扫描器该先剥注释**，而不是反过来去改注释迁就扫描器（那是拿产品迁就尺子）。
//
// 引号感知，而且只把「行首或前面是空白」的 # 当注释起点 —— YAML 本身就是
// 这个规矩，URL 片段和 foo#bar 这类写法不该被切掉。
function stripYamlComments(text) {
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

function onBlock(text) {
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
function jobBlocks(text) {
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
function needsOf(job) {
  const line = job.lines.find(l => l.trim().startsWith('needs:'));
  if (!line) return null;
  return line.replace(/.*\[/, '').replace(/\].*/, '').split(',').map(s => s.trim()).filter(Boolean);
}

// job 级 if 只出现在缩进 4 空格的位置。step 级的 if 缩进更深，不算。
function jobLevelIfs(job) {
  return job.lines.filter(l => /^ {4}if:/.test(l)).map(l => l.trim());
}

function runBlocks(text) {
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
// 2026-08-14 实测抓到的那条装饰就是这么来的（见 mirror 那条断言的注释）。
//
// 顺手剔掉 shell 注释行：run 块内部的 `# ...` 是文档，不是会执行的语句。
// 这和 stripYamlComments 是同一条道理，只是层级不同。
function blocksContaining(text, needle) {
  return runBlocks(text)
    .filter(b => b.body.includes(needle))
    .map(b => ({
      line: b.line,
      code: b.body.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    }));
}

function matrixSlugs(text) {
  return [...text.matchAll(/^\s*slug:\s*([A-Za-z0-9_-]+)\s*$/gm)].map(m => m[1]);
}
// ${{matrix.slug}} 一律写成不带空格的形式，这样 token 里不含空白，扫描器可以
// 用「非空白直到 .log」切出来。带空格的写法会把这条扫描悄悄变成零命中。
function expandMatrix(text, token) {
  if (!token.includes('${{')) return [token];
  if (!token.includes('${{matrix.slug}}')) {
    fail('workflow 里出现了扫描器不认识的表达式', `token: ${token}（matrix.slug 必须写成不带空格的 \${{matrix.slug}}）`);
  }
  return matrixSlugs(text).map(s => token.split('${{matrix.slug}}').join(s));
}
// 只吃剥过注释的文本。说明注释里提到一个产物名或日志名是文档，不是配置。
function tokenSet(key, re) {
  const text = bare(key);
  const out = new Set();
  for (const m of text.matchAll(re)) for (const v of expandMatrix(text, m[1])) out.add(v);
  return out;
}
const RE_REPORT = /name:\s*(report-[^\s]+)/g;
const RE_STDOUT = /stdout-([^\s`'"]+?)\.log/g;
// 回写那行的引用。@ 后面必须是 40 位十六进制，不许是分支或 tag —— 见那条断言。
const RE_WRITEBACK = /uses:\s*supercubegame\/ci-workflows\/\.github\/workflows\/report\.yml@([^\s]+)/g;

// 从 AGENTS.md 拆到 docs/PITFALLS.md 的两节。它们的性质和别的不一样：随经验
// 单调增长的档案，而 AGENTS.md 是每次都要读进上下文的指令。混在一起会让
// 200 行上限反复顶格，然后有人去调宽它 —— 而调宽一条上限就是把断言改成装饰。
const MOVED_SECTIONS = ['## 闸门红了先查夹具', '## 测不出来的'];

// ---------------------------------------------------------------- 检查清单
const report = new Report('快闸门（纯核心 + 静态断言）');

const CHECKS = [
  ['createState：默认设置与空列表', () => {
    const c = getCore();
    const s = c.createState();
    expectEq(s.todos, [], 'todos');
    expectEq(s.settings, { theme: 'light', fontScale: 100, confirmDelete: true, defaultPriority: 'normal', defaultSort: 'created' }, '默认设置');
    expectEq(s.bounds, { x: null, y: null, width: 960, height: 680 }, '默认窗口尺寸');
    return `version=${s.version}，5 项默认设置齐全`;
  }],

  ['新增：数量 +1 且字段完整', () => {
    const c = getCore();
    const s0 = c.createState();
    const s1 = c.addTodo(s0, { title: '买牛奶', notes: '低脂', priority: 'high' }, { id: 'x1', now: 777 });
    expectEq(s1.todos.length, 1, '数量');
    expectEq(s1.todos[0], { id: 'x1', title: '买牛奶', notes: '低脂', priority: 'high', done: false, createdAt: 777, updatedAt: 777, completedAt: null }, '新条目');
    return '1 条待办，9 个字段逐一比对通过';
  }],

  ['新增：空标题被拒（负向）', () => {
    const c = getCore();
    const s = c.createState();
    expectThrows(() => c.addTodo(s, { title: '   ' }, ctx()), 'EMPTY_TITLE', '全空白标题');
    expectThrows(() => c.addTodo(s, {}, ctx()), 'EMPTY_TITLE', '缺标题');
    return '空白与缺失两种写法都抛 EMPTY_TITLE';
  }],

  ['新增：标题去空白并截断到 200 字', () => {
    const c = getCore();
    const s = c.addTodo(c.createState(), { title: '  ' + 'x'.repeat(300) + '  ' }, { id: 'x', now: 1 });
    expectEq(s.todos[0].title.length, 200, '截断后长度');
    expectTrue(!s.todos[0].title.startsWith(' '), '标题仍带前导空白', JSON.stringify(s.todos[0].title.slice(0, 10)));
    return '300 字 -> 200 字，首尾空白已去掉';
  }],

  ['新增：不改动传入的 state（冻结原状态）', () => {
    const c = getCore();
    const s0 = deepFreeze(c.createState());
    const before = JSON.stringify(s0);
    const s1 = c.addTodo(s0, { title: '不许改我' }, { id: 'x', now: 1 });
    expectTrue(s1 !== s0, '返回了同一个对象引用', 'addTodo 必须返回新对象');
    expectEq(JSON.stringify(s0), before, '原状态');
    return '原状态被 deepFreeze，没抛 TypeError 说明没有就地写入';
  }],

  ['新增：重复 id 被拒（负向）', () => {
    const c = getCore();
    let s = c.addTodo(c.createState(), { title: '甲' }, { id: 'dup', now: 1 });
    expectThrows(() => c.addTodo(s, { title: '乙' }, { id: 'dup', now: 2 }), 'DUPLICATE_ID', '重复 id');
    return '同 id 第二次插入抛 DUPLICATE_ID';
  }],

  ['更新：字段生效且 updatedAt 用注入时钟', () => {
    const c = getCore();
    const s1 = c.updateTodo(sample(), 'b', { title: '写月报', priority: 'high' }, { now: 9999 });
    const t = s1.todos.find(x => x.id === 'b');
    expectEq(t.title, '写月报', '标题');
    expectEq(t.priority, 'high', '优先级');
    expectEq(t.updatedAt, 9999, 'updatedAt');
    expectEq(t.createdAt, 200, 'createdAt 不该被动');
    return 'updatedAt=9999 来自注入时钟，createdAt 原样保留';
  }],

  ['更新：未知 id 报 NOT_FOUND（负向）', () => {
    const c = getCore();
    expectThrows(() => c.updateTodo(sample(), '不存在', { title: 'x' }, { now: 1 }), 'NOT_FOUND', '未知 id');
    expectThrows(() => c.removeTodo(sample(), '不存在'), 'NOT_FOUND', '删除未知 id');
    return 'update / remove 两条路径都抛 NOT_FOUND';
  }],

  ['更新：未知字段报 BAD_FIELD（负向）', () => {
    const c = getCore();
    expectThrows(() => c.updateTodo(sample(), 'a', { id: '偷改 id' }, { now: 1 }), 'BAD_FIELD', '改 id');
    expectThrows(() => c.updateTodo(sample(), 'a', { createdAt: 0 }, { now: 1 }), 'BAD_FIELD', '改 createdAt');
    return '白名单之外的字段一律 BAD_FIELD';
  }],

  ['切换完成：done 翻转且 completedAt 同步', () => {
    const c = getCore();
    const on = c.toggleTodo(sample(), 'a', { now: 500 });
    const t1 = on.todos.find(x => x.id === 'a');
    expectEq([t1.done, t1.completedAt], [true, 500], '勾选后');
    const off = c.toggleTodo(on, 'a', { now: 600 });
    const t2 = off.todos.find(x => x.id === 'a');
    expectEq([t2.done, t2.completedAt], [false, null], '取消后');
    return 'done/completedAt 成对变化，取消后回到 null';
  }],

  ['删除：数量 -1 且该 id 不再出现（负向孪生）', () => {
    const c = getCore();
    const s = c.removeTodo(sample(), 'b');
    expectEq(s.todos.length, 2, '数量');
    expectEq(s.todos.filter(t => t.id === 'b').length, 0, '被删 id 的出现次数');
    expectEq(JSON.stringify(s).split('写周报').length - 1, 0, '被删标题在整个 state 里的出现次数');
    return '3 -> 2，且 id 与标题在序列化结果里都出现 0 次';
  }],

  ['删除：不影响其它条目', () => {
    const c = getCore();
    const s0 = sample();
    const s = c.removeTodo(s0, 'b');
    expectEq(s.todos.map(t => t.id), ['a', 'c'], '剩余顺序');
    expectEq(s.todos[0], s0.todos[0], '剩下的条目应逐字段不变');
    return '剩余两条顺序与内容都没动';
  }],

  ['清除已完成：只删 done 的', () => {
    const c = getCore();
    let s = c.toggleTodo(sample(), 'a', { now: 1 });
    s = c.toggleTodo(s, 'c', { now: 2 });
    const after = c.clearCompleted(s);
    expectEq(after.todos.map(t => t.id), ['b'], '剩余');
    const none = c.clearCompleted(sample());
    expectEq(none.todos.length, 3, '没有已完成时不该删任何东西');
    return '2 条已完成被清掉，未完成的 b 留下；空集合时零删除';
  }],

  ['查询：filter 三态各自命中', () => {
    const c = getCore();
    const s = c.toggleTodo(sample(), 'a', { now: 1 });
    expectEq(c.selectTodos(s, { filter: 'all' }).length, 3, 'all');
    expectEq(c.selectTodos(s, { filter: 'active' }).map(t => t.id), ['b', 'c'], 'active');
    expectEq(c.selectTodos(s, { filter: 'completed' }).map(t => t.id), ['a'], 'completed');
    return 'all=3 / active=2 / completed=1';
  }],

  ['查询：关键词匹配标题与备注且忽略大小写', () => {
    const c = getCore();
    const s = sample();
    expectEq(c.selectTodos(s, { query: '牛奶' }).map(t => t.id), ['a'], '标题命中');
    expectEq(c.selectTodos(s, { query: '周五' }).map(t => t.id), ['b'], '备注命中');
    expectEq(c.selectTodos(s, { query: 'apple' }).map(t => t.id), ['c'], '小写命中大写标题');
    expectEq(c.selectTodos(s, { query: '  APPLE  ' }).map(t => t.id), ['c'], '大写 + 空白');
    return '标题/备注/大小写/首尾空白 四种情况都命中';
  }],

  ['查询：不存在的关键词返回 0 条（负向孪生）', () => {
    const c = getCore();
    expectEq(c.selectTodos(sample(), { query: '这个词绝对不存在zzz' }).length, 0, '命中数');
    return '不匹配时确实是 0 条，不是「全部返回」';
  }],

  ['排序：三种排序确定且可复现', () => {
    const c = getCore();
    const s = sample();
    expectEq(c.selectTodos(s, { sort: 'created' }).map(t => t.id), ['a', 'b', 'c'], 'created');
    expectEq(c.selectTodos(s, { sort: 'priority' }).map(t => t.id), ['a', 'b', 'c'], 'priority(high>normal>low)');
    const byTitle = c.selectTodos(s, { sort: 'title' }).map(t => t.id);
    expectEq(byTitle, c.selectTodos(s, { sort: 'title' }).map(t => t.id), 'title 两次结果');
    expectEq(byTitle[0], 'c', 'title 排序里 ASCII 开头的应排最前');
    return `created/priority/title 三种都确定，title -> ${byTitle.join(',')}`;
  }],

  ['设置：合法补丁生效且未指定项不变', () => {
    const c = getCore();
    const s = c.setSettings(c.createState(), { theme: 'dark' });
    expectEq(s.settings.theme, 'dark', 'theme');
    expectEq(s.settings.fontScale, 100, '未指定的 fontScale');
    expectEq(s.settings.confirmDelete, true, '未指定的 confirmDelete');
    return '只改 theme，其余 4 项原样';
  }],

  ['设置：未知键与非法枚举被拒（负向）', () => {
    const c = getCore();
    const s = c.createState();
    expectThrows(() => c.setSettings(s, { 我不存在: 1 }), 'BAD_FIELD', '未知键');
    expectThrows(() => c.setSettings(s, { theme: 'rainbow' }), 'BAD_THEME', '非法主题');
    expectThrows(() => c.setSettings(s, { defaultSort: '随便' }), 'BAD_SORT', '非法排序');
    return '未知键 / 非法主题 / 非法排序 三条都抛错';
  }],

  ['设置：fontScale 两端都真的被夹住（上下限可达）', () => {
    const c = getCore();
    const s = c.createState();
    expectEq(c.setSettings(s, { fontScale: 5 }).settings.fontScale, 80, '下限');
    expectEq(c.setSettings(s, { fontScale: 9999 }).settings.fontScale, 160, '上限');
    expectEq(c.setSettings(s, { fontScale: 133.4 }).settings.fontScale, 133, '四舍五入');
    expectThrows(() => c.setSettings(s, { fontScale: 'big' }), 'BAD_FONT_SCALE', '非数字');
    return '80/160 两个边界都被触发过，不是装饰';
  }],

  ['窗口：clampBounds 不低于最小尺寸、不超工作区', () => {
    const c = getCore();
    const area = { x: 0, y: 0, width: 1280, height: 1000 };
    expectEq(c.clampBounds({ width: 10, height: 10 }, area), { x: null, y: null, width: 480, height: 360 }, '过小');
    expectEq(c.clampBounds({ width: 99999, height: 99999 }, area), { x: null, y: null, width: 1280, height: 1000 }, '过大');
    return '最小 480x360 与工作区上限两条边界都可达';
  }],

  ['窗口：离屏坐标被拉回工作区（负向）', () => {
    const c = getCore();
    const area = { x: 0, y: 0, width: 1280, height: 1000 };
    expectEq(c.clampBounds({ x: -500, y: -500, width: 800, height: 600 }, area), { x: 0, y: 0, width: 800, height: 600 }, '左上越界');
    expectEq(c.clampBounds({ x: 5000, y: 5000, width: 800, height: 600 }, area), { x: 480, y: 400, width: 800, height: 600 }, '右下越界');
    return '(-500,-500) -> (0,0)，(5000,5000) -> (480,400)';
  }],

  // 这条是 2026-08-14 逐条复核 PITFALLS「测不出来的」时补上的，而且它补的是
  // 那一节里**一句写错的话**：「clampBounds 的多屏分支在 CI 里根本走不到」。
  //
  // 那句话把两件事混成了一件。端到端闸门走不到是真的 —— xvfb 里没有窗口管理器，
  // 也只有一个屏。但 **clampBounds 是纯函数，area 只是个普通参数**：快闸门想喂
  // 什么工作区就喂什么。把「端到端测不了」写成「测不了」，代价是那个方向被
  // 永久豁免了监督 —— 没人会去核对一件已经宣布无法核对的事。
  //
  // 代价是实测出来的，不是推的：上面那两条断言喂的 area 原点全是 (0,0)，于是把
  // 函数里的 a.x / a.y 整个换成字面量 0，**58 条断言一条都不会红**。
  ['窗口：非零原点的工作区也夹得对（副屏 / 负坐标 / 任务栏偏移），含变异体自证', () => {
    const c = getCore();
    const RIGHT = { x: 1920, y: 0, width: 1920, height: 1080 };
    const cases = [
      ['右侧副屏：主屏坐标被拉进副屏', { x: 100, y: 100, width: 800, height: 600 }, RIGHT, { x: 1920, y: 100, width: 800, height: 600 }],
      ['副屏内的坐标原样保留', { x: 2000, y: 200, width: 800, height: 600 }, RIGHT, { x: 2000, y: 200, width: 800, height: 600 }],
      ['左侧副屏：原点是负数', { x: 500, y: 0, width: 800, height: 600 }, { x: -1920, y: 0, width: 1920, height: 1080 }, { x: -800, y: 0, width: 800, height: 600 }],
      ['顶部任务栏的 y 偏移', { x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 48, width: 1920, height: 1032 }, { x: 0, y: 48, width: 800, height: 600 }]
    ];
    for (const [name, bounds, area, want] of cases) expectEq(c.clampBounds(bounds, area), want, name);

    // 变异体：只把工作区原点当成 0，其它逻辑逐字照抄。
    function originBlind(b, a) {
      const w = Math.max(480, Math.min(Math.round(b.width), a.width));
      const h = Math.max(360, Math.min(Math.round(b.height), a.height));
      return {
        x: Math.max(0, Math.min(Math.round(b.x), a.width - w)),
        y: Math.max(0, Math.min(Math.round(b.y), a.height - h)),
        width: w, height: h
      };
    }
    // 先证明它是个**像样的**变异体：在零原点的工作区上它和真货完全一致。
    // 这一步不做的话，这条自证就退化成「随便造个坏函数当然会红」。
    const zero = { x: 0, y: 0, width: 1280, height: 1000 };
    for (const b of [{ x: -500, y: -500, width: 800, height: 600 }, { x: 5000, y: 5000, width: 800, height: 600 }]) {
      expectEq(originBlind(b, zero), c.clampBounds(b, zero),
        '变异体在 (0,0) 工作区上应与真货一致 —— 那正是它藏得住的原因');
    }
    const survived = cases
      .filter(([, b, a]) => isDeepStrictEqual(originBlind(b, a), c.clampBounds(b, a)))
      .map(([n]) => n);
    expectEq(survived, [], '「把工作区原点当成 0」的变异体活下来的输入');

    return `${cases.length} 组非零原点输入全部夹对；变异体在 (0,0) 工作区上与真货一致（所以上面两条放它过去），` +
      `在这 ${cases.length} 组上全部被抓住`;
  }],

  ['存档：序列化往返深度相等且不标 recovered', () => {
    const c = getCore();
    const s = c.setSettings(sample(), { theme: 'dark', fontScale: 120 });
    const back = c.deserialize(c.serialize(s));
    expectEq(back.recovered, false, 'recovered');
    expectEq(back.issues, [], 'issues');
    expectEq(back.state, s, '往返后的 state');
    return '一份健康存档往返后逐字段相等，且没有误报 recovered';
  }],

  ['存档：损坏的 JSON 不抛异常但明确标记 recovered', () => {
    const c = getCore();
    for (const bad of ['{ 这不是 json', '', '[]', 'null', '"字符串"']) {
      const r = c.deserialize(bad);
      expectEq(r.recovered, true, `recovered(${JSON.stringify(bad).slice(0, 20)})`);
      expectTrue(r.issues.length > 0, '标了 recovered 却没给原因', JSON.stringify(r));
      expectEq(r.state.todos, [], '损坏时应回到空列表');
    }
    return '5 种坏输入都不抛异常，全部 recovered=true 且带原因（不能读起来像干净的一遍）';
  }],

  ['存档：残缺条目被丢弃且逐条记 issue', () => {
    const c = getCore();
    const raw = JSON.stringify({
      version: 1,
      todos: [
        { id: 'ok', title: '留下我', createdAt: 1, updatedAt: 1, priority: 'low', done: false, completedAt: null, notes: '' },
        { title: '没有 id' },
        { id: 'empty', title: '   ' },
        { id: 'ok', title: '重复 id' },
        '我不是对象'
      ],
      settings: { theme: '紫色', fontScale: 100, confirmDelete: true, defaultPriority: 'normal', defaultSort: 'created' },
      bounds: { x: null, y: null, width: 960, height: 680 }
    });
    const r = c.deserialize(raw);
    expectEq(r.state.todos.map(t => t.id), ['ok'], '存活条目');
    expectEq(r.recovered, true, 'recovered');
    expectTrue(r.issues.length >= 5, 'issue 条数少于被丢弃的数量', JSON.stringify(r.issues, null, 2));
    expectEq(r.state.settings.theme, 'light', '非法主题应回默认');
    return `丢弃 4 条 + 主题回默认，共记录 ${r.issues.length} 条 issue`;
  }],

  // ------------------------------------------------------------ 撤销 / 重做
  ['历史：初始为空，记录一次后深度 1（摘要正确）', () => {
    const h = getHist();
    const empty = h.createHistory();
    expectEq(h.summary(empty), { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0, limit: h.HISTORY_LIMIT }, '空历史的摘要');
    const after = h.record(empty, sample());
    expectEq(h.summary(after), { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, limit: h.HISTORY_LIMIT }, '记录一次后的摘要');
    expectEq(after.future, [], '记录之后的 future');
    return `上限 ${h.HISTORY_LIMIT}；空历史 canUndo=false，记录一次后 canUndo=true 且 canRedo 仍为 false`;
  }],

  ['历史：撤销回到上一状态，重做再回来，且不改动入参', () => {
    const c = getCore();
    const h = getHist();
    const s0 = sample();
    const s1 = c.removeTodo(s0, 'b');
    const h1 = deepFreeze(h.record(h.createHistory(), s0));
    const frozenBefore = JSON.stringify(h1);

    const back = h.undo(h1, s1);
    expectEq(back.state, s0, '撤销后的状态');
    expectEq(back.history.past, [], '撤销后的 past');
    expectEq(back.history.future.length, 1, '撤销后的 future 深度');

    const fwd = h.redo(back.history, back.state);
    expectEq(fwd.state, s1, '重做后的状态');
    expectEq(fwd.history.future, [], '重做后的 future');
    expectEq(fwd.history.past.length, 1, '重做后的 past 深度');

    expectEq(JSON.stringify(h1), frozenBefore, '原历史');
    return '3 条 -> 删 1 条 -> 撤销回 3 条 -> 重做回 2 条，原历史逐字节未变';
  }],

  ['历史：空历史撤销与无重做项时重做各自抛错（负向）', () => {
    const h = getHist();
    const s = sample();
    expectThrows(() => h.undo(h.createHistory(), s), 'NOTHING_TO_UNDO', '空历史撤销');
    expectThrows(() => h.redo(h.createHistory(), s), 'NOTHING_TO_REDO', '空历史重做');
    const recorded = h.record(h.createHistory(), s);
    expectThrows(() => h.redo(recorded, s), 'NOTHING_TO_REDO', '只记录过就重做');
    return '三种走不通的路径都抛对应错误码，而不是静默返回原状态';
  }],

  ['历史：新改动清空重做链（负向孪生）', () => {
    const c = getCore();
    const h = getHist();
    const s0 = sample();
    const s1 = c.removeTodo(s0, 'b');
    const back = h.undo(h.record(h.createHistory(), s0), s1);
    expectEq(h.summary(back.history).canRedo, true, '撤销之后应该可以重做');
    const s2 = c.removeTodo(back.state, 'c');
    const branched = h.record(back.history, back.state);
    expectEq(h.summary(branched).canRedo, false, '新改动之后还能重做');
    expectThrows(() => h.redo(branched, s2), 'NOTHING_TO_REDO', '新分支之后重做');
    return '撤销后 canRedo=true；再改一次之后 canRedo=false 且重做抛错';
  }],

  ['历史：上限真的可达，最老那份被丢掉（不是装饰）', () => {
    const c = getCore();
    const h = getHist();
    const limit = h.HISTORY_LIMIT;
    let s = c.createState();
    let history = h.createHistory();
    const first = s;
    for (let i = 0; i < limit + 1; i += 1) {
      history = h.record(history, s);
      s = c.addTodo(s, { title: `第 ${i} 条` }, { id: `h${i}`, now: i });
    }
    expectEq(history.past.length, limit, `推 ${limit + 1} 次之后的 past 深度`);
    expectEq(history.past[0].todos.length, 1, '栈底状态的待办数');
    expectEq(history.past.filter(x => x === first).length, 0, '最初那份状态在栈里的出现次数');
    return `上限 ${limit}：推 ${limit + 1} 次后深度恰好 ${limit}，最初那份已被挤出（栈底变成有 1 条的状态）`;
  }],

  // 这条的后半段（主进程 / preload / 界面三处都接上了）原来在**没剥注释**的
  // 原文上找关键词。2026-08-14 实测：把那三处的真实代码全删掉、只在注释里
  // 提到它们，这条照样绿。现在走 codeOf()，并带一个变异体自证。
  ['历史：不进存档，且主进程与界面都真的接上了（读可执行代码，含变异体自证）', () => {
    const c = getCore();
    const h = getHist();
    const s = sample();
    const raw = c.serialize(s);
    expectEq(JSON.parse(raw).history, undefined, '存档里的 history 字段');
    expectEq(Object.keys(JSON.parse(raw)).sort(), ['bounds', 'settings', 'todos', 'version'], '存档的顶层字段');
    expectEq(c.deserialize(raw).state.history, undefined, '读回来的 state 里的 history 字段');

    // 光有核心不够：主进程、preload、界面三处都要真的接上，否则功能对用户
    // 不存在，而上面那几条照样全绿 —— 那是覆盖缺口。
    const mainNeedles = ["ipcMain.handle('history:undo'", "ipcMain.handle('history:redo'", 'hist.record'];
    const mainCode = codeOf('src/main/main.js');
    expectEq(missingNeedles(mainCode, mainNeedles), [], 'main.js 里缺的接线（只看可执行代码）');
    const preCode = codeOf('src/preload/preload.js');
    expectEq(missingNeedles(preCode, ['history:undo', 'history:redo']), [], 'preload 里缺的暴露');
    const htmlCode = codeOf('src/renderer/index.html');
    expectEq(missingNeedles(htmlCode, ['data-testid="undo"', 'data-testid="redo"']), [], '界面上缺的按钮');
    expectEq(h.summary(h.createHistory()).undoDepth, 0, '摘要的初始深度');

    // 自证：把那条 IPC 注册换成一句 TODO 注释。剥注释之后必须判红,
    // 而在**没剥注释**的原文上它会活下来，那正是这条断言之前的样子。
    const tampered = readIfExists('src/main/main.js')
      .replace("ipcMain.handle('history:undo'", "// TODO 接回来：ipcMain.handle('history:undo'");
    expectTrue(tampered !== readIfExists('src/main/main.js'), '构造变异体时没替换到任何东西 —— 夹具坏了');
    expectTrue(missingNeedles(tampered, mainNeedles).length === 0,
      '在没剥注释的原文上，被注释掉的 IPC 应该仍然「命中」—— 这正是旧版为什么是装饰');
    expectTrue(missingNeedles(stripComments(tampered), mainNeedles).length >= 1,
      '剥注释之后仍然没判红 —— 那这条还是装饰');

    return '存档顶层只有 4 个字段（无 history）；主进程 IPC、preload、界面按钮三处都在**可执行代码**里' +
      '（变异体：把 IPC 注册改成注释,不剥注释时活下来，剥注释后被抓住）';
  }],

  ['纯度：src/core 不出现 Date.now / Math.random / fs / process / DOM', () => {
    const dir = path.join(ROOT, 'src', 'core');
    const files = walk(dir);
    expectTrue(files.length > 0, 'src/core 下一个文件都没有', `目录: ${dir}`);
    const banned = ['Date.now', 'new Date', 'Math.random', "require('fs')", 'require("fs")', 'process.', 'window.', 'document.', 'localStorage', 'fetch('];
    const hits = [];
    let scanned = 0;
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      const raw = fs.readFileSync(f, 'utf8');
      // 只扫会执行的代码。注释里写「别往里塞 Date.now()」是文档，不是违规 ——
      // 上一版没剥注释，第一次跑就被自己的说明文字抓了，根因在夹具不在产品。
      const code = stripComments(raw);
      expectTrue(code.includes('module.exports'), `剥注释后 ${rel} 里连 module.exports 都没了`, `原文 ${raw.length} 字节 -> 剥后 ${code.length} 字节，扫描器坏了`);
      expectTrue(code.length > raw.length * 0.4, `剥注释把 ${rel} 剥掉了太多`, `${raw.length} -> ${code.length} 字节`);
      scanned += code.length;
      for (const b of banned) if (code.includes(b)) hits.push(`${rel} 含 ${b}`);
    }
    expectEq(hits, [], '核心里的不纯用法');
    return `${files.length} 个核心文件、${scanned} 字节可执行代码，10 类不纯用法全部 0 命中`;
  }],

  ['纯度：同样输入连续两次调用结果深度相等', () => {
    const c = getCore();
    const h = getHist();
    const s = deepFreeze(sample());
    const a = c.selectTodos(s, { filter: 'all', sort: 'title', query: '' });
    const b = c.selectTodos(s, { filter: 'all', sort: 'title', query: '' });
    expectEq(a, b, '两次查询');
    expectEq(c.serialize(s), c.serialize(s), '两次序列化');
    expectEq(c.counts(s), { total: 3, active: 3, completed: 0 }, '计数');
    expectEq(h.record(h.createHistory(), s), h.record(h.createHistory(), s), '两次记录');
    return '查询、序列化、记录历史各跑两次，结果逐字节一致';
  }],

  // 这条原来在没剥注释的原文上找那四个关键词。实测：把 clampBounds / setBounds /
  // minWidth / minHeight 的真实调用全删掉、只写一句「原来这里会 clampBounds +
  // setBounds」的注释，它照样绿。
  //
  // 负向那侧同时也是错的：一句「注意：绝对不要写成 resizable: false」的注释会让
  // 它**误报成红**。剥注释一次修好两侧,这就是为什么剥注释要做在扫描器里，
  // 而不是靠「别在注释里提这些词」的约定（拿产品迁就尺子）。
  ['主进程：窗口可调整大小且用 clampBounds 恢复（读可执行代码，含变异体自证）', () => {
    const needles = ['minWidth', 'minHeight', 'clampBounds', 'setBounds'];
    const code = codeOf('src/main/main.js');
    expectEq(missingNeedles(code, needles), [], 'main.js 里缺的窗口关键词（只看可执行代码）');
    // 负向：真的把窗口设成不可调整大小要红,而注释里提到这串字不算。
    expectTrue(!code.includes('resizable: false'), 'main.js 把窗口设成了不可调整大小',
      '需求要求窗口大小可以随意调节。注意这条只看可执行代码 —— 注释里提到这串字不算违规。');
    expectTrue(code.includes('resizable: true'), 'main.js 里找不到 resizable: true',
      '光断言「没有 false」是空断言：整段配置被删掉也会通过。正向那侧必须也在。');

    // 自证一：把四个关键词的真实调用注释掉，剥注释后必须判红。
    const raw = readIfExists('src/main/main.js');
    const blinded = raw
      .replace('core.clampBounds(state.bounds, workArea())', '/* core.clampBounds(...) */ state.bounds')
      .replace('minWidth: core.MIN_WIDTH', '/* minWidth: core.MIN_WIDTH */')
      .replace('core.setBounds(state, win.getBounds(), workArea())', '/* core.setBounds(...) */ state');
    expectTrue(blinded !== raw, '构造变异体时没替换到任何东西 —— 夹具坏了，不是产品对了');
    expectTrue(missingNeedles(raw, needles).length === 0, '真货应该四个都命中');
    expectTrue(missingNeedles(stripComments(blinded), needles).length >= 1,
      '把真实调用注释掉之后仍然没判红 —— 那这条还是装饰',
      '这正是旧版的行为：它在没剥注释的原文上找关键词，而注释里那几个词照样命中。');

    // 自证二：负向那侧不许被注释误报。
    const commented = raw.replace('    resizable: true,', '    // 别写成 resizable: false\n    resizable: true,');
    expectTrue(commented !== raw, '构造注释变异体时没替换到任何东西 —— 夹具坏了');
    expectTrue(!stripComments(commented).includes('resizable: false'),
      '注释里提到 resizable: false 被误判成违规 —— 剥注释没起作用');
    expectTrue(raw.replace('resizable: true', 'resizable: false').includes('resizable: false'),
      '真的改成 false 之后应该命中 —— 否则负向那侧是空的');

    return `${needles.length} 个窗口关键词都在可执行代码里，resizable: true 在、false 不在；` +
      '两个变异体都被抓住（注释掉真实调用 / 注释里提到 false 不误报）';
  }],

  ['主进程：contextIsolation / nodeIntegration / preload 安全不变量（读可执行代码，含变异体自证）', () => {
    const needles = ['contextIsolation: true', 'nodeIntegration: false', 'preload:'];
    const code = codeOf('src/main/main.js');
    expectEq(missingNeedles(code, needles), [], '缺的安全不变量（只看可执行代码）');
    const preCode = codeOf('src/preload/preload.js');
    expectTrue(preCode.includes('contextBridge'), 'preload 没走 contextBridge（只看可执行代码）',
      preCode.slice(0, 300));

    // 自证：把三条安全设置注掉,这是调试时最常见的动作，也是这条断言唯一
    // 要防的那件事。剥注释后必须判红；在原文上它会活下来（旧版的行为）。
    const raw = readIfExists('src/main/main.js');
    const unsafe = raw
      .replace('      contextIsolation: true,', '      // 先注掉调试：contextIsolation: true,')
      .replace('      nodeIntegration: false,', '      // 先注掉调试：nodeIntegration: false,');
    expectTrue(unsafe !== raw, '构造变异体时没替换到任何东西 —— 夹具坏了');
    expectTrue(missingNeedles(unsafe, needles).length === 0,
      '在没剥注释的原文上，被注掉的安全设置应该仍然「命中」—— 这正是旧版为什么是装饰');
    expectTrue(missingNeedles(stripComments(unsafe), needles).length >= 2,
      '注掉两条安全设置之后没判红 —— 那这条还是装饰');

    // preload 那侧同样自证：改成直接挂 window，contextBridge 只剩注释。
    const preRaw = readIfExists('src/preload/preload.js');
    const leaky = stripComments(preRaw).split('contextBridge').join('window.__x');
    expectTrue(!leaky.includes('contextBridge'), '构造 preload 变异体失败 —— 夹具坏了');

    return '三条安全不变量 + preload 走 contextBridge，全部在**可执行代码**里；' +
      '变异体（把 contextIsolation / nodeIntegration 注掉）不剥注释时活下来，剥注释后被抓住';
  }],

  ['打包：win / mac / linux 三平台 target 齐全', () => {
    const pkg = JSON.parse(readIfExists('package.json'));
    const b = pkg.build || {};
    for (const plat of ['win', 'mac', 'linux']) {
      const t = b[plat] && b[plat].target;
      expectTrue(Array.isArray(t) && t.length > 0, `build.${plat}.target 缺失或为空`, JSON.stringify(b, null, 2));
    }
    expectTrue(Boolean(b.appId), '缺少 appId');
    expectEq(pkg.main, 'src/main/main.js', 'main 入口');
    return `win=${b.win.target.join('/')}｜mac=${b.mac.target.join('/')}｜linux=${b.linux.target.join('/')}`;
  }],

  ['打包：.deb 的 maintainer 存在且是邮箱形状', () => {
    const pkg = JSON.parse(readIfExists('package.json'));
    const linux = (pkg.build && pkg.build.linux) || {};
    const targets = (linux.target || []).map(t => String(t).toLowerCase());
    expectTrue(targets.includes('deb'), 'linux.target 里没有 deb', JSON.stringify(linux, null, 2));
    const author = pkg.author;
    const email = author && typeof author === 'object' ? author.email : null;
    const maintainer = linux.maintainer || null;
    expectTrue(
      (typeof email === 'string' && email.includes('@')) || (typeof maintainer === 'string' && maintainer.includes('@')),
      'deb 目标缺少 maintainer',
      `author=${JSON.stringify(author)}\nlinux.maintainer=${JSON.stringify(maintainer)}\n` +
      "electron-builder 会报 Please specify author 'email' in the application package.json，" +
      '而 AppImage 那一半照样成功 —— 所以症状是「Linux 只出了 1 个产物」，不是「构建全挂」。'
    );
    return `deb 在 target 里，maintainer=${maintainer || email}`;
  }],

  ['文档：AGENTS.md ≤ 200 行，两节已挪进 PITFALLS 且没有留副本', () => {
    const agents = readIfExists('AGENTS.md');
    const n = agents.split('\n').length;
    expectTrue(n <= 200, `AGENTS.md ${n} 行，超过 200 行上限`,
      '写长了模型会开始忽略里面的指令。这条上限只有断言守得住，写在文件里没用。\n' +
      '正确反应是压措辞或者把增长最快的那节挪去 docs/PITFALLS.md,**不是调宽上限**。');
    const pit = readIfExists('docs/PITFALLS.md');
    const pitLines = pit.split('\n').length;
    expectTrue(pitLines >= 40, `docs/PITFALLS.md 只有 ${pitLines} 行，像是没真的搬过去`, pit.slice(0, 300));
    expectTrue(agents.includes('docs/PITFALLS.md'), 'AGENTS.md 里没有引用 docs/PITFALLS.md',
      '拆出去而不留指路牌，等于把那份档案藏起来了。');
    for (const h of MOVED_SECTIONS) {
      expectTrue(pit.includes(h), `docs/PITFALLS.md 里找不到「${h}」`, '这节应该被挪过去了');
      expectTrue(!agents.includes(h), `AGENTS.md 里还留着「${h}」`,
        '两处各留一份会各自长歪，而没有任何断言看得见 —— 这条负向就是为这件事写的。');
    }
    return `AGENTS.md ${n} / 200 行（余 ${200 - n}）｜PITFALLS ${pitLines} 行，${MOVED_SECTIONS.length} 节正反两侧都对`;
  }],

  ['文档：AGENTS.md 与 CLAUDE.md 逐字节相同', () => {
    const a = fs.readFileSync(path.join(ROOT, 'AGENTS.md'));
    const b = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'));
    expectTrue(a.equals(b), '两份规矩文件已经分叉', `AGENTS.md ${a.length} 字节 / CLAUDE.md ${b.length} 字节`);
    return `同一份内容，${a.length} 字节`;
  }],

  ['文档：README 引用的截图、SHOTS 清单、磁盘文件三方相等', () => {
    const readme = readIfExists('README.md');
    const referenced = [...readme.matchAll(/docs\/screenshots\/([A-Za-z0-9._-]+\.png)/g)].map(m => m[1]);
    expectTrue(referenced.length > 0, 'README 里一张截图都没引用 —— 是扫描器坏了，不是 README 对了', readme.slice(0, 300));
    const want = SHOTS.map(s => `${s.slug}.png`).sort();
    expectEq([...new Set(referenced)].sort(), want, 'README 引用的截图集合');
    const dir = path.join(ROOT, SHOT_DIR);
    const onDisk = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.png')).sort();
    expectEq(onDisk, want, `${SHOT_DIR} 下实际存在的截图集合`);
    const sizes = want.map(n => ({ n, bytes: fs.statSync(path.join(dir, n)).size }));
    const empty = sizes.filter(s => s.bytes <= MIN_BYTES).map(s => `${s.n}: ${s.bytes} 字节`);
    expectEq(empty, [], `小于 ${MIN_BYTES} 字节的截图（像是空图）`);
    return `${want.length} 张图三方一致：${sizes.map(s => `${s.n} ${(s.bytes / 1024).toFixed(0)}KB`).join('，')}`;
  }],

  ['CI：.github/workflows 下每一份 workflow 都被扫描器登记（目录即期望）', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const actual = fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort();
    expectTrue(actual.length > 0, '一份 workflow 文件都没扫到 —— 是扫描器坏了，不是配置对了', `目录: ${dir}`);
    const registered = Object.values(WF).map(w => path.basename(w.path)).sort();
    expectEq(actual, registered, '已登记的 workflow 集合');
    for (const key of Object.keys(WF)) {
      expectTrue(wf(key).length > 0, `${WF[key].path} 是空文件`);
      bare(key);
    }
    const kept = Object.keys(WF).map(k => `${path.basename(WF[k].path)} ${wf(k).length}->${bare(k).length}`);
    return `${actual.length} 份 workflow 全部在扫描范围内，剥注释后都自证通过：${kept.join('，')}`;
  }],

  ['CI：所有 workflow 里出现 tee 的脚本块都设置了 pipefail', () => {
    let totalRun = 0;
    let totalTee = 0;
    const bad = [];
    for (const key of Object.keys(WF)) {
      const blocks = runBlocks(wf(key));
      expectTrue(blocks.length > 0, `${WF[key].path} 里一个 run: | 块都没扫到 —— 是扫描器坏了，不是配置对了`, wf(key).slice(0, 400));
      const tee = blocks.filter(b => b.body.includes('tee '));
      expectTrue(tee.length > 0, `${WF[key].path} 里没有任何 tee 块 —— 那报告缺失时评论里就没有日志尾巴了`);
      totalRun += blocks.length;
      totalTee += tee.length;
      for (const b of tee) if (!b.body.includes('pipefail')) bad.push(`${WF[key].path} 第 ${b.line} 行的 run 块`);
    }
    expectEq(bad, [], '缺 pipefail 的 tee 块');
    return `${Object.keys(WF).length} 份 workflow、${totalRun} 个 run 块，其中 ${totalTee} 个用了 tee，全部带 pipefail（否则闸门红了 job 照样绿）`;
  }],

  ['CI：回写 job 用共享 workflow、钉在 40 位 SHA、四份钉同一个、本地零 steps', () => {
    const bad = [];
    const pins = new Set();
    for (const key of Object.keys(WF)) {
      const jobs = jobBlocks(bare(key));
      const j = jobs.get('summary');
      expectTrue(Boolean(j), `${WF[key].path} 里没有 summary job —— 送不出结论的闸门等于没跑`, [...jobs.keys()].join(','));
      const refs = [...j.text.matchAll(RE_WRITEBACK)].map(m => m[1]);
      if (refs.length !== 1) {
        bad.push(`${WF[key].path} 引用共享回写 workflow 的次数是 ${refs.length}，应该恰好 1 次`);
        continue;
      }
      const ref = refs[0];
      if (!/^[0-9a-f]{40}$/.test(ref)) {
        bad.push(`${WF[key].path} 把回写钉在 ${ref} 上，不是 40 位 SHA（分支和 tag 都是可变引用）`);
      }
      pins.add(ref);
      if (j.lines.some(l => l.trim() === 'steps:')) bad.push(`${WF[key].path} 的 summary 自己长出了 steps`);
    }
    expectEq(bad, [], '回写 job 的问题');
    expectEq(pins.size, 1, '四份 workflow 钉住的 SHA 个数（多于一个说明只更新了一半）');
    return `${Object.keys(WF).length} 份 workflow 全部钉在 ${[...pins][0].slice(0, 7)}，本地零 steps`;
  }],

  ['CI：gates 引用真实的 needs.<job>.result 且与 needs 一致', () => {
    const summary = [];
    for (const key of Object.keys(WF)) {
      const jobs = jobBlocks(bare(key));
      const j = jobs.get('summary');
      const needs = needsOf(j);
      expectTrue(needs !== null, `${WF[key].path} 的 summary 没有 needs`, j.text.slice(0, 400));
      const gatesLine = j.lines.find(l => l.trim().startsWith('gates:'));
      expectTrue(Boolean(gatesLine), `${WF[key].path} 的 summary 没有 gates 输入`, j.text.slice(0, 400));
      const refs = [...gatesLine.matchAll(/needs\.([A-Za-z0-9_-]+)\.result/g)].map(m => m[1]);
      expectEq(refs.slice().sort(), needs.slice().sort(), `${WF[key].path} 的 gates 引用的 job 集合`);
      for (const n of needs) expectTrue(jobs.has(n), `${WF[key].path} 的 needs 里 ${n} 不是真实存在的 job`, [...jobs.keys()].join(','));
      expectTrue(!/"result"\s*:\s*"(success|failure)"/.test(gatesLine), `${WF[key].path} 的 gates 里写了硬编码的结果字面量`, gatesLine);
      summary.push(`${key}=[${needs.join(',')}]`);
    }
    return `${summary.join('｜')}，全部引用真实 result，没有硬编码`;
  }],

  ['CI：verify 上传的 report-* 产物集合与 GATES 一致', () => {
    const names = tokenSet('verify', RE_REPORT);
    const want = new Set(GATES.map(g => `report-${g.slug}`));
    expectEq([...names].sort(), [...want].sort(), '产物名集合');
    return `${names.size} 个产物名与 GATES 一一对应（扫的是剥掉注释的那份）`;
  }],

  ['CI：verify 的 stdout-<slug>.log 集合与 GATES 一致', () => {
    const slugs = tokenSet('verify', RE_STDOUT);
    const want = new Set(GATES.map(g => g.slug));
    expectEq([...slugs].sort(), [...want].sort(), 'stdout 日志 slug 集合');
    return `${slugs.size} 条日志与 GATES 一一对应，composer 不会去找一个没人产出的 slug`;
  }],

  ['CI：verify 的每个 job 要么无条件执行，要么显式 always()（枚举即期望）', () => {
    const jobs = jobBlocks(bare('verify'));
    expectTrue(jobs.size >= 6, 'verify.yml 的 job 数量少于预期 —— 是扫描器坏了，不是配置对了', [...jobs.keys()].join(','));
    const ALWAYS = ['summary', 'attest'];
    for (const n of ALWAYS) expectTrue(jobs.has(n), `verify.yml 里没有 ${n} job`, [...jobs.keys()].join(','));
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
  }],

  ['CI：verify 有回写送达核对 job，marker 两处一致且不占用报告命名空间', () => {
    const text = bare('verify');
    const jobs = jobBlocks(text);
    const j = jobs.get('attest');
    expectTrue(Boolean(j), 'verify.yml 里没有 attest job —— 回写坏掉时没有任何东西在喊', [...jobs.keys()].join(','));
    const needs = needsOf(j);
    expectTrue(needs !== null && needs.includes('summary'), 'attest 必须 needs summary —— 评论还没写就去找它，等的是时序不是真相', j.text.slice(0, 300));
    expectTrue(j.text.includes('scripts/attest-comment.mjs'), 'attest job 没有真的执行核对脚本', j.text.slice(0, 400));
    const summaryNeeds = needsOf(jobs.get('summary')) || [];
    expectTrue(!summaryNeeds.includes('attest'), 'summary 的 needs 里出现了 attest —— 那是个环', summaryNeeds.join(','));
    const markerLine = /marker:\s*'([^']+)'/.exec(jobs.get('summary').text);
    expectTrue(Boolean(markerLine), '扫不到 summary 的 marker —— 是扫描器坏了，不是配置对了', jobs.get('summary').text.slice(0, 400));
    const script = readIfExists('scripts/attest-comment.mjs');
    expectTrue(script.includes(`'${markerLine[1]}'`), 'attest 脚本里的 marker 与 workflow 不一致',
      `workflow: ${markerLine[1]}\n核对脚本里找不到这个字面量。两处必须逐字相同。`);
    expectTrue(!tokenSet('verify', RE_STDOUT).has('attest'), 'attest 的日志占用了 stdout-<slug>.log 命名空间（那个集合由 GATES 定义）');
    expectTrue(!tokenSet('verify', RE_REPORT).has('report-attest'), 'attest 的产物占用了 report-* 命名空间（同上）');
    expectTrue(j.text.includes('attest.log'), 'attest 没有把输出 tee 成日志 —— 失败时读不到原因');
    expectTrue(MANIFEST.attest > 0, 'manifest 里没有登记 attest 的条数', JSON.stringify(MANIFEST));
    return `attest needs [${needs.join(',')}]，执行 attest-comment.mjs（${MANIFEST.attest} 条核对），marker ${markerLine[1]} 两处一致，未占用 report-* / stdout-*`;
  }],

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
  }],

  ['密钥：哨兵在源码与报告里出现 0 次（负向）', () => {
    const files = walk(ROOT).filter(isTextFile);
    const hits = files.filter(f => {
      try { return fs.readFileSync(f, 'utf8').includes(SENTINEL); } catch { return false; }
    }).map(f => path.relative(ROOT, f));
    expectEq(hits, [], '哨兵泄漏的文件');
    const inReport = JSON.stringify(report.toJSON()).includes(SENTINEL);
    expectTrue(!inReport, '哨兵密钥泄漏进了报告本体', '报告会被原样贴到 PR 评论里');
    return `哨兵（每次运行随机生成）在 ${files.length} 个文本文件与报告 JSON 中出现 0 次`;
  }],

  ['密钥：仓库里没有密钥形状的字面量', () => {
    const patterns = [
      ['GitHub token', new RegExp(['gh', 'p_[A-Za-z0-9]{20,}'].join(''))],
      ['AWS key', new RegExp(['AK', 'IA[0-9A-Z]{16}'].join(''))],
      ['私钥块', new RegExp(['-----BEGIN', ' [A-Z ]*PRIVATE KEY-----'].join(''))],
      ['Slack token', new RegExp(['xox', '[abpr]-[A-Za-z0-9-]{12,}'].join(''))]
    ];
    const hits = [];
    let scanned = 0;
    for (const f of walk(ROOT).filter(isTextFile)) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      scanned += 1;
      for (const [name, re] of patterns) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
    }
    expectEq(hits, [], '密钥形状的字面量');
    return `${scanned} 个文本文件、4 类密钥形状全部 0 命中（模式由拼接构造，扫描不会抓到自己）`;
  }],

  ['自检：标题唯一 + 实际检查数等于清单数', () => {
    const titles = report.checks.map(c => c.title);
    const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
    expectEq(dup, [], '重复的检查标题');
    const actual = report.checks.length + 1;
    expectEq(actual, CHECKS.length, '本次实际执行的检查数');
    expectEq(CHECKS.length, MANIFEST.fast, 'scripts/manifest.json 里登记的条数');
    return `${actual} 条检查全部执行，等号断言（不是下限，下限会自己漂）`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

report.save(ARTIFACTS, 'fast');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
