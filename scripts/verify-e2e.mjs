#!/usr/bin/env node
// 端到端闸门：真的把 Electron 起起来，做真实操作，断言真实行为。
//
// 三条自己踩过的规矩写在这里，别删：
// 1. 每一步都轮询，不睡固定时间。轮询函数返回**布尔**，返回计数的话 0 会被
//    当成「条件还没成立」一直等到超时，然后报告里写成「没有数据」。
// 2. **第一个动作也要轮询。** 取窗口句柄这种开场动作最容易被写成直接取值，
//    那一刻应用可能还没初始化完 —— 它是竞态，平时能过，输了那次会把后面
//    所有步骤连带判成跳过。
// 3. 画面断言要看内容。截图字节数只能证明「有像素」，所以这里从主进程
//    capturePage 取真实位图，数探针颜色的像素个数，并且要求空列表状态下
//    这个数**必须为 0**（负向孪生）。集合基数会抛硬币，像素计数不会。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Report } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'todox-e2e-'));
const DATA_FILE = path.join(USER_DATA, 'todox.json');

// 只有待办行的标记条用这个颜色，应用里别处不许再用。
const PROBE = { r: 0, g: 214, b: 132, tol: 10 };
const LIGHT_BG = 'rgb(246, 247, 249)';
const DARK_BG = 'rgb(22, 26, 32)';

const report = new Report('Electron 端到端闸门');
const ctx = { app: null, page: null, fatal: null, consoleErrors: [], probeEmpty: null, probeFull: null };

function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  throw e;
}
function expectEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) fail(`${label} 不符`, `期望: ${b}\n实际: ${a}\n${envNote()}`);
}
function expectTrue(cond, label, evidence) { if (!cond) fail(label, `${evidence == null ? '' : evidence}\n${envNote()}`); }
// 每条失败都附环境自证数据。没有这些只能靠推理定位，而推理会错。
function envNote() {
  return `[环境自证] 用户数据目录=${USER_DATA} 存档存在=${fs.existsSync(DATA_FILE)} 控制台错误数=${ctx.consoleErrors.length}`;
}

async function waitFor(label, fn, timeout = 25000) {
  const start = Date.now();
  let last = '（还没观测到）';
  for (;;) {
    try {
      const v = await fn();
      if (v === true) return true;
      last = v;
    } catch (err) { last = `抛错: ${err.message}`; }
    if (Date.now() - start > timeout) fail(`等待超时: ${label}`, `最后一次观测: ${JSON.stringify(last)}\n${envNote()}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

const t = (id) => ctx.page.locator(`[data-testid="${id}"]`);
const rows = () => ctx.page.locator('[data-testid="item"]');
const rowCount = () => rows().count();
const diag = () => ctx.page.evaluate(() => JSON.parse(JSON.stringify({
  ready: window.__DIAG__.ready,
  counts: window.__DIAG__.counts,
  rendered: window.__DIAG__.rendered,
  renderCount: window.__DIAG__.renderCount,
  settings: window.__DIAG__.settings,
  view: window.__DIAG__.view,
  lastError: window.__DIAG__.lastError
})));

async function launch() {
  const app = await electron.launch({
    cwd: ROOT,
    args: ['.', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, TODOX_USER_DATA: USER_DATA, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    timeout: 60000
  });
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('console', m => { if (m.type() === 'error') ctx.consoleErrors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', e => ctx.consoleErrors.push(`pageerror: ${e.message}`));
  ctx.app = app; ctx.page = page;
  // 后台窗口会被节流，依赖时间推进的东西在夹具里根本不触发。显式切到前台。
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { w.show(); w.focus(); }
  });
  await waitFor('渲染进程 __DIAG__.ready', async () =>
    (await page.evaluate(() => Boolean(window.__DIAG__ && window.__DIAG__.ready === true))) === true);
  return app;
}

async function probePixels() {
  return await ctx.app.evaluate(async ({ BrowserWindow }, probe) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.webContents.capturePage();
    const size = img.getSize();
    const bmp = img.getBitmap();
    let n = 0;
    for (let i = 0; i + 3 < bmp.length; i += 4) {
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (Math.abs(r - probe.r) <= probe.tol && Math.abs(g - probe.g) <= probe.tol && Math.abs(b - probe.b) <= probe.tol) n += 1;
    }
    return { n, size, bytes: bmp.length };
  }, PROBE);
}

async function addTodo(title, priority) {
  const before = await rowCount();
  await t('new-title').fill(title);
  if (priority) await t('new-priority').selectOption(priority);
  await t('add').click();
  await waitFor(`新增「${title}」后行数变成 ${before + 1}`, async () => (await rowCount()) === before + 1);
}

async function titleOccurrences(text) {
  return await ctx.page.evaluate(s => {
    const inTitles = [...document.querySelectorAll('[data-testid="item-title"]')].filter(e => e.textContent === s).length;
    const inBody = (document.body.innerText.split(s).length - 1);
    return { inTitles, inBody };
  }, text);
}

async function expectVisible(id, want) {
  const got = await t(id).isVisible();
  expectEq(got, want, `${id} 的可见性`);
}

const STEPS = [
  ['启动：主窗口出现且 __DIAG__ 就绪（轮询驱动）', async () => {
    await launch();
    ctx.probeEmpty = await probePixels();
    const d = await diag();
    expectEq(d.counts, { total: 0, active: 0, completed: 0 }, '首次启动的计数');
    await expectVisible('empty', true);
    return `窗口 ${ctx.probeEmpty.size.width}x${ctx.probeEmpty.size.height}，位图 ${ctx.probeEmpty.bytes} 字节，空列表探针像素 ${ctx.probeEmpty.n}`;
  }],

  ['诊断出口：字段齐全且只读', async () => {
    const d = await diag();
    for (const k of ['ready', 'counts', 'rendered', 'renderCount', 'settings', 'view']) {
      expectTrue(k in d, `__DIAG__ 缺字段 ${k}`, JSON.stringify(d));
    }
    const tamper = await ctx.page.evaluate(() => {
      const frozen = Object.isFrozen(window.__DIAG__);
      try { window.__DIAG__ = { ready: false }; } catch (e) { /* 严格模式会抛，也算守住了 */ }
      const copy = window.__DIAG__.counts;
      copy.total = 999;
      return { frozen, stillReady: window.__DIAG__.ready === true, totalAfter: window.__DIAG__.counts.total };
    });
    expectEq(tamper, { frozen: true, stillReady: true, totalAfter: 0 }, '篡改 __DIAG__ 的结果');
    return '6 个字段齐全，整体冻结，counts 返回副本（改副本改不动本体）';
  }],

  ['新增：连续添加 3 条，DOM 行数与计数器都为 3', async () => {
    await addTodo('买牛奶', 'high');
    await addTodo('写周报', 'normal');
    await addTodo('遛狗', 'low');
    const d = await diag();
    expectEq(await rowCount(), 3, 'DOM 行数');
    expectEq(d.counts, { total: 3, active: 3, completed: 0 }, '计数器');
    expectEq(d.rendered, 3, '__DIAG__.rendered');
    return 'DOM 与状态两侧都是 3';
  }],

  ['新增：空标题不产生新行，并给出可见的错误（负向）', async () => {
    await t('new-title').fill('   ');
    await t('add').click();
    await waitFor('错误提示出现', async () => (await t('error').isVisible()) === true);
    expectEq(await rowCount(), 3, '行数');
    const d = await diag();
    expectEq(d.lastError && d.lastError.code, 'EMPTY_TITLE', '错误码');
    await t('new-title').fill('');
    return '行数仍是 3，错误码 EMPTY_TITLE 并且真的显示出来了';
  }],

  ['渲染证据：有列表时探针像素 > 0，空列表时为 0（负向孪生）', async () => {
    ctx.probeFull = await probePixels();
    await ctx.page.screenshot({ path: path.join(ARTIFACTS, 'screen-list.png') });
    expectEq(ctx.probeEmpty.n, 0, '空列表状态下的探针像素数');
    expectTrue(ctx.probeFull.n > 0, '有 3 条待办时一个探针像素都没有 —— 界面根本没画出来', `空=${ctx.probeEmpty.n} 满=${ctx.probeFull.n}`);
    expectTrue(ctx.probeFull.n >= 240, '探针像素太少，可能只画出了一条', `期望 >= 240（3 条 x 8x22 的一半余量），实际 ${ctx.probeFull.n}`);
    return `空列表 0 像素 -> 3 条待办 ${ctx.probeFull.n} 像素（比差值，不比绝对阈值）`;
  }],

  ['修改：行内改标题后新标题出现，旧标题出现 0 次（负向孪生）', async () => {
    const row = rows().nth(1);
    await row.locator('[data-testid="item-edit"]').click();
    await waitFor('编辑框出现', async () => (await ctx.page.locator('[data-testid="item-edit-input"]').count()) === 1);
    await ctx.page.locator('[data-testid="item-edit-input"]').fill('写月报');
    await ctx.page.keyboard.press('Enter');
    await waitFor('新标题出现', async () => (await titleOccurrences('写月报')).inTitles === 1);
    const old = await titleOccurrences('写周报');
    expectEq(old, { inTitles: 0, inBody: 0 }, '旧标题的出现次数');
    expectEq(await rowCount(), 3, '行数不该变');
    return '「写周报」-> 「写月报」，旧标题在标题元素与整页文本里都是 0 次';
  }],

  ['完成：勾选后行标记为已完成，未完成计数 -1', async () => {
    await rows().nth(0).locator('[data-testid="item-toggle"]').click();
    await waitFor('计数变成 2 未完成', async () => {
      const d = await diag();
      return d.counts.active === 2 && d.counts.completed === 1;
    });
    const done = await rows().nth(0).getAttribute('data-done');
    expectEq(done, 'true', '行上的 data-done');
    expectEq(await t('count-active').textContent(), '2', '页脚未完成数');
    return 'data-done=true，页脚 2/3';
  }],

  ['筛选：三个页签的行数分别为 3 / 2 / 1', async () => {
    await t('filter-active').click();
    await waitFor('active 页签 2 行', async () => (await rowCount()) === 2);
    await t('filter-completed').click();
    await waitFor('completed 页签 1 行', async () => (await rowCount()) === 1);
    await t('filter-all').click();
    await waitFor('all 页签 3 行', async () => (await rowCount()) === 3);
    return 'all=3 / active=2 / completed=1，切回 all 后完全恢复';
  }],

  ['搜索：关键词只留匹配行，清空后全部回来', async () => {
    await t('search').fill('牛奶');
    await waitFor('只剩 1 行', async () => (await rowCount()) === 1);
    expectEq(await rows().nth(0).locator('[data-testid="item-title"]').textContent(), '买牛奶', '命中的标题');
    await t('search').fill('这个词绝对不存在zzz');
    await waitFor('0 行（负向）', async () => (await rowCount()) === 0);
    await t('search').fill('');
    await waitFor('恢复 3 行', async () => (await rowCount()) === 3);
    return '命中 1 行、不命中 0 行、清空恢复 3 行';
  }],

  ['设置：切到深色主题后 body 背景色确实变了', async () => {
    const before = await ctx.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expectEq(before, LIGHT_BG, '切换前的背景色');
    await t('settings-toggle').click();
    await waitFor('设置面板可见', async () => (await t('settings-panel').isVisible()) === true);
    await t('set-theme').selectOption('dark');
    await waitFor('背景变深色', async () =>
      (await ctx.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === DARK_BG);
    const d = await diag();
    expectEq(d.settings.theme, 'dark', '设置里的主题');
    return `${before} -> ${DARK_BG}（比对具体令牌，不是「颜色变了就算」）`;
  }],

  ['设置：字号滑条真的把列表项字号顶上去（比差值）', async () => {
    const read = () => ctx.page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('[data-testid="item-title"]')).fontSize));
    const before = await read();
    await t('set-fontscale').focus();
    // 按一格等一格。连按的话，晚到的那一轮回写会把滑条 value 顶回旧值，
    // 最后停在中间某个数上 —— 那是夹具的竞态，不是产品的毛病。
    for (const want of [110, 120, 130, 140, 150, 160]) {
      await ctx.page.keyboard.press('ArrowRight');
      await waitFor(`fontScale 到 ${want}`, async () => (await diag()).settings.fontScale === want);
    }
    const after = await read();
    expectTrue(after > before * 1.3, '字号没有随设置变大', `之前 ${before}px，之后 ${after}px（期望 > ${(before * 1.3).toFixed(1)}px）`);
    return `${before}px -> ${after}px，用键盘真的推了 6 格，每格都确认落地`;
  }],

  ['删除：开着确认时要先确认，行数 -1 且标题出现 0 次（负向孪生）', async () => {
    await rows().nth(2).locator('[data-testid="item-delete"]').click();
    await waitFor('确认框出现', async () => (await t('confirm').isVisible()) === true);
    expectEq(await rowCount(), 3, '还没确认就不该删');
    await t('confirm-yes').click();
    await waitFor('行数变 2', async () => (await rowCount()) === 2);
    expectEq(await titleOccurrences('遛狗'), { inTitles: 0, inBody: 0 }, '被删标题的出现次数');
    return '确认前 3 行、确认后 2 行，被删标题整页 0 次';
  }],

  ['设置：关掉「删除前确认」后不再弹确认框', async () => {
    await t('set-confirmdelete').uncheck();
    await waitFor('设置已生效', async () => (await diag()).settings.confirmDelete === false);
    await rows().nth(1).locator('[data-testid="item-delete"]').click();
    await waitFor('直接变成 1 行', async () => (await rowCount()) === 1);
    expectEq(await t('confirm').isVisible(), false, '确认框可见性');
    return '关掉之后一步删除，确认框始终没出现';
  }],

  ['窗口：可调整大小、最小尺寸 480x360、resize 到 1024x720 真的生效', async () => {
    const info = await ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { resizable: w.isResizable(), min: w.getMinimumSize(), bounds: w.getBounds() };
    });
    expectEq(info.resizable, true, '窗口是否可调整大小');
    expectEq(info.min, [480, 360], '最小尺寸');
    await ctx.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ width: 1024, height: 720 });
    });
    await waitFor('窗口真的变成 1024x720', async () => {
      const b = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      return b.width === 1024 && b.height === 720;
    });
    return `原尺寸 ${info.bounds.width}x${info.bounds.height} -> 1024x720，最小 480x360，可调整`;
  }],

  ['重启：待办、设置、窗口尺寸全部恢复', async () => {
    const beforeDiag = await diag();
    await ctx.app.close();
    await new Promise(r => setTimeout(r, 800));
    await launch();
    const after = await diag();
    expectEq(after.counts, beforeDiag.counts, '重启后的计数');
    expectEq(await rowCount(), 1, '重启后的行数');
    expectEq(await rows().nth(0).locator('[data-testid="item-title"]').textContent(), '买牛奶', '幸存待办的标题');
    expectEq(after.settings, { theme: 'dark', fontScale: 160, confirmDelete: false, defaultPriority: 'normal', defaultSort: 'created' }, '重启后的设置');
    const b = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    expectTrue(Math.abs(b.width - 1024) <= 4 && Math.abs(b.height - 720) <= 4, '窗口尺寸没有恢复', `期望 ~1024x720，实际 ${b.width}x${b.height}`);
    await ctx.page.screenshot({ path: path.join(ARTIFACTS, 'screen-restart.png') });
    return `1 条待办 + 深色 + 160% + 关闭确认 + ${b.width}x${b.height} 全部恢复`;
  }],

  ['落盘证据：存档文件存在、字节数 > 0、内容对得上', async () => {
    expectTrue(fs.existsSync(DATA_FILE), '存档文件根本不存在', DATA_FILE);
    const bytes = fs.statSync(DATA_FILE).size;
    expectTrue(bytes > 0, '存档文件是空的', `${DATA_FILE} = ${bytes} 字节`);
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    expectEq(raw.todos.map(x => x.title), ['买牛奶'], '落盘的标题');
    expectEq(raw.settings.theme, 'dark', '落盘的主题');
    expectEq([raw.bounds.width, raw.bounds.height], [1024, 720], '落盘的窗口尺寸');
    expectEq(raw.todos.filter(x => x.title === '遛狗').length, 0, '被删条目在磁盘上的残留');
    return `${bytes} 字节，标题/设置/尺寸都对，被删的条目磁盘上也没有（验产物，不验接口被调用过）`;
  }],

  ['全程零控制台错误', async () => {
    expectEq(ctx.consoleErrors, [], '控制台错误');
    return '两次启动全程 0 条 console.error / pageerror';
  }],

  ['自检：本次实际执行的检查数等于清单数', async () => {
    const actual = report.checks.length + 1;
    expectEq(actual, STEPS.length, '本次执行的检查数');
    expectEq(STEPS.length, MANIFEST.e2e, 'scripts/manifest.json 里登记的条数');
    return `${actual} 条，等号断言`;
  }]
];

fs.mkdirSync(ARTIFACTS, { recursive: true });

for (let i = 0; i < STEPS.length; i += 1) {
  const [title, fn] = STEPS[i];
  const isSelfCheck = i === STEPS.length - 1;
  if (ctx.fatal && !isSelfCheck) {
    report.skip(title, `前置步骤失败后跳过（跳过一律算失败）：${ctx.fatal}`);
    continue;
  }
  const entry = await report.checkAsync(title, fn);
  if (!entry.ok && i === 0) ctx.fatal = entry.detail;
}

try { if (ctx.app) await ctx.app.close(); } catch { /* 关不掉不影响结论 */ }

report.save(ARTIFACTS, 'e2e');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
