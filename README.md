# TodoX

Electron 桌面待办事项应用。Windows / macOS / Linux 三平台，数据全部存在本机。

![TodoX 主界面](docs/screenshots/light-list.png)

## 下载

最新版本在 [Releases](https://github.com/supercubegame/TodoX/releases/latest) 页面。

| 平台 | 下载哪个 |
| --- | --- |
| Windows | `TodoX.Setup.<版本>.exe`（安装版）或 `TodoX-<版本>-win.zip`（免安装，解压即用） |
| macOS · Apple 芯片 | `TodoX-<版本>-arm64.dmg` |
| macOS · Intel | `TodoX-<版本>.dmg` |
| Linux | `TodoX-<版本>.AppImage`（`chmod +x` 后直接跑）或 `todox_<版本>_amd64.deb` |

**安装包没有代码签名**（签名需要开发者证书，CI 里拿不到），所以首次打开会被系统拦一次：

- **macOS**：提示「无法验证开发者」。到「系统设置 → 隐私与安全性」点「仍要打开」，
  或者终端里跑 `xattr -dr com.apple.quarantine /Applications/TodoX.app`。
- **Windows**：SmartScreen 拦一次，点「更多信息」→「仍要运行」。

## 功能

**完整增删改查。** 新增、行内改标题、勾选完成、删除（可选二次确认）、一键清除已完成。
每条待办有高 / 中 / 低优先级和备注。

**搜索与筛选。** 关键词同时匹配标题与备注，忽略大小写；全部 / 未完成 / 已完成三个页签。

![搜索](docs/screenshots/search.png)

**用户设置。** 浅色 / 深色主题、字号 80%–160%、删除前是否确认、默认优先级、默认排序
（创建时间 / 标题 / 优先级）。

![深色主题与设置面板](docs/screenshots/dark-settings.png)

**窗口随意调节。** 最小 480x360，尺寸和位置退出后自动记住，下次打开还原。
存档在系统的用户数据目录里（`todox.json`），采用原子写入：先写临时文件再 rename，
断电也不会留下半份 JSON。

## 本地跑起来

```bash
npm install
npm start
```

打包（产物在 `dist/`）：

```bash
npm run pack     # 当前平台，只出目录不出安装包
npm run dist     # 三平台安装包（跨平台打包需要对应环境）
```

需要 Node 20+。

## 项目结构

```
src/core/store.js       纯函数状态核心：CRUD / 查询 / 设置 / 窗口尺寸 / 存档
src/main/main.js        主进程：窗口、IPC、持久化编排（唯一的状态所有者）
src/main/persist.js     原子落盘
src/preload/preload.js  contextBridge 暴露的 window.todox
src/renderer/           界面。只渲染 + 发意图，不持有业务规则
```

`src/core/` 不碰任何 I/O：不读文件、不碰 DOM、不发网络、不看系统时间、不用未播种的随机。
时间和 id 由调用方注入。这样同样的输入必然得到同样的输出，逻辑也能换任意外壳复用。

渲染进程跑在 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` 下，
只能看见 preload 用 `contextBridge` 显式暴露的那 7 个方法。

## 验证

每次推送都会跑三条闸门，逐项结果回写到对应提交或 PR 的评论里。

| 闸门 | 条数 | 验什么 |
| --- | --- | --- |
| 快闸门 | 50 | 纯核心真实行为、纯度扫描、安全不变量、打包配置、CI 自审。零依赖，十几秒 |
| Electron 端到端 | 18 | 真起 Electron 真点：增删改查、搜索筛选、主题字号、窗口 resize、重启恢复、落盘产物、零控制台错误 |
| 三平台打包 | 4 × 3 | 三个 runner 上各真打一次包，验产物体积与 `app.asar` |

发布另有一条资产审计：**八个安装包全部上传完成并逐项核对通过之前，Release 一直停在草稿状态。**

```bash
npm run verify       # 快闸门
npm run verify:e2e   # 端到端（Linux 上用 xvfb-run）
```

上面那三张截图不是手工截的，是 CI 里真起一遍 Electron 生成的：喂固定的演示数据，
截图后数像素校验（每行 8x22 的绿色标记条贡献 164 个像素，所以「3 行」必须正好是 492 个），
再核对背景色是否等于该主题的颜色令牌。截图对不上就不许提交,
否则 README 里挂的可能是一张黑图。

改代码之前先读 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
