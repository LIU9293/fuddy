# AI Native Project Agent

> 面向自由职业者与个人开发者的多项目 AI 助理。当前仓库已进入 Electron 桌面端 MVP 开发阶段。

## 当前实现状态（2026-08-09）

当前版本已经跑通从项目上下文、决策事项到真实 Agent Session 的桌面端主链路：

- 工作助理、每日简报、决策收件箱、项目状态 / 目标 / 设置、文件、Agent Runs 和自动化已接入同一套本地数据模型；
- Agent Run 不再区分 Coding / General，统一选择 Pi、Codex、Claude Code 或 OpenCode 作为执行 Agent；
- 每个项目支持一个或多个 Workspace Roots，并指定主 Workspace。普通 Run 与自动任务都在真实项目目录执行，同时把其他 Roots 和项目产物目录提供给 Agent；
- 新建 Agent Session 只创建草稿，不自动发送消息。“去处理”和 Milestone“开始任务”都会直接创建或打开关联 Session、进入聊天，并把持久化的建议任务放进输入框，用户确认或修改后再发送；
- 工作助理使用统一能力目录与持续任务上下文：可以管理项目、目标、收件箱、Agent Run 和自动化，读取每日简报、联网公开来源，并受约束地读取项目文件空间及已配置 Workspace 中的文件/代码；只读能力可直接执行，改变 App 状态的能力先展示确认 Action，创建 Run 只预填不发送；
- Codex 使用 app-server，Claude Code 使用 Agent SDK，OpenCode 使用本机 CLI；三者均保存原生 Session ID，可在后续消息中恢复同一上下文；
- Coding Agents 设置会检测本机安装状态、版本和可选模型，可设置全局默认 Coding Agent，并为每个 Agent 选择默认模型；运行时仅在已选择模型时显式传入模型参数；
- macOS GUI 启动时读取交互式 zsh 环境，因此本机 Agent 能获得与终端一致、未经应用过滤的环境变量和认证配置；应用不会修改 `.zshrc`；
- Agent Run 当前按产品约定使用 Full Access / 自动批准模式。Codex、Claude Code 和 OpenCode 分别使用各自支持的完全访问参数；
- Agent 对话已支持流式回复、思考摘要、折叠工具调用链、当前工具运行态、Session 重命名 / 归档，以及 10 分钟无活动运行超时；
- Agent Runs 详情采用完整聊天主区域，Session 列表只在运行时显示加载图标；主侧边栏支持拖拽调整宽度；临时成功和错误提示会在 5 秒后自动消失；
- 主进程、Renderer 未处理异常及 Electron 子进程异常已接入 Sentry 崩溃报告。
- 已加入原生 SwiftUI iOS Companion 工程。Mac 可显示一次性配对二维码，iPhone 使用 VisionKit 原生扫码连接；本地 SQLite outbox 会把项目、目标、决策、每日总结、工作助理、Agent Run、消息和产物增量同步到 Cloudflare Relay。手机以顶部“助理 / Runs”切换和侧边栏组织导航，两类聊天共用支持照片 / 文件上传的输入组件；每日总结直接进入助理时间线，Agent 工具调用按 Thinking 阶段折叠分组。项目详情提供与 Mac 对齐的概览 / 设置，可编辑基本信息、产品上下文、一个或多个 Workspace、主 Workspace、默认 Agent、入口与数据源，并通过受约束的 `project.update` 命令交由 Mac 落库。Session 聊天不再内嵌产物列表，右上角“信息与文件”Modal 集中展示基本信息和文件；缺少云端副本时，iPhone 会通过受约束的命令请求在线 Mac 实时上传，再进行大小与 SHA-256 校验并用 Quick Look 打开。手机也支持离线缓存、收件箱处理和 Session 重命名 / 归档，所有实际 Agent 与工具操作仍在 Mac 执行；完整架构见 [`docs/ios-companion-architecture.md`](docs/ios-companion-architecture.md)。
- Companion Relay 已部署到 [`project-agent-companion-relay.moghub.workers.dev`](https://project-agent-companion-relay.moghub.workers.dev)，使用 Durable Objects、Hibernation WebSocket 和私有 R2；配对密钥一次有效、设备 Token 只保存哈希，Mac 解除绑定会撤销设备并清理 Relay 数据。Mac 与前台 iPhone 以 WebSocket 事件作为同步唤醒信号，只保留 60 秒一次的 ordered replay 兜底，并每 20 秒执行应用层心跳；漏掉一次 `pong` 会主动废弃半开连接，断线重连按 5 / 15 / 60 秒退避。iPhone 进入后台会主动关闭 WebSocket 和兜底定时器，改由 APNs 静默通知唤醒 HTTPS replay，回到前台后立即重连补齐。命令状态同样写入 ordered event log，离线期间发生的执行失败不会丢失；Worker 只持久化显式错误日志，Trace 采样为 1%。手机会区分 Relay 断线与 Mac 离线并直接消费 presence 帧，Mac 设置页也分开显示 HTTP 同步和实时连接；Mac 离线时仍可安全排队操作。APNs 后台唤醒代码已接入，但正式设备推送仍需 Apple Developer Team、APNs Key 与签名配置。

目前仍属于本机 / 个人设备 MVP：Mac 签名、公证、自动更新，以及 iOS 的 Apple Developer 签名、APNs 凭证与应用层端到端加密仍是公开分发前的发布门槛。

## 1. 产品定位

这是一个以 Agent 交互为中心的个人项目操作系统，用来同时管理 5–6 个规模、类型与阶段不同的项目。

它不是：

- 通用 Trello / Jira 式看板；
- 默认堆满指标的 Dashboard；
- 文档或资料库；
- 模拟真人开会的“AI 晨会”；
- 用同一套完成率衡量所有项目的项目管理工具。

它应该帮助用户：

1. 让 AI 在后台持续理解每个项目的目标、现状、代码与自动任务；
2. 每天快速了解真正发生的变化、影响和下一步重点；
3. 通过自然语言追问、分析和调整优先级；
4. 把适合的工作连同上下文、权限和验收标准交给 Codex 等 Coding Agent；
5. 仅在需要时动态生成图表、数据视图或操作界面。

## 2. 核心用户场景

用户可能同时负责：

- 多行业经营小程序，例如 Roombase；
- 婚礼与活动邀请工具，例如 Vows；
- 面向品牌的 To B AI 内容产品，例如 AI Marketing；
- 以及后续的客户项目、内部工具或开源项目。

这些项目不能共享一套固定的进度模板。系统需要根据项目画像切换分析视角：

| 项目类型或阶段 | 主要分析视角 | 典型关注内容 |
| --- | --- | --- |
| 产品开发 | Product / Delivery | 范围、里程碑、质量、阻塞、发布准备度 |
| 推广增长 | Marketing / Growth | 获客、激活、留存、渠道质量、实验结果 |
| Trading | Risk / Strategy | 收益、回撤、敞口、规则执行、策略稳定性 |
| 团队协作 | Delivery / Dependency | 责任边界、依赖、承诺、交付风险 |
| 维护运营 | Reliability / Efficiency | 稳定性、异常、成本、重复工作自动化 |

项目规模、生命周期和用户当前承担的责任，也应影响 AI 的判断与优先级，而不仅是展示标签。

## 当前项目组合（首批）

| 项目 | 形态与阶段 | 代码 / 线上入口 | 当前使命 | 重点工作流 |
| --- | --- | --- | --- | --- |
| Roombase | 多行业门店小程序；运营与增长 | `~/Code/shopmy`；[roombase.cn](https://roombase.cn) | 建立可复用的获客与转化体系，找到能持续拉新的宣传渠道 | 数据分析、Marketing、拉新转化、客服洞察 |
| Vows | 婚礼与活动邀请工具；验证与扩展 | `~/Code/wedding-app`；当前为小程序，规划 H5 | 验证婚礼场景增长闭环，再扩展至多种活动 | 营销推广、邀请传播、模板内容、H5 扩展 |
| AI Marketing（暂名） | To B 品牌素材工作台；Active Development | `~/Code/marketing-tool` | 用真实品牌试点跑通图片与带货视频的自动化生产线 | 产品开发、品牌工作流、素材质量、交付效率 |

AI Marketing 当前以牙刷品牌和婴儿睡袋品牌作为首批试点。Vows Repo 已有营销 Agent，应作为该项目的现有能力接入，而不是在主应用中复制一套实现。

三个项目在产品中统一使用“项目工作区”，每个工作区保存项目身份、阶段、使命、入口、工作流、数据源、Agent 配置与建议下一步。跨项目层只统一调度、权限、审计和决策收件箱，不强行统一业务指标。

能力拆分遵循三层：

- **Connector / Plugin**：负责读取 Cloudflare、Google Analytics、小程序业务库、投放平台和品牌素材等外部系统；认证、API Schema、限流与同步状态留在这里。
- **Skill**：复用分析方法，例如漏斗分析、渠道归因、营销实验设计、客服主题聚类、品牌素材质检和增长周报。
- **Project Profile / Workflow**：保存每个项目自己的事件口径、目标、品牌约束、行业术语、数据映射，以及 Vows 现有营销 Agent 等项目专属流程。

第一轮建议优先建立的闭环：

1. Roombase：访问 → 咨询 / 注册 → 创建门店 → 激活 → 付费，并配套首轮低成本渠道实验；
2. Vows：创建活动 → 完成邀请 → 分享 → 访客打开 → 回执 / 互动，并接入现有营销 Agent；
3. AI Marketing：品牌输入 → 生成 → 人工修改 → 交付 → 投放反馈，记录单条素材成本、耗时与可用率。

## 3. 核心闭环：目标 + 工作助理 + 决策收件箱

```text
项目目标与里程碑
        ↓
Connector、Agent 与自动化持续采集证据
        ↓
Agent Check-in 更新指标、进度与风险判断
        ↓
生成带证据的原子化 Signal
        ↓
投递至跨项目“决策收件箱”
        ↓
助理 Agent 筛选、去重、排序与总结
        ↓
生成按需简报（文字 + TTS）
        ↓
用户确认、修改或派发给专业 Agent
        ↓
执行结果与证据回投决策收件箱
```

目标是项目内的一级对象，不是设置中的一段文字。每个项目先保存一份带来源和更新时间的“项目现状”；用户确认事实优先于 Agent 推断和 Repo 证据。每个目标包含独立的优先级（P0 / P1 / P2）与生命周期状态（已规划 / 进行中 / 有风险 / 暂停 / 已完成），以及结果描述、一个主指标（Baseline / Current / Target）、截止时间、下一次 Check-in、里程碑、监控数据源、Agent 总结与置信度。Check-in 单独留存历史，Agent 可以根据已有证据更新当前值、里程碑、进度和风险状态，但不能静默修改成功标准、目标值或截止日期。

对话是目标与收件箱的主要管理入口，而不只是问答界面。Agent 可以根据用户的明确指令创建目标、检查进展、暂停 / 恢复 / 完成目标，也可以创建和流转收件箱事项。收件箱页面本身不提供通用输入框；用户点击“去处理”后，事项进入“进行中”，系统创建或打开关联草稿 Session 并预填问题但不自动发送。“忽略”关闭该事项。每次操作都先把自然语言映射为受约束的应用动作，只允许引用当前数据库中真实存在的项目、目标和收件箱 ID，并写入权限审计；普通咨询不会触发写入。

目标创建与 Check-in 不依赖 Renderer 中的业务文案。Agent 会在执行时读取最新 Project Profile、Repo 状态、README / 项目规划、已有 Skill 摘要和 Connector 运行结果，再生成结构化目标与证据。Git、README 和测试结果只能证明工程能力及开发进展，不能被当作生产用户、收入或转化率证据；缺少业务 Connector 数据时，Baseline / Current 必须保持未知。

正常进展只进入目标历史和每日简报；只有出现风险、阻塞或需要用户判断时才投递决策收件箱，避免把普通开发过程变成噪音。目标风险处理完成后，Agent Run 的结果和证据再关联回原目标，形成：

```text
Goal → Milestone → Evidence → Check-in → Briefing / Decision → Agent Run → Goal
```

收件箱采用“问题生命周期”而不是“每日消息”模型。每类持续问题都有不含日期的稳定 `dedupeKey`；每次巡检会读取待处理、进行中、等待中、已完成和已忽略的完整历史，只追加或更新 Observation，并刷新原 Item 的摘要、证据、最近发现时间和出现次数。巡检结果为 `active` 时继续维护原 Item；如果更新且更晚的证据与“已完成”冲突，系统会重新打开同一个 Item 并记录 reopen 次数，而不是新建重复事项。巡检结果为 `resolved` 时，只有最新证据直接证明问题解除后才主动标记完成。缺少数据或无法检查不能作为完成证据；已忽略事项只更新观察，不会被 Agent 擅自恢复。

问题事实与修复进度分开追踪：由收件箱“去处理”创建的 Run 会保留原始 Decision ID；Run 中产生的规范 GitHub PR 链接会自动成为修复证据。PR 提交、Review 或 CI 状态推动事项进入“进行中”；PR 合并只表示代码工作完成，事项进入“等待中 · 等待部署”，生产发布后进入“等待中 · 等待验证”。只有后续生产 Connector 或其他验收证据证明问题解除，事项才自动进入“已完成”。非开发事项使用同一套 Ticket 状态，并通过等待外部处理、等待指标、等待用户或等待复查等原因表达不同验收路径。每次自动状态转换都会记录原因、证据、操作者和时间；GitHub 暂时不可用时保留最后一次已核验状态，不把未知当作完成。

“工作助理”是独立一级通用聊天频道，用来跨项目讨论、规划和推进任务，不依赖当天是否已经生成简报。“每日简报”是工作助理每天 09:00 自动发送的一种特殊消息，由助理 Agent 汇总所有项目的数据、信号与决策收件箱；消息内是一张三分钟以内的中文语音卡片，支持直接播放和在卡片内展开全文。简报、任务讨论和用户追问共同组成一条连续时间线，输入框始终固定在聊天区域底部。每条收件箱项目至少包含所属项目、类型、影响、紧急度、置信度、证据、建议动作与处理状态。助理 Agent 在自动任务或用户手动触发时生成简报，建议结构固定为：

1. **发生了什么**：基于最新证据总结变化；
2. **这意味着什么**：解释影响、风险与机会；
3. **接下来关注什么**：给出少量、明确、可行动的重点；
4. **证据来源**：链接到 Repo、自动任务结果、分析数据或人工更新；
5. **待确认事项**：需要用户判断或授权的选择。

工作助理的能力统一按授权等级组织：

- **只读**：列出/检查项目与 Agent Run、搜索项目文件、读取已配置 Workspace、联网搜索与读取 HTTP/HTTPS 页面（包括本机和私有网络服务）、读取历史简报；结果必须保留来源，且不能把网页或 Repo 信息直接当作已确认的生产事实。
- **确认后执行**：新建或更新项目、创建/打开/修改 Agent Run、管理目标与收件箱、生成简报、创建或启停自动化。确认 Action 会持久化到助理消息，点击时重新校验对象状态。
- **明确执行**：向 Run 发送消息、归档 Run、触发会写入外部系统的 Agent 工作。工作助理本身不修改项目代码，而是把任务交给项目绑定的 Agent Run。

用户要求“处理 PR / 问题 / 事项”时，助理先按 Decision ID、PR URL/编号、项目和历史消息查找已有 Run。强匹配的运行中、草稿、空闲或可恢复中断 Run 优先复用，并展示“继续这个 Run / 新建 Run”Action；没有匹配时才建议创建 Draft Run。用户确认后跳转并把建议 Prompt 放进 Input，但不自动发送。每日简报的定时投递和手动生成复用同一个 `briefing.generate` 能力，Scheduler 只是另一种触发入口。

## 4. 单个项目的信息模型

### 基本信息

- 项目名称与简介；
- 项目类型；
- 项目规模；
- 生命周期阶段；
- 当前状态；
- 用户的责任范围；
- AI 当前采用的分析视角。

### 目标与现状

- 长期目标；
- 当前里程碑；
- 当前重点；
- 成功标准；
- 用户最近一次人工总结；
- AI 对目标达成的判断与置信度；
- 下一次复盘时间。

### Repo 与环境

- 一个或多个仓库地址；
- 默认分支；
- 本地工作目录；
- 预览或部署地址；
- Repo 连接状态；
- 项目指令文件，例如 `AGENTS.md`。

不在系统中直接保存密钥。凭证应通过操作系统、Agent Runtime 或部署平台的安全机制提供。

### Agent 配置

- 默认 Agent，例如 Codex；
- Agent 可读取的上下文；
- 允许操作的 Repo / 目录范围；
- 审批模式；
- 运行预算或时间限制；
- 最近运行与输出；
- 任务验收标准。

### 决策收件箱与简报

- 项目与投递来源；
- 类型：风险、机会、待决策、执行结果或信息；
- 影响、紧急度与置信度；
- 证据引用与去重标识；
- 建议动作与处理状态；
- 简报生成时间；
- 夜间巡检时间；
- 语音播报开关；
- 当前分析视角；
- 需要读取的数据源；
- 简报语言、长度与通知方式。

## 5. Cron Jobs / 自动化模型

每个自动任务至少包含：

- 名称与所属项目；
- 使用的 Agent；
- 自然语言计划与 Cron Expression；
- 要完成的动作；
- 输入数据与允许访问的范围；
- 输出位置；
- 是否需要人工确认；
- 上次运行、下次运行和当前状态；
- 失败提醒与重试策略；
- 可审计的运行记录。

首批自动任务示例：

| 自动任务 | 计划 | 作用 |
| --- | --- | --- |
| 每日项目巡检 | 每天 23:30 | 检查 Repo、目标和项目状态变化 |
| 今日简报生成 | 每天 09:00 | 汇总所有项目，作为助理消息自动发送文字与语音卡片 |
| 增长周报 | 每周一 09:00 | 为增长阶段项目总结渠道与实验表现 |
| Trading 风险巡检 | 每 30 分钟 | 检查回撤、敞口和风险规则 |

## 6. 信息架构与交互原则

第一版保留三个一级入口；项目通过侧边栏直接进入，不再占用一个全局一级入口：

### 工作助理

- 作为跨项目的通用 Agent 对话频道，不以某一天的简报为边界；
- 页面采用标准 AI Chat 结构，任务讨论、多天简报和追问进入同一条消息时间线；
- 从目标里程碑点击“开始任务”时，携带项目、目标和里程碑 ID 进入工作助理，并先讨论完成标准与第一步；
- 开始任务不会自动把里程碑标记为完成，完成状态必须由后续证据或用户明确确认；
- 每日简报汇总全部项目，而不是逐项目展示多份报告；
- 每天 09:00 自动发送一张中文语音卡片，并触发桌面通知；
- 中文语音控制在三分钟以内，全文默认折叠并直接在卡片内展开；
- 聊天输入框固定在页面底部；
- 支持结合项目现状、目标、里程碑、收件箱和最近简报继续讨论；
- 云端 TTS 不可用时保留系统语音兜底。

### 决策收件箱

- 使用“待处理、进行中、等待中、已完成、已忽略”五个状态；“去处理”立即进入进行中；
- 等待中包含等待部署、等待验证、等待外部处理、等待指标、等待用户和等待复查；关联 PR 合并不会直接完成事项，最新验收证据才可以自动完成；
- 选择项目后，项目工作区使用“收件箱、状态、目标、设置”四个一级 Tab；
- 收件箱默认聚焦待处理事项，不显示通用输入框；创建和管理事项通过工作助理完成；
- 支持由助理 Agent 生成简报；
- 支持播放语音、查看文字和自然语言追问；
- 展示少量证据链接；
- 需要数据时由 Agent 临时生成动态视图。

### 文件

- 在 Agent Runs 前提供跨项目文件入口，用于集中保存运营、Marketing、分析和内容生产产物；
- 每个项目拥有独立文件空间，另有不归属具体项目的共享空间；
- 支持新建文件与文件夹、导入、文本预览和编辑，并可在 Finder 中打开；
- Agent 只能在绑定的项目 Workspace Roots 和所选文件空间内工作，不能越过项目目录；代码与随产品发布的资源进入 Workspace，Marketing、运营、研究、报告、品牌与宣传素材等代码无关产物进入项目文件空间；
- Agent 真实写入的文件会作为 Artifact 关联回产生它的 Agent Run，避免只在对话里声称“已保存”。

### Agent Runs

- 每个 Run 都是一个可恢复、可继续对话的持久 Session；列表页只展示 Session，不保留底部全局输入框；
- 点击 Run 后在右侧打开 Session 对话，展示完整消息、工具活动和错误；默认收起、可拖拽调宽的右侧信息栏分为“基本信息 / 文件”，集中展示 Git 增删行、项目与 Workspace 摘要，并在栏内预览 Run 产出的 Markdown、文本和图片；
- Session 可以选择关联一个 Goal / Milestone，也可以作为独立任务运行；
- Agent Run 不再区分“普通任务”和“代码任务”，只选择执行 Agent；Pi、Codex、Claude Code 和 OpenCode 都接收同一种 Run 和项目上下文；
- Pi 使用内置 Agent Harness；Codex、Claude Code 和 OpenCode 连接本机已登录的运行时，并继续拥有各自的认证、模型配置和 Session；
- 每个项目可在项目设置中选择默认 Agent；全局 Coding Agents 设置另有一个默认 Coding Agent，供“去处理”等未显式选择 Agent 的入口使用；单次 Run 仍可覆盖；
- Session 保存对应运行时返回的 Session ID，后续消息恢复同一个 Agent 上下文；工作目录使用项目主 Workspace，其他 Workspace Roots 和项目文件空间作为额外可访问目录；
- 新建 Session 先进入 `draft`，创建页只配置项目、Agent、关联里程碑和标题；第一条消息在聊天页由用户发送；
- 从决策收件箱点击“去处理”时，系统直接创建草稿 Session 并把建议任务预填到聊天输入框，不自动执行；
- 从 Goal Milestone 点击“开始任务”时复用已有未归档关联 Run，或创建新的草稿 Run；预填 Prompt 会在 Mac 与 iPhone 间同步，编辑后自动保存，首条消息仍由用户发送；
- Codex、Claude Code 与 OpenCode 使用各自本机默认账号和配置，不注入 CC Switch 配置；应用继承交互式 zsh 环境，并只在用户选择模型后显式传入对应模型参数；
- 三个外部 Agent 默认使用完整本机访问和自动批准模式。每段思考摘要独立保存和显示；两个 Thinking 之间的连续工具调用归为一个默认折叠的调用组，当前 Thinking 与正在运行的工具会显示动态工作状态。

### 项目状态

- 状态页统一维护项目使命、愿景、当前现状和已确认事实；
- 用户确认的现状优先于 Agent 推断与 Repo 证据，并显示来源和更新时间；
- 使命、愿景和项目现状不再混在目标或设置页中。

### 项目目标

- 目标页使用按 P0 / P1 / P2 排序的统一单列列表，不再按进行中、Roadmap 或已完成拆分区块；
- P0 / P1 / P2 只表示优先级；已规划 / 进行中等状态单独管理，只有进行中和有风险的目标进入例行 Check-in；
- 每个目标都可以独立展开或折叠；折叠后保留标题、状态、指标和里程碑数量，展开后显示进度、里程碑和最近一次 Agent Check-in；
- 用户可以在统一输入框中直接描述结果，或在工作助理中要求 Agent 操作，由目标 Agent 创建结构化目标和 2–5 个可验证里程碑；
- 未完成里程碑提供“开始任务”操作，点击后进入工作助理的结构化任务上下文，而不是直接修改完成状态；
- 里程碑是信息行而不是可选择列表；每项的三点菜单可由用户明确标记完成或删除，删除时保留历史 Agent Run 并解除其里程碑关联；
- 支持手动“检查进展”，每天 09:00 生成简报前也会检查已到期的目标；
- Check-in 优先使用项目 Connector 的真实数据和证据，没有证据时明确保持未知，不虚构完成度；
- Agent 发现目标有风险时才创建关联的收件箱 Signal；后续 Check-in 使用稳定问题键更新同一 Item，证据确认风险解除时主动完成；
- 用户可以暂停、恢复、标记风险或完成目标；恢复后会重新安排 Check-in。

可以直接对 Agent 说：

- “分析 Vows 当前状态，并创建下一个目标”；
- “检查 Vows 当前目标的进展”；
- “暂停这个目标”或“把这个目标标记为完成”；
- “把这个阻塞投递到 Vows 的收件箱”；
- “忽略这条收件箱事项”。

Vows 当前以用户确认现状为准：产品已可正常使用，用户自主创建婚礼 Event 的完整流程已经打通。当前 Roadmap 包含一个 P0 当前目标（社交媒体账号与宣传内容体系）、一个 P1 规划目标（婚礼模板优化与升学宴、百日宴等场景扩展）以及两个 P2 规划目标（定价方式、H5 与海外用户支持）。

### 自动化

- 独立管理 Cron Jobs；
- 列表、任务详情、新建任务和运行记录分别进入独立页面；
- 支持立即运行、启停、失败提示和审计记录。

### 页面规则

- **主区域每次只承载一种主要内容**；
- 页面切换优先于抽屉和多栏堆叠；
- Agent 对话是主要入口，固定 Dashboard 是次要能力；
- 图表和复杂数据 UI 按问题动态生成，不长期占据首页；
- 不设置资料库、文件库等与核心闭环无关的一级入口；
- 始终保持清晰的返回路径和项目上下文。

### 全局 Provider 设置

- 进入设置后，主侧边栏切换成设置二级导航，并提供返回原主页面的入口；
- 全局设置拆分为“通用、模型、语音与 TTS、权限与安全”；项目 Connector 移入对应项目的“设置”Tab；
- 每个设置页面使用扁平单列布局，不再用嵌套 Card 重复标题或描述；
- Agent 与 TTS 分开配置，各自包含一套 Primary 和可选 Backup；Primary 请求失败时自动切换一次，并在运行结果中记录实际 Provider；
- 工作助理的内置模型 Provider 支持 OpenAI-compatible API（自动兼容 `/responses` 与 `/chat/completions`），并保留 CC Switch Codex OAuth 本地反代兼容模式；这套配置不注入 Codex、Claude Code 或 OpenCode；
- Agent 回复使用 SSE 逐段传输并以 GitHub Flavored Markdown 渲染；内部更新事件对齐 ACP `session/update` 的 `agent_message_chunk` 与 `plan` 结构，为后续 Codex / Claude ACP Adapter 保留兼容边界；
- TTS 支持 macOS 系统语音、OpenAI-compatible `/audio/speech` 和 ElevenLabs；OpenAI 默认使用 `gpt-4o-mini-tts` / `marin`，ElevenLabs 默认建议 `eleven_multilingual_v2` 并单独配置 Voice ID；
- API Key 只写入系统安全凭证存储，SQLite 仅保存非敏感配置与凭证引用；
- 设置页提供 TTS 实际试听，用来验证系统语音、OpenAI-compatible 网关或 ElevenLabs 配置；试听也走同一套 fallback 链路。

## 7. AI Native 原则

1. **Conversation first**：大多数操作可通过自然语言发起和调整。
2. **Context aware**：Agent 的判断来自项目目标、阶段、Repo、自动任务和数据源。
3. **Evidence backed**：总结和建议必须能追溯到实际证据。
4. **Adaptive lens**：不同项目使用不同的分析方法和成功标准。
5. **Full-access autonomy**：当前本机 Agent Run 的文件、命令、网络、浏览器和应用操作默认完全访问并自动批准，减少频繁打断。
6. **Respect explicit scope**：完整访问不等于扩大用户意图；Agent 仍应遵守任务范围，避免未经要求的不可逆操作、凭证外传或生产数据破坏。
7. **Audit everything**：Agent 的工具操作和结果都应进入运行记录与审计链路。
8. **Dynamic UI**：表格、图表、表单和操作面板由 Agent 在需要时生成。
9. **Progressive disclosure**：默认界面保持简单，细节按用户意图展开。
10. **Automation with auditability**：自动运行必须有状态、历史和失败处理。
11. **No fake progress**：没有证据时，AI 应明确标记未知，而不是推测完成度。

## 8. 视觉设计原则

当前设计方向参考 Apple 2026 年 macOS 27 的 Liquid Glass 设计语言，但不复制某个具体 Apple App。

- Liquid Glass 只用于导航与关键交互控件；
- 内容层保持安静、清晰和高可读；
- 通过层级、排版和间距建立结构，不依赖大量卡片；
- 采用同心圆角、熟悉的控件位置和克制的系统色；
- Light / Dark 跟随系统外观，不额外增加应用内主题负担；
- Dark Mode 使用 base / elevated 层级，而不是简单颜色反转；
- 支持 Reduce Transparency 与 Increase Contrast 等可访问性偏好；
- 每个主页面只展示一个核心内容。

Apple 官方参考：

- [Apple Design Resources](https://developer.apple.com/design/resources/)
- [Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass)
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)

## 9. MVP 建议范围

### 必须完成

- 项目创建、切换与配置；
- 结构化目标、里程碑、Check-in、风险回投和简报汇总；
- Repo 连接检查；
- 工作助理通用对话，以及每日简报的文字生成、语音播放和追问；
- Cron Jobs 列表、新建、启停、立即运行和运行记录；
- Full Access / 自动批准策略与完整审计；
- Codex / Claude Code / OpenCode 任务适配器与结果回收；
- Browser Use 与 Computer Use 基础能力；
- Light / Dark 自动适配。

### 第二阶段

- 项目类型模板和分析视角自动推荐；
- GitHub、产品分析、营销渠道、Trading 数据等 Connector；
- Agent 动态生成表格、图表和操作 UI；
- 跨项目依赖与注意力分配建议；
- 通知、移动端简报和语音交互；
- 团队共享项目与权限模型。

### 暂不做

- 通用文档或资料库；
- 复杂传统看板；
- 固定、重型的数据驾驶舱；
- 通过模拟会议增加仪式感；
- 没有明确执行价值的统计指标。

## 10. 建议的系统模块

```text
App Shell
├── Decision Inbox / Briefing
├── Projects / Project Context
├── Agent Conversation & Dynamic UI
└── Automation / Run History

Backend
├── Project Config Store
├── Decision Inbox & Evidence Store
├── Connector Adapters
├── Agent Orchestrator
├── Permission Broker & Audit Log
├── Scheduler / Cron Runtime
├── Briefing Engine
├── Voice / TTS
└── Audit & Approval Log
```

实现时应让 Scheduler、Agent Runtime、Connector 和 UI 解耦，以便未来替换模型、Coding Agent 或数据源。

## 11. 当前设计文件

| 页面 | 外观 | 文件 |
| --- | --- | --- |
| 今日简报 | Light Mode | [`design/01-today-light.png`](design/01-today-light.png) |
| 项目设置 | Dark Mode | [`design/02-project-settings-dark.png`](design/02-project-settings-dark.png) |
| 自动化 | Dark Mode | [`design/03-automation-dark.png`](design/03-automation-dark.png) |

## 12. 已确认的技术决策

### 桌面框架与 UI

- 首个运行平台是 macOS 桌面端；
- 使用 Electron + React + Vite + TypeScript，不使用 Tauri；
- UI 学习当前 ChatGPT Mac App 的信息层级与交互骨架，不做像素复制；
- Electron Renderer 保持 `sandbox`、`contextIsolation`，远程内容不得开启 Node Integration；
- 首版通过签名与公证后的 DMG 分发，暂不以 Mac App Store 为目标。

选择 Electron 的主要原因是应用需要稳定的桌面主进程、沙盒 Renderer、原生权限归属和外部 Agent 生命周期管理。Browser Use 与 Computer Use 都是 Agent Run 期间通过 MCP 调用的能力，不在应用中内嵌浏览器或远程桌面页面。

### Agent 与外部执行

- 底层协调 Agent 使用轻量的 Pi Agent，并通过自有 `AgentRuntime` 接口隔离；
- LLM Provider 可替换，生产密钥存入 macOS Keychain；
- `cc-switch` 仅作为开发期 Provider 切换工具，不成为生产依赖；
- Pi Agent 不作为权限或安全边界，权限、审计、取消、超时、预算和持久化由应用层实现；
- Codex 优先使用 Codex SDK、App Server 或 `codex exec --json`；
- Claude 优先使用 Agent SDK 或 `claude -p --output-format stream-json`；
- 当前外部 Agent Run 使用 Codex app-server JSON-RPC、官方 Claude Agent SDK 与 OpenCode CLI；三者的 Session ID、流式结果和工具事件都回投同一个 Agent Run；
- Coding Agent Runtime 不覆盖各 CLI 的账号或基础配置。Electron 主进程启动时读取交互式 zsh 环境，确保从 Finder 启动时也能继承终端中的 `PATH`、API Key 和 Provider 变量；
- 外部 Agent Run 使用 Full Access / 自动批准策略；用户仍可停止当前 Run，工具事件和结果进入同一个 Session 记录；
- 不通过 Computer Use 点击 Codex / Claude UI 来派发任务；没有结构化接口的 App 才回退到 Computer Use。

### Browser Use 与 Computer Use

- Browser Use 使用 `browser-use==0.13.7` 的固定 Schema stdio MCP（`browser-use --mcp`），默认 headless 独立 Profile；
- Project Agent 携带固定版本的 Astral `uv`，由 uv 管理 Python 3.12 与 Browser Use 环境，不依赖系统 Python；
- Computer Use 使用 CUA Driver `0.19.0` 的 embedded daemon 与 stdio MCP proxy，不维护自有 Swift Helper；
- CUA daemon 由 Electron 主进程直接启动，继承 Project Agent 的 Screen Recording 与 Accessibility 权限，并把同一私有 socket 暴露给 Pi、Codex、Claude 和 OpenCode；
- 浏览器优先走 Browser Use；只有明确需要用户现有本机登录态或原生 App 时才走 CUA Driver；
- 两项能力都只存在于 Agent Run，不提供独立内置页面，并遵循当前本机 Run 的 Full Access 策略。

### 权限模型

当前本机模式为 `full access`：

| 操作类型 | 默认处理 | 示例 |
| --- | --- | --- |
| 文件与命令 | 完整访问、自动批准并记录 | 项目读写、测试、构建与本机命令 |
| 网络与工具 | 完整访问、自动批准并记录 | 浏览网页、调用 MCP、运行 Connector |
| 浏览器与应用 | 完整访问、自动批准并记录 | Browser Use 与 Computer Use |

Agent 仍必须服从用户明确的任务范围，不能因为拥有完整访问就主动扩大目标。用户可以随时停止运行；远程、多用户或生产发布场景的细粒度权限门禁留待后续实现。

### 数据、插件与 Skills

- Cloudflare、Google Analytics 等需要认证、API Schema 和限流控制的数据源实现为 Plugin / Connector；
- 异常检测、漏斗分析、增长周报、项目健康总结等方法实现为 Skills；
- 不同项目的 Property、Zone、指标定义、目标、基准与业务术语存入 Project Analytics Profile；
- 规则是：Plugin 负责“能访问什么”，Skill 负责“如何分析”，Project Profile 负责“这个项目具体怎么看”。

### TTS

- 简报首先实现单向 TTS，不在 MVP 中实现完整实时语音对话；
- TTS 使用可替换 Provider 接口；
- 云端语音支持 OpenAI `gpt-4o-mini-tts`、OpenAI-compatible Provider 与 ElevenLabs；ElevenLabs 中文简报默认使用 `eleven_multilingual_v2`；
- Primary 和 Backup 使用独立凭证，失败后自动降级；配置变化会使旧音频缓存失效；
- 文字简报生成后缓存整段音频，并保留逐句定位与播放速度扩展点。

### 本地数据

- 项目、决策收件箱、Agent Runs 与审计记录使用本地 SQLite；
- 所有外部动作保留输入摘要、风险判断、结果、证据和时间；
- 密钥不写入 SQLite、配置文件或日志。

## 13. 第一版工程范围

当前代码骨架覆盖：

- Electron 主进程、沙盒 Preload 与 React Renderer；
- 决策收件箱、项目和 Agent Run 的共享领域模型；
- SQLite 本地存储；业务目标、收件箱事项与 Agent Run 不使用演示数据填充；
- 对话 Agent 的受约束应用动作层：创建 / 检查 / 流转目标，以及创建 / 流转决策收件箱事项；
- Agent 可更新用户确认的项目现状、目标优先级和 Roadmap 状态；所有写操作进入权限审计；
- 基于实时 Project Profile、Repo / README / Skill 摘要和 Connector 结果的目标分析与证据化 Check-in；
- Settings 控制面、Connector Catalog、Connector 实例与运行记录；
- 可运行的 Local Repo Connector：只读取 Git 元数据、`AGENTS.md`/Skills 是否存在和数量，不读取源码、`.env` 或凭证内容；
- 可运行的 PostgreSQL Connector：连接信息按项目保存、密码进入 macOS Keychain、查询强制使用只读事务；
- Connector 结果指纹去重、证据记录与决策收件箱回投；
- 独立的每日项目总结存储、手动生成入口、每日 09:00（Asia/Shanghai）调度、聊天推送与启动补跑；
- Roombase Production Analytics Profile：引用项目现有 env、固定聚合 SQL、只读事务，不复制凭证或用户级数据；
- Vows `vows-growth-v1`：固定聚合付费订单、婚礼创建、邀请就绪/发布、RSVP 与祝福；只返回汇总值，并监控已支付未交付；
- AI Marketing `ai-marketing-production-v1`：固定聚合生成任务、候选、评审采纳、图片/视频交付与 Worker 心跳；不读取 Prompt、素材内容或用户身份；
- Vows Project Agent 直接派发 Codex 到现有 `wedding-promotion` Skill 与 `marketing/` 工作区；AI Marketing Adapter 直接复用现有 Super Agent Thread + SSE Chat API；
- 聚合结果持久化、确定性无模型回退，以及按日期稳定去重的行动信号；
- 基于操作系统安全存储的 Credential Vault；SQLite 和日志只保存凭证引用；
- 模型与 TTS 的 Primary / Backup 配置、自动 fallback、ElevenLabs TTS 和按配置失效的音频缓存；
- Full Access 运行参数、权限策略和单元测试；
- Codex app-server 与 Claude Agent SDK 的真实可恢复 Session、流式结果、工具事件和取消处理测试；
- Agent Session 草稿创建、默认 Coding Agent / 模型传递、思考摘要、工具调用链，以及重命名和归档；
- Coding Agent 使用项目主 Workspace 作为 `cwd`，并获得所有 Workspace Roots 与项目产物目录；
- Electron 主进程从交互式 zsh 继承本机 Agent 环境，不改写或过滤用户的 `.zshrc` 配置；
- Agent Run 10 分钟无活动超时与应用启动时的遗留运行状态修正；
- Sentry 主进程、Renderer 和 Electron 子进程崩溃上报；
- Pi Agent Runtime、Codex、Claude、OpenCode、Browser Use MCP、CUA Driver MCP 与 TTS 的适配器边界；
- 固定版本和 SHA-256 校验的第三方工具准备流程，以及 Browser Use / CUA Driver 的真实 MCP smoke；
- 接近 ChatGPT Mac App 信息架构的基础 UI。

本地启动：

```bash
npm install
npm run prepare:agent-tools
npm run dev
```

验证：

```bash
npm run typecheck
npm test
npm run build
npm run ios:generate
npm run ios:typecheck
RUN_AGENT_TOOLS_SMOKE=1 npx vitest run src/main/services/third-party-mcp-runtime.integration.test.ts
RUN_CODING_CLI_SMOKE=1 npx vitest run src/main/services/coding-cli.integration.test.ts
RUN_MORNING_BRIEFING_SMOKE=1 npx vitest run src/main/services/morning-briefing.integration.test.ts
```

### PostgreSQL 指标 View 协议

PostgreSQL Connector 不接受 Agent 生成的任意 SQL。每个项目可以选择一个由项目维护的 `schema.view`，Connector 只读取以下字段：

| 字段 | 含义 |
| --- | --- |
| `metric_key` | 稳定的指标标识 |
| `metric_value` | 当前指标值 |
| `status` | `info`、`warning` 或 `critical` |
| `summary` | 给人的简短解释 |
| `observed_at` | 指标观测时间 |

只有 `warning` 和 `critical` 会生成决策项；`info`、正常数据和普通开发状态只保留在 Connector 运行记录中。View 名称经过安全标识符校验，查询运行于 PostgreSQL `READ ONLY` transaction，并带连接与语句超时。

### 每日项目总结 v0

数据库计算与语言总结严格分开：

1. **Project Analytics Collector** 使用版本化、固定、只读的聚合 SQL 计算完整自然日、前一日和 7 日基线；
2. Collector 只输出聚合指标、指标定义与数据质量说明，不输出用户级记录；
3. **Daily Summary Agent** 只解释结构化 JSON，不接触凭证、不写 SQL、不把普通波动投递收件箱；
4. 对所有项目通用的判断规则放在 Prompt，不同项目的表结构和业务口径放在 Project Analytics Profile。

基础 Prompt 位于 [`prompts/daily-project-summary.md`](prompts/daily-project-summary.md)。Roombase 第一版 Collector 位于 [`scripts/roombase-daily-metrics.mjs`](scripts/roombase-daily-metrics.mjs)，真实聚合数据生成的样例见 [`docs/examples/roombase-daily-summary-2026-08-04.md`](docs/examples/roombase-daily-summary-2026-08-04.md)。

桌面应用已内置同口径的 `roombase-daily-v0` Analytics Profile。应用每天上海时间 09:00 运行；如果当时未启动，则下次启动时检查并补齐上一完整自然日。生成结果会作为助理消息进入工作助理时间线，并在应用运行时触发桌面通知。模型 Provider 可用时由 Agent Runtime 解释聚合 JSON；不可用或调用失败时使用明确标记的确定性模板，确保早晨仍有结果且不会伪装成模型回答。简报保存在独立的 `daily_briefings` 表中，只有达到固定阈值的原子行动信号才进入决策收件箱。持续异常会更新原 Item；巡检确认指标恢复后，系统主动完成原 Item，而不是第二天再生成同义消息。

本地只读运行：

```bash
npm run metrics:roombase:daily -- --env-file /path/to/roombase-api.env
```

第一版口径使用 `Asia/Shanghai` 的前一个完整自然日；首次预订、新增用户、预订、支付、净实收和商户 onboarding 均由代码计算。Prompt 只在相对 7 日基线有足够偏离或存在明确积压时生成 Signal。

## 14. 尚待后续完成

- 产品正式名称与图标；
- 将 Roombase 的本地 env 引用升级为发行版 Keychain 配置；
- Browser Use 代理、域名 Allowlist 与现有登录态的显式授权流程；
- CUA Driver bounded policy 与应用级危险动作审批联动；
- TTS 播放进度、倍速与逐句定位；
- Scheduler 的系统级后台唤醒、指数退避与运行健康告警；
- 签名、公证、自动更新与发布流水线。
