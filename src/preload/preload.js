'use strict';
// 渲染进程能碰到的全部东西都在这里。没有 node，没有 fs，没有 ipcRenderer 本体。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('todox', Object.freeze({
  view: (opts) => ipcRenderer.invoke('todos:view', opts),
  add: (input, opts) => ipcRenderer.invoke('todos:add', input, opts),
  update: (id, patch, opts) => ipcRenderer.invoke('todos:update', id, patch, opts),
  toggle: (id, opts) => ipcRenderer.invoke('todos:toggle', id, opts),
  remove: (id, opts) => ipcRenderer.invoke('todos:remove', id, opts),
  clearCompleted: (opts) => ipcRenderer.invoke('todos:clearCompleted', opts),
  setSettings: (patch, opts) => ipcRenderer.invoke('settings:set', patch, opts),
  undo: (opts) => ipcRenderer.invoke('history:undo', opts),
  redo: (opts) => ipcRenderer.invoke('history:redo', opts)
}));
