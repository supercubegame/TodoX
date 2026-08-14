#!/usr/bin/env node
// 性能压测闸门：只压纯核心，零依赖。
//
// 为什么要有这条：另外四条闸门能证明「行为对」，但一条 O(n²) 的查询在 3 条
// 待办上和线性实现长得一模一样 —— 全绿。性能属于「我在乎、却完全没有断言
// 在看」的那一类，而覆盖缺口和空断言在报告上是同一个样子。
//
// 为什么不写「新增一条必须快于 5 毫秒」这种绝对预算：共享 runner 的抖动能到
// 好几倍，那种断言会变成随机红，然后被人一路调宽到永远不会红 —— 一条永远
// 不红的断言就是装饰。这里的做法是四条：
//   1. 先跑一段确定的参考负载校准这台机器的速度，时间预算按校准值**放大**
//      （只放大不收紧；放大到 8 倍还兜不住就宣布「本次测量不可信」并红，
//      而不是给出一个安静的通过）；
//   2. 主力断言是**比值**：数据量 x4，耗时不许超过 6 倍。比值对机器绝对速度
//      不敏感，能抓住真正的复杂度退化；
//   3. 每个测量取多次里的**最小值** —— 噪声只会让测量变慢，不会让它变快；
//   4. 有一条自证：同一套测量器套在故意二次 / 故意慢的实现上必须判红。
//      够不着的阈值和空断言是同一个洞。
//
// 顺序建库在不可变核心下本来就是 O(n²)：每次新增都要扫一遍查重、复制一遍
// 数组。这不是 bug，是「状态不可变」的价钱（撤销白送就是它换来的）。所以
// 这里断言的是**稳态单次操作的延迟**与**规模比值**，不是批量导入的总时长。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Report, GATES } from './lib/report.mjs';

const SELF = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf8'));

const SLUG = 'perf';
const GATE = GATES.find(g => g.slug === SLUG);
if (!GATE) {
  process.stderr.write(`GATES 里没有 ${SLUG} —— 这条闸门没登记，报告合成器不会去找它的产物\n`);
  process.exit(2);
}

// 堆增长那条断言需要确定的 GC 时机。没有 --expose-gc 就带上它把自己重启一遍：
// 比「悄悄跳过堆那条」诚实，也让本地 npm run verify:perf 不用记参数。
if (typeof global.gc !== 'function') {
  if (process.env.TODOX_PERF_RESPAWNED === '1') {
    process.stderr.write('已经带 --expose-gc 重启过一次，global.gc 依然不可用\n');
    process.exit(2);
  }
  const again = spawnSync(process.execPath, ['--expose-gc', SELF], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { TODOX_PERF_RESPAWNED: '1' })
  });
  process.exit(again.status == null ? 2 : again.status);
}

const core = require(path.join(ROOT, 'src', 'core', 'store.js'));
const hist = require(path.join(ROOT, 'src', 'core', 'history.js'));

// ---------------------------------------------------------------- 断言小工具
function fail(msg, evidence) {
  const e = new Error(msg);
  if (evidence != null) e.evidence = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  throw e;
}
function expectEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} 不符`, `期望: ${JSON.stringify(expected)}\n实际: ${JSON.stringify(actual)}`);
  }
}
function expectTrue(cond, label, evidence) { if (!cond) fail(label, evidence); }

// ------------------------------------------------------------------ 预算清单
// 时间预算的单位是毫秒，且都会乘上校准系数。比值和内存不乘 —— 它们本来就
// 与机器速度无关。
const BUDGETS = {
  build: 2500,        // 顺序建 2000 条（不可变核心下是 O(n²)，这是上限不是目标）
  write: 5,           // 稳态单次写入的 p95（n = 2000）
  query: 15,          // 稳态单次查询的 p95（n = 2000，含过滤 + 搜索 + 排序）
  saveLoad: 1500,     // 2000 条存档 序列化 + 反序列化 往返
  historyHeapMB: 12,  // 50 层撤销栈带来的堆增长
  scaleRatio: 6       // 数据量 x4 时耗时的上限倍数（见下面那条断言的地板说明）
};
const usedBudgets = new Set();
function budget(key) {
  if (!Object.prototype.hasOwnProperty.call(BUDGETS, key)) fail(`预算清单里没有 ${key}`);
  usedBudgets.add(key);
  return BUDGETS[key];
}
// 时间预算：乘校准系数。校准没跑成的时候**直接红**，不许拿 NaN 去比较 ——
// `12 > NaN` 是 false，那会让每条时间断言静默通过。
function timeBudget(key) {
  if (!(M.scale >= 1)) fail('校准没跑成，任何时间预算都无法判定', '根因看「校准基线」那条');
  return budget(key) * M.scale;
}

// -------------------------------------------------------------------- 测量器
const REF_UNIT_MS = 8;   // 参考负载在一台正常机器上的耗时量级
const MAX_SCALE = 8;     // 放大上限。再慢就是环境病了，不该用放大预算盖过去
const M = { scale: null, state: null, big: null };
const keepAlive = [];    // 防止被测对象在测堆之前就被回收

// 确定的参考负载：整数运算，不看时钟、不用随机、不分配内存。返回 x 是为了
// 不让它被优化掉 —— 一段被 JIT 删掉的校准会给出「0 毫秒」，然后所有预算都
// 会被算成最紧的那档。
function calibrate() {
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < 3000000; i += 1) x = (x + Math.imul(i, 2654435761)) >>> 0;
  return { ms: performance.now() - t0, x: x };
}

// 自适应重复次数：单次只有几十微秒的操作，直接测一次等于在测时钟噪声。
function timed(fn, minMs = 25) {
  let reps = 1;
  let last = null;
  while (reps <= 4194304) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i += 1) fn(i);
    const dt = performance.now() - t0;
    last = { perOp: dt / reps, reps: reps, total: dt };
    if (dt >= minMs) return last;
    const factor = dt <= 0.05 ? 16 : Math.min(32, Math.ceil((minMs / dt) * 1.5));
    reps *= Math.max(2, factor);
  }
  return last;
}
// 取最小值而不是平均：噪声是单向的，只会让测量变慢。
function best(times, fn) {
  let out = null;
  for (let i = 0; i < times; i += 1) {
    const r = fn();
    if (out === null || r.perOp < out.perOp) out = r;
  }
  return out;
}
function percentile(xs, p) {
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
function heapMB() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
}
function ms(n) { return `${n.toFixed(n < 10 ? 3 : 1)}ms`; }

// 测一轮「小集合 → 大集合」的耗时比值。**两轮各自独立**，用来把「余量薄」和
// 「其实在抛硬币」分开 —— 单轮的话这两件事在报告上长得一模一样。
function ratioRound(fn) {
  const small = best(5, () => timed(() => fn(M.state)));
  const big = best(5, () => timed(() => fn(M.big)));
  return { small: small, big: big, r: big.perOp / small.perOp };
}

// -------------------------------------------------------------------- 压测集
const N = 2000;    // 一个真人可能真的攒到的量级
const BIG = 8000;  // 4 倍，用来看比值

function countIf(n, pred) {
  let c = 0;
  for (let i = 0; i < n; i += 1) if (pred(i)) c += 1;
  return c;
}

// 确定的压测集：第 4 条勾一次完成，第 7 条标题里带「牛奶」。两个周期互质，
// 于是「未完成 + 搜索命中」这种组合条件真的有交集，不会退化成空集 ——
// 一个总是返回 0 行的查询快得毫无意义，那是空压测。
function buildState(n) {
  let s = core.createState();
  let ops = 0;
  for (let i = 0; i < n; i += 1) {
    s = core.addTodo(s, {
      title: `压测条目 ${i} ${i % 7 === 0 ? '牛奶' : '周报'}`,
      notes: i % 3 === 0 ? `备注 ${i}` : '',
      priority: core.PRIORITIES[i % core.PRIORITIES.length]
    }, { id: `p${i}`, now: 1000 + i });
    ops += 1;
    if (i % 4 === 0) { s = core.toggleTodo(s, `p${i}`, { now: 500000 + i }); ops += 1; }
  }
  return { state: s, ops: ops };
}

const VIEWS = [
  { label: '全部 · 按创建时间', view: { filter: 'all', sort: 'created', query: '' }, rows: n => n },
  { label: '未完成 · 按优先级 · 搜「牛奶」', view: { filter: 'active', sort: 'priority', query: '牛奶' }, rows: n => countIf(n, i => i % 4 !== 0 && i % 7 === 0) },
  { label: '已完成 · 按标题', view: { filter: 'completed', sort: 'title', query: '' }, rows: n => countIf(n, i => i % 4 === 0) },
  { label: '全部 · 搜一个不存在的词（负向孪生）', view: { filter: 'all', sort: 'title', query: '这个词绝对不存在zzz' }, rows: () => 0 }
];
const HOT_VIEW = VIEWS[1].view;

// 故意二次的对照实现：给自证那条用。它算的东西和 selectTodos 的排序结果无关，
// 只是一个规模敏感度已知的负载。
function quadraticRank(state) {
  const out = [];
  for (let i = 0; i < state.todos.length; i += 1) {
    const t = state.todos[i];
    let rank = 0;
    for (let j = 0; j < state.todos.length; j += 1) if (state.todos[j].createdAt < t.createdAt) rank += 1;
    out.push(rank);
  }
  return out;
}

function writeLatencies(state, rounds) {
  const lat = [];
  let s = state;
  for (let i = 0; i < rounds; i += 1) {
    const id = `w${i}`;
    let t0 = performance.now();
    s = core.addTodo(s, { title: `稳态写入 ${i}` }, { id: id, now: 900000 + i });
    lat.push(performance.now() - t0);

    t0 = performance.now();
    s = core.updateTodo(s, id, { title: `稳态写入 ${i} 改过` }, { now: 900001 + i });
    lat.push(performance.now() - t0);

    t0 = performance.now();
    s = core.toggleTodo(s, id, { now: 900002 + i });
    lat.push(performance.now() - t0);

    t0 = performance.now();
    s = core.removeTodo(s, id);
    lat.push(performance.now() - t0);
  }
  return { lat: lat, state: s };
}

// ---------------------------------------------------------------- 检查清单
const report = new Report(GATE.label);

const CHECKS = [
  ['校准：参考负载耗时落在可信区间（否则本次测量不可信）', () => {
    const runs = [];
    for (let i = 0; i < 5; i += 1) runs.push(calibrate());
    const unit = Math.min.apply(null, runs.map(r => r.ms));
    // 下限：被 JIT 删掉的校准会给出 0 毫秒，然后把所有预算算成最紧的一档。
    expectTrue(unit > 0.2, '参考负载快得不真实，像是被优化掉了', `5 次最小值 ${ms(unit)}，x=${runs[0].x}`);
    // 上限：放大到 MAX_SCALE 还兜不住的机器上，测出来的数字没有意义 ——
    // 这时候要红，不能给出一个安静的通过。
    expectTrue(unit <= REF_UNIT_MS * MAX_SCALE, `这台机器慢到测量不可信（参考负载 ${ms(unit)}）`,
      `参考值 ${REF_UNIT_MS}ms，放大上限 ${MAX_SCALE} 倍 = ${REF_UNIT_MS * MAX_SCALE}ms\n` +
      '与其把预算调宽到永远不会红，不如如实说「这一次没测准」。');
    M.scale = Math.max(1, Math.min(MAX_SCALE, unit / REF_UNIT_MS));
    return `参考负载 ${ms(unit)}（5 次取最小）｜校准系数 x${M.scale.toFixed(2)}（只放大不收紧）｜各次 ${runs.map(r => r.ms.toFixed(1)).join('/')}`;
  }],

  ['压测集真的建起来了：2000 条、计数与操作数都对上（不是空压测）', () => {
    const t0 = performance.now();
    const built = buildState(N);
    const elapsed = performance.now() - t0;
    M.state = built.state;
    M.buildMs = elapsed;
    keepAlive.push(built.state);

    const c = core.counts(built.state);
    expectEq(c.total, N, '压测集条数');
    expectEq(c.completed, countIf(N, i => i % 4 === 0), '已完成条数');
    expectEq(c.active, N - countIf(N, i => i % 4 === 0), '未完成条数');
    expectEq(built.ops, N + countIf(N, i => i % 4 === 0), '实际执行的核心操作数');
    expectTrue(elapsed > 0, '建库耗时为 0 —— 时钟或负载有一个是假的', `elapsed=${elapsed}`);
    const limit = timeBudget('build');
    expectTrue(elapsed <= limit, `建 ${N} 条超预算`, `实际 ${ms(elapsed)}，预算 ${ms(limit)}（含校准系数 x${M.scale.toFixed(2)}）`);
    return `${N} 条 / ${built.ops} 次核心操作，${ms(elapsed)}（预算 ${ms(limit)}）｜已完成 ${c.completed}，未完成 ${c.active}`;
  }],

  ['稳态写入：n=2000 下 增/改/勾/删 的 p95 在预算内', () => {
    expectTrue(M.state !== null, '压测集没建起来，这条无法判定');
    const rounds = 200;
    const r = writeLatencies(M.state, rounds);
    expectEq(r.lat.length, rounds * 4, '计时样本数');
    // 每轮末尾把自己删掉，集合大小始终是 2000 —— 否则测的是「越来越大的库」。
    expectEq(core.counts(r.state).total, N, '压测后的集合大小');
    const p50 = percentile(r.lat, 50);
    const p95 = percentile(r.lat, 95);
    const limit = timeBudget('write');
    expectTrue(p95 <= limit, `写入 p95 超预算`, `p50 ${ms(p50)}，p95 ${ms(p95)}，最慢 ${ms(Math.max.apply(null, r.lat))}，预算 ${ms(limit)}`);
    return `${rounds * 4} 次写入：p50 ${ms(p50)}，p95 ${ms(p95)}（预算 ${ms(limit)}）`;
  }],

  ['查询路径：四种视图各自 p95 在预算内，且行数都对（含负向孪生）', () => {
    expectTrue(M.state !== null, '压测集没建起来，这条无法判定');
    const limit = timeBudget('query');
    const lines = [];
    for (const v of VIEWS) {
      const lat = [];
      let rows = 0;
      for (let i = 0; i < 60; i += 1) {
        const t0 = performance.now();
        const out = core.selectTodos(M.state, v.view);
        lat.push(performance.now() - t0);
        rows = out.length;
      }
      // 行数先对，再谈快慢。一个总是返回 0 行的查询快得毫无意义。
      expectEq(rows, v.rows(N), `「${v.label}」的行数`);
      const p95 = percentile(lat, 95);
      expectTrue(p95 <= limit, `「${v.label}」查询 p95 超预算`, `p95 ${ms(p95)}，预算 ${ms(limit)}，行数 ${rows}`);
      lines.push(`${v.label} ${rows} 行 p95 ${ms(p95)}`);
    }
    return `${lines.join('｜')}（预算 ${ms(limit)}）`;
  }],

  ['存档往返：2000 条 序列化+读回 在预算内，且逐字节无损', () => {
    expectTrue(M.state !== null, '压测集没建起来，这条无法判定');
    const t0 = performance.now();
    const raw = core.serialize(M.state);
    const back = core.deserialize(raw);
    const elapsed = performance.now() - t0;
    expectEq(back.recovered, false, '往返后的 recovered');
    expectEq(back.issues, [], '往返后的 issues');
    expectEq(back.state.todos.length, N, '读回来的条数');
    // 快不算数，无损才算数：再序列化一次必须逐字节相同。
    expectTrue(core.serialize(back.state) === raw, '往返后再序列化的字节不一致', `原 ${raw.length} 字节，重出 ${core.serialize(back.state).length} 字节`);
    const limit = timeBudget('saveLoad');
    expectTrue(elapsed <= limit, '存档往返超预算', `实际 ${ms(elapsed)}，预算 ${ms(limit)}，存档 ${(raw.length / 1048576).toFixed(2)} MB`);
    return `${(raw.length / 1048576).toFixed(2)} MB 存档往返 ${ms(elapsed)}（预算 ${ms(limit)}），recovered=false 且字节级无损`;
  }],

  // ======================================================================
  // 这条断言的**地板是 4.0，不是 0**。单次新增在不可变核心下必然是 O(n)：
  // 查重扫一遍 + `todos.concat` 复制一遍，两件都是 O(n)，所以数据量翻 4 倍
  // 耗时就翻 4 倍。
  //
  // **加索引解决不了这件事**，写下来免得下次有人再试：索引要住在 state 里，
  // 而 state 不可变 —— 每次插入都得复制一份索引，那本身就是 O(n)，净收益零。
  // 用原型链做免复制的索引会让查询退化成 O(链深)，更糟。而且就算查重完全
  // 免费，那一遍数组复制还在。真要让插入低于 O(n)，得换带结构共享的持久化
  // 数据结构 —— 那会毁掉「state 是一份普通 JSON」这条，而存档往返、深比较、
  // 序列化那几条断言全都建立在它上面。
  //
  // 所以上限 6 距离地板 4.0 只有 1.5 倍：**这条断言天生就紧，紧不等于该调宽。**
  // 它红的时候要问的是「有人加了第二类超线性的活吗」，不是「6 是不是小了」。
  //
  // 三轮实测是 x4.84 / x4.88 / x4.95，看着像在往上漂 —— 但每轮只有一个数据点，
  // 而「余量薄」和「其实在抛硬币」从报告上看长得一模一样。所以两个比值各测
  // 两轮、**两轮都断言**（比原来严，不是松），报告里带上两轮的差：那是判断
  // 「在漂」还是「在抖」唯一的依据。
  // ======================================================================
  ['规模比值：数据量 x4，查询与单次写入的耗时都不超过 6 倍（两轮各自断言）', () => {
    expectTrue(M.state !== null, '压测集没建起来，这条无法判定');
    const built = buildState(BIG);
    M.big = built.state;
    keepAlive.push(built.state);
    expectEq(core.counts(built.state).total, BIG, '大压测集条数');

    const probe = { title: '规模探针' };
    const paths = [
      { label: '查询', floor: 4.3, fn: s => core.selectTodos(s, HOT_VIEW) },
      { label: '单次新增', floor: 4.0, fn: s => core.addTodo(s, probe, { id: 'probe', now: 1 }) }
    ];

    const limit = budget('scaleRatio');
    const lines = [];
    for (const p of paths) {
      const a = ratioRound(p.fn);
      const b = ratioRound(p.fn);
      // 两轮都要在上限内。任意一轮超了都红 —— 挑「好看的那轮」就是在挑数据。
      for (const [i, round] of [a, b].entries()) {
        expectTrue(round.r <= limit, `「${p.label}」第 ${i + 1} 轮的规模比值超过 ${limit} 倍`,
          `n=${N} ${ms(round.small.perOp)}（${round.small.reps} 次取样）→ n=${BIG} ${ms(round.big.perOp)}（${round.big.reps} 次）= x${round.r.toFixed(2)}\n` +
          `这条路径的理论地板是 x${p.floor}。超过上限先问「是不是有人加了第二类超线性的活」，\n` +
          '别去调宽上限 —— 上限距地板只有 1.5 倍，它天生就紧。');
      }
      const spread = Math.abs(a.r - b.r);
      lines.push(`${p.label} x${a.r.toFixed(2)} / x${b.r.toFixed(2)}（两轮差 ${spread.toFixed(2)}，地板 x${p.floor}）`);
    }
    return `${lines.join('｜')}｜上限 x${limit}。两轮差远小于「距上限的余量」才说明是抖不是漂`;
  }],

  ['自证：同一套测量器套在故意二次 / 故意慢的实现上必须判红（阈值可达）', () => {
    // 先证明 p95 这把尺子本身是对的：已知输入，已知答案。
    const known = [];
    for (let i = 1; i <= 100; i += 1) known.push(i);
    expectEq(percentile(known, 95), 96, 'p95 在 1..100 上的取值');
    expectEq(percentile(known, 50), 51, 'p50 在 1..100 上的取值');

    expectTrue(M.big !== null, '大压测集没建起来，这条无法判定');
    const limit = budget('scaleRatio');
    const small = best(3, () => timed(() => quadraticRank(M.state)));
    const big = best(3, () => timed(() => quadraticRank(M.big)));
    const ratio = big.perOp / small.perOp;
    expectTrue(ratio > limit, '故意二次的实现没有被比值断言判红 —— 那条断言是装饰',
      `n=${N} ${ms(small.perOp)} → n=${BIG} ${ms(big.perOp)} = x${ratio.toFixed(2)}，没超过上限 x${limit}`);

    // 再证明 p95 与预算的比较真的会判红：故意慢三倍的操作。
    const wl = timeBudget('write');
    const target = wl * 3;
    const lat = [];
    for (let i = 0; i < 12; i += 1) {
      const t0 = performance.now();
      while (performance.now() - t0 < target) { /* 故意占着 */ }
      lat.push(performance.now() - t0);
    }
    const slowP95 = percentile(lat, 95);
    expectTrue(slowP95 > wl, '故意慢三倍的操作没有被 p95 断言判红',
      `p95 ${ms(slowP95)}，预算 ${ms(wl)}`);
    return `二次实现 x${ratio.toFixed(2)} > 上限 x${limit}；故意慢的 p95 ${ms(slowP95)} > 预算 ${ms(wl)}；p95 函数在已知输入上取值正确`;
  }],

  ['撤销栈：50 层的堆增长有上限，深拷贝对照组明显更大（历史只存引用）', () => {
    expectTrue(M.state !== null, '压测集没建起来，这条无法判定');
    const base = M.state;
    const before = heapMB();
    let h = hist.createHistory();
    let s = base;
    for (let i = 0; i < hist.HISTORY_LIMIT; i += 1) {
      h = hist.record(h, s);
      s = core.updateTodo(s, `p${i}`, { title: `第 ${i} 次改动` }, { now: 800000 + i });
    }
    keepAlive.push(h, s);
    const sharedMB = heapMB() - before;
    expectEq(hist.summary(h).undoDepth, hist.HISTORY_LIMIT, '撤销深度（先证明真的压满了）');

    // 对照组：如果历史存的是快照副本，就是这个量级。它同时证明这把尺子
    // 看得见膨胀 —— 一个永远读出 0 的内存测量和没测是一样的。
    const before2 = heapMB();
    const copies = [];
    for (let i = 0; i < hist.HISTORY_LIMIT; i += 1) copies.push(structuredClone(base));
    keepAlive.push(copies);
    const copyMB = heapMB() - before2;

    const limit = budget('historyHeapMB');
    expectTrue(sharedMB <= limit, '50 层撤销栈的堆增长超预算', `实际 ${sharedMB.toFixed(2)} MB，预算 ${limit} MB，深拷贝对照组 ${copyMB.toFixed(2)} MB`);
    expectTrue(copyMB > 5, '深拷贝对照组几乎没占内存 —— 是这把尺子坏了，不是历史省内存', `对照组 ${copyMB.toFixed(2)} MB`);
    expectTrue(copyMB > sharedMB * 3, '撤销栈和深拷贝占用差不多 —— 历史大概真的在存副本', `撤销栈 ${sharedMB.toFixed(2)} MB，深拷贝 ${copyMB.toFixed(2)} MB`);
    return `${hist.HISTORY_LIMIT} 层撤销栈 +${sharedMB.toFixed(2)} MB（预算 ${limit} MB）｜同样层数的深拷贝 +${copyMB.toFixed(2)} MB，差 ${(copyMB / Math.max(sharedMB, 0.01)).toFixed(1)} 倍`;
  }],

  ['负载下依然可复现：两遍同样输入的 SHA-256 相同', () => {
    const t0 = performance.now();
    const a = crypto.createHash('sha256').update(core.serialize(buildState(N).state)).digest('hex');
    const mid = performance.now();
    const b = crypto.createHash('sha256').update(core.serialize(buildState(N).state)).digest('hex');
    const end = performance.now();
    expectEq(a.length, 64, '摘要长度');
    expectTrue(a === b, '两遍同样输入的摘要不一致 —— 核心里混进了不确定的东西', `第一遍 ${a}\n第二遍 ${b}`);
    expectTrue(mid - t0 > 0 && end - mid > 0, '两遍里有一遍耗时为 0，像是没真的跑', `${ms(mid - t0)} / ${ms(end - mid)}`);
    return `两遍各 ${N} 条：${ms(mid - t0)} / ${ms(end - mid)}，摘要同为 ${a.slice(0, 16)}…`;
  }],

  ['自审：verify.yml 里每条闸门都真的执行了闸门脚本，perf 那条带 --expose-gc', () => {
    // 一条压根没执行的性能闸门是最坏的那种绿。产物名和日志名的对齐由快闸门
    // 守着，但那两条看不见「这个 job 到底跑了什么」—— 它完全可以 echo 一句
    // 假日志然后全绿。
    const p = path.join(ROOT, '.github', 'workflows', 'verify.yml');
    const text = fs.readFileSync(p, 'utf8');
    const matrix = [...text.matchAll(/^\s*slug:\s*([A-Za-z0-9_-]+)\s*$/gm)].map(m => m[1]);
    const re = /node[^\n]*scripts\/verify[A-Za-z0-9._-]*\.mjs[^\n]*tee\s+test\/artifacts\/stdout-([^\s]+)\.log/g;
    const hits = [...text.matchAll(re)].map(m => m[1]);
    expectTrue(hits.length > 0, '一条「跑闸门脚本并 tee 成日志」的命令都没扫到 —— 是扫描器坏了，不是配置对了', text.slice(0, 400));
    const slugs = new Set();
    for (const token of hits) {
      if (token.includes('${{matrix.slug}}')) {
        expectTrue(matrix.length > 0, 'workflow 用了 matrix.slug 但扫不到 slug 列表', token);
        for (const s of matrix) slugs.add(token.split('${{matrix.slug}}').join(s));
      } else slugs.add(token);
    }
    expectEq([...slugs].sort(), GATES.map(g => g.slug).sort(), '真的执行了闸门脚本的 slug 集合');
    const perfLine = text.split('\n').find(l => l.includes('scripts/verify-perf.mjs') && l.includes('tee'));
    expectTrue(Boolean(perfLine), 'verify.yml 里没有跑 verify-perf.mjs 的那一行');
    // 脚本自己会重启补上这个参数，但显式写出来能省一次进程启动，也让意图
    // 留在 workflow 里。
    expectTrue(perfLine.includes('--expose-gc'), 'perf 那一行没有 --expose-gc', perfLine.trim());
    return `${hits.length} 条命令展开成 ${slugs.size} 个 slug，与 GATES 完全相等；perf 带 --expose-gc`;
  }],

  ['自检：执行条数等于清单数，且每条预算都真的被用过', () => {
    const actual = report.checks.length + 1;
    expectEq(actual, CHECKS.length, '本次实际执行的检查数');
    expectEq(CHECKS.length, MANIFEST.perf, 'scripts/manifest.json 里登记的条数');
    // 没人用的预算就是死数字：它会一直躺在那里，看起来像有人在守。
    const unused = Object.keys(BUDGETS).filter(k => !usedBudgets.has(k));
    expectEq(unused, [], '没有被任何断言用到的预算');
    const titles = report.checks.map(c => c.title);
    expectEq(titles.filter((t, i) => titles.indexOf(t) !== i), [], '重复的检查标题');
    return `${actual} 条检查（等号断言）｜${Object.keys(BUDGETS).length} 条预算全部被用过｜校准系数 x${(M.scale || 0).toFixed(2)}`;
  }]
];

for (const [title, fn] of CHECKS) report.check(title, fn);

fs.mkdirSync(ARTIFACTS, { recursive: true });
report.save(ARTIFACTS, SLUG);
process.stdout.write(`\n共执行 ${report.total} 条检查，通过 ${report.passed}，失败 ${report.failed}\n`);
process.exit(report.ok ? 0 : 1);
