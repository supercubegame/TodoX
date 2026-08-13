// README 里那几张截图的**唯一**清单。
//
// 为什么要单独一份：生成器按它产图，快闸门按它反查「README 引用的图」与
// 「docs/screenshots 里实际存在的图」是否三方相等。各写一份的话，改了名字
// 只会得到一个 README 里的破图 —— 而破图不会让任何东西变红。
export const SHOT_DIR = 'docs/screenshots';

export const SHOTS = [
  { slug: 'light-list', theme: 'light', caption: '浅色主题 · 列表、优先级与筛选页签' },
  { slug: 'search', theme: 'light', caption: '搜索：关键词同时匹配标题与备注' },
  { slug: 'dark-settings', theme: 'dark', caption: '深色主题 · 设置面板（主题 / 字号 / 删除确认 / 默认值）' }
];

export function shotPath(slug) { return `${SHOT_DIR}/${slug}.png`; }

// 主题令牌。改 styles.css 里的背景色必须同步改这里，否则「深色截图的背景
// 真的是深色」那条断言红的是尺子不是产品。见 AGENTS.md「相互耦合的参数」。
export const THEME_BG = {
  light: { r: 246, g: 247, b: 249 },
  dark: { r: 22, g: 26, b: 32 }
};

// 待办行标记条的颜色。整个应用里只有那里用它，所以「这张图上有几个探针像素」
// 等价于「列表真的画出来了几行」。
export const PROBE = { r: 0, g: 214, b: 132 };
