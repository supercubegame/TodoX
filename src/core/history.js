'use strict';
// 撤销 / 重做。和 store.js 一样纯：不看时间、不碰 I/O、不用随机。
//
// 因为状态是不可变的，撤销不需要「反向操作」,只要留一个状态栈。这是纯核心
// 白送的第四个好处（另外三个是可复现、可压测、可换外壳）。
//
// **历史不进存档。** 撤销跨重启没有意义，而且历史里每一项都是一份完整状态，
// 写进磁盘会让存档膨胀几十倍。快闸门有一条断言守它。

const HISTORY_LIMIT = 50;

class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

function createHistory() {
  return { past: [], future: [] };
}

// 记录一次改动前的状态。**同时清空 future**：产生新分支之后，原来那条
// 重做链就不可达了,留着它会让用户重做出一个跟当前状态无关的东西。
function record(history, prevState) {
  const past = history.past.concat([prevState]);
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: []
  };
}

function undo(history, currentState) {
  if (history.past.length === 0) throw new HistoryError('NOTHING_TO_UNDO', '没有可撤销的操作');
  const prev = history.past[history.past.length - 1];
  const future = [currentState].concat(history.future);
  return {
    state: prev,
    history: {
      past: history.past.slice(0, -1),
      future: future.length > HISTORY_LIMIT ? future.slice(0, HISTORY_LIMIT) : future
    }
  };
}

function redo(history, currentState) {
  if (history.future.length === 0) throw new HistoryError('NOTHING_TO_REDO', '没有可重做的操作');
  const next = history.future[0];
  const past = history.past.concat([currentState]);
  return {
    state: next,
    history: {
      past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
      future: history.future.slice(1)
    }
  };
}

// 给界面和诊断出口用的只读摘要。返回计数而不是状态本身,把整个历史
// 暴露给渲染进程既没必要也很贵。
function summary(history) {
  return {
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undoDepth: history.past.length,
    redoDepth: history.future.length,
    limit: HISTORY_LIMIT
  };
}

module.exports = { HISTORY_LIMIT, HistoryError, createHistory, record, undo, redo, summary };
