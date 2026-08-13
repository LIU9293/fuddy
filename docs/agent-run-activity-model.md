# Agent Run 活动展示模型

Agent Run 的界面不直接渲染 Codex、Claude Code 或 OpenCode 的原始事件。三种 Runtime 先将事件归一为以下产品语义：

```text
一轮回复
├── 思考摘要 1
│   └── 连续操作组（默认折叠）
├── 思考摘要 2
│   └── 连续操作组（默认折叠）
└── 最终回复
```

## 归一化边界

| Provider | 思考来源 | 工具开始 | 工具结束 |
| --- | --- | --- | --- |
| Codex | app-server `reasoning.summaryTextDelta` | `item/started` | `item/completed` |
| Claude Code | Agent SDK 的 summarized thinking delta | assistant `tool_use` | 后续 user `tool_result` |
| OpenCode | JSON `reasoning` part | `part.state.status=pending/running` | `completed/error/failed` |

归一后的工具只有 `running / completed / failed` 三种状态，并带有稳定的 `read / search / edit / command / browser / other` 类别。界面使用工具类别和可读摘要，原始参数与输出只在二级展开里显示。

思考区只展示 Provider 明确支持的摘要，不展示或推测隐藏思维链。

## Mac 与 iPhone 的共同规则

- 完成的一轮处理默认整体折叠，标题显示耗时和操作数。
- 展开后，每条思考摘要保持独立；只把两条思考之间的连续工具调用分为一组。
- 工具组默认折叠，例如“读取 2 次 · 运行 1 次”；展开后才看单次操作与原始细节。
- 运行中显示已到达的思考摘要和工具，只高亮最后一个活动阶段。
- iPhone 不再隐藏运行中的思考摘要。Relay 只传输有界的工具细节，完整输出仍留在 Mac。

## 可重复的 Provider 回放

三个回放场景分别模拟数据库迁移修复（Codex）、跨端组件重构（Claude Code）和依赖审计（OpenCode）。每个场景都验证：

1. 思考事件进入独立阶段；
2. 工具调用跟随上一条思考；
3. 工具类别、摘要和状态不依赖 Provider 原始命名；
4. Mac 和 iPhone 产生相同的阶段数与工具分组。

桌面端回放与解析测试：

```bash
npx vitest run \
  src/shared/agent-activity.test.ts \
  src/main/services/cli-agent-runtime.test.ts \
  src/renderer/src/components/AgentRunsView.test.ts
```

iPhone 同口径回放在 `SyncModelTests.testCodexClaudeAndOpenCodeFixturesShareOneStageContract` 中。完整 Simulator 验收使用 `ProjectAgentCompanion` Scheme 的 XCTest 套件。
