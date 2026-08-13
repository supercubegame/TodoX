'use strict';
// 主进程是**唯一**的状态所有者。渲染进程只渲染 + 发意图，不持有业务规则 ——
// 这样规则只有一份，而且那一份是纯的、可断言的。
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const core = require('../core/store.js');
const hist = require('../core/history.js');
const persist = require('./persist.js');

// 端到端闸门用它把用户数据指到临时目录。必须在 ready 之前设置，否则 Electron
// 内部已经缓存了旧路径。这是给测试的显式通道，不污染正常路径。
const overrideUserData = process.env.TODOX_USER_DATA;
if (overrideUserData) app.setPath('userData', overrideUserData);

let state = core.createState();
// 历史和状态并列，但**不进存档**：撤销跨重启没有意义，而且历史里每一项都是
// 一份完整状态，写进磁盘会让存档膨胀几十倍。快闸门有一条断言守这件事。
let history = hist.createHistory();
let dataFile = null;
let win = null;
let idSeq = 0;
let boundsTimer = null;

function nextId() {
  idSeq += 1;
  return `t${Date.now().toString(36)}-${idSeq.toString(36)}`;
}
function nowMs() { return Date.now(); }

function workArea() {
  try {
    return screen.getPrimaryDisplay().workArea;
  } catch (e) {
    return { x: 0, y: 0, width: 1920, height: 1080 };
  }
}

function viewOf(opts) {
  return {
    todos: core.selectTodos(state, opts || {}),
    counts: core.counts(state),
    settings: state.settings,
    // 只给摘要，不给整个历史。
    history: hist.summary(history)
  };
}
function okOf(opts) { return { ok: true, data: viewOf(opts) }; }
function errOf(e) {
  return { ok: false, error: { code: e && e.code ? e.code : 'UNKNOWN', message: e && e.message ? e.message : String(e) } };
}

// 校验失败不抛到渲染进程去，回一个结构化信封：界面要显示得出来，闸门要断言得到。
//
// 改动成功之后才记历史 —— 失败的尝试不该占一格撤销。
async function mutate(fn, opts) {
  let next = null;
  try {
    next = fn();
  } catch (e) {
    return errOf(e);
  }
  history = hist.record(history, state);
  state = next;
  await persist.save(dataFile, state);
  return okOf(opts);
}

// 撤销与重做走另一条路：它们不产生新状态，而是在历史里移动。
async function timeTravel(fn, opts) {
  let moved = null;
  try {
    moved = fn();
  } catch (e) {
    return errOf(e);
  }
  state = moved.state;
  history = moved.history;
  await persist.save(dataFile, state);
  return okOf(opts);
}

function registerIpc() {
  ipcMain.handle('todos:view', (_e, opts) => okOf(opts));
  ipcMain.handle('todos:add', (_e, input, opts) => mutate(() => core.addTodo(state, input, { id: nextId(), now: nowMs() }), opts));
  ipcMain.handle('todos:update', (_e, id, patch, opts) => mutate(() => core.updateTodo(state, id, patch, { now: nowMs() }), opts));
  ipcMain.handle('todos:toggle', (_e, id, opts) => mutate(() => core.toggleTodo(state, id, { now: nowMs() }), opts));
  ipcMain.handle('todos:remove', (_e, id, opts) => mutate(() => core.removeTodo(state, id), opts));
  ipcMain.handle('todos:clearCompleted', (_e, opts) => mutate(() => core.clearCompleted(state), opts));
  ipcMain.handle('settings:set', (_e, patch, opts) => mutate(() => core.setSettings(state, patch), opts));
  ipcMain.handle('history:undo', (_e, opts) => timeTravel(() => hist.undo(history, state), opts));
  ipcMain.handle('history:redo', (_e, opts) => timeTravel(() => hist.redo(history, state), opts));
}

function captureBounds() {
  if (!win || win.isDestroyed()) return;
  state = core.setBounds(state, win.getBounds(), workArea());
}
function flushBounds() {
  if (boundsTimer !== null) { clearTimeout(boundsTimer); boundsTimer = null; }
  captureBounds();
  if (dataFile !== null) persist.saveSync(dataFile, state);
}
function scheduleBoundsSave() {
  if (boundsTimer !== null) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => { boundsTimer = null; flushBounds(); }, 250);
}

function createWindow() {
  const b = core.clampBounds(state.bounds, workArea());
  const options = {
    width: b.width,
    height: b.height,
    minWidth: core.MIN_WIDTH,
    minHeight: core.MIN_HEIGHT,
    resizable: true,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'TodoX',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
  if (b.x !== null && b.y !== null) { options.x = b.x; options.y = b.y; }

  win = new BrowserWindow(options);
  win.once('ready-to-show', () => win.show());
  win.on('resize', scheduleBoundsSave);
  win.on('move', scheduleBoundsSave);
  win.on('close', flushBounds);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  dataFile = path.join(app.getPath('userData'), 'todox.json');
  const loaded = await persist.load(dataFile);
  state = loaded.state;
  // 载入不算一次改动，历史从空开始 —— 刚打开就能撤销回一个用户没见过的状态，
  // 那不是撤销，是惊吓。
  history = hist.createHistory();
  if (loaded.recovered) {
    // 恢复过的存档必须留下痕迹。静默修好和「本来就没坏」长得一模一样。
    process.stderr.write(`[todox] 存档不完整，已按默认值恢复: ${loaded.issues.join('; ')}\n`);
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', flushBounds);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
