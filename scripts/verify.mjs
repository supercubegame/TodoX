#!/usr/bin/env node
// 快闸门：零依赖，几十秒出结果。断言纯核心的真实行为 + 一批静态不变量 +
// CI 配置自审（假绿、沉默通道、清单漂移）。
//
// 每一条断言都问过同一个问题：如果这个功能完全没实现，这条会不会失败？
// 不会失败的就是空断言，不许留在这里。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { Report, GATES } from './lib/report.mjs';

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
    if (['node_modules', '.git', 'dist', 'artifacts'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

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

// ---------------------------------------------------------------- 核心与夹具
let core = null;
function getCore() {
  if (!core) core = require(path.join(ROOT, 'src', 'core', 'store.js'));
  return core;
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
const WF_PATH = '.github/workflows/verify.yml';
let wfText = null;
function wf() { if (wfText == null) wfText = readIfExists(WF_PATH); return wfText; }

function jobBlocks() {
  const lines = wf().split('\n');
  const start = lines.findIndex(l => l.trimEnd() === 'jobs:');
  if (start < 0) fail('workflow 里找不到顶层 jobs:', wf().slice(0, 400));
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

function runBlocks() {
  const lines = wf().split('\n');
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

function matrixSlugs() {
  return [...wf().matchAll(/^\s*slug:\s*([A-Za-z0-9_-]+)\s*$/gm)].map(m => m[1]);
}
// ${{matrix.slug}} 一律写成不带空格的形式，这样 token 里不含空白，扫描器可以
// 用「非空白直到 .log」切出来。带空格的写法会把这条扫描悄悄变成零命中。
function expandMatrix(token) {
  if (!token.includes('${{')) return [token];
  if (!token.includes('${{matrix.slug}}')) {
    fail('workflow 里出现了扫描器不认识的表达式', `token: ${token}（matrix.slug 必须写成不带空格的 \${{matrix.slug}}）`);
  }
  return matrixSlugs().map(s => token.split('${{matrix.slug}}').join(s));
}
function tokenSet(re) {
  const out = new Set();
  for (const m of wf().matchAll(re)) for (const v of expandMatrix(m[1])) out.add(v);
  return out;
}

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
    const s = deepFreeze(sample());
    const a = c.selectTodos(s, { filter: 'all', sort: 'title', query: '' });
    const b = c.selectTodos(s, { filter: 'all', sort: 'title', query: '' });
    expectEq(a, b, '两次查询');
    expectEq(c.serialize(s), c.serialize(s), '两次序列化');
    expectEq(c.counts(s), { total: 3, active: 3, completed: 0 }, '计数');
    return '查询与序列化各跑两次，结果逐字节一致';
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

  ['CI：出现 tee 的脚本块都设置了 pipefail', () => {
    const blocks = runBlocks();
    expectTrue(blocks.length > 0, '一个 run: | 块都没扫到 —— 是扫描器坏了，不是配置对了', wf().slice(0, 500));
    const teeBlocks = blocks.filter(b => b.body.includes('tee '));
    expectTrue(teeBlocks.length > 0, '没有任何 tee 块 —— 那报告缺失时评论里就没有日志尾巴了');
    const bad = teeBlocks.filter(b => !b.body.includes('pipefail')).map(b => `第 ${b.line} 行的 run 块`);
    expectEq(bad, [], '缺 pipefail 的 tee 块');
    return `${blocks.length} 个 run 块，其中 ${teeBlocks.length} 个用了 tee，全部带 pipefail（否则闸门红了 job 照样绿）`;
  }],

  ['CI：report job 用共享 workflow，且没有自己长出 steps', () => {
    const jobs = jobBlocks();
    const j = jobs.get('summary');
    expectTrue(Boolean(j), 'workflow 里没有 summary job', [...jobs.keys()].join(','));
    expectTrue(j.text.includes('uses: supercubegame/ci-workflows/.github/workflows/report.yml@main'), 'summary 没有引用共享回写 workflow', j.text.slice(0, 600));
    const hasSteps = j.lines.some(l => l.trim() === 'steps:');
    expectTrue(!hasSteps, 'summary 自己长出了 steps —— 回写逻辑必须只有一份', j.text.slice(0, 600));
    return '引用 ci-workflows/report.yml@main，本地零 steps';
  }],

  ['CI：gates 引用真实的 needs.<job>.result 且与 needs 一致', () => {
    const j = jobBlocks().get('summary');
    const needsLine = j.lines.find(l => l.trim().startsWith('needs:'));
    expectTrue(Boolean(needsLine), 'summary 没有 needs', j.text.slice(0, 400));
    const needs = needsLine.replace(/.*\[/, '').replace(/\].*/, '').split(',').map(s => s.trim()).filter(Boolean);
    const gatesLine = j.lines.find(l => l.trim().startsWith('gates:'));
    expectTrue(Boolean(gatesLine), 'summary 没有 gates 输入', j.text.slice(0, 400));
    const refs = [...gatesLine.matchAll(/needs\.([A-Za-z0-9_-]+)\.result/g)].map(m => m[1]);
    expectEq(refs.slice().sort(), needs.slice().sort(), 'gates 引用的 job 集合');
    const jobs = jobBlocks();
    for (const n of needs) expectTrue(jobs.has(n), `needs 里的 ${n} 不是真实存在的 job`, [...jobs.keys()].join(','));
    expectTrue(!/"result"\s*:\s*"(success|failure)"/.test(gatesLine), 'gates 里写了硬编码的结果字面量', gatesLine);
    return `needs=[${needs.join(',')}]，gates 逐个引用真实 result，没有硬编码`;
  }],

  ['CI：上传的 report-* 产物集合与闸门清单一致', () => {
    const names = tokenSet(/name:\s*(report-[^\s]+)/g);
    const want = new Set(GATES.map(g => `report-${g.slug}`));
    expectEq([...names].sort(), [...want].sort(), '产物名集合');
    return `${names.size} 个产物名与 GATES 一一对应`;
  }],

  ['CI：stdout-<slug>.log 集合与闸门清单一致', () => {
    const slugs = tokenSet(/stdout-([^\s`'"]+?)\.log/g);
    const want = new Set(GATES.map(g => g.slug));
    expectEq([...slugs].sort(), [...want].sort(), 'stdout 日志 slug 集合');
    return `${slugs.size} 条日志与 GATES 一一对应，composer 不会去找一个没人产出的 slug`;
  }],

  ['CI：闸门 job 上没有 job 级 if（不会静默不跑）', () => {
    const jobs = jobBlocks();
    const offenders = [];
    for (const [name, j] of jobs) {
      if (name === 'summary') continue;
      for (const l of j.lines) if (/^ {4}if:/.test(l)) offenders.push(`${name}: ${l.trim()}`);
    }
    expectEq(offenders, [], '带 job 级 if 的闸门 job');
    expectTrue(jobs.size >= 4, 'job 数量少于预期', [...jobs.keys()].join(','));
    return `${jobs.size - 1} 条闸门 job 全部无条件执行 —— 条件写歪会让 job 静默永不执行，而 run 依然全绿`;
  }],

  ['密钥：哨兵在源码与报告里出现 0 次（负向）', () => {
    const files = walk(ROOT);
    const hits = files.filter(f => {
      try { return fs.readFileSync(f, 'utf8').includes(SENTINEL); } catch { return false; }
    }).map(f => path.relative(ROOT, f));
    expectEq(hits, [], '哨兵泄漏的文件');
    const inReport = JSON.stringify(report.toJSON()).includes(SENTINEL);
    expectTrue(!inReport, '哨兵密钥泄漏进了报告本体', '报告会被原样贴到 PR 评论里');
    return `哨兵（每次运行随机生成）在 ${files.length} 个文件与报告 JSON 中出现 0 次`;
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
    for (const f of walk(ROOT)) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const [name, re] of patterns) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
    }
    expectEq(hits, [], '密钥形状的字面量');
    return '4 类密钥形状全部 0 命中（模式由拼接构造，扫描不会抓到自己）';
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
