# 项目共享与多人 Chat 改造计划

状态（2026-09-29）：P0–P6 的本地代码与自动化测试已接通，包括共享附件、成员上传、iPhone 成员入口和账户隔离缓存。Mac 与 iPhone 入口、Account API 共享路由和成员命令不再受环境或构建开关控制；项目所有者仍需主动开启共享并发布历史。Account API、Relay 及两条 D1 迁移已部署；P7 的真实双账户、多 Mac、iPhone 联调与迁移演练仍未完成，不能把健康检查或本地测试视为端到端验收。

当前实现：Account API 用服务端共享 ID 绑定所有者本地项目，管理邮箱邀请、成员、设备授权、执行 Mac 与短租约命令；每个所有者 Mac 可登记为发布源。Relay 保存每个来源的分页加密 baseline 与增量。Mac 在凭证保险库存项目密钥，发布字段白名单内的项目、Chat、消息、附件与产物，读取时按来源水位合并；执行机从服务端已认证命令生成作者身份、按权限领取和续租，持久本地队列防止重复执行。成员 Mac 可接受邀请、申请设备授权、查看项目设置与多人 Chat、新建草稿、发送附件、停止自己的请求、管理自己创建的 Chat 并退出。iPhone 可接受邀请、授权设备、离线阅读已缓存共享内容、查看设置与附件、新建和发送文本 Chat、停止请求及退出。旧归档 Chat 进入历史发布。实现与边界见 [project-sharing-review.md](./project-sharing-review.md)。

仍需完成：真实两账户与多 Mac/iPhone 联调、撤权停机、旧客户端混合版本、迁移与灰度回滚演练。iPhone 共享 Chat 目前发送文本，可查看并下载附件；从 iPhone 向共享 Chat 上传新附件未纳入本轮 P6 范围。当前只有代码层、测试替身和开发预览证据；不把模拟测试当作真实云端验收。

## 1. 产品范围

项目所有者邀请其他 Fuddy 账户成为项目成员。成员可以查看共享项目信息、历史和后续 Chats、聊天附件与产物，可以新建 Chat，并在已有 Chat 中发送消息触发 Agent。所有消息显示发送者身份。

项目仍归所有者账户；不新增 Organization、Team Workspace、团队计费或所有权转移。成员不可编辑项目设置、管理其他成员、浏览主机目录、配置连接器或启动自动化。目标、决策、个人助理、项目文件空间不随本次共享开放；聊天中指向这些对象的关联不授予访问权。

既有同账户多 Mac 同步继续保留。成员不获得所有者的 Sync Space 授权或 Space Data Key。

### 1.1 权限基线

| 动作 | 所有者 | 成员 |
| --- | --- | --- |
| 查看共享项目信息、已发布 Chats、附件 | 可以 | 可以 |
| 新建草稿、发消息 | 可以 | 可以 |
| 修改项目共享设置、邀请和移除成员 | 可以 | 不可以 |
| 重命名、归档 Chat | 所有 Chat | 自己创建的 Chat |
| 撤回尚未执行的请求 | 所有请求 | 自己的请求 |
| 停止正在执行的请求 | 所有请求 | 自己的请求 |
| 指定协作执行 Mac、Agent 与执行策略 | 可以 | 不可以 |
| 退出共享项目 | 不适用 | 可以 |

新建 Chat 只创建 draft，不发送消息。未发布草稿和草稿附件只对创建者可见；所有者不能通过普通共享查询看到别人的未发布草稿，但主机本地持有数据，不承诺对主机所有者的密码学隐私。首次发送成功落库时原子发布 Chat。成员退出后，已发布 Chat 和消息保留。

### 1.2 内容与体验基线

- 邀请分享整个项目的已发送历史（包括归档 Chat）和后续内容；历史预览完成后由所有者确认发布。所有成员看到相同的已发布范围。
- 设置展示名称、图标、简介、状态及明确允许共享的项目背景；默认采用字段白名单，不直接序列化 Project.profile。
- 不发布本机路径、原生 Session ID、账户用量、凭证、环境变量、完整工具参数和原始输出。展示用户消息、公开回复、运行状态与经过共享投影处理的操作摘要。
- 正文及文件可能本身包含敏感内容；不承诺自动脱敏全部历史。分享确认说明附件也会共享。
- 头像、显示名、时间采用统一消息组件；自己标注“你”，Agent 使用独立图标及名称。没有头像时显示稳定的姓名首字头像；头像上传不是首版依赖。
- 同一作者连续消息可合并署名，跨作者、轮次后重新显示。无障碍标签包含真实显示名，不能只用颜色表达身份。
- 新用户接受邀请后可直接阅读和发消息，不要求配置本机 Coding Agent 或 Workspace。
- Mac 管理邀请；Mac/iPhone 接受、查看、发消息和退出。iPhone 完整成员管理后置。

### 1.3 执行基线与开放条件

所有者指定一台在线且配置项目目录的协作执行 Mac，供成员创建的新 Chat 使用。已有 Chat 永远在原执行 Mac 续接，不迁移原生 Session，不静默换机器。成员不能指定任意路径或运行参数；修改默认执行 Mac 只影响未来新建 Chat。

执行机离线时，客户端可保存本地未提交草稿；恢复后由用户提交，主机创建 canonical draft。发送不自动排到未来执行，提示上线后重试；已经被主机持久接收的请求按队列恢复规则处理。

当前运行时是 Full Access。首版建议定位可信成员内测，邀请时明确成员将使用所有者的机器、Agent 账户和额度。工程启动时记录这一产品决策；公开面向非可信成员开放执行前，必须另行完成运行隔离与工具能力限制。项目字段过滤与提示词不构成执行沙盒。

## 2. 架构和数据边界

### 2.1 账户控制面

Account API 保存项目资源注册、所有权、成员、邀请、授权版本和执行授权；不保存聊天明文。云端共享 ID 由服务端生成，所有者账户内关联现有 `Project.shared.id`；成员看不到本地项目 UUID。

建议新增独立模型（实现时可调整命名）：

- project_shares：projectId、ownerUserId、状态、默认执行 hostId、permissionRevision、keyEpoch、协议版本。
- project_memberships：projectId、userId、role(owner/member)、状态、加入/撤销时间；项目+用户唯一。
- project_invitations：projectId、受邀规范化邮箱、tokenHash、expiresAt、状态、inviterUserId；一次性、默认七天有效，重复接受幂等。
- project_device_grants：projectId、userId、deviceId、授权版本、keyEpoch、加密密钥封装、状态。账户成员身份和单设备密钥授权分别管理。
- 复用或扩展持久撤销任务与审计记录，不依赖某个客户端在线才能持久记录撤销。

API 最少覆盖注册共享项目、列出自己拥有/加入的项目、读取权限、创建/撤销/接受邀请、列出/移除成员、退出、关闭共享、获取设备授权。服务端从登录身份推导 actor，不信任客户端传入的 ownerUserId/role。

### 2.2 共享内容通道

在现有个人同步之外新增项目共享通道，使用独立的项目密钥、事件序列、附件范围和设备授权。复用 E2EE 封装、outbox、重放、R2 与完整性校验基础，不复用整空间读写权限。

所有者各 Mac 发布自己负责的该项目 Chat；项目设置以所有者账户现有共享版本规则合并。注册哪些 owner hosts 可以发布及各自的 sourceSpaceId。接收端按 projectId + sourceSpaceId + runId 去重路由，多主机事件各自排序并维护游标。

定义专门的 SharedProject、SharedChat、SharedMessage、SharedAttachment DTO 与字段白名单，不直接复用含敏感执行字段的全量 Run/Project 对象。

先生成可分页 baseline，再按水位接增量，重连无缺口、重复可幂等。显示每个源主机的同步状态；某台机器离线缺少历史时标记“部分历史尚未同步”。新成员需要读取明确分享的已有历史；通过仍获授权主机交付所需历史密钥封装或重新发布历史完成，不能只发新 epoch 密钥。

云端保留可重建当前共享视图的加密 baseline 与必要增量，不能直接套用现有 outbox 30 天清理策略导致历史消失。附件保留策略跟随共享引用，关闭共享后按清理流程回收云端共享副本，不删除主机原始文件。

### 2.3 身份与执行记录

- Chat：createdByUserId、createdBySnapshot、visibility(draft/published)、executionHostId。
- Message：authorUserId（历史可空）、authorSnapshot(displayName/avatarRef)、requestId、turnId、主机确认的 sequence。
- Turn/执行请求：requestedByUserId、sourceDeviceId、状态、权限版本、幂等 requestId、持久化执行标记与结束原因。
- 身份快照保留发送时署名。显示名不唯一，用户 ID 才是权限依据；默认不公开成员邮箱。退出后仍保留历史署名。
- 旧记录只有在有确定来源证据时回填作者，否则标“历史用户”；历史 Chat 无法确定创建者时只允许所有者管理。
- Relay 从已认证身份产生不可伪造的命令发起者信息，并将身份、projectId、runId、requestId、目标 hostId 和权限版本绑定到可信命令封装；Mac 校验封装及有效授权。不得直接接受密文正文中声称的 authorUserId。
- Agent 上下文包含可信的作者标记与发送顺序，用户可见消息正文仍保持原话。

### 2.4 多人队列与撤销

同一 Chat 的所有入口（本机所有者、同账户设备、项目成员）汇入原执行 Mac 的持久队列，每次只执行一个 turn。排队消息明确标注“尚未进入 Agent 上下文”；提交并执行时按已确认序列组装上下文，避免未来排队消息提前进入当前请求。

排队取消与执行抢占必须原子；取消运行等待 provider 退出后才放行下一个 turn。发起者可以取消自己的请求，Chat 创建者不能停止别人发起的请求，所有者可以。

接收和开始执行均复核权限。成员撤销后拒绝新请求、取消其待执行请求、通知对应主机停止其当前请求。采用授权版本和有期限的授权租约/复核机制，主机失联不能无限继续接受旧授权；需要在实现前确定并测试租约时限及在运行请求的停止行为。撤销界面区分“云端已撤销”和“等待主机确认停止”，不承诺网络隔离下瞬时停机或回滚已发生副作用。

移除成员后轮换共享内容密钥，旧发布端必须取得当前版本才能继续发布。旧 keyEpoch 的写入由服务端拒绝，不只由客户端自觉检查。在线客户端清理缓存，阻止所有被撤销设备继续拉取内容；无法收回已下载/复制内容，也无法即时删除离线副本。

## 3. 实施工作包

每个工作包完成后提交可检查的本地结果与验证记录；不自动 commit、push 或部署。新增数据库迁移采用实施时最新的递增编号。

| 编号 | 交付内容 | 主要代码位置 | 依赖 | 完成条件 |
| --- | --- | --- | --- | --- |
| P0 | 固定权限矩阵、共享 DTO、命令 actor、错误码、版本协商、Full Access 开放范围和撤销时效；建立两个账户/多个项目的测试 fixture | src/shared、cloud/account-api/src/schemas.ts、cloud/relay/src/schemas.ts | 无 | 契约与状态转换明确，旧客户端不能误获得共享执行权限 |
| P1 | 本地消息作者、Chat 创建者、turn 发起者与持久队列字段；无损迁移和来源回填 | src/shared/contracts.ts、src/shared/account.ts、src/main/services/database-schema.ts、database-migrations.ts、src/main/features/runs/run-repository.ts | P0 | 旧 Chat 可恢复，新消息从可信身份落库，重开后数据不丢 |
| P2 | 云端项目所有权登记、成员与邀请 API、邮箱绑定接受、设备授权、持久撤销与审计 | cloud/account-api/src、cloud/account-api/migrations、src/main/services/account-service.ts | P0 | 两账户可完成邀请生命周期；非成员和伪造所有者请求被拒绝 |
| P3 | 项目隔离 Relay、E2EE 密钥封装、共享投影、baseline/增量/分页、共享附件及成员上传通道、撤销轮换 | cloud/relay/src、src/shared/companion-*、src/main/features/companion、src/main/services/companion-sync.ts、mac-peer-sync.ts；新增 project-sharing 服务 | P1、P2 | B 只收到项目 A 的允许字段和附件；主机离线能读已同步内容；撤销后旧设备不能收新内容 |
| P4 | 成员 draft 创建、首次发送发布、指定主机路由、统一队列、执行复核、取消停止、崩溃恢复 | src/main/ipc/runs.ts、src/main/ipc/schemas.ts、src/preload/index.ts、src/main/services/task-dispatcher.ts、src/main/features/runs | P1、P2、P3 | 两用户同 Chat 顺序执行、身份正确、重试不重复执行、成员不能越权控制其他请求 |
| P5 | Mac 共享面板、接受邀请、与我共享侧栏、设置只读、多人署名、排队/权限/同步状态、免本机 Agent onboarding | src/renderer/src/features/app-shell、views/ProjectViews.tsx、components/AgentRunsView.tsx、ConversationSpeaker.tsx、ChatComposer.tsx、features/onboarding、web fixtures/preview-api | P2、P3、P4 | 两账户完整走通创建、查看、发送、退出；共用布局并完成 Light/Dark 与可调整宽度验收 |
| P6 | Swift 协议生成、项目级缓存与授权、邀请入口、共享列表、头像署名、创建/发送/停止/退出 | scripts/generate-companion-contracts.mjs、ios/ProjectAgentCompanion/CompanionStore.swift、RootViews.swift、ChatComposer.swift、ChatHistory.swift、对应 XCTest | P3、P4、P5 的交互契约 | iPhone 与 Mac 同一项目同一队列；退出切号缓存隔离；无需本地执行能力 |
| P7 | 全链路验收、发布开关、协议兼容、迁移演练、文档与灰度方案 | README.md、docs/multi-mac-projects.md、docs/ios-companion-architecture.md、docs/chat-attachments.md、各测试目录 | P1–P6 | 验收矩阵通过；已记录真实双账户/多机证据和仍未验证项 |

实施顺序：P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7。P3 完成先验收跨账户只读链路，P4 完成再开放成员执行；不能因为 UI 已完成而提前开放执行。

### 3.1 Mac 界面任务细化

- 项目 Header 增加“共享”入口和成员数；复用共享 page-header。
- 共享面板展示范围预览、默认执行机、成员、待接受邀请、复制链接、撤销和关闭共享。
- 邀请令牌入口先说明阅读历史、附件和发送消息的权限；项目名称属于端到端加密内容，接受并获得设备密钥后才显示。错误账户、过期、已撤销各有可恢复状态，不展示未授权历史。
- Sidebar 增加“与我共享”；Chat 列表可显示创建者，详情显示当前执行机和运行发起者。
- 每条真人消息由 ConversationSpeaker 渲染头像与姓名，Agent 独立署名；复用现有 conversation rail、composer 与主题 tokens。
- 项目设置只显示允许字段；不显示可点击但不可用的主机文件选择器或凭证入口。
- 聊天菜单依据权限展示，但所有动作仍在主进程和云端复核。
- 无权限、主机离线、等待授权、部分同步、撤销处理中等需要用户行动的状态持续显示；普通临时成功/失败通知五秒消失。

### 3.2 附件与发送任务细化

- 成员只能上传到自己有发送权的项目和请求，服务端验证附件大小、配额、归属；不能用其他项目 attachmentId 构造消息。
- 草稿附件未发布时不进入其他成员 baseline；首次发送时与 Chat 可见性一起提交。
- 成员上传先进入私有加密存储，由目标主机校验大小、哈希、文件名/路径后作为 Agent 输入；不把客户端路径当主机路径。
- 已发布聊天附件与产物复用私有 R2 和下载完整性校验，成员每次获取下载授权都检查项目权限。
- 取消草稿/失败上传的孤立对象有回收机制；共享关闭不删除所有者原始产物。

## 4. 必须通过的验收矩阵

1. A 有项目 P/Q，B 仅加入 P：B 的列表、搜索、历史分页、附件、错误响应和事件重放均不泄露 Q；知道 Q 的 ID 也不能访问。
2. 邀请仅目标账户能接受；过期、撤销、重复接受和重复邀请不会产生额外权限。B 新设备单独获取合法密钥授权，不能借旧设备令牌跨项目。
3. A/B 同时发消息，作者与顺序正确；B 伪造 actor 被拒绝；同一 requestId 重试只产生一条消息和一次执行。
4. B 新建草稿不发送，其他成员不可见；首次提交后成为共享 Chat；主机离线时保持本地未提交状态并不伪造主机成功。
5. 已存在于不同 owner Mac 的 Chats 始终回原主机；新 Chat 使用指定主机；机器下线不会偷偷转移 Session 或丢失署名。
6. 主机/客户端重启恢复队列；执行标记不明的任务不自动重新运行，而进入需确认状态，避免终端命令重复执行。
7. B 可取消自己的排队请求、停止自己的运行；不能停止 A 的请求、编辑设置、归档 A 的 Chat 或访问 Git/文件空间等未开放 API。
8. 移除 B 时，多个设备和待执行请求都撤销；运行停止有确认状态；旧 epoch 发布被拒绝；A 和其他成员继续正常使用新密钥。
9. 加入时历史 Chat/附件完整或明确标记待同步；已有授权时主机离线可读云端已发布内容；不具备密钥的新设备显示等待授权。
10. 旧消息不捏造作者，成员退出后历史身份仍可读；姓名相同、长姓名、头像失败和无头像都可辨认；无障碍可读。
11. 退出账户清理该账户授权与共享缓存；切换账户不复用前一账户内容。旧客户端不支持时明确升级，不能回退到全空间授权。
12. 原有个人项目、同账户多 Mac、iPhone、自动化、原生 Session 续接不回归。成员不能通过聊天之外的入口绕过权限。

## 5. 验证与发布

按工作包运行对应迁移、服务、协议、队列和 UI 测试。代码交付前运行 npm run typecheck、npm test、npm run build、git diff --check；涉及云端执行 npm run account:typecheck、npm run account:test、npm run relay:typecheck、npm run relay:test。生成并检查 Companion 合约。

iOS 使用 cd ios && xcodegen generate，DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer；运行 npm run ios:typecheck，并在可用 iPhone Simulator 上运行 ProjectAgentCompanion XCTest，保留 ad-hoc signing。缺少运行时、签名或账号条件时记录真实阻塞，不将静态检查当作真机验证。

UI 和集成测试只使用 Fuddy Dev、独立开发账户与开发云环境；不访问或操作生产 Fuddy 及其数据。适配器 live smoke 仅显式 opt-in，不能默认执行。

发布时先部署向后兼容的 Account API/Relay 与迁移，再更新客户端，最后按账户开启项目共享及成员执行开关。先可信成员灰度；允许关闭成员执行而保留共享阅读。旧版 owner host 不得发布新共享项目或处理成员命令。

真实双账户、至少两台 owner Mac 和成员 Mac/iPhone 的联调是发布验收；本机模拟不能替代。生产部署、提交、推送由后续明确指令触发，本计划阶段不执行。

## 6. 本次不实施

团队组织层级、角色自定义、团队账单、公开匿名链接、逐 Chat 权限、独立人际群聊、评论系统、@提醒/已读回执、项目设置共同编辑、成员自带执行机、运行迁移、项目所有权转移与面向非可信成员的沙盒执行。

下一轮目标是用隔离的开发 Account API、Relay、两个真实账户、至少两台 owner Mac 与成员 Mac/iPhone 完成第 4 节矩阵，并记录迁移和灰度回滚证据；没有这些证据前保持发布开关关闭。本文的工作包与当前完成度以顶部状态和 Review 为准。
