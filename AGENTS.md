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

## 结构

```
src/core/store.js       纯函数状态核心：CRUD / 查询 / 设置 / 窗口尺寸 / 存档
src/main/main.js        Electron 主进程：窗口、IPC、持久化编排（唯一的状态所有者）
src/main/persist.js     原子落盘（写临时文件再 rename）
src/preload/preload.js  contextBridge 暴露的 window.todox
src/renderer/           界面。只渲染 + 发意图，不持有业务规则
scripts/verify.mjs      快闸门：纯核心 + 静态不变量 + 两份 workflow 自审（45 条）
scripts/verify-e2e.mjs  端到端闸门：真起 Electron，真操作，真断言（18 条）
scripts/verify-pack.mjs 打包闸门：三平台各打一次 --dir（每平台 4 条）
scripts/verify-dist.mjs 安装包闸门：三平台各打真安装包（每平台 6 条）
scripts/verify-release.mjs 发布资产校验：把 Release 从 API 读回来（6 条）
scripts/lib/compose.mjs 报告合成，验证与发布两条流水线共用
```

## 两条流水线

- `.github/workflows/verify.yml` — 任何分支推送都跑。快闸门 + 端到端 + 三平台打包。
- `.github/workflows/release.yml` — **只在 `release/**` 分支上跑**。三平台打真安装包
  → 建 Release → 把 Release 读回来校验资产。发版就是推一个 `release/vX.Y.Z` 分支。

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
- **主题色令牌** `#f6f7f9` / `#161a20` ↔ 端到端闸门里 `LIGHT_BG` / `DARK_BG`。
  改配色必须同步，否则闸门红的是尺子不是产品。
- **探针色 `#00d684`** 只允许出现在待办行的标记条上。别处一旦复用这个颜色，
  「空列表探针像素必须为 0」这条负向孪生立刻变成空断言。
- **fontScale 上下限 80/160** ↔ 滑条的 `min`/`max`/`step` ↔ 闸门里逐格按到 160。
  改 step 就要改按键序列。
- **`scripts/manifest.json` 的条数** ↔ 各闸门里 `CHECKS` / `STEPS` 数组长度。
  这是等号断言，不是下限 —— 下限会自己漂，加一条少一条都不会红。
- **`GATES` / `RELEASE_GATES`（scripts/lib/report.mjs）** ↔ 两份 workflow 里的
  `stdout-<slug>.log` 与 `report-<slug>` 产物名。快闸门断言这些集合完全相等。
- **发布资产数量 8**（Linux 2 + macOS 4 + Windows 2）出现在三处：
  `verify-dist.mjs` 的 `PLAN[*].count`、`verify-release.mjs` 的 `EXPECT_TOTAL`、
  `release.yml` 的「发布前清点资产」。加减一个架构必须三处同改。
- **安装包体积地板 30MB** 同时写在 `verify-dist.mjs` 和 `verify-release.mjs`。
  实测最小的产物在 70MB 上下，留了三倍余量；它只用来抓「打出来是个空壳」。
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
- xvfb 默认 8 位色深，会让像素计数掷骰子。workflow 里显式要了 24 位。
- 后台窗口会被节流。夹具在操作前显式 `show()` + `focus()`。
- 静态扫描前先证明解析成功。剥注释剥成空字符串的话，后面每条断言都会免费通过。

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
- **截图的「好看」程度**。像素计数只能证明特定颜色画出来了多少个点，
  它区分不了「布局正常」和「布局错乱但颜色还在」。
- **窗口在真实窗口管理器下的行为**（吸附、多显示器、DPI 缩放切换）。CI 里跑的
  是没有窗口管理器的 xvfb，`clampBounds` 的多屏分支在那里根本走不到。
