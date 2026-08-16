// 静态不变量：核心纯度、主进程安全与窗口、打包目标、文档，9 条。
// **标题与判据逐字未改。**
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, getCore, getHist, sample, deepFreeze, walk, codeOf, missingNeedles,
  readIfExists, stripComments, expectEq, expectTrue, MOVED_SECTIONS
} from './verify-kit.mjs';
import { SHOTS, SHOT_DIR, MIN_BYTES } from './shots.mjs';

export const STATIC_CHECKS = [
  ['纯度：src/core 不出现 Date.now / Math.random / fs / process / DOM', () => {
    const dir = path.join(ROOT, 'src', 'core');
    const files = walk(dir);
    expectTrue(files.length > 0, 'src/core 下一个文件都没有', `目录: ${dir}`);
    const banned = ['Date.now', 'new Date', 'Math.random', "require('fs')", 'require("fs")', 'process.', 'window.', 'document.', 'localStorage', 'fetch('];
    const hits = [];
    let scanned = 0;
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      const raw = fs.readFileSync(f, 'utf8');
      // 只扫会执行的代码。注释里写「别往里塞 Date.now()」是文档，不是违规 ——
      // 上一版没剥注释，第一次跑就被自己的说明文字抓了，根因在夹具不在产品。
      const code = stripComments(raw);
      expectTrue(code.includes('module.exports'), `剥注释后 ${rel} 里连 module.exports 都没了`, `原文 ${raw.length} 字节 -> 剥后 ${code.length} 字节，扫描器坏了`);
      expectTrue(code.length > raw.length * 0.4, `剥注释把 ${rel} 剥掉了太多`, `${raw.length} -> ${code.length} 字节`);
      scanned += code.length;
      for (const b of banned) if (code.includes(b)) hits.push(`${rel} 含 ${b}`);
    }
    expectEq(hits, [], '核心里的不纯用法');
    return `${files.length} 个核心文件、${scanned} 字节可执行代码，10 类不纯用法全部 0 命中`;
  }],

  ['纯度：同样输入连续两次调用结果深度相等', () => {
    const c = getCore();
    const h = getHist();
    const s = deepFreeze(sample());
    const a = c.selectTodos(s, { filter: 'all', sort: 'title', query: '' });
    const b = c.selectTodos(s, { filter: 'all', sort: 'title', query: '' });
    expectEq(a, b, '两次查询');
    expectEq(c.serialize(s), c.serialize(s), '两次序列化');
    expectEq(c.counts(s), { total: 3, active: 3, completed: 0 }, '计数');
    expectEq(h.record(h.createHistory(), s), h.record(h.createHistory(), s), '两次记录');
    return '查询、序列化、记录历史各跑两次，结果逐字节一致';
  }],

  // 这条原来在没剥注释的原文上找那四个关键词。实测：把 clampBounds / setBounds /
  // minWidth / minHeight 的真实调用全删掉、只写一句注释，它照样绿。
  //
  // 负向那侧同时也是错的：一句「注意：绝对不要写成 resizable: false」的注释会让
  // 它**误报成红**。剥注释一次修好两侧,这就是为什么剥注释要做在扫描器里，
  // 而不是靠「别在注释里提这些词」的约定（拿产品迁就尺子）。
  ['主进程：窗口可调整大小且用 clampBounds 恢复（读可执行代码，含变异体自证）', () => {
    const needles = ['minWidth', 'minHeight', 'clampBounds', 'setBounds'];
    const code = codeOf('src/main/main.js');
    expectEq(missingNeedles(code, needles), [], 'main.js 里缺的窗口关键词（只看可执行代码）');
    // 负向：真的把窗口设成不可调整大小要红,而注释里提到这串字不算。
    expectTrue(!code.includes('resizable: false'), 'main.js 把窗口设成了不可调整大小',
      '需求要求窗口大小可以随意调节。注意这条只看可执行代码 —— 注释里提到这串字不算违规。');
    expectTrue(code.includes('resizable: true'), 'main.js 里找不到 resizable: true',
      '光断言「没有 false」是空断言：整段配置被删掉也会通过。正向那侧必须也在。');

    // 自证一：把四个关键词的真实调用注释掉，剥注释后必须判红。
    const raw = readIfExists('src/main/main.js');
    const blinded = raw
      .replace('core.clampBounds(state.bounds, workArea())', '/* core.clampBounds(...) */ state.bounds')
      .replace('minWidth: core.MIN_WIDTH', '/* minWidth: core.MIN_WIDTH */')
      .replace('core.setBounds(state, win.getBounds(), workArea())', '/* core.setBounds(...) */ state');
    expectTrue(blinded !== raw, '构造变异体时没替换到任何东西 —— 夹具坏了，不是产品对了');
    expectTrue(missingNeedles(raw, needles).length === 0, '真货应该四个都命中');
    expectTrue(missingNeedles(stripComments(blinded), needles).length >= 1,
      '把真实调用注释掉之后仍然没判红 —— 那这条还是装饰',
      '这正是旧版的行为：它在没剥注释的原文上找关键词，而注释里那几个词照样命中。');

    // 自证二：负向那侧不许被注释误报。
    const commented = raw.replace('    resizable: true,', '    // 别写成 resizable: false\n    resizable: true,');
    expectTrue(commented !== raw, '构造注释变异体时没替换到任何东西 —— 夹具坏了');
    expectTrue(!stripComments(commented).includes('resizable: false'),
      '注释里提到 resizable: false 被误判成违规 —— 剥注释没起作用');
    expectTrue(raw.replace('resizable: true', 'resizable: false').includes('resizable: false'),
      '真的改成 false 之后应该命中 —— 否则负向那侧是空的');

    return `${needles.length} 个窗口关键词都在可执行代码里，resizable: true 在、false 不在；` +
      '两个变异体都被抓住（注释掉真实调用 / 注释里提到 false 不误报）';
  }],

  ['主进程：contextIsolation / nodeIntegration / preload 安全不变量（读可执行代码，含变异体自证）', () => {
    const needles = ['contextIsolation: true', 'nodeIntegration: false', 'preload:'];
    const code = codeOf('src/main/main.js');
    expectEq(missingNeedles(code, needles), [], '缺的安全不变量（只看可执行代码）');
    const preCode = codeOf('src/preload/preload.js');
    expectTrue(preCode.includes('contextBridge'), 'preload 没走 contextBridge（只看可执行代码）',
      preCode.slice(0, 300));

    // 自证：把三条安全设置注掉,这是调试时最常见的动作，也是这条断言唯一
    // 要防的那件事。剥注释后必须判红；在原文上它会活下来（旧版的行为）。
    const raw = readIfExists('src/main/main.js');
    const unsafe = raw
      .replace('      contextIsolation: true,', '      // 先注掉调试：contextIsolation: true,')
      .replace('      nodeIntegration: false,', '      // 先注掉调试：nodeIntegration: false,');
    expectTrue(unsafe !== raw, '构造变异体时没替换到任何东西 —— 夹具坏了');
    expectTrue(missingNeedles(unsafe, needles).length === 0,
      '在没剥注释的原文上，被注掉的安全设置应该仍然「命中」—— 这正是旧版为什么是装饰');
    expectTrue(missingNeedles(stripComments(unsafe), needles).length >= 2,
      '注掉两条安全设置之后没判红 —— 那这条还是装饰');

    // preload 那侧同样自证：改成直接挂 window，contextBridge 只剩注释。
    const preRaw = readIfExists('src/preload/preload.js');
    const leaky = stripComments(preRaw).split('contextBridge').join('window.__x');
    expectTrue(!leaky.includes('contextBridge'), '构造 preload 变异体失败 —— 夹具坏了');

    return '三条安全不变量 + preload 走 contextBridge，全部在**可执行代码**里；' +
      '变异体（把 contextIsolation / nodeIntegration 注掉）不剥注释时活下来，剥注释后被抓住';
  }],

  ['打包：win / mac / linux 三平台 target 齐全', () => {
    const pkg = JSON.parse(readIfExists('package.json'));
    const b = pkg.build || {};
    for (const plat of ['win', 'mac', 'linux']) {
      const t = b[plat] && b[plat].target;
      expectTrue(Array.isArray(t) && t.length > 0, `build.${plat}.target 缺失或为空`, JSON.stringify(b, null, 2));
    }
    expectTrue(Boolean(b.appId), '缺少 appId');
    expectEq(pkg.main, 'src/main/main.js', 'main 入口');
    return `win=${b.win.target.join('/')}｜mac=${b.mac.target.join('/')}｜linux=${b.linux.target.join('/')}`;
  }],

  ['打包：.deb 的 maintainer 存在且是邮箱形状', () => {
    const pkg = JSON.parse(readIfExists('package.json'));
    const linux = (pkg.build && pkg.build.linux) || {};
    const targets = (linux.target || []).map(t => String(t).toLowerCase());
    expectTrue(targets.includes('deb'), 'linux.target 里没有 deb', JSON.stringify(linux, null, 2));
    const author = pkg.author;
    const email = author && typeof author === 'object' ? author.email : null;
    const maintainer = linux.maintainer || null;
    expectTrue(
      (typeof email === 'string' && email.includes('@')) || (typeof maintainer === 'string' && maintainer.includes('@')),
      'deb 目标缺少 maintainer',
      `author=${JSON.stringify(author)}\nlinux.maintainer=${JSON.stringify(maintainer)}\n` +
      "electron-builder 会报 Please specify author 'email' in the application package.json，" +
      '而 AppImage 那一半照样成功 —— 所以症状是「Linux 只出了 1 个产物」，不是「构建全挂」。'
    );
    return `deb 在 target 里，maintainer=${maintainer || email}`;
  }],

  ['文档：AGENTS.md ≤ 200 行，两节已挪进 PITFALLS 且没有留副本', () => {
    const agents = readIfExists('AGENTS.md');
    const n = agents.split('\n').length;
    expectTrue(n <= 200, `AGENTS.md ${n} 行，超过 200 行上限`,
      '写长了模型会开始忽略里面的指令。这条上限只有断言守得住，写在文件里没用。\n' +
      '正确反应是压措辞或者把增长最快的那节挪去 docs/PITFALLS.md,**不是调宽上限**。');
    const pit = readIfExists('docs/PITFALLS.md');
    const pitLines = pit.split('\n').length;
    expectTrue(pitLines >= 40, `docs/PITFALLS.md 只有 ${pitLines} 行，像是没真的搬过去`, pit.slice(0, 300));
    expectTrue(agents.includes('docs/PITFALLS.md'), 'AGENTS.md 里没有引用 docs/PITFALLS.md',
      '拆出去而不留指路牌，等于把那份档案藏起来了。');
    for (const h of MOVED_SECTIONS) {
      expectTrue(pit.includes(h), `docs/PITFALLS.md 里找不到「${h}」`, '这节应该被挪过去了');
      expectTrue(!agents.includes(h), `AGENTS.md 里还留着「${h}」`,
        '两处各留一份会各自长歪，而没有任何断言看得见 —— 这条负向就是为这件事写的。');
    }
    return `AGENTS.md ${n} / 200 行（余 ${200 - n}）｜PITFALLS ${pitLines} 行，${MOVED_SECTIONS.length} 节正反两侧都对`;
  }],

  ['文档：AGENTS.md 与 CLAUDE.md 逐字节相同', () => {
    const a = fs.readFileSync(path.join(ROOT, 'AGENTS.md'));
    const b = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'));
    expectTrue(a.equals(b), '两份规矩文件已经分叉', `AGENTS.md ${a.length} 字节 / CLAUDE.md ${b.length} 字节`);
    return `同一份内容，${a.length} 字节`;
  }],

  ['文档：README 引用的截图、SHOTS 清单、磁盘文件三方相等', () => {
    const readme = readIfExists('README.md');
    const referenced = [...readme.matchAll(/docs\/screenshots\/([A-Za-z0-9._-]+\.png)/g)].map(m => m[1]);
    expectTrue(referenced.length > 0, 'README 里一张截图都没引用 —— 是扫描器坏了，不是 README 对了', readme.slice(0, 300));
    const want = SHOTS.map(s => `${s.slug}.png`).sort();
    expectEq([...new Set(referenced)].sort(), want, 'README 引用的截图集合');
    const dir = path.join(ROOT, SHOT_DIR);
    const onDisk = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.png')).sort();
    expectEq(onDisk, want, `${SHOT_DIR} 下实际存在的截图集合`);
    const sizes = want.map(n => ({ n, bytes: fs.statSync(path.join(dir, n)).size }));
    const empty = sizes.filter(s => s.bytes <= MIN_BYTES).map(s => `${s.n}: ${s.bytes} 字节`);
    expectEq(empty, [], `小于 ${MIN_BYTES} 字节的截图（像是空图）`);
    return `${want.length} 张图三方一致：${sizes.map(s => `${s.n} ${(s.bytes / 1024).toFixed(0)}KB`).join('，')}`;
  }]
];
