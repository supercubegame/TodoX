// README 里那几张截图的**唯一**清单。
//
// 为什么要单独一份：生成器按它产图，快闸门按它反查「README 引用的图」与
// 「docs/screenshots 里实际存在的图」是否三方相等。各写一份的话，改了名字
// 只会得到一个 README 里的破图 —— 而破图不会让任何东西变红。
export const SHOT_DIR = 'docs/screenshots';

// rows 是这张图上**应该**出现几条待办。它不是装饰：截图那一刻 capturePage
// 给的可能是上一帧，于是 DOM 说 1 行、位图里却是 3 行。生成器靠
// rows × PROBE_PER_ROW 一直轮询到两边对上，这条顺带变成了内容断言 ——
// 「这张图上画的是不是我想要的那个状态」。
export const SHOTS = [
  { slug: 'light-list', theme: 'light', rows: 3, caption: '浅色主题 · 列表、优先级与筛选页签' },
  { slug: 'search', theme: 'light', rows: 1, caption: '搜索：关键词同时匹配标题与备注' },
  { slug: 'dark-settings', theme: 'dark', rows: 3, caption: '深色主题 · 设置面板（主题 / 字号 / 删除确认 / 默认值）' }
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

// 一行贡献多少个探针像素。实测值：.probe 是 8x22，抗锯齿之后稳定落在 164,
// 端到端闸门里 3 行也一直是 492 = 3 x 164。
//
// 改 styles.css 里 .probe 的宽高必须重算这个数（见 AGENTS.md「相互耦合的参数」）。
// 容差取 ±24：1 行(164) 与 3 行(492) 的区间离得很远，不会互相吃掉,
// 也就是说这条断言不可能因为容差太宽而变空。
export const PROBE_PER_ROW = 164;
export const PROBE_TOL = 24;

// 只用来抓「空图 / 截图接口什么都没返回」。**不是**画面质量的度量 ——
// 大片纯色的界面 PNG 实测压到 15KB 左右，第一版拍脑袋写 20KB 直接把三张
// 真图判成假的。取 5KB，对实测最小值留三倍余量。
// 真正承重的是探针像素数与背景色令牌那两条。
export const MIN_BYTES = 5000;
