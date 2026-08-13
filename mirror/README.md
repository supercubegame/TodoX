# TodoX

跨平台桌面待办事项应用，基于 Electron。Windows / macOS / Linux，数据全部存在本机。

![TodoX 主界面](docs/screenshots/light-list.png)

## 下载

安装包在 [Releases](https://github.com/supercubegame/todox-desktop/releases/latest)。

| 平台 | 下载哪个 |
| --- | --- |
| Windows | `TodoX.Setup.<版本>.exe`（安装版）或 `TodoX-<版本>-win.zip`（免安装，解压即用） |
| macOS · Apple 芯片 | `TodoX-<版本>-arm64.dmg` |
| macOS · Intel | `TodoX-<版本>.dmg` |
| Linux | `TodoX-<版本>.AppImage`（`chmod +x` 后直接跑）或 `todox_<版本>_amd64.deb` |

**安装包没有代码签名**，所以首次打开会被系统拦一次：

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

## 关于这个仓库

这是一个**只读镜像**：代码由私有开发仓自动同步过来，历史被压成单个提交。
发 issue 可以，但 PR 合不进来（改动会在下一次同步时被覆盖）。

## 许可证

MIT
