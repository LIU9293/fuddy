# Chat 附件链路

Mac 与 iPhone 的项目 Chat 都支持每条消息最多 4 个附件，单个文件最多 20 MiB 减去 32 字节加密封装。图片支持 PNG / JPEG / WEBP / GIF 原生输入；iPhone 相册选图转为 JPEG，其他文档按文件交给 Agent。Mac 支持选择、粘贴和拖入附件；工作助理继续使用图片输入。

## 输入

1. Mac 的 IPC 校验文件类型标记、Base64、解码后大小及数量。iPhone 将消息和附件先写入每个账户 / Relay 空间独立的本地发送队列。
2. 手机将附件 AES-GCM 加密上传至私有 R2，再提交携带附件描述的 `agent.send-message`。失败后恢复原命令 ID、创建时间和已上传描述，避免重复执行；PUT 重试遇到不可变 ID 冲突时，下载并核对已有原文。退出账户会删除其待发送队列。
3. Mac 下载、解密、验证大小和 SHA-256，然后与本机输入一起进入 `persistInputAttachments`。附件存入项目文件空间，登记 Artifact 与消息附件描述；绝对路径只进入本机运行时，用户消息正文不拼入路径。
4. Codex `turn/start.input` 使用 `localImage`；Claude SDK 使用结构化 image content；Pi 使用 `images`；OpenCode 使用原生 `--file`。普通文档保留可读文件引用。

## 输出与历史

- 项目文件空间中新建 / 修改的产物，以及最终回复中指向已配置 Workspace 的本地 Markdown 文件链接，登记为产物。文件复制到 `_artifacts` 的内容快照；后续覆盖原文件不会改变旧消息的附件。
- Workspace 外路径、越界符号链接、隐藏文件以及 `.pem` / `.key` 链接不会自动导出。
- 输入与输出的附件描述都随消息写入 SQLite，进入实时事件、初始快照及历史分页。旧消息缺少附件字段时仍可读取；旧版仅存文件名的消息继续显示兼容文件名标签。
- 私有 R2 保存加密字节。iPhone 在解密、大小与 SHA 校验后展示缩略图 / Quick Look，校验通过的缓存可在离线时复用。Mac 点击卡片进入文件预览，支持图片、文本、Markdown 和 PDF，其他格式可在 Finder 中访问。
- Agent 仍需在回复中列出 Workspace 输出链接，或把交付物放入项目文件空间。应用不会将整个代码仓库自动上传。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run relay:typecheck
npm run relay:test
npm run ios:typecheck
```

`attachment-loop.test.ts` 用隔离的加密 Relay 传输替身串联真实 CompanionSync、TaskDispatcher、附件落盘和输出回传，并检查哈希错误及命令重放。`agent-attachments.test.ts` 验证数据库重开、历史分页、文件快照与路径边界。iOS `AttachmentTests` 验证上传冲突恢复、发送队列持久化、缓存和完整性。

真实 Codex 看图测试需要本机已登录的 Codex、Python 3 和 Pillow；只在临时项目中执行，不访问生产 Fuddy 数据，也不默认运行：

```sh
RUN_ATTACHMENT_CODEX_SMOKE=1 npx vitest run src/main/services/attachment-codex.integration.test.ts
```

测试生成不含文字元数据的随机数字图片，要求 Codex 识图、交付图片和报告，再恢复相同 Session 验证图片上下文。iOS XCTest 应在隔离 iPhone Simulator 上运行，保留本地 ad-hoc 签名。`--design-preview --design-preview-attachments` 提供离线附件卡片预览，不连接真实账户。
