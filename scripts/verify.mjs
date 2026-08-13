#!/usr/bin/env node
// 快闸门：零依赖，几十秒出结果。断言纯核心的真实行为 + 一批静态不变量 +
// CI 配置自审（假绿、沉默通道、清单漂移、触发策略、回写钉住）。
//
// 每一条断言都问过同一个问题：如果这个功能完全没实现，这条会不会失败？
// 不会失败的就是空断言，不许留在这里。
//
// 第二个自问同样重要：**我在乎的属性里，有哪一个完全没有断言在看？**
// 覆盖缺口和空断言在报告上长得一模一样 —— 都是全绿。
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
// 剥掉注释的那份，给「集合相等」类断言用。**剥完先自证**：剥成空字符串的话，
// 后面每条集合断言都会免费通过（空集合等于空集合）。
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
  // 纯核心让这个功能几乎白送：状态本来就不可变，撤销不需要「反向操作」，
  // 只要一个状态栈。下面六条每条都配了负向那侧。
  ['历史：初始为空，记录一次后深度 1（摘要正确）', () => {
    const h = getHist();
    const empty = h.createHistory();
    expectEq(h.summary(empty), { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0, limit: h.HISTORY_LIMIT }, '空历史的摘要');
    const after = h.record(empty, sample());
    expectEq(h.summary(after), { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, limit: h.HISTORY_LIMIT }, '记录一次后的摘要');
    // 负向：记录不该凭空造出可重做的东西。
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

    // 入参被 deepFreeze 过：没抛 TypeError 说明没有就地写入。
    expectEq(JSON.stringify(h1), frozenBefore, '原历史');
    return '3 条 -> 删 1 条 -> 撤销回 3 条 -> 重做回 2 条，原历史逐字节未变';
  }],

  ['历史：空历史撤销与无重做项时重做各自抛错（负向）', () => {
    const h = getHist();
    const s = sample();
    expectThrows(() => h.undo(h.createHistory(), s), 'NOTHING_TO_UNDO', '空历史撤销');
    expectThrows(() => h.redo(h.createHistory(), s), 'NOTHING_TO_REDO', '空历史重做');
    // 只记录过、没撤销过的时候，也不该能重做。
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
    // 撤销之后产生了新分支：原来那条重做链已经不可达，留着它会让用户
    // 重做出一个跟当前状态无关的东西。
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
    // 推 limit + 1 次，让上限真的被撞一次。一个默认参数下永远碰不到的边界，
    // 和空断言是同一个洞。
    for (let i = 0; i < limit + 1; i += 1) {
      history = h.record(history, s);
      s = c.addTodo(s, { title: `第 ${i} 条` }, { id: `h${i}`, now: i });
    }
    expectEq(history.past.length, limit, `推 ${limit + 1} 次之后的 past 深度`);
    // 最老那份（空列表）应该已经被挤掉了：现在栈底是「已经有 1 条」的状态。
    expectEq(history.past[0].todos.length, 1, '栈底状态的待办数');
    expectEq(history.past.filter(x => x === first).length, 0, '最初那份状态在栈里的出现次数');
    return `上限 ${limit}：推 ${limit + 1} 次后深度恰好 ${limit}，最初那份已被挤出（栈底变成有 1 条的状态）`;
  }],

  ['历史：不进存档，且主进程与界面都真的接上了', () => {
    const c = getCore();
    const h = getHist();
    // 存档里不许出现历史：撤销跨重启没有意义，而且历史里每一项都是一份完整
    // 状态，写进磁盘会让存档膨胀几十倍。
    const s = sample();
    const raw = c.serialize(s);
    expectEq(JSON.parse(raw).history, undefined, '存档里的 history 字段');
    expectEq(Object.keys(JSON.parse(raw)).sort(), ['bounds', 'settings', 'todos', 'version'], '存档的顶层字段');
    expectEq(c.deserialize(raw).state.history, undefined, '读回来的 state 里的 history 字段');
    // 光有核心不够：主进程、preload、界面三处都要真的接上，否则功能对用户
    // 不存在，而上面五条照样全绿 —— 那是覆盖缺口。
    const main = readIfExists('src/main/main.js');
    for (const need of ["ipcMain.handle('history:undo'", "ipcMain.handle('history:redo'", 'hist.record']) {
      expectTrue(main.includes(need), `main.js 里找不到 ${need}`, '核心实现了但没接上，等于对用户不存在');
    }
    const pre = readIfExists('src/preload/preload.js');
    expectTrue(pre.includes('history:undo') && pre.includes('history:redo'), 'preload 没暴露 undo/redo');
    const html = readIfExists('src/renderer/index.html');
    expectTrue(html.includes('data-testid="undo"') && html.includes('data-testid="redo"'), '界面上没有撤销/重做按钮');
    expectEq(h.summary(h.createHistory()).undoDepth, 0, '摘要的初始深度');
    return '存档顶层只有 4 个字段（无 history）；主进程 IPC、preload、界面按钮三处都在';
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
      // 解析式的断言要先证明解析成功：剥成空字符串的话下面每一条都会免费通过。
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
    // 历史那三个函数同样纯：同样输入必然同样输出。
    expectEq(h.record(h.createHistory(), s), h.record(h.createHistory(), s), '两次记录');
    return '查询、序列化、记录历史各跑两次，结果逐字节一致';
  }],

  ['主进程：窗口可调整大小且用 clampBounds 恢复', () => {
    const text = readIfExists('src/main/main.js');
    for (const need of ['minWidth', 'minHeight', 'clampBounds', 'setBounds']) {
      expectTrue(text.includes(need), `main.js 里找不到 ${need}`, '这条静态断言的行为孪生在端到端闸门里（isResizable / getMinimumSize / 真的 resize）');
    }
    expectTrue(!text.includes('resizable: false'), 'main.js 把窗口设成了不可调整大小', '需求要求窗口大小可以随意调节');
    return 'minWidth/minHeight/clampBounds/setBounds 齐全，没有 resizable:false';
  }],

  ['主进程：contextIsolation / nodeIntegration / preload 安全不变量', () => {
    const text = readIfExists('src/main/main.js');
    expectTrue(text.includes('contextIsolation: true'), '缺少 contextIsolation: true');
    expectTrue(text.includes('nodeIntegration: false'), '缺少 nodeIntegration: false');
    expectTrue(text.includes('preload:'), '没有挂 preload');
    const pre = readIfExists('src/preload/preload.js');
    expectTrue(pre.includes('contextBridge'), 'preload 没走 contextBridge', pre.slice(0, 300));
    return '三条安全不变量 + preload 走 contextBridge';
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

  // 这条是一次真实失败换来的：author 写成裸字符串时，AppImage 照样打出 102MB，
  // 只有 deb 挂在「Please specify author 'email'」上。那个失败要等三分钟构建
  // 才看得到，而它其实是一条几毫秒的静态不变量。
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

  ['文档：AGENTS.md 存在且不超过 200 行', () => {
    const text = readIfExists('AGENTS.md');
    const n = text.split('\n').length;
    expectTrue(n <= 200, `AGENTS.md ${n} 行，超过 200 行上限`, '写长了模型会开始忽略里面的指令。这条上限只有断言守得住，写在文件里没用。');
    return `${n} / 200 行`;
  }],

  ['文档：AGENTS.md 与 CLAUDE.md 逐字节相同', () => {
    const a = fs.readFileSync(path.join(ROOT, 'AGENTS.md'));
    const b = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'));
    expectTrue(a.equals(b), '两份规矩文件已经分叉', `AGENTS.md ${a.length} 字节 / CLAUDE.md ${b.length} 字节`);
    return `同一份内容，${a.length} 字节`;
  }],

  // README 里的破图不会让任何东西变红，只会让人以为项目没做完。所以三方对齐：
  // README 引用了什么、SHOTS 清单说该有什么、磁盘上实际有什么。
  // 负向那侧也在：多出一张没人引用的图同样红。
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

  // 这条是漏继承的解药。以前登记表是手写的两项，于是**新加的 workflow 文件完全
  // 在扫描范围之外**：它可以自由长出一个没有 pipefail 的 tee，而所有 run 依然
  // 全绿。手写清单永远追不上目录，所以让目录本身成为期望。
  // 实测有效：加 mirror.yml 那次就是它当场抓住的。
  ['CI：.github/workflows 下每一份 workflow 都被扫描器登记（目录即期望）', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const actual = fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort();
    expectTrue(actual.length > 0, '一份 workflow 文件都没扫到 —— 是扫描器坏了，不是配置对了', `目录: ${dir}`);
    const registered = Object.values(WF).map(w => path.basename(w.path)).sort();
    expectEq(actual, registered, '已登记的 workflow 集合');
    // 登记了但文件是空的也要红，否则 wf() 会在别的断言里抛一个看不懂的错。
    // 顺手把剥注释那份也建出来并自证一遍（bare 内部会断言剥完还剩真东西）。
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

  // 这条原来逐字核对 `report.yml@main`。**@main 是可变引用**：上游改一行就会
  // 悄悄改掉这四条流水线的行为，而回写坏掉的表现是「闸门全绿但没人看得到
  // 结论」—— 已知最安静的一种失效，实测发生过一次。
  //
  // 现在要求 40 位 SHA，并且**四份 workflow 钉的 SHA 集合大小必须为 1**：
  // 只更新一半比全钉 @main 更糟，两边行为会分叉而没有任何断言看得见。
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
      // 明确拒绝分支与 tag 形状的引用，而不只是「不等于 main」——
      // 后者会放过 @v1 / @latest 这类同样可变的写法。
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

  // 这条原来是「闸门 job 上一个 job 级 if 都不许有」，名单里手工排除了 summary。
  // 加 attest 的时候它会立刻误报 —— 和「手写清单追不上目录」是同一个形状。
  // 改成枚举式：每个 job 必须落进两类之一，新加 job 自动被覆盖。
  ['CI：verify 的每个 job 要么无条件执行，要么显式 always()（枚举即期望）', () => {
    const jobs = jobBlocks(bare('verify'));
    expectTrue(jobs.size >= 6, 'verify.yml 的 job 数量少于预期 —— 是扫描器坏了，不是配置对了', [...jobs.keys()].join(','));
    // 这两个必须 always：上游炸了它们也要跑。summary 要如实报「闸门挂了」，
    // attest 要如实报「结论没送达」—— 静默跳过和「一切正常」在面板上一模一样。
    const ALWAYS = ['summary', 'attest'];
    for (const n of ALWAYS) expectTrue(jobs.has(n), `verify.yml 里没有 ${n} job`, [...jobs.keys()].join(','));
    const problems = [];
    for (const [name, j] of jobs) {
      const ifs = jobLevelIfs(j);
      if (ALWAYS.includes(name)) {
        // 负向那侧：名单里的 job 丢了 always() 也要红。
        if (!ifs.some(l => /^if:\s*always\(\)$/.test(l))) problems.push(`${name} 应该带 if: always()，实际：${ifs.join(' / ') || '（没有任何 if）'}`);
      } else if (ifs.length > 0) {
        // 其余一律不许有条件：写歪会让 job 静默永不执行，而 run 依然全绿。
        problems.push(`${name} 不该有 job 级 if，实际：${ifs.join(' / ')}`);
      }
    }
    expectEq(problems, [], 'job 条件的问题');
    const plain = [...jobs.keys()].filter(n => !ALWAYS.includes(n));
    return `${jobs.size} 个 job：${plain.join(' / ')} 无条件执行，${ALWAYS.join(' / ')} 带 always() —— 新加 job 会自动落进这条断言`;
  }],

  // 钉住 SHA 只解决「上游悄悄变了」，不解决「这一次到底送出去了没有」。
  // attest 是那件事的答案：它跑在 summary 之后，回头去 API 上找那条评论。
  // 这条静态断言守的是「它还在、还接着、marker 还对得上」——
  // 一个被误删或改歪的核对 job，会让回写通道重新变成沉默通道。
  //
  // 注意这里**只读具体那一行**（needs / uses / marker），不对整段 job 文本做
  // 子串匹配：jobBlocks 会把一个 job 之前的注释块算进上一个 job，而那段注释
  // 里反复提到 attest。实测就是这么误报成「环」的。
  ['CI：verify 有回写送达核对 job，marker 两处一致且不占用报告命名空间', () => {
    const text = bare('verify');
    const jobs = jobBlocks(text);
    const j = jobs.get('attest');
    expectTrue(Boolean(j), 'verify.yml 里没有 attest job —— 回写坏掉时没有任何东西在喊', [...jobs.keys()].join(','));
    const needs = needsOf(j);
    expectTrue(needs !== null && needs.includes('summary'), 'attest 必须 needs summary —— 评论还没写就去找它，等的是时序不是真相', j.text.slice(0, 300));
    expectTrue(j.text.includes('scripts/attest-comment.mjs'), 'attest job 没有真的执行核对脚本', j.text.slice(0, 400));
    // 它也不许被塞进 summary 的 needs：那会造出一个环。只看 needs 那一行。
    const summaryNeeds = needsOf(jobs.get('summary')) || [];
    expectTrue(!summaryNeeds.includes('attest'), 'summary 的 needs 里出现了 attest —— 那是个环', summaryNeeds.join(','));

    // marker 是两处耦合的字符串。改了一处而没改另一处，核对会去找一个没人写的
    // marker，然后每次都红在一个看起来像「评论没送达」的地方 —— 根因其实在这里。
    const markerLine = /marker:\s*'([^']+)'/.exec(jobs.get('summary').text);
    expectTrue(Boolean(markerLine), '扫不到 summary 的 marker —— 是扫描器坏了，不是配置对了', jobs.get('summary').text.slice(0, 400));
    const script = readIfExists('scripts/attest-comment.mjs');
    expectTrue(script.includes(`'${markerLine[1]}'`), 'attest 脚本里的 marker 与 workflow 不一致',
      `workflow: ${markerLine[1]}\n核对脚本里找不到这个字面量。两处必须逐字相同。`);

    // attest 不是一条被合成进报告的闸门（它跑在报告写完之后），所以不许占用
    // stdout-<slug>.log 与 report-* 这两个由 GATES 定义的命名空间 ——
    // 占用会让上面那两条「集合相等」的断言红在命名上，而那是假红。
    // 这里扫的是剥过注释的那份，所以说明文字里提到它们不算违规。
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
    // 反方向：发布分支上也必须过一遍全套闸门。verify 的范围一旦被改窄，
    // release 分支就会在没验过的情况下直接打包发出去。
    const vb = onBlock(wf('verify')).filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(vb, ["branches: ['**']"], 'verify.yml 的分支过滤');
    return "release 只认 release/**（不挂 main，不挂 **），verify 仍覆盖 ** —— 该跑不跑要红，不该跑却跑了也要红";
  }],

  // 截图 job 把 PNG 推回**同一条分支**，而这个 workflow 就挂在这条分支的 push 上。
  // 提交信息里的跳过标记是唯一的循环终止条件 —— 截图不可能字节级复现，所以
  // 「没有改动就不提交」在这里不成立。
  ['CI：screenshots 的触发范围与回写循环守卫', () => {
    const text = wf('screenshots');
    const on = onBlock(text);
    expectTrue(on.length > 0, 'screenshots.yml 里解析不到 on: 块 —— 扫描器坏了', text.slice(0, 300));
    const branches = on.filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(branches, ["branches: ['docs/**', 'shots/**']"], 'screenshots.yml 的分支过滤');
    expectTrue(on.some(l => l.trim() === 'workflow_dispatch:'), 'screenshots.yml 没有手动触发的口子', on.join('\n'));
    const jobs = jobBlocks(text);
    expectTrue(jobs.has('shots'), 'screenshots.yml 里没有 shots job', [...jobs.keys()].join(','));
    const j = jobs.get('shots');
    expectEq(jobLevelIfs(j), [], 'shots job 上的 job 级 if');
    expectTrue(j.text.includes('contents: write'), 'shots job 没有 contents: write，回写会直接失败', j.text.slice(0, 400));
    expectTrue(text.includes('[skip ci]'), '回写提交没有跳过 CI 的标记 —— 它推回同一条分支，会再次触发自己，无限循环', '截图不可能字节级复现，所以「没改动就不提交」拦不住这个循环');
    expectTrue(text.includes("steps.gate.outcome == 'success'"), '回写没有挂在截图闸门的结果上 —— 闸门红的时候会把黑图钉进仓库', j.text.slice(0, 600));
    return "只认 docs/** 与 shots/**，job 无条件执行，带 contents:write、[skip ci] 与「绿了才回写」三重守卫";
  }],

  // 另外两条流水线早就有「产物名与清单对齐」这条断言，截图这条没有 ——
  // 那就是同一个漏继承又长了一遍。少了它，composer 会去找一个没人产出的 slug，
  // 然后报告里只剩一句「没有产出报告」。
  ['CI：screenshots 的产物名与 stdout 日志集合等于 SHOTS_GATES', () => {
    const names = tokenSet('screenshots', RE_REPORT);
    const wantNames = new Set(SHOTS_GATES.map(g => `report-${g.slug}`));
    expectEq([...names].sort(), [...wantNames].sort(), '产物名集合');
    const slugs = tokenSet('screenshots', RE_STDOUT);
    const wantSlugs = new Set(SHOTS_GATES.map(g => g.slug));
    expectEq([...slugs].sort(), [...wantSlugs].sort(), 'stdout 日志 slug 集合');
    return `${names.size} 个产物 + ${slugs.size} 条日志，与 SHOTS_GATES 完全相等`;
  }],

  // 镜像这条流水线的全部意义是「别把不该给的东西给出去」，所以它自己失效时
  // 必须响亮。三件事在这里守：令牌缺失不许静默跳过、强推保证公开仓历史干净、
  // 提交信息里带源 SHA（审计唯一能区分「同步成功」与「早就不同步了」的凭据）。
  ['CI：mirror 的触发范围、令牌守卫与源 SHA 痕迹', () => {
    const text = wf('mirror');
    const on = onBlock(text);
    expectTrue(on.length > 0, 'mirror.yml 里解析不到 on: 块 —— 扫描器坏了', text.slice(0, 300));
    const branches = on.filter(l => l.includes('branches:')).map(l => l.trim());
    expectEq(branches, ['branches: [main]'], 'mirror.yml 的分支过滤');
    expectTrue(on.some(l => l.trim() === 'workflow_dispatch:'), 'mirror.yml 没有手动触发的口子', on.join('\n'));
    const jobs = jobBlocks(text);
    expectTrue(jobs.has('sync'), 'mirror.yml 里没有 sync job', [...jobs.keys()].join(','));
    expectEq(jobLevelIfs(jobs.get('sync')), [], 'sync job 上的 job 级 if');
    // 令牌缺失必须 exit 1。静默跳过和「同步成功」在面板上长得一模一样。
    expectTrue(text.includes('MIRROR_TOKEN:-') && text.includes('exit 1'), 'mirror.yml 没有在令牌缺失时明确失败', '静默跳过就等于「以为同步了，其实什么都没发生」');
    expectTrue(text.includes('git push --force'), 'mirror.yml 不是强推 —— 公开仓可能留下私有历史', text.slice(0, 400));
    expectTrue(text.includes('${GITHUB_SHA:0:7}'), '同步的提交信息里没有源 SHA', '那是审计唯一能区分「同步成功」与「镜像早就停在旧内容上」的凭据');
    const names = tokenSet('mirror', RE_REPORT);
    expectEq([...names].sort(), MIRROR_GATES.map(g => `report-${g.slug}`).sort(), '产物名集合');
    const slugs = tokenSet('mirror', RE_STDOUT);
    expectEq([...slugs].sort(), MIRROR_GATES.map(g => g.slug).sort(), 'stdout 日志 slug 集合');
    return '只认 main，令牌缺失即红，强推 + 源 SHA 痕迹都在，产物名与 MIRROR_GATES 相等';
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

  // 这条原来手写着 ['dist','publish','verify','summary'] 四个 job 名。加
  // mirror job 的时候它完全在检查范围之外 —— 和「新加的 workflow 没登记」
  // 是同一个形状，一小时内长了第二遍。所以改成枚举即期望：
  // release.yml 里**每一个** job 都必须落进这两类之一。
  ['CI：release 的每个 job 要么无条件执行，要么显式 always()（枚举即期望）', () => {
    const jobs = jobBlocks(bare('release'));
    expectTrue(jobs.size >= 5, 'release.yml 的 job 数量少于预期 —— 是扫描器坏了，不是配置对了', [...jobs.keys()].join(','));
    // 这两个必须 always：上游炸了它们也要跑，然后如实报「读不到 Release」。
    // 静默跳过和「验过了没问题」在面板上长得一模一样。
    const ALWAYS = ['verify', 'summary'];
    for (const n of ALWAYS) expectTrue(jobs.has(n), `release.yml 里没有 ${n} job`, [...jobs.keys()].join(','));
    const problems = [];
    for (const [name, j] of jobs) {
      const ifs = jobLevelIfs(j);
      if (ALWAYS.includes(name)) {
        // 负向那侧：名单里的 job 丢了 always() 也要红。
        if (!ifs.some(l => /^if:\s*always\(\)$/.test(l))) problems.push(`${name} 应该带 if: always()，实际：${ifs.join(' / ') || '（没有任何 if）'}`);
      } else if (ifs.length > 0) {
        // 其余 job 一律不许有条件：写歪了会让它静默永不执行，而 run 依然全绿。
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
    // 模式用拼接构造，否则这条扫描会抓到自己的字面量 —— 那时说谎的是夹具。
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
