# TodoX · 项目规矩

Electron 三平台待办事项应用。改完任何东西，**必须跑闸门**。

## 铁律

1. `npm run verify` 通过才算改完。红了先看「闸门红了先查夹具」那节。
2. `src/core/` 必须保持纯净：不读文件、不碰 DOM、不发网络、**不用 `Date.now()`、
   不用未播种的随机**。时间和 id 一律由调用方通过 `ctx = { id, now }` 注入。
   理由：可以断言「同样输入必然同样输出」，可以毫秒级压测，同一份逻辑换个外壳
   就能复用。图省事往里塞一个 `Date.now()` 会一次性毁掉这三样。快闸门有一条
   扫描在守（只扫可执行代码，注释里提这些名字不算违规）。
3. `window.__DIAG__` 是只读诊断出口。**字段可以增加，不能删改**，否则端到端
   闸门会当场变哑。
4. 密钥只走仓库 secrets。代码、日志、报告里一个字符都不能出现。
5. 新增可验证行为，顺手补一条断言，并更新 `scripts/manifest.json` 里的条数。
6. **发布分支上的改动必须回流 main。** 已经犯过两次，现在有断言在守（见下）。

## 结构

```
src/core/store.js       纯函数状态核心：CRUD / 查询 / 设置 / 窗口尺寸 / 存档
src/main/main.js        Electron 主进程：窗口、IPC、持久化编排（唯一的状态所有者）
src/main/persist.js     原子落盘（写临时文件再 rename）
src/preload/preload.js  contextBridge 暴露的 window.todox
src/renderer/           界面。只渲染 + 发意图，不持有业务规则
mirror/                 公开镜像用的 README 与 LICENSE（不参与应用构建）
scripts/verify.mjs      快闸门：纯核心 + 静态不变量 + 四份 workflow 自审（51 条）
scripts/verify-e2e.mjs  端到端闸门：真起 Electron，真操作，真断言（18 条）
scripts/verify-pack.mjs 打包闸门：三平台各打一次 --dir（每平台 4 条）
scripts/verify-dist.mjs 安装包闸门：三平台各打真安装包（每平台 6 条）
scripts/verify-release.mjs 发布资产校验：把 Release 从 API 读回来（6 条）
scripts/shoot.mjs       截图生成器：真起 Electron 截 README 用的图（8 条）
scripts/verify-mirror.mjs 镜像审计 + 版本回流：读公开仓真实的树（10 条）
scripts/lib/compose.mjs 报告合成，四条流水线共用
scripts/lib/mirror.mjs  公开镜像的路径白名单与黑名单，唯一一份
```

## 四条流水线

- `verify.yml` — 任何分支推送都跑。快闸门 + 端到端 + 三平台打包。
- `release.yml` — **只在 `release/**` 上跑**。三平台打真安装包 → 建 Release →
  把 Release 读回来校验资产。发版就是推一个 `release/vX.Y.Z` 分支。
- `screenshots.yml` — 只在 `docs/**` 与 `shots/**` 上跑。生成 README 用的截图，
  闸门绿了才把 PNG 回写进仓库。
- `mirror.yml` — 推 `main` 就同步一次公开镜像 `supercubegame/todox-desktop`：
  白名单拷贝 → 全新历史强推 → **回头读公开仓的真实树做审计**。

回写都走 `supercubegame/ci-workflows` 那一份共享 workflow，本地不许再抄一份。

## 命令

```
npm start           本地跑起来
npm run verify      快闸门（几十秒，零依赖，每次改动都要跑）
npm run verify:e2e  端到端闸门（需要 npm install；Linux 上用 xvfb-run）
npm run verify:pack 打包闸门（需要 TODOX_PACK_SLUG=pack-linux|pack-mac|pack-win）
npm run verify:dist 安装包闸门（需要 TODOX_DIST_SLUG=dist-linux|dist-mac|dist-win）
```

## 相互耦合的参数：改一个必须重算另一个

- **最小窗口尺寸 480x360** ↔ 端到端闸门里 `getMinimumSize()` 的期望值
  ↔ `clampBounds` 的下限断言。三处一起改。
- **主题色令牌** `#f6f7f9` / `#161a20` ↔ 端到端闸门里 `LIGHT_BG` / `DARK_BG`
  ↔ `lib/shots.mjs` 的 `THEME_BG`。改配色必须同步，否则闸门红的是尺子不是产品。
- **探针色 `#00d684`** 只允许出现在待办行的标记条上。别处一旦复用这个颜色，
  「空列表探针像素必须为 0」这条负向孪生立刻变成空断言。
- **`.probe` 的 8x22 尺寸** ↔ `lib/shots.mjs` 的 `PROBE_PER_ROW = 164`。改宽高
  必须重新实测这个数，否则「探针像素 == 行数 x 164」会红在尺子上。
- **fontScale 上下限 80/160** ↔ 滑条的 `min`/`max`/`step` ↔ 闸门里逐格按到 160。
  改 step 就要改按键序列。
- **`scripts/manifest.json` 的条数** ↔ 各闸门里 `CHECKS` / `STEPS` 数组长度。
  这是等号断言，不是下限 —— 下限会自己漂，加一条少一条都不会红。
- **`GATES` / `RELEASE_GATES` / `SHOTS_GATES` / `MIRROR_GATES`** ↔ 四份 workflow 里的
  `stdout-<slug>.log` 与 `report-<slug>` 产物名。快闸门断言这些集合完全相等。
- **发布资产数量 8**（Linux 2 + macOS 4 + Windows 2）出现在三处：
  `verify-dist.mjs` 的 `PLAN[*].count`、`verify-release.mjs` 的 `EXPECT_TOTAL`、
  `release.yml` 的「发布前清点资产」。加减一个架构必须三处同改。
- **安装包体积地板 30MB** 同时写在 `verify-dist.mjs` 和 `verify-release.mjs`。
  实测最小的产物在 70MB 上下，留了三倍余量；它只用来抓「打出来是个空壳」。
- **`package.json` 的 `version`** ↔ 已发布的 `vX.Y.Z` tag。发布分支 bump 完必须
  回流 main，镜像审计里有一条在守（放那儿是因为它每次推 main 都跑且能上网,
  快闸门是离线的，看不到「已经发过什么」）。
- **`lib/mirror.mjs` 的 `ALLOW_TOP` / `DENY_PATHS` / `REQUIRE_FILES`** ↔ `mirror.yml`
  里那段拷贝脚本。新增顶层目录默认**不**同步（白名单），但要记得决定它该不该给。
- **`screenshots.yml` 里装 `fonts-noto-cjk` 那一行**是承重的。删了界面上每个汉字
  都会变成豆腐块，而守它的是 `shoot.mjs` 的字形断言，不是某条静态检查。
- **`${{matrix.slug}}` 必须写成不带空格的形式**，扫描器靠「无空白到 .log」
  切 token；写成带空格的会让那条扫描静默变成零命中。

## 闸门红了先查夹具

命中率极高的排查顺序：**先问「这条断言的前提成立吗」，再问「产品对不对」。**
你在同时调试产品和尺子，而尺子是新写的。已知的夹具坑：

- 轮询函数必须返回**布尔**。返回计数的话 0 会被当成「还没成立」等到超时，
  报告里写成「没有数据」。
- **第一个动作也要轮询。** 取窗口句柄那一刻应用可能还没初始化完。
- 设置类控件按一格要等一格。连按的话晚到的回写会把控件顶回旧值，
  最后停在中间某个数上 —— 那是夹具的竞态，不是产品的毛病。
- **`capturePage` 会返回上一帧。** DOM 断言过了不代表画面跟上了，截图动作本身
  也要轮询到像素与 DOM 一致为止。
- xvfb 默认 8 位色深，会让像素计数掷骰子。workflow 里显式要了 24 位。
- CI runner 默认**不带中日韩字体**。中文全变方块时，坏的是环境不是产品。
- 后台窗口会被节流。夹具在操作前显式 `show()` + `focus()`。
- 静态扫描前先证明解析成功。剥注释剥成空字符串的话，后面每条断言都会免费通过。
- 密钥扫描只看文本文件。把 PNG 也扫进去会给出偶发的、谁也看不懂的红。

## 读外部系统的审计，必须有正向痕迹

发布资产校验和镜像审计都是「回头去读服务端那份」。这类审计有个共同的假绿：
**推送失败时读到的是上一次留下的内容，于是每一条断言都通过。** 所以两边都要有
一条断言把结果钉在**本次**运行上（镜像那条是「提交信息里含本次 `GITHUB_SHA`」）。
「没有坏消息」和「早就不同步了」长得一模一样，带时间戳的痕迹不会。

同一类形状还有「发布分支不回流」：改动只活在 `release/**` 上，而 main 看起来
完全正常。这个毛病犯过两次（v1.0.0 的 deb 修复、v1.0.1 的版本号），所以它
现在是一条断言而不是一句嘱咐。

## 测不出来的

诚实列出来，免得后来者去补一个补不上的洞，或者更糟 —— 加一条启发式假装补上了。

- **界面好不好看、顺不顺手**，机器判断不了。闸门只能证明「画出来了、点得动、
  数据对」，不能证明「好用」。
- **macOS 与 Windows 上的真实观感与原生行为**（菜单、Dock、任务栏、高 DPI）。
  CI 只验证「能打出包、体积合理、Release 上真的有这个文件」，行为验收得在真机上做。
- **安装包没有签名，装机流程验不了。** macOS Gatekeeper 与 Windows SmartScreen
  的拦截行为、以及绕过之后能不能正常启动，只有真机点得出来。代码签名与公证需要
  证书，agent 碰不到。
- **`.deb` 在各发行版上的依赖解析**、AppImage 在没有 FUSE 的机器上的表现。
- **截图的「好看」程度**。像素计数与字形签名能证明「颜色对、字画出来了」，
  但区分不了「布局正常」和「布局错乱但颜色和字都还在」。
- **窗口在真实窗口管理器下的行为**（吸附、多显示器、DPI 缩放切换）。CI 里跑的
  是没有窗口管理器的 xvfb，`clampBounds` 的多屏分支在那里根本走不到。
- **公开镜像里的内容会不会被人从别处推翻。** 审计只在同步那一刻看一眼；
  中间有人直接往公开仓推东西，要等下一次同步才会被强推覆盖并被发现。
