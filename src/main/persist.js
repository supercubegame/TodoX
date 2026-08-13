'use strict';
// 原子落盘：先写临时文件再 rename。断电或崩溃时不会留下半份 JSON。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const core = require('../core/store.js');

async function load(file) {
  let text = null;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: core.createState(), recovered: false, fresh: true, issues: [] };
    throw e;
  }
  const r = core.deserialize(text);
  return { state: r.state, recovered: r.recovered, fresh: false, issues: r.issues };
}

async function save(file, state) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, core.serialize(state), 'utf8');
  await fsp.rename(tmp, file);
}

// 关窗那一刻没有等异步的机会，只能同步写。
function saveSync(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, core.serialize(state), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { load, save, saveSync };
