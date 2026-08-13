'use strict';
// TodoX 的状态核心。**纯的**：不读文件、不碰 DOM、不发网络、不看系统时间、
// 不用未播种的随机。时间和 id 一律由调用方通过 ctx = { id, now } 注入。
//
// 这不是洁癖。回报有三个：可以断言「同样输入必然同样输出」；可以在毫秒内
// 模拟几万步；同一份逻辑换任意外壳都能复用。往里塞一个 Date.now() 会一次性
// 毁掉这三样，所以快闸门有一条扫描在守。

const SCHEMA_VERSION = 1;
const MAX_TITLE = 200;
const MAX_NOTES = 2000;
const PRIORITIES = ['high', 'normal', 'low'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const SORTS = ['created', 'title', 'priority'];
const FILTERS = ['all', 'active', 'completed'];
const THEMES = ['light', 'dark'];

// 改这两个值必须同步改：端到端闸门里 getMinimumSize() 的期望值、
// clampBounds 的下限断言。见 AGENTS.md「相互耦合的参数」。
const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;

const FONT_SCALE_MIN = 80;
const FONT_SCALE_MAX = 160;

const DEFAULT_SETTINGS = {
  theme: 'light',
  fontScale: 100,
  confirmDelete: true,
  defaultPriority: 'normal',
  defaultSort: 'created'
};
const DEFAULT_BOUNDS = { x: null, y: null, width: 960, height: 680 };
const DEFAULT_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function createState() {
  return {
    version: SCHEMA_VERSION,
    todos: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    bounds: Object.assign({}, DEFAULT_BOUNDS)
  };
}

function requireNow(ctx) {
  if (!ctx || !isFiniteNumber(ctx.now)) throw new StoreError('BAD_CTX', 'ctx.now 必须是有限数字（时间要注入，核心不许自己看表）');
}
function requireCtx(ctx) {
  requireNow(ctx);
  if (typeof ctx.id !== 'string' || ctx.id === '') throw new StoreError('BAD_CTX', 'ctx.id 必须是非空字符串');
}
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function cleanTitle(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') throw new StoreError('EMPTY_TITLE', '标题不能为空');
  return s.slice(0, MAX_TITLE);
}
function cleanNotes(v) { return String(v == null ? '' : v).slice(0, MAX_NOTES); }
function cleanPriority(v, fallback) {
  if (v == null) return fallback;
  if (PRIORITIES.indexOf(v) < 0) throw new StoreError('BAD_PRIORITY', `优先级只能是 ${PRIORITIES.join('/')}，收到 ${JSON.stringify(v)}`);
  return v;
}

// ------------------------------------------------------------------ 增删改查
function addTodo(state, input, ctx) {
  requireCtx(ctx);
  const src = input || {};
  for (let i = 0; i < state.todos.length; i += 1) {
    if (state.todos[i].id === ctx.id) throw new StoreError('DUPLICATE_ID', `id 已存在: ${ctx.id}`);
  }
  const todo = {
    id: ctx.id,
    title: cleanTitle(src.title),
    notes: cleanNotes(src.notes),
    priority: cleanPriority(src.priority, state.settings.defaultPriority),
    done: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    completedAt: null
  };
  return Object.assign({}, state, { todos: state.todos.concat([todo]) });
}

const PATCHABLE = ['title', 'notes', 'priority', 'done'];

function updateTodo(state, id, patch, ctx) {
  requireNow(ctx);
  const idx = indexOfId(state, id);
  const keys = Object.keys(patch || {});
  const bad = keys.filter(k => PATCHABLE.indexOf(k) < 0);
  if (bad.length > 0) throw new StoreError('BAD_FIELD', `不认识的字段: ${bad.join(',')}（可改的只有 ${PATCHABLE.join('/')}）`);
  if (keys.length === 0) throw new StoreError('EMPTY_PATCH', '补丁是空的');
  const prev = state.todos[idx];
  const next = Object.assign({}, prev);
  if (keys.indexOf('title') >= 0) next.title = cleanTitle(patch.title);
  if (keys.indexOf('notes') >= 0) next.notes = cleanNotes(patch.notes);
  if (keys.indexOf('priority') >= 0) next.priority = cleanPriority(patch.priority, prev.priority);
  if (keys.indexOf('done') >= 0) {
    next.done = Boolean(patch.done);
    next.completedAt = next.done ? ctx.now : null;
  }
  next.updatedAt = ctx.now;
  const todos = state.todos.slice();
  todos[idx] = next;
  return Object.assign({}, state, { todos: todos });
}

function toggleTodo(state, id, ctx) {
  const cur = state.todos[indexOfId(state, id)];
  return updateTodo(state, id, { done: !cur.done }, ctx);
}

function removeTodo(state, id) {
  indexOfId(state, id);
  return Object.assign({}, state, { todos: state.todos.filter(t => t.id !== id) });
}

function clearCompleted(state) {
  return Object.assign({}, state, { todos: state.todos.filter(t => !t.done) });
}

function indexOfId(state, id) {
  for (let i = 0; i < state.todos.length; i += 1) if (state.todos[i].id === id) return i;
  throw new StoreError('NOT_FOUND', `没有这条待办: ${JSON.stringify(id)}`);
}

// ---------------------------------------------------------------------- 查询
function selectTodos(state, view) {
  const v = view || {};
  const filter = FILTERS.indexOf(v.filter) >= 0 ? v.filter : 'all';
  const sort = SORTS.indexOf(v.sort) >= 0 ? v.sort : state.settings.defaultSort;
  const q = String(v.query == null ? '' : v.query).trim().toLowerCase();
  const rows = state.todos.filter(t => {
    if (filter === 'active' && t.done) return false;
    if (filter === 'completed' && !t.done) return false;
    if (q !== '' && t.title.toLowerCase().indexOf(q) < 0 && t.notes.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  // localeCompare 的结果依赖运行环境，核心里不许用：那会让「同样输入同样输出」
  // 在不同平台上不成立。这里用确定的码点比较，并逐级 tie-break 到 id。
  const primary = {
    created: (a, b) => a.createdAt - b.createdAt,
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    title: (a, b) => cmpStr(a.title.toLowerCase(), b.title.toLowerCase())
  }[sort];
  return rows.slice().sort((a, b) => primary(a, b) || (a.createdAt - b.createdAt) || cmpStr(a.id, b.id));
}
function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function counts(state) {
  let completed = 0;
  for (let i = 0; i < state.todos.length; i += 1) if (state.todos[i].done) completed += 1;
  return { total: state.todos.length, active: state.todos.length - completed, completed: completed };
}

// ---------------------------------------------------------------------- 设置
function setSettings(state, patch) {
  const keys = Object.keys(patch || {});
  const bad = keys.filter(k => !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k));
  if (bad.length > 0) throw new StoreError('BAD_FIELD', `不认识的设置项: ${bad.join(',')}`);
  const next = Object.assign({}, state.settings);
  if (keys.indexOf('theme') >= 0) {
    if (THEMES.indexOf(patch.theme) < 0) throw new StoreError('BAD_THEME', `主题只能是 ${THEMES.join('/')}，收到 ${JSON.stringify(patch.theme)}`);
    next.theme = patch.theme;
  }
  if (keys.indexOf('fontScale') >= 0) {
    const n = Number(patch.fontScale);
    if (!isFiniteNumber(n)) throw new StoreError('BAD_FONT_SCALE', `fontScale 必须是数字，收到 ${JSON.stringify(patch.fontScale)}`);
    next.fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(n)));
  }
  if (keys.indexOf('confirmDelete') >= 0) next.confirmDelete = Boolean(patch.confirmDelete);
  if (keys.indexOf('defaultPriority') >= 0) next.defaultPriority = cleanPriority(patch.defaultPriority, next.defaultPriority);
  if (keys.indexOf('defaultSort') >= 0) {
    if (SORTS.indexOf(patch.defaultSort) < 0) throw new StoreError('BAD_SORT', `排序只能是 ${SORTS.join('/')}，收到 ${JSON.stringify(patch.defaultSort)}`);
    next.defaultSort = patch.defaultSort;
  }
  return Object.assign({}, state, { settings: next });
}

// ------------------------------------------------------------------ 窗口尺寸
// 最小尺寸优先于工作区上限：宁可让窗口比屏幕大，也不给出一个小到没法用的窗口。
// 两条边界都可达 —— 用户能把窗口拖到很小（下限），也能在小屏上打开一份大窗口
// 的存档（上限）。够不着的边界和空断言是同一个洞。
function clampBounds(bounds, area) {
  const a = area || DEFAULT_AREA;
  const b = bounds || {};
  let width = isFiniteNumber(b.width) ? Math.round(b.width) : DEFAULT_BOUNDS.width;
  let height = isFiniteNumber(b.height) ? Math.round(b.height) : DEFAULT_BOUNDS.height;
  width = Math.max(MIN_WIDTH, Math.min(width, a.width));
  height = Math.max(MIN_HEIGHT, Math.min(height, a.height));
  let x = isFiniteNumber(b.x) ? Math.round(b.x) : null;
  let y = isFiniteNumber(b.y) ? Math.round(b.y) : null;
  if (x !== null) x = Math.max(a.x, Math.min(x, a.x + a.width - width));
  if (y !== null) y = Math.max(a.y, Math.min(y, a.y + a.height - height));
  return { x: x, y: y, width: width, height: height };
}

function setBounds(state, bounds, area) {
  return Object.assign({}, state, { bounds: clampBounds(bounds, area) });
}

// ---------------------------------------------------------------------- 存档
function serialize(state) {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    todos: state.todos,
    settings: state.settings,
    bounds: state.bounds
  }, null, 2);
}

// 永远不抛异常，但**永远不假装干净**：任何丢弃、补默认、版本不符都会进 issues
// 并把 recovered 置真。静默恢复和静默截断是同一种谎。
function deserialize(text) {
  const issues = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { state: createState(), recovered: true, issues: ['存档为空'] };
  }
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { state: createState(), recovered: true, issues: [`JSON 解析失败: ${e.message}`] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: createState(), recovered: true, issues: ['存档顶层不是对象'] };
  }

  const state = createState();
  if (raw.version !== SCHEMA_VERSION) issues.push(`版本不匹配: ${JSON.stringify(raw.version)}，按当前版本尽力读取`);

  if (!Array.isArray(raw.todos)) {
    issues.push('todos 不是数组，按空列表处理');
  } else {
    const seen = {};
    for (let i = 0; i < raw.todos.length; i += 1) {
      const t = normalizeTodo(raw.todos[i], seen, issues, i);
      if (t !== null) { seen[t.id] = true; state.todos.push(t); }
    }
  }

  state.settings = normalizeSettings(raw.settings, issues);
  state.bounds = normalizeBounds(raw.bounds, issues);
  return { state: state, recovered: issues.length > 0, issues: issues };
}

function normalizeTodo(item, seen, issues, i) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    issues.push(`第 ${i} 条不是对象，已丢弃`);
    return null;
  }
  const id = typeof item.id === 'string' && item.id !== '' ? item.id : null;
  if (id === null) { issues.push(`第 ${i} 条没有可用的 id，已丢弃`); return null; }
  if (seen[id] === true) { issues.push(`第 ${i} 条 id 重复（${id}），已丢弃`); return null; }
  let title = null;
  try { title = cleanTitle(item.title); } catch (e) { issues.push(`第 ${i} 条标题为空（${id}），已丢弃`); return null; }

  const createdAt = isFiniteNumber(item.createdAt) ? item.createdAt : 0;
  if (!isFiniteNumber(item.createdAt)) issues.push(`待办 ${id} 缺少 createdAt，补 0`);
  const updatedAt = isFiniteNumber(item.updatedAt) ? item.updatedAt : createdAt;
  let priority = 'normal';
  if (PRIORITIES.indexOf(item.priority) >= 0) priority = item.priority;
  else issues.push(`待办 ${id} 的优先级非法，改成 normal`);
  const done = Boolean(item.done);
  let completedAt = null;
  if (done) completedAt = isFiniteNumber(item.completedAt) ? item.completedAt : updatedAt;

  return {
    id: id,
    title: title,
    notes: cleanNotes(item.notes),
    priority: priority,
    done: done,
    createdAt: createdAt,
    updatedAt: updatedAt,
    completedAt: completedAt
  };
}

function normalizeSettings(raw, issues) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) issues.push('settings 不是对象，全部回默认');
    return out;
  }
  const keys = Object.keys(DEFAULT_SETTINGS);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (!Object.prototype.hasOwnProperty.call(raw, k)) { issues.push(`settings 缺少 ${k}，补默认值`); continue; }
    try {
      const patch = {};
      patch[k] = raw[k];
      out[k] = setSettings({ settings: out }, patch).settings[k];
    } catch (e) {
      issues.push(`settings.${k} 非法（${e.code}），回默认值`);
    }
  }
  return out;
}

// 这里**不夹**尺寸：夹要用真实显示器的工作区，而存档不知道那是什么。
// 夹的动作在主进程建窗口时做。在这里夹会把大屏上存的大窗口悄悄改小。
function normalizeBounds(raw, issues) {
  const out = Object.assign({}, DEFAULT_BOUNDS);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) issues.push('bounds 不是对象，回默认值');
    return out;
  }
  out.width = isFiniteNumber(raw.width) ? Math.max(MIN_WIDTH, Math.round(raw.width)) : DEFAULT_BOUNDS.width;
  out.height = isFiniteNumber(raw.height) ? Math.max(MIN_HEIGHT, Math.round(raw.height)) : DEFAULT_BOUNDS.height;
  out.x = isFiniteNumber(raw.x) ? Math.round(raw.x) : null;
  out.y = isFiniteNumber(raw.y) ? Math.round(raw.y) : null;
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_TITLE,
  MIN_WIDTH,
  MIN_HEIGHT,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  PRIORITIES,
  SORTS,
  FILTERS,
  THEMES,
  DEFAULT_SETTINGS,
  StoreError,
  createState,
  addTodo,
  updateTodo,
  toggleTodo,
  removeTodo,
  clearCompleted,
  selectTodos,
  counts,
  setSettings,
  setBounds,
  clampBounds,
  serialize,
  deserialize
};
