# TodoX · 项目规矩

Electron 三平台待办事项应用。改完任何东西，**必须跑闸门**。

闸门红了、或者想知道哪些东西机器验不了：读 [docs/PITFALLS.md](docs/PITFALLS.md)。
那份是随经验增长的档案，这份是每次都要读的指令,所以这份有 200 行上限，那份没有。

## 铁律

1. `npm run verify` 通过才算改完。红了先查夹具（见 PITFALLS）。
2. `src/core/` 保持纯净：不读文件、不碰 DOM、不发网络、**不用 `Date.now()`、不用
   未播种的随机**。时间和 id 由调用方通过 `ctx = { id, now }` 注入。回报四样：可断言
   「同样输入同样输出」、可毫秒级压测、换个外壳就能复用、**撤销白送**（状态不可变，
   撤销只要一个状态栈）。塞一个 `Date.now()` 会一次性毁掉这四样。快闸门有扫描在守
   （只扫可执行代码，注释里提这些名字不算违规）。
3. `window.__DIAG__` 是只读诊断出口。**字段可以增加，不能删改**，否则端到端闸门变哑。
4. 密钥只走仓库 secrets。代码、日志、报告里一个字符都不能出现。
5. 新增可验证行为，顺手补一条断言，并更新 `scripts/manifest.json` 里的条数。
6. **发布分支上的改动必须回流 main。** 犯过两次，现在有断言在守（见下）。
7. **shell 里文件名一律加引号或用 `-print0`。** 犯过一次：`TodoX Setup 1.0.2.exe`
   被词分割，上传整体失败，而症状是「对面一个资产都没有」。
8. **共享回写只许钉 40 位 SHA，四份 workflow 钉同一个。** `@main` 是可变引用：上游
   改一行就悄悄改掉四条流水线，而回写坏掉的表现是「全绿但没人看得到结论」。跟上游
   要手动 bump 并读一遍 diff,有意的摩擦。快闸门在守，只更新一半也红。
9. **守卫不许靠提交信息里的字符串。** 循环终止、跳过、幂等这类条件要用身份或内容
   摘要,字符串守卫改一次模板就哑，而哑掉的表现不是红。
10. **规矩文件顶到 200 行就压措辞或拆文件，不许调宽上限。** 调宽一条上限等于把
    断言改成装饰。写长了模型会开始忽略里面的指令,这条上限只有断言守得住。

## 结构

```
src/core/store.js       纯函数状态核心：CRUD / 查询 / 设置 / 窗口尺寸 / 存档
src/core/history.js     纯函数撤销栈：record / undo / redo / summary
src/main/main.js        主进程：窗口、IPC、持久化编排（唯一的状态与历史所有者）
src/main/persist.js     原子落盘
src/preload/preload.js  contextBridge 暴露的 window.todox
src/renderer/           界面。只渲染 + 发意图，不持有业务规则
mirror/                 公开镜像用的 README 与 LICENSE（不参与应用构建）
docs/PITFALLS.md        夹具坑与「测不出来的」,档案，没有行数上限
scripts/verify.mjs      快闸门：纯核心 + 静态不变量 + 四份 workflow 自审（58 条）
scripts/verify-e2e.mjs  端到端闸门：真起 Electron，真操作，真断言（21 条）
scripts/verify-perf.mjs 性能压测闸门：稳态延迟 / 规模比值 / 堆增长（11 条）
scripts/verify-pack.mjs 打包闸门：三平台各打一次 --dir（每平台 4 条）
scripts/verify-dist.mjs 安装包闸门：三平台各打真安装包（每平台 6 条）
scripts/verify-release.mjs 发布资产校验：把 Release 从 API 读回来（6 条）
scripts/verify-release-mirror.mjs 公开仓 Release 同步校验，逐个比 sha256（8 条）
scripts/attest-comment.mjs 回写送达核对：报告写完之后回头找那条评论（7 条）
scripts/shoot.mjs       截图生成器：真起 Electron 截 README 用的图（8 条）
scripts/verify-mirror.mjs 镜像审计 + 版本回流：读公开仓真实的树（10 条）
scripts/lib/compose.mjs 报告合成，四条流水线共用
scripts/lib/mirror.mjs  公开镜像的路径白名单与黑名单，唯一一份
```

## 四条流水线

- `verify.yml` — 任何分支推送都跑。快闸门 + 端到端 + 性能压测 + 三平台打包，
  报告写完之后再跑一个 **attest**（回写送达核对）。
- `release.yml` — **只在 `release/**` 上跑**。三平台打真安装包 → 建 Release →
  读回来校验 → 同步到公开仓（先草稿，审计过了才转正）。发版就是推一个
  `release/vX.Y.Z` 分支并把 `version` 改成对应号。
- `screenshots.yml` — 只在 `docs/**` 与 `shots/**` 上跑。生成 README 用的截图，
  闸门绿了才回写 PNG。循环守卫看的是**提交者身份**，不是提交信息。
  **注意：随便开一条 `docs/xxx` 分支会顺带触发它。**
- `mirror.yml` — 推 `main` 就同步一次公开镜像 `supercubegame/todox-desktop`。

回写都走 `supercubegame/ci-workflows` 那一份共享 workflow，本地不许再抄一份。

## 命令

```
npm start           本地跑起来
npm run verify      快闸门（几十秒，零依赖，每次改动都要跑）
npm run verify:e2e  端到端闸门（需要 npm install；Linux 上用 xvfb-run）
npm run verify:perf 性能压测闸门（零依赖；脚本会自己带 --expose-gc 重启一遍）
npm run verify:pack 打包闸门（需要 TODOX_PACK_SLUG=pack-linux|pack-mac|pack-win）
npm run verify:dist 安装包闸门（需要 TODOX_DIST_SLUG=dist-linux|dist-mac|dist-win）
```

`attest-comment.mjs` 只在 CI 里有意义：它要读本次 run 的 id 和 token。

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
- **`HISTORY_LIMIT = 50`** ↔ 快闸门那条「上限真的可达」的断言（它推 51 次去撞）
  ↔ 性能闸门那条「50 层堆增长有上限」。历史**不进存档**：两条断言在守
  （serialize 顶层只有 4 个字段）。改上限要重算那两条断言的循环次数。
- **性能预算是相对值，不是绝对毫秒。** 时间预算乘一个校准系数（先跑确定的参考负载
  量机器速度，**只放大不收紧**；放大到 8 倍还兜不住就宣布「本次测量不可信」并红）。
  主力断言是比值：`N` → `BIG` 翻 4 倍，耗时不许超过 `scaleRatio = 6` 倍。改比例要重算它。
- **`marker`（`<!-- todox-verify -->`）在两处**：`verify.yml` 里 summary 的输入，和
  `attest-comment.mjs` 里那个常量。改一处不改另一处，核对会去找一个没人写的 marker,
  症状看起来像「评论没送达」，根因其实在这里。快闸门逐字比两处。
- **回写用的 bot 邮箱**在 `screenshots.yml` 两处：`git config user.email` 那行，和守卫里
  那个 `!=` 比较。快闸门真的去比,改一处不改另一处守卫会哑，而哑掉的表现是**自触发
  循环**，不是红。那个提交信息里的跳过标记已删干净，**别加回来**。
- **被钉住的回写 SHA** ↔ 四份 workflow。快闸门断言那个集合大小恰好为 1,
  只更新一半比全钉 `@main` 更糟：行为分叉而没有任何断言看得见。
- **`scripts/manifest.json` 的条数** ↔ 各闸门里 `CHECKS` / `STEPS` 数组长度。
  等号断言，不是下限 —— 下限会自己漂，加一条少一条都不会红。
- **`GATES` / `RELEASE_GATES` / `SHOTS_GATES` / `MIRROR_GATES`** ↔ 四份 workflow 里的
  `stdout-<slug>.log` 与 `report-<slug>` 产物名。快闸门断言这些集合完全相等，性能闸门
  再加一层：每条闸门 job 必须**真的执行了对应的闸门脚本**。**attest 不在 GATES 里**
  （它跑在报告之后），日志叫 `attest.log`、产物叫 `attest-log`,占用会让上面几条红在命名上。
- **AGENTS.md 的 200 行上限** ↔ `docs/PITFALLS.md` 的存在。快闸门断言那两节标题
  **只在 PITFALLS 里、不在 AGENTS 里**,复制一份留两处同样会红（那样两边会分叉）。
- **发布资产数量 8**（Linux 2 + macOS 4 + Windows 2）出现在四处：
  `verify-dist.mjs` 的 `PLAN[*].count`、`verify-release.mjs` 的 `EXPECT_TOTAL`、
  `verify-release-mirror.mjs` 的 `EXPECT_TOTAL`、`release.yml` 的「发布前清点资产」。
- **安装包体积地板 30MB** 写在三个发布相关的闸门里。实测最小产物在 70MB 上下，
  留了三倍余量；它只用来抓「打出来是个空壳」。
- **`package.json` 的 `version`** ↔ 已发布的 `vX.Y.Z` tag。发布分支 bump 完必须
  回流 main，镜像审计里有一条在守（放那儿是因为它每次推 main 都跑且能上网,
  快闸门是离线的，看不到「已经发过什么」）。
- **`lib/mirror.mjs` 的白名单与黑名单** ↔ `mirror.yml` 里那段拷贝脚本。新增顶层
  目录默认**不**同步（白名单），但要记得决定它该不该给。
- **`screenshots.yml` 里装 `fonts-noto-cjk` 那一行**是承重的。删了界面上每个汉字
  都会变成豆腐块，而守它的是 `shoot.mjs` 的字形断言，不是某条静态检查。
- **`${{matrix.slug}}` 必须写成不带空格的形式**，扫描器靠「无空白到 .log」
  切 token；写成带空格的会让那条扫描静默变成零命中。

## 读外部系统的审计，必须有正向痕迹

发布资产校验、镜像审计、回写送达核对都是「回头去读服务端那份」。这类审计有个
共同的假绿：**推送失败时读到的是上一次留下的内容，于是每一条断言都通过。**
所以每一边都要有一条断言把结果钉在**本次**运行上（镜像那条是「提交信息里含本次
`GITHUB_SHA`」，发布那条是「逐个比 sha256」，回写那条是「评论正文里含本次短 SHA
与 run id」）。带时间戳或内容摘要的痕迹才承重。

**半成品要做成看得见的失败态**：先建草稿，审计过了才转正。犯过一次相反的，
结果留下一个「谁都看得见但零个文件」的发布。

**审计除了「我这次写对了吗」，还要问「那个系统里现在有没有不该存在的东西」。**
只看当次 tag 的话，旁边躺一个 0 资产的正式发布是完全隐形的 —— 实测真躺了一个。
