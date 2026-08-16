// 纯核心（src/core/store.js）的真实行为断言，26 条。
//
// 这些条目从 verify.mjs 搬过来，**标题与判据逐字未改**。拆的理由写在
// verify-kit.mjs 头部：一次整文件替换到 72KB 就不可信，而那不是小心能解决的事。
import {
  getCore, sample, ctx, deepFreeze,
  expectEq, expectTrue, expectThrows, isDeepStrictEqual
} from './verify-kit.mjs';

export const STORE_CHECKS = [
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

  // 这条是 2026-08-14 逐条复核 PITFALLS「测不出来的」时补上的，而且它补的是
  // 那一节里**一句写错的话**：「clampBounds 的多屏分支在 CI 里根本走不到」。
  //
  // 那句话把两件事混成了一件。端到端闸门走不到是真的 —— xvfb 里没有窗口管理器，
  // 也只有一个屏。但 **clampBounds 是纯函数，area 只是个普通参数**：快闸门想喂
  // 什么工作区就喂什么。把「端到端测不了」写成「测不了」，代价是那个方向被
  // 永久豁免了监督 —— 没人会去核对一件已经宣布无法核对的事。
  //
  // 代价是实测出来的，不是推的：上面那两条断言喂的 area 原点全是 (0,0)，于是把
  // 函数里的 a.x / a.y 整个换成字面量 0，**58 条断言一条都不会红**。
  ['窗口：非零原点的工作区也夹得对（副屏 / 负坐标 / 任务栏偏移），含变异体自证', () => {
    const c = getCore();
    const RIGHT = { x: 1920, y: 0, width: 1920, height: 1080 };
    const cases = [
      ['右侧副屏：主屏坐标被拉进副屏', { x: 100, y: 100, width: 800, height: 600 }, RIGHT, { x: 1920, y: 100, width: 800, height: 600 }],
      ['副屏内的坐标原样保留', { x: 2000, y: 200, width: 800, height: 600 }, RIGHT, { x: 2000, y: 200, width: 800, height: 600 }],
      ['左侧副屏：原点是负数', { x: 500, y: 0, width: 800, height: 600 }, { x: -1920, y: 0, width: 1920, height: 1080 }, { x: -800, y: 0, width: 800, height: 600 }],
      ['顶部任务栏的 y 偏移', { x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 48, width: 1920, height: 1032 }, { x: 0, y: 48, width: 800, height: 600 }]
    ];
    for (const [name, bounds, area, want] of cases) expectEq(c.clampBounds(bounds, area), want, name);

    // 变异体：只把工作区原点当成 0，其它逻辑逐字照拄。
    function originBlind(b, a) {
      const w = Math.max(480, Math.min(Math.round(b.width), a.width));
      const h = Math.max(360, Math.min(Math.round(b.height), a.height));
      return {
        x: Math.max(0, Math.min(Math.round(b.x), a.width - w)),
        y: Math.max(0, Math.min(Math.round(b.y), a.height - h)),
        width: w, height: h
      };
    }
    // 先证明它是个**像样的**变异体：在零原点的工作区上它和真货完全一致。
    // 这一步不做的话，这条自证就退化成「随便造个坏函数当然会红」。
    const zero = { x: 0, y: 0, width: 1280, height: 1000 };
    for (const b of [{ x: -500, y: -500, width: 800, height: 600 }, { x: 5000, y: 5000, width: 800, height: 600 }]) {
      expectEq(originBlind(b, zero), c.clampBounds(b, zero),
        '变异体在 (0,0) 工作区上应与真货一致 —— 那正是它藏得住的原因');
    }
    const survived = cases
      .filter(([, b, a]) => isDeepStrictEqual(originBlind(b, a), c.clampBounds(b, a)))
      .map(([n]) => n);
    expectEq(survived, [], '「把工作区原点当成 0」的变异体活下来的输入');

    return `${cases.length} 组非零原点输入全部夹对；变异体在 (0,0) 工作区上与真货一致（所以上面两条放它过去），` +
      `在这 ${cases.length} 组上全部被抓住`;
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
  }]
];
