#!/usr/bin/env node
// 截图生成器：真的起 Electron，喂一份固定的存档，截三张图写进 docs/screenshots。
//
// 截图是副作用，所以这里**验最终产物**，不验「截图接口被调用过」：
//   - 探针像素个数 == 这张图该有的行数 x 每行 164（内容断言，也是重绘屏障）
//   - 背景色等于该主题的令牌（深色那张必须真的是深色，负向孪生）
//   - PNG 存在且字节数过得去（只抓空图，不当画面质量的度量）
//   - 三张图的 sha256 互不相同（防「同一张图存了三遍」）
//
// 那条「探针像素 == 行数 x 164」是一次真实失败换来的：capturePage 给的是
// **上一帧**，于是 search 那张 DOM 已经只剩 1 行、位图里却还是 3 行的 492 个
// 探针像素，而「三张图互不相同」照样绿 —— 它们确实互不相同，只是每张都晚了
// 一步。所以截图这个动作本身也必须轮询，不能取一次就走。
//
// capturePage 拿到的位图既用来写文件、又用来算指标 —— 一个来源。分成两次抓的话，
// 指标可能量的是另一帧，而那种谎最难发现。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Report } from './lib/report.mjs';
import { SHOTS, SHOT_DIR, THEME_BG, PROBE, PROBE_PER_ROW, PROBE_TOL, MIN_BYTES } from './lib/shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, SHOT_DIR);
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'todox-shots-'));
const DATA_FILE = path.join(USER_DATA, 'todox.json');
const WIDTH = 1000;
const HEIGHT = 660;
const TOL = 6;

// 固定的演示数据。时间戳写死，这样图里的顺序每次都一样。
const SEED = {
  version: 1,
  todos: [
    { id: 's1', title: '早上跑步', notes: '五公里，别偷懒', priority: 'high', done: true, createdAt: 1000, updatedAt: 1000, completedAt: 1200 },
    { id: 's2', title: '中午做饭洗菜', notes: '先去买菜', priority: 'normal', done: false, createdAt: 2000, updatedAt: 2000, completedAt: null },
    { id: 's3', title: '晚上玩 LoL 游戏，定时打卡', notes: '23 点前下线', priority: 'low', done: false, createdAt: 3000, updatedAt: 3000, completedAt: null }
  ],
  settings: { theme: 'light', fontScale: 100, confirmDelete: true, defaultPriority: 'normal', defaultSort: 'created' },
  bounds: { x: null, y: null, width: WIDTH, height: HEIGHT }
};

const report = new Report('截图生成器');
const ctx = { app: null, page: null, fatal: null, shots: new Map() };
const shotOf = slug => SHOTS.find(s => s.slug === slug);

function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  throw e;
}
function expectEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) fail(`${label} 不符`, `期望: ${b}\n实际: ${a}`);
}
function expectTrue(cond, label, evidence) { if (!cond) fail(label, evidence); }

// 轮询驱动，返回布尔。返回计数的话 0 会被当成「还没成立」一直等到超时，
// 然后报告里写成「没有数据」。
async function waitFor(label, fn, timeout = 25000) {
  const start = Date.now();
  let last = '（还没观测到）';
  for (;;) {
    try {
      const v = await fn();
      if (v === true) return true;
      last = v;
    } catch (err) { last = `抛错: ${err.message}`; }
    if (Date.now() - start > timeout) fail(`等待超时: ${label}`, `最后一次观测: ${JSON.stringify(last)}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

const t = (id) => ctx.page.locator(`[data-testid="${id}"]`);
const rows = () => ctx.page.locator('[data-testid="item"]');
const diag = () => ctx.page.evaluate(() => JSON.parse(JSON.stringify({
  ready: window.__DIAG__.ready,
  counts: window.__DIAG__.counts,
  settings: window.__DIAG__.settings
})));

// 一次 capturePage，同时产出 PNG 字节和像素指标。
async function grab() {
  return await ctx.app.evaluate(async ({ BrowserWindow }, args) => {
    const w = BrowserWindow.getAllWindows()[0];
    // 等两帧再抓，减少拿到上一帧的概率。真正的保证在外面那层轮询。
    await new Promise(r => w.webContents.executeJavaScript(
      'new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))'
    ).then(r, r));
    const img = await w.webContents.capturePage();
    const size = img.getSize();
    const bmp = img.getBitmap();
    const px = (x, y) => {
      const i = (y * size.width + x) * 4;
      return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
    };
    let probe = 0;
    for (let i = 0; i + 3 < bmp.length; i += 4) {
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (Math.abs(r - args.probe.r) <= 10 && Math.abs(g - args.probe.g) <= 10 && Math.abs(b - args.probe.b) <= 10) probe += 1;
    }
    return { png: img.toPNG().toString('base64'), size, probe, corner: px(4, 4) };
  }, { probe: PROBE });
}

// 截图也是轮询：一直抓到位图里的探针像素等于「这张图该有几行」为止。
// 这既是重绘屏障，也是内容断言 —— 之前根本没人在验「图上画的是不是那个状态」。
async function capture(slug) {
  const spec = shotOf(slug);
  const wantProbe = spec.rows * PROBE_PER_ROW;
  const seen = [];
  let shot = null;
  await waitFor(`${slug} 的位图追上 DOM（探针 ${wantProbe} ± ${PROBE_TOL}）`, async () => {
    shot = await grab();
    seen.push(shot.probe);
    return Math.abs(shot.probe - wantProbe) <= PROBE_TOL;
  }, 20000).catch(err => {
    fail(`${slug}：位图一直没追上 DOM 状态`, `期望探针 ${wantProbe} ± ${PROBE_TOL}（${spec.rows} 行 x ${PROBE_PER_ROW}）\n` +
      `每次观测到: ${seen.join(', ')}\n` +
      'capturePage 会返回上一帧 —— DOM 断言过了不代表画面跟上了。');
  });

  const buf = Buffer.from(shot.png, 'base64');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${slug}.png`), buf);
  const entry = {
    slug,
    theme: spec.theme,
    rows: spec.rows,
    bytes: buf.length,
    sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    size: shot.size,
    probe: shot.probe,
    corner: shot.corner,
    attempts: seen.length
  };
  ctx.shots.set(slug, entry);
  return entry;
}

function verifyShot(entry) {
  const want = THEME_BG[entry.theme];
  const wantProbe = entry.rows * PROBE_PER_ROW;
  expectTrue(Math.abs(entry.probe - wantProbe) <= PROBE_TOL, `${entry.slug}.png 的探针像素与行数不符`, JSON.stringify(entry));
  expectTrue(entry.bytes > MIN_BYTES, `${entry.slug}.png 只有 ${entry.bytes} 字节，像是一张空图`, JSON.stringify(entry));
  const c = entry.corner;
  expectTrue(
    Math.abs(c.r - want.r) <= TOL && Math.abs(c.g - want.g) <= TOL && Math.abs(c.b - want.b) <= TOL,
    `${entry.slug}.png 的背景色不是 ${entry.theme} 主题的令牌`,
    `期望 rgb(${want.r},${want.g},${want.b})，实际 rgb(${c.r},${c.g},${c.b})\n` +
    '这是负向孪生：深色那张必须真的是深色的，不能只是 DOM 上写了 dark。'
  );
  return `${entry.size.width}x${entry.size.height}，${(entry.bytes / 1024).toFixed(0)} KB，探针 ${entry.probe}（${entry.rows} 行）` +
    `，背景 rgb(${c.r},${c.g},${c.b})，抓了 ${entry.attempts} 次才追上`;
}

async function launch() {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(SEED, null, 2), 'utf8');
  const app = await electron.launch({
    cwd: ROOT,
    args: ['.', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, TODOX_USER_DATA: USER_DATA, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    timeout: 60000
  });
  const page = await app.firstWindow({ timeout: 60000 });
  ctx.app = app;
  ctx.page = page;
  // 后台窗口会被节流，依赖时间推进的东西在夹具里根本不触发。显式切到前台。
  await app.evaluate(({ BrowserWindow }, size) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    w.setBounds({ width: size.w, height: size.h });
    w.show();
    w.focus();
  }, { w: WIDTH, h: HEIGHT });
  // 第一个动作也要轮询：取到句柄那一刻渲染进程可能还没初始化完。
  await waitFor('渲染进程 __DIAG__.ready', async () =>
    (await page.evaluate(() => Boolean(window.__DIAG__ && window.__DIAG__.ready === true))) === true);
  await waitFor('三条演示数据都渲染出来', async () => (await rows().count()) === 3);
  return app;
}

const STEPS = [
  ['启动并载入演示数据（轮询驱动）', async () => {
    await launch();
    const d = await diag();
    expectEq(d.counts, { total: 3, active: 2, completed: 1 }, '演示数据的计数');
    return `3 条待办（1 条已完成），窗口 ${WIDTH}x${HEIGHT}`;
  }],

  ['截图 light-list：浅色列表', async () => {
    await waitFor('浅色背景就位', async () =>
      (await ctx.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(246, 247, 249)');
    return verifyShot(await capture('light-list'));
  }],

  ['截图 search：搜索命中一行', async () => {
    await t('search').fill('洗菜');
    await waitFor('DOM 只剩 1 行', async () => (await rows().count()) === 1);
    const detail = verifyShot(await capture('search'));
    await t('search').fill('');
    await waitFor('恢复 3 行', async () => (await rows().count()) === 3);
    return `${detail}（「洗菜」命中备注，1/3 行）`;
  }],

  ['截图 dark-settings：深色主题 + 设置面板', async () => {
    await t('settings-toggle').click();
    await waitFor('设置面板可见', async () => (await t('settings-panel').isVisible()) === true);
    await t('set-theme').selectOption('dark');
    await waitFor('背景真的变深色', async () =>
      (await ctx.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(22, 26, 32)');
    const d = await diag();
    expectEq(d.settings.theme, 'dark', '设置里的主题');
    return verifyShot(await capture('dark-settings'));
  }],

  ['三张图互不相同，且浅深背景真的分得开', async () => {
    const missing = SHOTS.filter(s => !ctx.shots.has(s.slug)).map(s => s.slug);
    expectEq(missing, [], '没截到的图');
    const entries = SHOTS.map(s => ctx.shots.get(s.slug));
    const shas = entries.map(e => e.sha);
    expectEq(new Set(shas).size, shas.length, '互不相同的 sha256 个数');
    // 注意：这条**单独存在时是靠不住的**。上一版三张图各晚了一步，它照样全绿 ——
    // 因为「晚了一步」的三张图确实互不相同。真正在守内容的是每张图那条
    // 「探针像素 == 行数 x 164」。
    const light = ctx.shots.get('light-list');
    const dark = ctx.shots.get('dark-settings');
    expectTrue(Math.abs(light.corner.r - dark.corner.r) > 100, '浅色与深色两张图的背景几乎一样', `light r=${light.corner.r}，dark r=${dark.corner.r}（比差值，不比绝对阈值）`);
    const search = ctx.shots.get('search');
    expectTrue(light.probe > search.probe * 2, '3 行那张的探针像素没有明显多于 1 行那张', `light-list=${light.probe}，search=${search.probe}（比差值，不比绝对阈值）`);
    return `${shas.length} 张图 sha 各不相同；浅深背景 r 差 ${Math.abs(light.corner.r - dark.corner.r)}；探针 ${light.probe} vs ${search.probe}`;
  }],

  ['落盘证据：清单里每张图都在磁盘上，且没有多余文件（负向孪生）', async () => {
    const want = SHOTS.map(s => `${s.slug}.png`).sort();
    const got = fs.readdirSync(OUT).filter(n => n.endsWith('.png')).sort();
    expectEq(got, want, `${SHOT_DIR} 下的 PNG 集合`);
    const sizes = got.map(n => `${n} ${(fs.statSync(path.join(OUT, n)).size / 1024).toFixed(0)}KB`);
    return sizes.join('  ');
  }],

  ['自检：本次实际执行的步骤数等于清单数', async () => {
    const actual = report.checks.length + 1;
    expectEq(actual, STEPS.length, '本次执行的步骤数');
    expectEq(SHOTS.length, 3, 'SHOTS 清单条数');
    return `${actual} 条步骤 + ${SHOTS.length} 张图，等号断言`;
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

report.save(ARTIFACTS, 'shots');
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
