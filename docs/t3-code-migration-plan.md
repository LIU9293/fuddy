# Fuddy 的 T3 Code 改造计划

2026-11-24 · 源码走查与实施提案。对照版本为 Fuddy `22b99a0` 和 [T3 Code `cf90d1a466`](https://github.com/pingdotgg/t3code/tree/cf90d1a466fbb4ca81992b4239656cf95813170e)。本文记录待实施、待验收的工作。

让 T3 负责从 Provider 事件到 Chat 输出的整条链路。桌面直接复用 T3 的 Agent 适配器、会话编排、时间线分组和消息组件。Fuddy 负责项目与成员、选择执行 Mac、通过 Cloudflare 同步，以及向 Agent 提供项目工具、Browser Use 和 Computer Use。改造期间保留现有中文菜单、按钮及操作入口。

第一份交付是在 Fuddy Dev 中完成一条真实的 Codex 两轮对话。验收时要确认 T3 运行时能随应用启动，Chat 能按 T3 的方式显示工具和文件修改，重开后还能接着同一个原生会话工作。

## 现状与差异

| 范围 | Fuddy 当前实现 | 迁移影响 |
| --- | --- | --- |
| Agent 管理 | Pi、Codex、Claude Code 和 OpenCode 共用 Agent Run 接口，已有持久队列、原生会话续接、运行中追加指令、停止和重试。 | Fuddy 的一个 Agent Run 是长期会话，对应 T3 的 **Thread**。一次发送对应一轮 T3 Run。投递请求 ID、执行尝试和 Provider 原生会话引用需要分别保存，否则重试与远程停止可能指向错误对象。 |
| Chat 输出 | 主进程会把部分中间正文转存为思考摘要。桌面分别处理实时流与历史消息，还对 Claude 做可见性过滤。iOS 也在 Swift 中分组。 | T3 的 `TurnItem` 已区分中间回复、最终回复、推理摘要、命令、文件修改和用户输入请求。采用其事件类型、分组和渲染后，同一轮的实时显示与历史回放有共同依据。 |
| 页面样式 | 桌面样式入口加载 10 个 CSS 文件，共 10,496 行。聊天、工作区和设置存在后加载的覆盖规则。 | 引入 T3 共用的明暗色板、语义颜色、排版、留白及基础控件。每迁完一类页面，即删除对应旧规则，直至撤掉旧样式入口。 |
| 个人与团队同步 | 个人 Companion 支持历史分页、附件和有序回放。团队共享另有字段白名单，会过滤工具、系统消息和推理记录。仓库记录的双账户、双 Mac、iPhone 真实联调仍待验收。 | 执行 Mac 先按接收方权限生成展示数据，再通过现有通道发送。桌面和手机可以复用时间线语义，成员端只接收获准共享的内容。 |

Fuddy 实现可从 [Run 契约](../src/shared/contracts.ts)、[主进程事件处理](../src/main/services/task-dispatcher.ts)、[桌面时间线](../src/renderer/src/components/AgentRunsView.tsx)、[iOS 时间线](../ios/ProjectAgentCompanion/RootViews.swift)、[样式入口](../src/renderer/src/styles.css) 和 [共享发布白名单](../src/shared/project-sharing.ts) 核对。跨设备已有能力和待验收项见[项目共享评审](./project-sharing-review.md)。

## 第一阶段 · 在 Fuddy Dev 打通 Codex Chat

固定上游提交，在独立的 Fuddy Dev 数据目录中验证由 Electron 管理本地子进程，承载 T3 的 `orchestration-v2`、Codex adapter 和持久化。Fuddy 的主进程通过受校验的接口提交命令和订阅结果。草稿创建、项目选择、决策收件箱预填和发送动作继续走现有入口。桌面接入 T3 的时间线、Markdown、增量更新及其依赖。文件与附件链接交给 Fuddy 的项目文件服务。首版同时验证开发环境与打包后的 Fuddy Dev 都能启动运行时。[T3 编排与存储边界](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/docs/internals/01_architecture.md) · [时间线入口](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/apps/web/src/components/chat/ThreadTimeline.tsx) · [Markdown 渲染](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/apps/web/src/components/ChatMarkdown.tsx)

验收时，从收件箱点“去处理”后出现预填草稿，点击发送才启动 Codex。在测试项目中完成一次工具调用和文件修改，收到最终回复，重开 Fuddy Dev 后追问第二轮并核对原生会话引用。另测运行中停止。用同一份事件回放对照两端的行顺序、工具分组、折叠、Markdown 和最终正文，并比较实时显示与重开后的历史。

## 第二阶段 · 迁移其他 Provider、项目工具和历史会话

接入上游 Claude Code 和 OpenCode 适配器。内置 Fuddy Agent 单独适配同一生命周期，并保留 Pi 的项目工具、模型配置和工作助理动作。Fuddy 向各 Provider 提供项目主工作目录、附加目录、项目文件目录及所需 MCP 服务。验证本机账号、默认模型和现有 Full Access 策略。模型留空时沿用 Agent 自己的默认值。[上游 Provider 契约](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/docs/internals/03_providers.md) · [Fuddy Pi 工具](../src/main/services/pi-task-harness.ts) · [MCP 运行时](../src/main/services/third-party-mcp-runtime.ts)

新会话先使用新引擎，旧会话按已有绑定逐个迁移。已归属 Fuddy 的 Codex 会话直接 resume。具有旧来源 ID 的会话按原有逻辑 fork 一次，在发送首轮之前持久化新绑定。旧记录只展示实际保存的内容。切换期间，每个请求只由一个引擎执行。回退时将之后新建的会话交给原引擎，已受理的请求继续按原绑定查询结果。[Codex 会话归属与迁移](../src/main/services/codex-session.ts)

验收时，四种 Provider 分别覆盖默认模型、原生续接、附件、停止、失败重试和各自支持的追加指令。用排队期间重启、重复投递和旧会话再次打开验证不会重复执行。验证 Agent 确实能在指定项目目录调用 Fuddy 工具、生成产物，并从聊天中打开产物。

## 第三阶段 · 统一三个 Chat 入口与 iPhone 展示

项目 Chat、共享 Chat、工作助理采用同一套消息行、Markdown、代码块与滚动行为。Fuddy 的多人署名、简报、受约束的动作确认和附件预览接在对应位置。iPhone 继续用 SwiftUI，消费执行 Mac 生成的版本化展示数据，并对照 T3 移动端布局，尤其验证长消息、工具折叠与键盘避让。

由执行 Mac 持久化 T3 已提交的运行变化。同步桥在 Fuddy 的事务中一起写入消费游标和现有 Companion outbox，通过已有的 Cloudflare 有序回放恢复进度。游标超出 T3 保留窗口时，用已持久化的会话快照恢复。团队发布继续经过项目白名单及成员权限检查。个人手机的工具摘要、团队成员可见的消息、附件描述与私有 R2 下载各按现有契约输出。[Companion 协议](../src/shared/companion-protocol.ts) · [项目共享方案](./project-sharing-plan.md)

验收时，对照桌面实时、重开、手机离线后回放的顺序与内容。覆盖执行完成后同步前崩溃、重复命令、历史分页、附件校验、共享成员撤权和旧手机连接新 Mac。最终用独立开发账户验证双账户、双 Mac、iPhone 的真实链路。

## 第四阶段 · 替换全站样式

第一阶段的 Chat 就采用 T3 默认 Light/Dark 主题。随后依次迁移侧栏和页头、收件箱与项目、文件与自动化、设置与登录。用同一套按钮、菜单、输入框、弹层和焦点样式承载现有操作。iOS 使用对应的颜色角色与移动端尺度。每批迁移后删除失去调用方的旧 CSS。最后移除旧主题入口、`*-current.css` 覆盖层和重复的 Chat 分组代码。[T3 色板](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/packages/shared/src/themePalettes.ts) · [基础控件](https://github.com/pingdotgg/t3code/tree/cf90d1a466fbb4ca81992b4239656cf95813170e/apps/web/src/components/ui)

验收时，每类页面在明暗模式、窄窗口和宽窗口下与参考页并排检查，并对照 Fuddy 同类页面。按现有菜单逐项验证入口、键盘操作、弹层、侧栏拖拽和文件动作。分发包沿用 Fuddy 名称、图标及品牌资产，引入的上游源码随附许可声明。[T3 源码许可](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/LICENSE) · [品牌说明](https://github.com/pingdotgg/t3code/blob/cf90d1a466fbb4ca81992b4239656cf95813170e/TRADEMARK.md)

## 后续跟进 T3 更新

将引入的上游源码、准确提交号和 Fuddy 适配代码集中管理。升级时先用上游 Provider 回放验证事件与生命周期，再跑 Fuddy 的历史会话、项目工具、权限、桌面展示和跨设备回放用例。只有第一阶段的真实两轮对话与打包验证通过，才将同一路径推广到其余 Provider 和页面。[T3 回放用例](https://github.com/pingdotgg/t3code/tree/cf90d1a466fbb4ca81992b4239656cf95813170e/apps/server/src/orchestration-v2/testkit/fixtures)
