# TodoX

Electron 桌面待办事项应用，目标平台 Windows / macOS / Linux。

- 完整增删改查：新增、行内改标题、勾选完成、删除（可选二次确认）、清除已完成
- 搜索与筛选：关键词匹配标题和备注，全部 / 未完成 / 已完成三个页签
- 用户设置：主题（浅色 / 深色）、字号 80%–160%、删除前确认、默认优先级、默认排序
- 窗口大小随意调节，最小 480x360，尺寸与位置退出后自动记住

## 跑起来

```bash
npm install
npm start
```

## 打包

```bash
npm run pack     # 当前平台，只出目录不出安装包
npm run dist     # 三平台安装包（跨平台打包需要对应环境）
```

## 验证

每次改动都要过闸门。三条闸门都会把逐项结果回写到对应提交或 PR 的评论里。

```bash
npm run verify       # 快闸门：纯核心 + 静态不变量 + CI 自审，零依赖
npm run verify:e2e   # 端到端：真的起 Electron，真的点，真的看像素
TODOX_PACK_SLUG=pack-linux npm run verify:pack   # 真的打一次包
```

改代码之前先读 [AGENTS.md](AGENTS.md)。
