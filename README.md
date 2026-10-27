# Fuddy

Mac 后台同步或设备发现确认登录失效时，会立即通知界面返回登录页；普通网络错误继续保留登录。退出原因只记录固定分类、已知服务端错误码和时间，不保存凭证或原始响应。

Mac 项目设置通过原生目录选择器添加本机文件夹，只显示目录地址；已配置文件夹时至少保留一个，并按目录地址选择本机主文件夹。设置中不再显示官网、“Agent 分析视角”字段和“产品上下文”区块，基本信息保留“一句话介绍”；保存其他设置时保留已有上下文数据。

> 面向自由职业者与个人开发者的多项目 AI 助理。当前仓库已进入 Electron 桌面端 MVP 开发阶段。

Mac 与 iPhone 的产品界面统一将 Agent Runs 称为 **Chats**（单个为 Chat）；已有会话、持久化 ID 与同步协议保持兼容。

项目 Chat 已接通 Mac / iPhone 图片与文件附件：统一数量和大小校验、持久附件描述、原生 Agent 图片输入，以及加密产物回传。手机发送队列可在重连后恢复，已校验的附件缓存可离线打开；Mac 支持选择、粘贴和拖入文件。iPhone 从输入栏弹出系统照片选择器，只访问选中的照片，无需授权整个相册；照片读取失败会显示错误。生成的图片与报告保留内容快照，双端消息显示可打开的附件卡片。实现边界与验证命令见 [Chat 附件链路](docs/chat-attachments.md)。

项目 Chat 将用户原话与 Fuddy 指令、项目背景分开传递。Codex 使用 `developerInstructions`，Claude SDK 在原生 system prompt 后追加，Pi 追加 system prompt，OpenCode 通过临时 `instructions` 文件加载并在本轮结束后删除。每轮恢复会话时刷新精简项目背景，保留有效事实及其来源、目标和收件箱证据，省略使命、愿景、初始设置占位信息与空值；背景不再拼入用户消息。主目录通过运行参数提供，Codex / Claude 使用原生附加目录参数；Pi / OpenCode 的附加 Workspace 以简短上下文补充。文件空间仅说明地址和产物用途。重建丢失的原生会话时仍补入已有可见对话。

iPhone Chat 详情在标题下方显示执行 Mac 名称与状态点（在线绿色、离线灰色），输入框上方不再重复显示主机状态；VoiceOver 仍可读出在线状态。

项目详情的目标页不再显示聊天输入框，项目设置移除“数据与下一步”编辑区，已有数据保持不变。外部 Agent 执行时将账户与用量快照写入 Chat 的 `accountContext`，在 Mac 的 Chat 信息栏展示：Codex 使用 app-server 的账户/额度接口，Claude Code 使用 SDK 的账户信息、限流事件和本轮用量，OpenCode 读取 JSON 步骤中的 token 与估算费用。套餐余量、API 接入方式和本轮用量分开记录；接口未提供的字段保持未知，API 模式不推算账户余额。记录带时间戳，不含邮箱、账户 Token、API Key 或原始账户响应；旧 Chat 在下次执行时采集，iPhone 同步并缓存此上下文字段。

## 当前实现状态（2026-08-19）

当前版本已经跑通从项目上下文、决策事项到真实 Agent Session 的桌面端主链路：

- 工作助理、每日简报、决策收件箱、项目状态 / 目标 / 设置、文件、Agent Runs 和自动化已接入同一套本地数据模型；
- Agent Run 不再区分 Coding / General，统一选择 Pi、Codex、Claude Code 或 OpenCode 作为执行 Agent；
- 每个项目支持一个或多个 Workspace Roots，并指定主 Workspace。普通 Run 与自动任务都在真实项目目录执行，同时把其他 Roots 和项目产物目录提供给 Agent；
- 新建 Agent Session 只创建草稿，不自动发送消息。“去处理”和 Milestone“开始任务”都会直接创建或打开关联 Session、进入聊天，并把持久化的建议任务放进输入框，用户确认或修改后再发送；
- 工作助理运行在 Pi 的持久 Agent Session 中，使用原生 Tool Call 和自动上下文压缩：可以管理项目、目标、收件箱、Agent Run 和自动化，读取每日简报、联网公开来源，并受约束地读取项目文件空间及已配置 Workspace 中的文件/代码；只读能力可直接执行，改变 App 状态的能力通过 `ask_user` 展示持久确认 Action，创建 Run 只预填不发送；
- Codex 使用 app-server，Claude Code 使用 Agent SDK，OpenCode 使用本机 CLI；三者均保存原生 Session ID，可在后续消息中恢复同一上下文；
- Mac Chat 在 Agent 运行期间发送的新消息先进入持久队列；排队消息可取消，Pi、Codex 和 Claude Code 还可选择 Steer，立即送入当前运行轮次。若当前轮已结束或原生接口拒绝，消息仍按队列顺序执行；OpenCode 的单次 CLI 运行暂不提供 Steer。
- Fuddy 的 Codex Chat 独立续接，不再与 Codex 桌面端交替操作同一个会话 ID。升级后首次发送时，旧会话通过 `thread/read` 读取历史、确认没有正在执行的轮次，再用 `thread/fork` 从已确认的最后一轮派生新 ID；新 ID、归属记录与缺失的可见对话原子保存，之后一直恢复新 ID。原生完整上下文由 Codex 保留，Fuddy 只补入缺失的用户消息和公开回复，不导入隐藏推理或工具原始输出；迁移后不再同步原会话的新消息。迁移失败或历史不完整时不发送本轮消息、不清空原 ID；已绑定会话遇到外部占用时提示重试，不自动再派生，也不停止其他应用。沿用 CLI 的登录、配置与原生存储，不修改 `CODEX_HOME` 或复制凭证；请只在 Fuddy Mac / iPhone 内继续 Fuddy 会话。
- 手机和 Fuddy Mac 的同一 Chat 共用发送队列；取消后等待运行时退出再放行下一轮。Agent 执行失败时远程命令也标记失败；当前页面的纯文本失败消息回填输入框供用户编辑后重发，不自动重放命令。
- 本机 Chat 发送队列已持久化：排队消息在进入 Agent 上下文前可以取消，重复请求不会重复执行；重启后只恢复尚未开始的本账户请求，执行状态不明的请求需人工确认。真人消息显示发送时的姓名和首字头像，旧消息来源不明时显示“历史用户”。项目共享已接通 Mac 的项目邀请、成员权限、设备授权、加密历史、附件与产物及多人 Chat 命令；iPhone Debug 客户端可接受邀请、阅读、发送文本、停止请求和退出。Mac 与 iPhone 入口及 Account API 共享路由不再受环境或构建开关控制，项目所有者仍需主动开启共享并发布历史。Account API、Relay 与 D1 新迁移已部署；真实双账户、多 Mac/iPhone 联调与迁移演练仍未完成，不能把健康检查或本地测试视为端到端验收。实施边界见 [项目共享计划](docs/project-sharing-plan.md) 与 [阶段性 Review](docs/project-sharing-review.md)。
- Coding Agents 设置会检测本机安装状态、版本、可选模型及各模型支持的 Reasoning Effort；Mac 聊天输入框的无底色模型入口也可向上展开，直接选择默认或 Session 级 Agent、模型与 Reasoning Level。运行时仅在用户选择后显式传入对应参数；
- macOS GUI 启动时读取登录且交互式的 zsh 环境（`.zprofile` 与 `.zshrc`），继承导出变量并尊重显式 unset，因此本机 Agent 能获得与终端一致、未经应用过滤的环境变量和认证配置；应用不会修改 Shell 配置文件；
- Agent Run 最新失败消息的错误卡片提供“重试”，沿用原消息、附件、发送者与原生 Session，不重复插入用户消息；重试收到回复或工具进度后移除旧错误卡片，再次失败时只显示新错误，Mac 与 iOS 保持一致；正在运行、排队或执行 Mac 离线时禁用重试；
- Mac 与 iOS 同样隐藏 Claude SDK 的 `claude-thinking-*` 段落，保留正常进度说明、工具调用与最终回复；iOS 升级后会自动重放同步，补回旧缓存丢失的段落标记；
- Agent Run 当前按产品约定使用 Full Access / 自动批准模式。Codex、Claude Code 和 OpenCode 分别使用各自支持的完全访问参数；
- Agent 对话已支持流式回复、思考摘要、折叠工具调用链、当前工具运行态、Session 重命名 / 归档，以及无活动超时保护：没有正在执行的工具且连续 10 分钟未收到运行进展时才自动停止；工具运行期间暂停计时，所有并行工具完成或失败后重新计时。Provider 的命令输出、MCP 进展和未展示的模型流事件也计入活动，不记录或展示隐藏推理；工具自身超时和用户手动停止仍然有效。Codex、Claude Code 和 OpenCode 的原始事件先归一为“思考阶段 + 连续操作组”，工具统一保留运行 / 完成 / 失败状态和可读摘要；Mac 与 iPhone 消费同一套展示语义，原始参数和输出只在二级展开中显示；
- Mac 主区域统一使用纯色页面背景和全宽顶部 Header；Agent Run 顶部用项目与会话标题的单行导航，工作助理与 Agent Run 共用聊天对齐、消息署名、底部时间和紧凑输入框，Light / Dark 都使用同一套语义颜色。项目列表是独立页面，所有已添加项目常驻主侧边栏，即使没有 Run 或所有 Run 已归档，也可从项目标题旁的加号新建 Run；Agent Run Session 按项目分组且只在运行时显示加载图标；回复的相关文件集中展示在正文下方，一个容器内每个文件独占一行，并显示文件数量，点击可预览；主侧边栏支持拖拽调整宽度；临时成功和错误提示会在 5 秒后自动消失；
- Renderer App Shell 使用单一的 route 状态机表达页面、项目 Section、Settings 返回路径和 Run 选择，领域数据通过可按 Projects、Goals、Decisions、Runs 等 key 独立订阅的 store 更新；Sidebar、Route Outlet、Goal Composer 与跨页面 Workflow 均有独立边界，`App.tsx` 只负责应用装配。
- 主进程、Renderer 未处理异常及 Electron 子进程异常已接入 Sentry 崩溃报告。
- 账户改造已进入可运行首版：独立 `cloud/account-api` Worker 使用 D1 管理 Email / Google Identity、短期 access token、完整历史重放检测的原子 refresh token 轮换、Device、Mac Host、默认 Sync Space 与 enrollment；生产 Worker 已部署到 `https://fuddy.ai/api/account`，邮箱验证码通过已验证的 Resend `fuddy.ai` 域名发送，发送冷却和校验次数都由 D1 原子占位，签名 Webhook 会幂等记录投递结果并抑制退信/投诉地址。每个账户最多保留 20 台活跃设备，其中最多 5 台 Mac；每台设备最多保留 10 个活跃 Session。Cron 除了持久重试 Relay 撤销，也会分批清理过期验证码、限流窗口、已撤销 Session、邮件回执和安全审计历史，避免免费托管的 D1 数据只增不减。Mac 必须先登录，随后按“检测 Coding Agent → 添加第一个项目（可跳过）”完成两步 onboarding；手机连接不再是设置步骤。Fuddy session 与设备私钥只进入 credential vault。一个账户可以同时登录多台 Mac，每台 Mac 对应独立同步空间；iPhone 登录同一账户后自动连接各 Mac，默认展示账户级项目；项目详情与 Runs 列表汇总各执行机的 Run，新建时选择在线且已配置主文件夹的 Mac，后续操作固定回到原执行机。每台 iPhone、每个空间仍有独立 grant、Relay Token、Space Data Key 与本地缓存，设置展示设备状态，不再切换全局空间。Mac 先用 Relay Token 获取五分钟内单次有效的所有权证明，Account API 在 D1 预占后才通过私有 Cloudflare Service Binding 消耗证明并绑定 `spaceId + bindingId + generation`；D1 落库失败会释放 Relay 绑定。设备/空间撤销先原子写入 D1，再由 Cron 持久重试，旧任务不能修改或撤销不属于它的 Relay。Mac 轮询保留为恢复路径。在线 Mac 使用设备 P-256 公钥和 ECDH/HKDF/AES-GCM 封装授权，账户服务器只保存密文 grant。安全提醒邮件、完整账户删除、分段 baseline v2、主动 wake-up、密钥轮换与 Sign in with Apple 仍是正式多用户发布前的未完成项。
- 多 Mac 项目模型已在代码中接入：账户共享项目身份、产品上下文、目标与 Milestone，每台 Mac 独立配置主文件夹、附加文件夹和默认 Agent；新建 Run 可选择在线且已配置目录的执行 Mac，后续消息与操作固定回到原机器。跨 Mac 复用加密 Relay、客户端授权和持久化命令去重；初次设备授权需要目标 Mac 在线。使用前须同步升级 Account API、Relay 与各 Mac，真实双机验收尚待执行。迁移和连接流程见 [`docs/multi-mac-projects.md`](docs/multi-mac-projects.md)。
- SQLite 使用递增版本和逐步事务执行迁移；迁移失败不会推进版本。领域读写已按 Projects、Goals、Runs、Connectors、Briefings、Automations、Companion 与 Decisions 拆成独立 Repository，`AppDatabase` 只负责连接、迁移与组合。已发布的 Companion outbox 事件默认保留 30 天并分批清理，避免本地同步历史无限增长；无法满足契约或传输上限的单条事件会进入可见的本地隔离状态，不会阻塞其后的有序队列。
- Companion 的事件、实体和 Payload，以及远程命令与 Payload 使用同一套强类型协议；本地 outbox DTO 与 Relay wire DTO 明确分型，Relay 在写入前执行完整嵌套 Zod 校验并移除已知协议版本中的未知字段。Swift 事件/命令枚举、命令 Payload、Snapshot 和非实体 Event Payload 由共享 manifest 生成。生成器还为核心同步 DTO 生成协议指纹，构建检查会阻止 Mac / iOS DTO 漂移后发布；未知未来事件类型仍可被安全忽略。
- Agent Run 通过 Provider Registry 调度。Pi、Codex、Claude Code 与 OpenCode 分别注册 Adapter 和能力声明；Task Dispatcher 不再包含 Provider-specific 执行分支，Renderer 的 Bootstrap 订阅与主进程事件重试也已从 App Shell 抽离。
- 所有聊天输入框已支持语音输入。Mac 首次录音会明确请求系统麦克风权限；已拒绝时打开“隐私与安全性 → 麦克风”供用户恢复授权。Mac 默认使用可选下载的 Whisper `large-v3-turbo Q5` 本地模型，未安装或本地失败时可回退到 OpenAI-compatible `/audio/transcriptions`；iPhone Release 构建通过准备脚本把同一模型预置进 App，并始终在设备上转写。录音只填入输入框，不会自动发送。
- 已加入原生 SwiftUI iOS Companion 工程。iPhone 登录 Fuddy 后会自动发现同账户的 Sync Space，由在线 Mac 完成设备授权并开始同步；新版界面不再提供二维码扫描或手动配对。本地 SQLite outbox 会把项目、目标、决策、每日总结、工作助理、Agent Run、消息和产物增量同步到 Cloudflare Relay。outbox 仍逐条落盘，但网络层按最多 100 条 / 512 KiB 批量提交；首次 baseline 使用轻量快照加按实体 / 聊天页有序事件，大型历史页会保留能安全传输的最新记录与续传游标，极端页面从较小窗口恢复，不会让大量 Run 或附件阻塞首次同步。协议升级时 Relay 保留仍待回放的加密事件，Mac 会用原版本关联数据排空既有加密命令并以当前协议回传终态，避免静默丢失用户操作。命令状态不重复携带原始输入，只有历史分页和附件上传保留 iPhone 真正消费的结果，超限结果会降级为可恢复失败。工具完整输出只留在 Mac，Relay 与 iPhone 只接收工具类别、完成 / 失败状态、可读摘要和最多 600 字的细节。手机侧边栏依次为 Chats、助理、收件箱、项目和设置，不再显示分割线或顶部“助理 / Runs”切换；Chats 直接打开按项目分组的列表，助理直接打开对话。Chat 列表右侧显示执行 Mac 名称及在线绿点（离线灰点）。已验证账户回到前台时在后台校验身份，保留当前页面与消息滚动位置；首次恢复账户仍显示加载页，身份失效时回到登录。Chat 列表按项目分组，仅保留页面右上角的创建入口，新建由 Mac 落库的 Draft Run；工作助理与 Agent Run 共用同一种 Chat Record、100 个展示 Block 的初始窗口、默认落在最新消息的滚动逻辑，以及向上滚动触发的受约束历史分页；差异只保留 Agent、预置 Prompt、附件能力和特殊卡片。两类聊天共用支持照片 / 文件上传的输入组件，但隐藏 Mac 专属的 Agent / 模型 / Reasoning 选择入口；每日总结直接进入助理时间线，Agent 的思考摘要与工具操作在运行中实时显示，完成后按同一阶段结构整体折叠。项目详情提供与 Mac 对齐的概览 / 设置，可编辑基本信息、产品上下文、一个或多个 Workspace、主 Workspace、默认 Agent、入口与数据源，并通过受约束的 `project.update` 命令交由 Mac 落库。Session 聊天不再内嵌产物列表，右上角“信息与文件”Modal 集中展示基本信息和文件；缺少云端副本时，iPhone 会通过受约束的命令请求在线 Mac 实时上传，再进行大小与 SHA-256 校验并用 Quick Look 打开。手机也支持离线缓存、收件箱处理和 Session 重命名 / 归档，所有实际 Agent 与工具操作仍在 Mac 执行；完整架构见 [`docs/ios-companion-architecture.md`](docs/ios-companion-architecture.md)。
- Companion Relay 默认地址为 [`fuddy.ai/api/relay`](https://fuddy.ai/api/relay/health)，使用 Durable Objects、Hibernation WebSocket 和私有 R2；当前产品只提供托管免费版，尚不开放自托管入口。每个 Relay 账户的单个 R2 密文对象最多 20 MiB（因此原文件上限为 20 MiB 减去固定 32 字节加密封装），已登记附件密文总量最多 100 GiB；Relay 会先在 Durable Object 中原子预占容量，超限请求不会写入 R2，上传失败或过期的预占会自动释放。旧 [`workers.dev`](https://project-agent-companion-relay.moghub.workers.dev) 入口与旧的一次性配对协议继续保留，供已安装版本无损升级，但配对期只允许认证、认领和生成账户所有权证明；只有 Account API 确认 `spaceId + bindingId` 后才能写事件、命令或附件，十分钟内未完成绑定的配对凭证会由 DO alarm 清理。事件、命令结果与附件使用在线 Mac 为设备封装的 Space Data Key 进行 AES-256-GCM 端到端加密；Relay 只保存密文、路由元数据和状态，不持有解密密钥。设备 Token 只保存哈希，账户设备撤销会同步撤销 Relay 访问。每批事件在 DO 内一次授权并通过 SQLite 同步事务幂等写入，随后只发送一个 `sync.available(lastSequence)` 唤醒提示；Mac 与 iPhone 收到提示后仍以 ordered replay 为准。Mac 至少每 24 小时生成一次完整状态快照；Relay 写入新快照后立即删除它之前的事件，并始终保留最新快照作为恢复基线。每个 Relay 账户最多保留 5,000 条事件；达到上限时 Relay 不会删除尚未纳入恢复基线的增量，而是要求 Mac 事务性重建 outbox、优先上传新快照，再删除旧基线与增量。如果当前状态本身需要超过 5,000 条 baseline 事件，Mac 会在替换 Relay 现有完整基线前明确报错，要求先归档不再需要的项目或 Run，不会循环上传半成品。命令最多保留 1,000 条，达到上限时优先回收最老的终态命令并在 30 天首次接纳 / 重试窗口内保留 ID tombstone；tombstone 空间不足时拒绝新命令，不会提前删除仍可重试的 ID。APNs 只携带通用唤醒/完成提醒，不包含业务正文；Release 配置默认使用 production APNs，开发命令显式覆盖为 development。

- iOS App 登录后默认进入 Chats 列表。Chat 与助理共用键盘避让和底部跟随逻辑：停在最新消息时，键盘或输入框高度变化会保持最新消息可见；阅读历史消息时不会主动跳回底部。
- iPhone 新建 Chat 时可选择 Fuddy Agent、Codex、Claude Code 或 OpenCode；不显式选择时沿用执行 Mac 的项目默认 Agent（无项目时使用默认 Coding Agent）。共享项目成员新建 Chat 时也可选择 Agent，实际执行仍由项目的执行 Mac 负责。

iOS 工作助理与项目 Chat 的消息共用固定 20pt 左右留白，留白包含在每条消息的滚动定位区域内；布局测试覆盖消息展开、键盘高度变化与窄屏重排。输入栏的附件、语音和发送按钮共用 44pt 操作区域，单行文字与图标垂直居中，多行输入时按钮保持在底部同一行。

目前仍属于本机 / 个人设备 MVP。仓库已提供 GitHub Actions macOS App 构建、Relay 部署与 iOS Simulator XCTest 门禁；个人开源 Release 默认生成 unsigned DMG / ZIP，不需要 Apple Developer、Cloudflare 或 APNs 凭证。需要公开分发时再接入签名、公证和自动更新凭证。

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

应用内核不预置项目记录、本机路径或凭证；全新数据库从空项目列表开始。上表中的项目属于当前产品组合示例，其 Analytics Profile、固定 Collector 与确定性简报策略集中在 `src/main/project-extensions/`，由组合根注册。第三方项目可在用户数据目录的 `project-capabilities/*.json` 声明 Profile，并通过注册表接入 Collector / Briefing Strategy，无需修改 IPC、共享领域合同或 PostgreSQL Connector 的编排逻辑。私有路径和项目数据只存在于本机配置，测试样例集中在 `src/main/test-support/`。

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

对话是目标与收件箱的主要管理入口，而不只是问答界面。Agent 可以根据用户的明确指令创建目标、检查进展、暂停 / 恢复 / 完成目标，也可以创建和流转收件箱事项。收件箱页面本身不提供通用输入框；用户点击“去处理”后，事项进入“进行中”，系统创建或打开关联草稿 Session 并预填问题但不自动发送。“忽略”关闭该事项。工作助理始终获得结构化工具，由模型根据语义和 Session 上下文自主选择；不使用关键词或正则预判意图。写操作通过 `ask_user` 生成受约束的持久 Action，只允许引用工具读取到的真实项目、目标和收件箱 ID，并在点击时重新校验。

目标创建与 Check-in 不依赖 Renderer 中的业务文案。Agent 会在执行时读取最新 Project Profile、Repo 状态、README / 项目规划、已有 Skill 摘要和 Connector 运行结果，再生成结构化目标与证据。Git、README 和测试结果只能证明工程能力及开发进展，不能被当作生产用户、收入或转化率证据；缺少业务 Connector 数据时，Baseline / Current 必须保持未知。

正常进展只进入目标历史和每日简报；只有出现风险、阻塞或需要用户判断时才投递决策收件箱，避免把普通开发过程变成噪音。目标风险处理完成后，Agent Run 的结果和证据再关联回原目标，形成：

```text
Goal → Milestone → Evidence → Check-in → Briefing / Decision → Agent Run → Goal
```

收件箱采用“问题生命周期”而不是“每日消息”模型。每类持续问题都有不含日期的稳定 `dedupeKey`；每次巡检会读取待处理、进行中、等待中、已完成和已忽略的完整历史，只追加或更新 Observation，并刷新原 Item 的摘要、证据、最近发现时间和出现次数。巡检结果为 `active` 时继续维护原 Item；如果更新且更晚的证据与“已完成”冲突，系统会重新打开同一个 Item 并记录 reopen 次数，而不是新建重复事项。巡检结果为 `resolved` 时，只有最新证据直接证明问题解除后才主动标记完成。缺少数据或无法检查不能作为完成证据；已忽略事项只更新观察，不会被 Agent 擅自恢复。

问题事实与修复进度分开追踪：由收件箱“去处理”创建的 Run 会保留原始 Decision ID；Run 中产生的规范 GitHub PR 链接会自动成为修复证据。PR 提交、Review 或 CI 状态推动事项进入“进行中”；PR 合并只表示代码工作完成，事项进入“等待中 · 等待部署”，生产发布后进入“等待中 · 等待验证”。只有后续生产 Connector 或其他验收证据证明问题解除，事项才自动进入“已完成”。非开发事项使用同一套 Ticket 状态，并通过等待外部处理、等待指标、等待用户或等待复查等原因表达不同验收路径。每次自动状态转换都会记录原因、证据、操作者和时间；GitHub 暂时不可用时保留最后一次已核验状态，不把未知当作完成。

“工作助理”是独立一级通用聊天频道，用来跨项目讨论、规划和推进任务，不依赖当天是否已经生成简报。对话由 Pi `SessionManager` 持久化，后续消息恢复同一 Session，并由 Pi 在接近上下文窗口时自动压缩；应用不再手工截取最近几轮来模拟记忆。“每日简报”是工作助理每天 09:00 自动发送的一种特殊消息，由助理 Agent 汇总所有项目的数据、信号与决策收件箱；消息内是一张三分钟以内的中文语音卡片，支持直接播放和在卡片内展开全文。简报、任务讨论和用户追问共同组成一条连续时间线，输入框始终固定在聊天区域底部。每条收件箱项目至少包含所属项目、类型、影响、紧急度、置信度、证据、建议动作与处理状态。助理 Agent 在自动任务或用户手动触发时生成简报，建议结构固定为：

1. **发生了什么**：基于最新证据总结变化；
2. **这意味着什么**：解释影响、风险与机会；
3. **接下来关注什么**：给出少量、明确、可行动的重点；
4. **证据来源**：链接到 Repo、自动任务结果、分析数据或人工更新；
5. **待确认事项**：需要用户判断或授权的选择。

工作助理的能力统一按授权等级组织：

- **只读**：列出/检查项目与 Agent Run、搜索项目文件、读取已配置 Workspace、联网搜索与读取 HTTP/HTTPS 页面（包括本机和私有网络服务）、读取历史简报；结果必须保留来源，且不能把网页或 Repo 信息直接当作已确认的生产事实。
- **确认后执行**：新建或更新项目、创建/修改 Agent Run、管理目标与收件箱、生成简报、创建或启停自动化。Agent 必须调用 `ask_user` 生成真实按钮；确认 Action 会持久化到助理消息，点击时重新校验对象状态。打开已有 Run 只是只读跳转，不需要确认。
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
- 后台 Cron 触发的 Agent Run 会把状态、思考摘要、工具活动和回复增量实时广播到已打开的 Run 对话；
- 失败提醒与重试策略；
- 可审计的运行记录。

“每日项目巡检”是内置的自动化 Job，默认每天上海时间 09:00 检查目标、修复进度与可用的只读业务数据，并生成跨项目简报。详情展示实际用于总结的 Prompt，编辑后从下一次运行生效；也可调整计划、暂停和立即运行，所有执行进入同一份运行记录。Prompt 控制简报重点和表达，系统仍负责数据采集、证据约束与输出格式校验；模型不可用或输出无效时，运行记录会明确注明模板生成。首次升级会补齐缺少的上一日简报，之后由统一 Cron 调度补跑错过的计划；保存的 Prompt、时间和暂停状态不会被重启覆盖，旧的独立定时器已移除。

自动任务示例（除每日项目巡检外，按需创建）：

| 自动任务 | 计划 | 作用 |
| --- | --- | --- |
| 每日项目巡检 | 每天 09:00 | 检查目标与项目证据，生成跨项目简报与语音卡片；Prompt 可编辑 |
| 增长周报 | 每周一 09:00 | 为增长阶段项目总结渠道与实验表现 |
| Trading 风险巡检 | 每 30 分钟 | 检查回撤、敞口和风险规则 |

## 6. 信息架构与交互原则

Mac 界面文字最小为 12px，说明、状态、菜单、文件预览与首次设置采用同一底线；相对字号也设有 12px 下限。字号直接维护在组件原始样式中，避免重复的后置覆盖；聊天正文和较大的标题继续使用各自的字号层级。

Mac 主侧边栏保留工作助理、决策收件箱、文件、项目和自动化入口；项目列表使用独立页面，Agent Run Session 列表常驻侧边栏，直接进入对应聊天：

侧栏项目标题优先显示已配置的项目图标，未配置时显示文件夹；项目名和下方 Chat 标题的文字左侧对齐，均使用与主导航一致的 14px 常规字重。

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
- 支持新建文件与文件夹、导入、Markdown 预览 / 编辑、文本编辑和图片直接预览；20 MB 以内的 PDF 使用内嵌原生阅读器打开，超限或不支持的格式保留 Finder 入口；
- Agent 只能在绑定的项目 Workspace Roots 和所选文件空间内工作，不能越过项目目录；代码与随产品发布的资源进入 Workspace，Marketing、运营、研究、报告、品牌与宣传素材等代码无关产物进入项目文件空间；
- Agent 真实写入的文件会作为 Artifact 关联回产生它的 Agent Run，避免只在对话里声称“已保存”。

### Agent Runs

- iPhone Runs 列表左滑显示“归档 / 重命名”，不再显示三个点按钮；运行中或排队中的 Run 保留重命名，但不能归档。详情页的操作菜单保持不变。
- 每个 Run 都是一个可恢复、可继续对话的持久 Session；Mac 主侧边栏与 iPhone Chats 页面都按项目分组，不展示消息摘要；Mac 可从列表或分组标题的“+”创建 Draft Run，iPhone 仅保留页面右上角的“+”创建入口；
- 点击 Run 后在右侧打开 Session 对话，展示完整消息、工具活动和错误；默认收起、可拖拽调宽的右侧信息栏分为“基本信息 / 文件”，集中展示 Git 增删行、项目与 Workspace 摘要，并在栏内预览 Run 产出的 Markdown、文本和图片；
- Mac 的工作助理、项目 Chat 与共享 Chat 按原文显示用户消息，保留换行、空行和列表编号；只有一位真人参与的 Chat 隐藏用户头像与姓名，多人参与时按消息保存的发送者身份署名。旧消息可按同一用户 ID 找回已有署名；确实没有身份记录时显示“未记录发送者”，不猜测归属；
- Session 可以选择关联一个 Goal / Milestone，也可以作为独立任务运行；
- Agent Run 不再区分“普通任务”和“代码任务”，只选择执行 Agent；Pi、Codex、Claude Code 和 OpenCode 都接收同一种 Run 和项目上下文；
- Pi 使用内置 Agent Harness；Codex、Claude Code 和 OpenCode 连接本机已登录的运行时，并继续拥有各自的认证、模型配置和 Session；
- 每个项目可在项目设置中选择默认 Agent；全局 Coding Agents 设置另有一个默认 Coding Agent，供“去处理”等未显式选择 Agent 的入口使用；单次 Run 仍可覆盖；
- Session 保存对应运行时返回的 Session ID，后续消息恢复同一个 Agent 上下文；工作目录使用项目主 Workspace，其他 Workspace Roots 和项目文件空间作为额外可访问目录；
- 新建 Agent Run 先进入 `draft`，创建页只配置项目、执行 Mac、Agent 和可选关联里程碑，无需填写标题；Mac 与 iPhone 新 Chat 先显示“新建 Chat”。发送首条消息后，通过现有 Fuddy 账户登录调用 Cloudflare Workers AI，统一生成跟随用户输入语言的标题，不再读取各 Coding Agent 的原生标题。标题请求独立于 Agent 回复；离线、未登录、超时或额度耗尽时保留首条消息首行的简短摘录（最多 48 个字符，截断加省略号），手动重命名后保留用户标题。聊天页明确显示“草稿 · 尚未运行”，第一条消息由用户发送；
- 从决策收件箱点击“去处理”时，系统直接创建草稿 Session 并把建议任务预填到聊天输入框，不自动执行；
- 从 Goal Milestone 点击“开始任务”时复用已有未归档关联 Run，或创建新的草稿 Run；预填 Prompt 会在 Mac 与 iPhone 间同步，编辑后自动保存，首条消息仍由用户发送；
- Codex、Claude Code 与 OpenCode 使用各自本机默认账号和配置，不注入 CC Switch 配置；应用继承交互式 zsh 环境，并只在用户选择模型或 Reasoning Effort 后显式传入对应参数；
- 三个外部 Agent 默认使用完整本机访问和自动批准模式。每段思考摘要独立保存和显示；两个 Thinking 之间的连续工具调用归为一个默认折叠的调用组，当前 Thinking、正在运行的工具和可见回复增量会实时显示。当前回复保留完整活动和操作计数，并行工具分别跟随各自的完成 / 失败事件更新状态；切换 Chat 或后台刷新时，已落库的当前回复不会与实时活动重复展示。

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
- Main Area 使用纯色背景；页面标题位于横跨主区域的顶部 Header，不使用模糊的说明性副标题；
- 页面切换优先于抽屉和多栏堆叠；
- Agent 对话是主要入口，固定 Dashboard 是次要能力；
- 图表和复杂数据 UI 按问题动态生成，不长期占据首页；
- 不设置资料库、文件库等与核心闭环无关的一级入口；
- 始终保持清晰的返回路径和项目上下文。

### 全局 Provider 设置

- 进入设置后，主侧边栏切换成设置二级导航，并提供返回原主页面的入口；
- 设置二级导航只显示实际可进入的设置项，不提供无行为的“所有设置”下拉或搜索入口；
- 全局设置拆分为“通用、模型、语音与 TTS、权限与安全”；项目 Connector 移入对应项目的“设置”Tab；
- 每个设置页面使用扁平单列布局，不再用嵌套 Card 重复标题或描述；
- Agent 与 TTS 分开配置，各自包含一套 Primary 和可选 Backup；Primary 请求失败时自动切换一次，并在运行结果中记录实际 Provider；
- 工作助理的内置模型 Provider 支持 OpenAI-compatible API（自动兼容 `/responses` 与 `/chat/completions`），并保留 CC Switch Codex OAuth 本地反代兼容模式；这套配置不注入 Codex、Claude Code 或 OpenCode；
- Agent 回复使用 SSE 逐段传输并以 GitHub Flavored Markdown 渲染；内部更新事件对齐 ACP `session/update` 的 `agent_message_chunk` 与 `plan` 结构，为后续 Codex / Claude ACP Adapter 保留兼容边界；
- TTS 支持 macOS 系统语音、OpenAI-compatible `/audio/speech` 和 ElevenLabs；OpenAI 默认使用 `gpt-4o-mini-tts` / `marin`，ElevenLabs 默认建议 `eleven_multilingual_v2` 并单独配置 Voice ID；
- ASR 与 TTS 独立：Mac ASR 可选“本地优先”或“仅云端”，本地使用 `whisper.cpp` + `large-v3-turbo Q5`，云端默认使用 OpenAI `gpt-transcribe`；云端模型名不与本地模型名混用；
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
- 首版通过 GitHub Release 的 unsigned DMG / ZIP 分发，暂不以 Mac App Store 为目标；打开时 macOS 可能需要用户在 Finder 中右键选择“打开”。

选择 Electron 的主要原因是应用需要稳定的桌面主进程、沙盒 Renderer、原生权限归属和外部 Agent 生命周期管理。Browser Use 与 Computer Use 都是 Agent Run 期间通过 MCP 调用的能力，不在应用中内嵌浏览器或远程桌面页面。

### Agent 与外部执行

- 底层协调 Agent 使用轻量的 Pi Agent，并通过自有 `AgentRuntime` 接口隔离；
- LLM Provider 可替换，生产密钥存入 macOS Keychain；
- `cc-switch` 仅作为开发期 Provider 切换工具，不成为生产依赖；
- Pi Agent 不作为权限或安全边界，权限、审计、取消、超时、预算和持久化由应用层实现；
- Codex 优先使用 Codex SDK、App Server 或 `codex exec --json`；
- Claude 优先使用 Agent SDK 或 `claude -p --output-format stream-json`；
- 当前外部 Agent Run 使用 Codex app-server JSON-RPC、官方 Claude Agent SDK 与 OpenCode CLI；三者的 Session ID、流式结果和工具事件都回投同一个 Agent Run；
- Claude Code 启动后台子代理时，Fuddy 以 SDK 的 `session_state_changed: idle` 作为本轮结束信号：先回复的内容照常显示，等待期间时间线显示“后台任务”，子代理完成后的后续回复继续写入同一轮；不支持该事件的旧版 CLI 仍在首个 `result` 结束。
- Coding Agent Runtime 不覆盖各 CLI 的账号或基础配置。Electron 主进程启动时读取交互式 zsh 环境，确保从 Finder 启动时也能继承终端中的 `PATH`、API Key 和 Provider 变量；
- 外部 Agent Run 使用 Full Access / 自动批准策略；用户仍可停止当前 Run，工具事件和结果进入同一个 Session 记录；
- 不通过 Computer Use 点击 Codex / Claude UI 来派发任务；没有结构化接口的 App 才回退到 Computer Use。

### Browser Use 与 Computer Use

- Browser Use 使用 `browser-use==0.13.7` 的固定 Schema stdio MCP（`browser-use --mcp`），默认 headless 独立 Profile；
- Fuddy 携带固定版本的 Astral `uv`，由 uv 管理 Python 3.12 与 Browser Use 环境，不依赖系统 Python；
- Computer Use 使用 CUA Driver `0.19.0` 的 embedded daemon 与 stdio MCP proxy，不维护自有 Swift Helper；
- CUA daemon 由 Electron 主进程直接启动，继承 Fuddy 的 Screen Recording 与 Accessibility 权限，并把同一私有 socket 暴露给 Pi、Codex、Claude 和 OpenCode；
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

### ASR

- Renderer 和 iPhone 都把麦克风输入转换为 16 kHz 单声道音频，本地与云端使用同一份转写输入；
- Mac 的约 547 MiB 模型不随桌面安装包下载，用户在“语音与 TTS”中按需安装或删除；模型文件按固定字节数和 SHA-256 校验；
- 未安装模型时，只有用户已配置云端 API Key 且启用回退才会上传录音；API Key 只保存在 Keychain；
- iPhone 构建使用 `npm run prepare:whisper:ios` 下载并校验官方 `whisper.cpp` XCFramework 和 Q5 模型，再把模型作为 App Resource 预置；大模型会显著增加 IPA 体积和峰值内存，正式设备发布前需要覆盖最低支持机型验证。

### 本地数据

- 项目、决策收件箱、Agent Runs 与审计记录使用本地 SQLite；每个项目可配置真实 Logo、Emoji 或文字图标，项目列表和 Agent Run 项目标识在未配置时回退到项目名首字；
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
- Vows 的 Fuddy Agent 直接派发 Codex 到现有 `wedding-promotion` Skill 与 `marketing/` 工作区；AI Marketing Adapter 直接复用现有 Super Agent Thread + SSE Chat API；
- 聚合结果持久化、确定性无模型回退，以及按日期稳定去重的行动信号；
- 基于操作系统安全存储的 Credential Vault；SQLite 和日志只保存凭证引用；
- 模型与 TTS 的 Primary / Backup 配置、自动 fallback、ElevenLabs TTS 和按配置失效的音频缓存；
- Mac / iPhone 语音输入、本地 Whisper、Mac 可选模型生命周期和云端 ASR 回退；
- Full Access 运行参数、权限策略和单元测试；
- Codex app-server 与 Claude Agent SDK 的真实可恢复 Session、流式结果、工具事件和取消处理测试；
- Agent Session 草稿创建、默认 Coding Agent / 模型传递、思考摘要、工具调用链，以及重命名和归档；
- Coding Agent 使用项目主 Workspace 作为 `cwd`，并获得所有 Workspace Roots 与项目产物目录；
- Electron 主进程从交互式 zsh 继承本机 Agent 环境，不改写或过滤用户的 `.zshrc` 配置；
- Agent Run 在无运行中工具且无运行进展时的 10 分钟超时保护，以及应用启动时的遗留运行状态修正；
- Sentry 主进程、Renderer 和 Electron 子进程崩溃上报；
- Pi Agent Runtime、Codex、Claude、OpenCode、Browser Use MCP、CUA Driver MCP 与 TTS 的适配器边界；
- 固定版本和 SHA-256 校验的第三方工具准备流程，以及 Browser Use / CUA Driver 的真实 MCP smoke；
- 接近 ChatGPT Mac App 信息架构的基础 UI。

本地启动：

```bash
npm install
npm run prepare:agent-tools
npm run prepare:whisper
npm run dev
```

只开发桌面前端 UI 时，可以不启动或打包 Electron，也不需要 Account API 或 Agent 工具：

```bash
npm run dev:web
# 浏览器打开 http://127.0.0.1:5174/
```

Web Mode 使用独立的 Vite 入口，复用 `src/renderer/src/App.tsx`、全部页面和共享样式，支持 React / CSS 热更新。可以让 Codex 在内置浏览器打开上述地址，再使用浏览器的标注功能反馈 UI 修改。Light / Dark 跟随浏览器的 `prefers-color-scheme`，可在浏览器开发工具中模拟两种主题；调整浏览器宽度和应用侧栏可检查布局。`npm run dev` 的 Electron Renderer 也支持热更新，只有原生能力联调才需要启动 Fuddy Dev。

顶部「Web 预览」工具栏明确区分开发数据，支持示例 / 空状态切换和重置；也可以用 `?fixture=empty` 直接进入空状态。`src/renderer/web/fixtures.ts` 提供虚构项目、目标、收件箱、聊天、文件与自动化，`preview-api.ts` 使用完整的 `DesktopApi` 类型约束提供内存实现。项目编辑、事项状态、Run 草稿 / 重命名 / 归档、已有示例文件编辑与自动化表单修改只影响当前页面，刷新即还原。新增 Run 不发送消息，开启示例自动化不会启动调度器。

Web Mode 不连接 Electron IPC、SQLite、Keychain、真实账户、Agent、Companion 或 Sentry，不读取 production / Fuddy Dev 的数据，也不加载项目 `.env` 文件。依赖原生服务的发送消息、生成目标、连接器运行、语音、文件导入等操作明确提示需要 Fuddy Dev，不伪造执行成功。开发服务器默认只监听 `127.0.0.1:5174`，端口占用时退出；可显式使用 `npm run dev:web -- --port 5175`。预览入口不参与 Electron 打包，也不提供独立 Web 发布构建；IPC、原生权限和真实任务执行仍使用隔离的 Fuddy Dev 验证。

首次开发账户流程时，在另一个终端准备本地 Account API。复制 `cloud/account-api/.dev.vars.example` 为不受版本控制的 `.dev.vars`，填入仅供开发的值，然后执行：

```bash
cd cloud/account-api
npm install
npx wrangler d1 migrations apply project-agent-account --local
npm run dev
```

Fuddy Dev 默认连接 `http://127.0.0.1:8788`。Production 默认连接 `https://fuddy.ai/api/account`，可通过 `FUDDY_ACCOUNT_API_URL` 显式覆盖；Mac 与 iOS Release 已内置公开的 Google OAuth Client ID，开发构建仍保持本地 Account API 隔离。Mac 只负责 loopback 回调与 PKCE，授权码统一由 Account API 交换，Google Client Secret 不进入 Electron 包。Account API 的 `GOOGLE_CLIENT_IDS` 必须包含 Mac Client ID 与 iOS 使用的 Server Client ID，并通过本地 `.dev.vars` 或生产 Cloudflare Secret 提供 `GOOGLE_CLIENT_SECRET`。生产 Resend Key、OAuth Secret、OTP pepper 与 session pepper 只能放部署环境或 Cloudflare Secrets，不能提交到仓库。

`npm run dev` 始终启动隔离的 **Fuddy Dev**，使用 `~/Library/Application Support/ai-native-project-agent-dev`。它与 `/Applications/Fuddy.app` 的 production 数据库、凭证、Companion 配对、Agent Session、自动化调度和单实例锁完全分离，因此两者可以同时运行。开发与 QA 不得把 production Fuddy 当作测试目标；需要测试打包形态时使用 `npm run package:smoke` 或 `npm run dist:mac:dev`，产物拥有独立的 `dev.ainative.projectagent.dev` Bundle ID 且禁用自动更新。production Fuddy 继续使用 `~/Library/Application Support/ai-native-project-agent`，保证现有安装升级后仍能读取原数据。

iPhone 真机连接线上账户服务时，Debug 构建必须显式传入 `FUDDY_ACCOUNT_API_URL=https://fuddy.ai/api/account`；默认 Debug 的 `127.0.0.1:8788` 仅适合本地服务联调，在真机上指向手机自身。账户地址通过 `ios/ProjectAgentCompanion-Info.plist` 写入安装包，安装前应检查产物 `Info.plist` 的 `FuddyAccountAPIURL`。Release 默认使用线上地址。

同账户自动连接不需要用户二次批准或扫码。Mac 会将历史托管 Relay 地址迁移到 `https://fuddy.ai/api/relay`，先验证原连接，再按既有流程自动恢复失效连接并向账户服务确认绑定。自动连接失败会在设置中显示重试提示；启动时的暂时失败不会关闭后续重试。

验证：

```bash
npm run typecheck
npm test
npm run build
npm run relay:typecheck
npm run relay:test
npm run account:typecheck
npm run account:test
npm run account:deploy:dry-run
npm run account:deploy:production:dry-run
npm run ios:generate
npm run ios:typecheck
RUN_AGENT_TOOLS_SMOKE=1 npx vitest run src/main/services/third-party-mcp-runtime.integration.test.ts
RUN_CODING_CLI_SMOKE=1 npx vitest run src/main/services/coding-cli.integration.test.ts
RUN_CLOUDFLARE_TITLE_SMOKE=1 CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx vitest run src/main/services/agent-title.integration.test.ts
RUN_CLOUDFLARE_TITLE_WORKER_SMOKE=1 FUDDY_TITLE_SMOKE_WORKER_URL=http://127.0.0.1:8799 npx vitest run src/main/services/agent-title-worker.integration.test.ts
RUN_MORNING_BRIEFING_SMOKE=1 npx vitest run src/main/services/morning-briefing.integration.test.ts
RUN_ASR_SMOKE=1 WHISPER_MODEL_PATH=/path/to/ggml-large-v3-turbo-q5_0.bin WHISPER_AUDIO_PATH=/path/to/sample.wav npx vitest run src/main/services/asr-service.integration.test.ts
```

标题服务位于 Account API 的 `POST /v1/chat-titles`，使用 `AI` binding，默认模型为 `@cf/qwen/qwen3-30b-a3b-fp8`（`/no_think`，最多输出 64 tokens）。仅发送首条消息的前 1,500 个字符，不发送项目文件、Agent 回复或后续聊天历史；服务不会记录请求内容。每个账户每小时最多 60 次标题请求，Worker 推理超时 10 秒，客户端超时 12 秒。Cloudflare 的 AI binding 需要随 Account API 部署，客户端无需填写模型 API key。单元测试禁用远程 binding；上面的多语言实测命令会使用已有 Wrangler 登录（或环境变量 `CLOUDFLARE_API_TOKEN`）并消耗少量真实 AI 额度，不接触生产 Fuddy 数据。可用 `FUDDY_TITLE_SMOKE_REPORT_DIR` 保存合成测试输入、标题、耗时和用量；`FUDDY_TITLE_SMOKE_COMPARE=1` 可同时比较 Granite 3B 与 Llama 1B。

Worker 链路实测须先在独立临时 `--persist-to` 目录执行 Account API 的本地 D1 migrations，再启动测试邮件模式的本地 `wrangler dev`（用测试 pepper、指定端口，`AI` binding 保持 remote）。该测试只接受 localhost，使用内存凭证与临时桌面数据库；Agent 回复使用桩，真实验证账户登录、Worker 路由、远程 AI、四个 provider 的标题持久化及 Companion 同步事件。Account API 的部署入口为 `src/worker.ts`，仅导出 Worker handler，测试辅助函数和常量留在 `src/index.ts`。

生产 Companion Relay 的部署由 GitHub Actions 执行。推送到 `main` 且改动涉及 `cloud/relay/**`、共享 Companion 协议或部署工作流时，`Deploy Companion Relay` 会先安装依赖、运行 Relay typecheck / tests，再使用 GitHub 的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 和 `APNS_PRIVATE_KEY` 部署 `cloud/relay/wrangler.jsonc`。也可以在 Actions 页面手动运行；连续部署按顺序执行，不会并发覆盖。首次配置需要在仓库的 `production` Environment 或 Repository Secrets 中保存这三个值。

桌面 App 发布不依赖 Apple、Cloudflare 或 APNs 凭证。先把 `package.json` 的版本改成目标版本，再提交并推送 tag：

```bash
git add .
git commit -m "Release v0.0.7"
git push origin main
git tag v0.0.7
git push origin v0.0.7
```

`v*` tag 会触发 `Release` workflow，检查 tag 与 `package.json` 版本一致，构建 unsigned arm64 DMG / ZIP，并自动创建 GitHub Release。当前发布只上传 DMG / ZIP，unsigned 包首次打开时需要在 Finder 中右键选择“打开”；正式签名、公证与自动更新仍留待以后接入。

需要把最新 iPhone Companion 装到已连接的开发设备时，在 Mac 上运行：

```bash
npm run ios:generate
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/ProjectAgentCompanion.xcodeproj \
  -scheme ProjectAgentCompanion \
  -destination 'id=<设备 UDID>' \
  -configuration Debug \
  -derivedDataPath /tmp/fuddy-ios-device-build \
  build
xcrun devicectl device install app \
  --device <设备 UDID> \
  /tmp/fuddy-ios-device-build/Build/Products/Debug-iphoneos/ProjectAgentCompanion.app
```

Debug 真机包默认连接本地 Account API；要连接线上服务，构建时显式传入 `FUDDY_ACCOUNT_API_URL=https://fuddy.ai/api/account`。设备需要已信任这台 Mac，并允许开发者模式 / 自动签名。

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
