// 公开镜像的路径契约。**唯一**一份：同步脚本按它挑文件，审计闸门按它核对
// 公开仓真实的树。各写一份的话，两边会各自漂,而漂的那一天不会有任何动静，
// 因为「同步成功」和「同步了错的东西」在私有仓里长得一模一样。

export const MIRROR_REPO = 'supercubegame/todox-desktop';

// 允许出现在公开仓的顶层条目。这是白名单：不在里面的一律不同步。
// 白名单而不是黑名单 —— 黑名单会在新增目录时默认泄漏，方向是反的。
export const ALLOW_TOP = ['src', 'docs', 'README.md', 'LICENSE', 'package.json', '.gitignore'];

// 必须在公开仓里出现 0 次的路径。这条负向孪生是整件事的**全部意义**：
// 正向那侧（src 在不在）在同步完全没生效时也会通过 —— 因为公开仓上一次的
// 内容还在那儿。只有这一侧能证明「不该给的东西真的没给」。
//
// 注意每一项都以 / 结尾或是精确文件名：用 includes 匹配裸字符串会让
// src/renderer/scripts.js 这种正常文件被误判成 scripts/ 目录。
export const DENY_PATHS = [
  '.github/',
  'scripts/',
  'test/',
  'AGENTS.md',
  'CLAUDE.md'
];

// 公开仓里必须真实存在的文件（不只是顶层目录在）。
// 「src 目录存在」证明不了业务代码在里面。
export const REQUIRE_FILES = [
  'README.md',
  'LICENSE',
  'package.json',
  'src/core/store.js',
  'src/main/main.js',
  'src/main/persist.js',
  'src/preload/preload.js',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/styles.css',
  'docs/screenshots/light-list.png',
  'docs/screenshots/search.png',
  'docs/screenshots/dark-settings.png'
];

// 公开仓 package.json 里不许出现的脚本键。它们指向 scripts/ 下的文件，
// 而那个目录不同步 —— 留着就是给别人一条必然报错的命令。
export const DENY_SCRIPT_KEYS = ['verify', 'verify:e2e', 'verify:pack', 'verify:dist', 'verify:release'];
export const DENY_DEV_DEPS = ['playwright-core'];

export function isDenied(p) {
  const s = String(p);
  return DENY_PATHS.some(d => (d.endsWith('/') ? s.startsWith(d) : s === d));
}

export function topOf(p) { return String(p).split('/')[0]; }
