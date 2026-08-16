// 撤销 / 重做（src/core/history.js）的断言，6 条。**标题与判据逐字未改。**
import {
  getCore, getHist, sample, deepFreeze, codeOf, missingNeedles, readIfExists, stripComments,
  expectEq, expectTrue, expectThrows
} from './verify-kit.mjs';

export const HISTORY_CHECKS = [
  ['历史：初始为空，记录一次后深度 1（摘要正确）', () => {
    const h = getHist();
    const empty = h.createHistory();
    expectEq(h.summary(empty), { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0, limit: h.HISTORY_LIMIT }, '空历史的摘要');
    const after = h.record(empty, sample());
    expectEq(h.summary(after), { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, limit: h.HISTORY_LIMIT }, '记录一次后的摘要');
    expectEq(after.future, [], '记录之后的 future');
    return `上限 ${h.HISTORY_LIMIT}；空历史 canUndo=false，记录一次后 canUndo=true 且 canRedo 仍为 false`;
  }],

  ['历史：撤销回到上一状态，重做再回来，且不改动入参', () => {
    const c = getCore();
    const h = getHist();
    const s0 = sample();
    const s1 = c.removeTodo(s0, 'b');
    const h1 = deepFreeze(h.record(h.createHistory(), s0));
    const frozenBefore = JSON.stringify(h1);

    const back = h.undo(h1, s1);
    expectEq(back.state, s0, '撤销后的状态');
    expectEq(back.history.past, [], '撤销后的 past');
    expectEq(back.history.future.length, 1, '撤销后的 future 深度');

    const fwd = h.redo(back.history, back.state);
    expectEq(fwd.state, s1, '重做后的状态');
    expectEq(fwd.history.future, [], '重做后的 future');
    expectEq(fwd.history.past.length, 1, '重做后的 past 深度');

    expectEq(JSON.stringify(h1), frozenBefore, '原历史');
    return '3 条 -> 删 1 条 -> 撤销回 3 条 -> 重做回 2 条，原历史逐字节未变';
  }],

  ['历史：空历史撤销与无重做项时重做各自抛错（负向）', () => {
    const h = getHist();
    const s = sample();
    expectThrows(() => h.undo(h.createHistory(), s), 'NOTHING_TO_UNDO', '空历史撤销');
    expectThrows(() => h.redo(h.createHistory(), s), 'NOTHING_TO_REDO', '空历史重做');
    const recorded = h.record(h.createHistory(), s);
    expectThrows(() => h.redo(recorded, s), 'NOTHING_TO_REDO', '只记录过就重做');
    return '三种走不通的路径都抛对应错误码，而不是静默返回原状态';
  }],

  ['历史：新改动清空重做链（负向孪生）', () => {
    const c = getCore();
    const h = getHist();
    const s0 = sample();
    const s1 = c.removeTodo(s0, 'b');
    const back = h.undo(h.record(h.createHistory(), s0), s1);
    expectEq(h.summary(back.history).canRedo, true, '撤销之后应该可以重做');
    const s2 = c.removeTodo(back.state, 'c');
    const branched = h.record(back.history, back.state);
    expectEq(h.summary(branched).canRedo, false, '新改动之后还能重做');
    expectThrows(() => h.redo(branched, s2), 'NOTHING_TO_REDO', '新分支之后重做');
    return '撤销后 canRedo=true；再改一次之后 canRedo=false 且重做抛错';
  }],

  ['历史：上限真的可达，最老那份被丢掉（不是装饰）', () => {
    const c = getCore();
    const h = getHist();
    const limit = h.HISTORY_LIMIT;
    let s = c.createState();
    let history = h.createHistory();
    const first = s;
    for (let i = 0; i < limit + 1; i += 1) {
      history = h.record(history, s);
      s = c.addTodo(s, { title: `第 ${i} 条` }, { id: `h${i}`, now: i });
    }
    expectEq(history.past.length, limit, `推 ${limit + 1} 次之后的 past 深度`);
    expectEq(history.past[0].todos.length, 1, '栈底状态的待办数');
    expectEq(history.past.filter(x => x === first).length, 0, '最初那份状态在栈里的出现次数');
    return `上限 ${limit}：推 ${limit + 1} 次后深度恰好 ${limit}，最初那份已被挤出（栈底变成有 1 条的状态）`;
  }],

  // 这条的后半段（主进程 / preload / 界面三处都接上了）原来在**没剥注释**的
  // 原文上找关键词。2026-08-14 实测：把那三处的真实代码全删掉、只在注释里
  // 提到它们，这条照样绿。现在走 codeOf()，并带一个变异体自证。
  ['历史：不进存档，且主进程与界面都真的接上了（读可执行代码，含变异体自证）', () => {
    const c = getCore();
    const h = getHist();
    const s = sample();
    const raw = c.serialize(s);
    expectEq(JSON.parse(raw).history, undefined, '存档里的 history 字段');
    expectEq(Object.keys(JSON.parse(raw)).sort(), ['bounds', 'settings', 'todos', 'version'], '存档的顶层字段');
    expectEq(c.deserialize(raw).state.history, undefined, '读回来的 state 里的 history 字段');

    // 光有核心不够：主进程、preload、界面三处都要真的接上，否则功能对用户
    // 不存在，而上面那几条照样全绿 —— 那是覆盖缺口。
    const mainNeedles = ["ipcMain.handle('history:undo'", "ipcMain.handle('history:redo'", 'hist.record'];
    const mainCode = codeOf('src/main/main.js');
    expectEq(missingNeedles(mainCode, mainNeedles), [], 'main.js 里缺的接线（只看可执行代码）');
    const preCode = codeOf('src/preload/preload.js');
    expectEq(missingNeedles(preCode, ['history:undo', 'history:redo']), [], 'preload 里缺的暴露');
    const htmlCode = codeOf('src/renderer/index.html');
    expectEq(missingNeedles(htmlCode, ['data-testid="undo"', 'data-testid="redo"']), [], '界面上缺的按钮');
    expectEq(h.summary(h.createHistory()).undoDepth, 0, '摘要的初始深度');

    // 自证：把那条 IPC 注册换成一句 TODO 注释。剥注释之后必须判红,
    // 而在**没剥注释**的原文上它会活下来，那正是这条断言之前的样子。
    const tampered = readIfExists('src/main/main.js')
      .replace("ipcMain.handle('history:undo'", "// TODO 接回来：ipcMain.handle('history:undo'");
    expectTrue(tampered !== readIfExists('src/main/main.js'), '构造变异体时没替换到任何东西 —— 夹具坏了');
    expectTrue(missingNeedles(tampered, mainNeedles).length === 0,
      '在没剥注释的原文上，被注释掉的 IPC 应该仍然「命中」—— 这正是旧版为什么是装饰');
    expectTrue(missingNeedles(stripComments(tampered), mainNeedles).length >= 1,
      '剥注释之后仍然没判红 —— 那这条还是装饰');

    return '存档顶层只有 4 个字段（无 history）；主进程 IPC、preload、界面按钮三处都在**可执行代码**里' +
      '（变异体：把 IPC 注册改成注释,不剥注释时活下来，剥注释后被抓住）';
  }]
];
