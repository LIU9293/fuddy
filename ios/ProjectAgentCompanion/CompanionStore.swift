import Combine
import Foundation
import UIKit
import UserNotifications

@MainActor
final class CompanionStore: ObservableObject {
    enum ConnectionState: Equatable { case unpaired, connecting, connected, offline, error(String) }

    @Published private(set) var state = CachedState()
    @Published private(set) var connection: ConnectionState = .unpaired
    @Published private(set) var macOnline = false
    @Published private(set) var credentials: CompanionCredentials?
    @Published var operationError: String?

    private var client: RelayClient?
    private var pollingTask: Task<Void, Never>?
    private var activeSync: Task<Void, Never>?
    private var activeSyncID: UUID?
    private var syncRequested = false
    private var commandErrors: [String: String] = [:]
    private var notificationObservers: [NSObjectProtocol] = []
    private var notificationAuthorizationRequested = false
    private let cacheURL: URL
    private let previewMode = ProcessInfo.processInfo.arguments.contains("--design-preview")
    private let runScrollPositionKeyPrefix = "agent-run.scroll-position."

    init() {
        cacheURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ProjectAgentCompanion/state.json")
#if DEBUG
        if previewMode {
            credentials = CompanionCredentials(relayURL: "https://relay.example.com", accountID: "preview", deviceID: "iphone-preview", deviceToken: "preview")
            connection = .connected
            macOnline = true
            seedDesignPreview()
            return
        }
#endif
        loadCache()
        do {
            credentials = try KeychainStore.load()
            if let credentials { configureClient(credentials); connection = .offline }
        } catch {
            operationError = error.localizedDescription
        }
        notificationObservers.append(NotificationCenter.default.addObserver(
            forName: .companionPushToken,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let token = notification.object as? String else { return }
            Task { @MainActor in await self?.registerPushToken(token) }
        })
        notificationObservers.append(NotificationCenter.default.addObserver(
            forName: .companionPushRegistrationFailed,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let error = notification.object as? Error else { return }
            Task { @MainActor in self?.operationError = "推送注册失败：\(error.localizedDescription)" }
        })
    }

    var isPaired: Bool { credentials != nil }
    var runs: [RunDetail] { state.runs.sorted { $0.run.updatedAt > $1.run.updatedAt } }
    var decisions: [Decision] { state.decisions.sorted { $0.createdAt > $1.createdAt } }
    var morningBriefings: [MorningBriefing] { state.morningBriefings.sorted { $0.generatedAt < $1.generatedAt } }
    var workAssistantMessages: [WorkAssistantMessage] { state.workAssistantMessages.sorted { $0.createdAt < $1.createdAt } }

    func savedRunScrollPosition(runID: String) -> String? {
        UserDefaults.standard.string(forKey: runScrollPositionKeyPrefix + runID)
    }

    func saveRunScrollPosition(_ position: String?, runID: String) {
        let key = runScrollPositionKeyPrefix + runID
        if let position { UserDefaults.standard.set(position, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    func start() {
        guard !previewMode else { return }
        guard isPaired else { return }
        requestNotificationAuthorizationIfNeeded()
        UIApplication.shared.registerForRemoteNotifications()
        client?.connect { [weak self] envelope in
            Task { @MainActor in await self?.handleSocketEnvelope(envelope) }
        }
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            await self?.sync()
            var elapsedSeconds: TimeInterval = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(companionFallbackSyncIntervalSeconds))
                guard !Task.isCancelled else { return }
                elapsedSeconds += companionFallbackSyncIntervalSeconds
                let interval = companionFallbackSyncIntervalSeconds(
                    realtimeConnected: self?.client?.realtimeConnected == true
                )
                guard elapsedSeconds >= interval else { continue }
                elapsedSeconds = 0
                await self?.sync()
            }
        }
    }

    func suspendForegroundTransport() {
        pollingTask?.cancel()
        pollingTask = nil
        client?.disconnect()
    }

    func pair(payloadText: String) async {
        connection = .connecting
        operationError = nil
        do {
            guard let data = payloadText.data(using: .utf8) else { throw RelayError.invalidResponse }
            let pairing = try JSONDecoder().decode(PairingPayload.self, from: data)
            let name = UIDevice.current.name
            let credentials = try await RelayClient.claim(pairing: pairing, deviceName: name)
            try KeychainStore.save(credentials)
            self.credentials = credentials
            configureClient(credentials)
            state = CachedState()
            persistCache()
            connection = .connected
            start()
            UIApplication.shared.registerForRemoteNotifications()
            await sync()
        } catch {
            connection = .error(error.localizedDescription)
            operationError = error.localizedDescription
        }
    }

    func unpair() {
        suspendForegroundTransport()
        activeSync?.cancel()
        activeSync = nil
        activeSyncID = nil
        syncRequested = false
        client = nil
        KeychainStore.delete()
        credentials = nil
        macOnline = false
        connection = .unpaired
    }

    func sync() async {
        guard client != nil else { return }
        if let activeSync {
            syncRequested = true
            await activeSync.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performSyncLoop()
        }
        let syncID = UUID()
        activeSyncID = syncID
        activeSync = task
        await task.value
        if activeSyncID == syncID {
            activeSync = nil
            activeSyncID = nil
        }
    }

    private func performSyncLoop() async {
        repeat {
            syncRequested = false
            await performSync()
        } while syncRequested && client != nil
    }

    private func performSync() async {
        guard let client else { return }
        do {
            var replayedOperationError: String?
            while true {
                let page = try await client.events(after: state.lastSequence)
                guard !Task.isCancelled else { return }
                if let presence = page.presence { macOnline = presence.macOnline }
                for event in page.events where event.sequence > state.lastSequence {
                    if let eventError = try apply(event) { replayedOperationError = eventError }
                    state.lastSequence = event.sequence
                }
                persistCache()
                if page.events.count < 200 { break }
            }
            connection = .connected
            if let replayedOperationError { operationError = replayedOperationError }
            else if operationError?.hasPrefix("同步失败：") == true { operationError = nil }
        } catch {
            connection = .offline
            operationError = "同步失败：\(error.localizedDescription)"
        }
    }

    func sendMessage(runID: String, prompt: String, attachments: [PendingAttachment] = []) async throws {
        guard let client else { throw RelayError.invalidResponse }
        guard let runIndex = state.runs.firstIndex(where: { $0.run.id == runID }) else {
            throw RelayError.invalidResponse
        }
        let commandID = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())
        let previousStatus = state.runs[runIndex].run.status
        let previousUpdatedAt = state.runs[runIndex].run.updatedAt
        upsertAgentMessage(AgentMessage(
            id: commandID,
            runId: runID,
            role: "user",
            content: prompt,
            eventType: "pending",
            toolName: nil,
            createdAt: now
        ), in: &state.runs)
        state.runs[runIndex].run.status = "running"
        state.runs[runIndex].run.updatedAt = now
        persistCache()
        do {
            let uploaded = try await upload(attachments, using: client)
            _ = try await client.sendCommand(
                commandID: commandID,
                type: "agent.send-message",
                payload: AgentSendMessagePayload(
                    runId: runID,
                    prompt: prompt,
                    attachments: uploaded,
                    clientMessageId: commandID
                )
            )
        } catch {
            removePendingAgentMessage(commandID)
            if let index = state.runs.firstIndex(where: { $0.run.id == runID }) {
                state.runs[index].run.status = previousStatus
                state.runs[index].run.updatedAt = previousUpdatedAt
            }
            persistCache()
            throw error
        }
    }

    func stopMessage(runID: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "agent.stop-message",
            payload: AgentArchivePayload(runId: runID)
        )
    }

    func sendWorkAssistantMessage(_ prompt: String, attachments: [PendingAttachment] = []) async throws {
        guard let client else { throw RelayError.invalidResponse }
        let uploaded = try await upload(attachments, using: client)
        _ = try await client.sendCommand(
            type: "assistant.send-message",
            payload: AssistantSendMessagePayload(prompt: prompt, attachments: uploaded)
        )
    }

    func executeWorkAssistantAction(messageID: String, proposalID: String, optionID: String) async throws -> String? {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "assistant.execute-action",
            payload: AssistantExecuteActionPayload(messageId: messageID, proposalId: proposalID, optionId: optionID)
        )
        for _ in 0..<12 {
            try await Task.sleep(for: .milliseconds(500))
            await sync()
            guard let message = state.workAssistantMessages.first(where: { $0.id == messageID }),
                  let proposal = message.actions.first(where: { $0.id == proposalID }) else { continue }
            if proposal.status != "pending" { return message.linkedRunId }
        }
        return nil
    }

    func handleDecision(_ decision: Decision) async throws -> String {
        guard let client else { throw RelayError.invalidResponse }
        if let existing = state.runs.first(where: {
            $0.run.decisionId == decision.id && $0.run.status != "completed" && $0.run.status != "cancelled"
        }) {
            try await updateDecision(id: decision.id, status: "in_progress")
            return existing.run.id
        }
        let runID = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())
        let previousStatus = state.decisions.first(where: { $0.id == decision.id })?.status
        if let decisionIndex = state.decisions.firstIndex(where: { $0.id == decision.id }) {
            state.decisions[decisionIndex].status = "in_progress"
        }
        state.runs.append(RunDetail(
            run: AgentRun(
                id: runID,
                projectId: decision.projectId,
                decisionId: decision.id,
                provider: "agent",
                title: "处理 · \(decision.title)",
                status: "idle",
                workingDirectory: nil,
                summary: "",
                createdAt: now,
                updatedAt: now
            ),
            messages: [],
            artifacts: []
        ))
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: "decision.handle",
                payload: DecisionHandlePayload(decisionId: decision.id, runId: runID)
            )
            return runID
        } catch {
            state.runs.removeAll { $0.run.id == runID }
            if let previousStatus, let decisionIndex = state.decisions.firstIndex(where: { $0.id == decision.id }) {
                state.decisions[decisionIndex].status = previousStatus
            }
            persistCache()
            throw error
        }
    }

    func rename(runID: String, title: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "agent.rename-session",
            payload: AgentRenamePayload(runId: runID, title: title)
        )
    }

    func updateDraftPrompt(runID: String, draftPrompt: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        guard let index = state.runs.firstIndex(where: { $0.run.id == runID }) else {
            throw RelayError.invalidResponse
        }
        let previous = state.runs[index].run.draftPrompt
        state.runs[index].run.draftPrompt = draftPrompt.isEmpty ? nil : draftPrompt
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: "agent.update-draft-prompt",
                payload: AgentDraftPromptPayload(runId: runID, draftPrompt: draftPrompt)
            )
        } catch {
            if let current = state.runs.firstIndex(where: { $0.run.id == runID }) {
                state.runs[current].run.draftPrompt = previous
            }
            persistCache()
            throw error
        }
    }

    func archive(runID: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(type: "agent.archive-session", payload: AgentArchivePayload(runId: runID))
    }

    func updateDecision(id: String, status: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        let previousStatus = state.decisions.first(where: { $0.id == id })?.status
        if let index = state.decisions.firstIndex(where: { $0.id == id }) {
            state.decisions[index].status = status
        }
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: "decision.update-status",
                payload: DecisionStatusPayload(decisionId: id, status: status)
            )
        } catch {
            if let previousStatus, let index = state.decisions.firstIndex(where: { $0.id == id }) {
                state.decisions[index].status = previousStatus
            }
            persistCache()
            throw error
        }
    }

    func updateProject(_ project: Project) async throws {
#if DEBUG
        if previewMode {
            upsert(project, in: &state.projects)
            persistCache()
            return
        }
#endif
        guard let client else { throw RelayError.invalidResponse }
        let previous = state.projects.first(where: { $0.id == project.id })
        upsert(project, in: &state.projects)
        persistCache()
        do {
            _ = try await client.sendCommand(type: "project.update", payload: ProjectUpdatePayload(project: project))
        } catch {
            if let previous { upsert(previous, in: &state.projects) }
            persistCache()
            throw error
        }
    }

    func download(_ attachment: AttachmentDescriptor) async throws -> URL {
        guard let client else { throw RelayError.invalidResponse }
        return try await client.downloadAttachment(attachment)
    }

    func openArtifact(_ artifact: AgentArtifact) async throws -> URL {
        if let attachment = attachment(for: artifact.id) {
            return try await download(attachment)
        }
        guard macOnline else {
            throw RelayError.server("Mac 当前不在线，暂时无法上传这个附件。")
        }
        guard let client else { throw RelayError.invalidResponse }
        let commandID = UUID().uuidString
        commandErrors[commandID] = nil
        defer { commandErrors[commandID] = nil }
        _ = try await client.sendCommand(
            commandID: commandID,
            type: "artifact.request-upload",
            payload: ArtifactUploadRequestPayload(artifactId: artifact.id)
        )

        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            await sync()
            if let attachment = attachment(for: artifact.id) {
                return try await download(attachment)
            }
            if let message = commandErrors[commandID] {
                throw RelayError.server(message)
            }
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(400))
        }
        throw RelayError.server("Mac 未在 30 秒内完成附件上传，请稍后重试。")
    }

    func attachment(for artifactID: String) -> AttachmentDescriptor? { state.attachments[artifactID] }

    private func registerPushToken(_ token: String) async {
        guard let client else { return }
        do { try await client.registerPushToken(token) }
        catch { operationError = "推送注册失败：\(error.localizedDescription)" }
    }

    private func requestNotificationAuthorizationIfNeeded() {
        guard !notificationAuthorizationRequested else { return }
        notificationAuthorizationRequested = true
        Task { @MainActor [weak self] in
            do {
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                if settings.authorizationStatus == .notDetermined {
                    let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                    if !granted {
                        self?.operationError = "通知权限未开启；可在系统设置中开启 Agent Run 完成提醒。"
                    }
                }
                UIApplication.shared.registerForRemoteNotifications()
            } catch {
                self?.operationError = "通知授权失败：\(error.localizedDescription)"
            }
        }
    }

    private func configureClient(_ credentials: CompanionCredentials) {
        client = RelayClient(credentials: credentials)
    }

    private func handleSocketEnvelope(_ envelope: SocketEnvelope) async {
        if let presence = envelope.presence {
            macOnline = presence.macOnline
        }
        if envelope.type == "sync.ready", let remoteSequence = envelope.lastSequence {
            let replayCursor = companionReplayCursor(
                cachedSequence: state.lastSequence,
                remoteSequence: remoteSequence
            )
            if replayCursor != state.lastSequence {
                state = CachedState()
                persistCache()
            }
        }
        if let command = envelope.command,
           let commandError = applyCommandResult(command) {
            operationError = commandError
        }
        if envelope.type == "presence.updated" { return }
        await sync()
    }

    private func apply(_ event: SyncEvent) throws -> String? {
        var eventError: String?
        switch event.type {
            case "snapshot.created":
                let snapshot = try event.payload.decode(SnapshotPayload.self)
                state.modelLabels = snapshot.modelLabels ?? .fallback
                state.projects = snapshot.projects
                state.goals = snapshot.goals
                state.decisions = snapshot.decisions
                state.morningBriefings = snapshot.morningBriefings ?? []
                state.workAssistantMessages = snapshot.workAssistantMessages
                state.runs = snapshot.runs
                state.attachments = Dictionary(
                    uniqueKeysWithValues: (snapshot.attachments ?? []).compactMap { attachment in
                        attachment.artifactId.map { ($0, attachment) }
                    }
                )
            case "project.created", "project.updated":
                upsert(try event.payload.decode(Project.self), in: &state.projects)
            case "goal.created", "goal.updated":
                upsert(try event.payload.decode(ProjectGoal.self), in: &state.goals)
            case "decision.created", "decision.updated":
                upsert(try event.payload.decode(Decision.self), in: &state.decisions)
            case "morning-briefing.updated":
                upsert(try event.payload.decode(MorningBriefing.self), in: &state.morningBriefings)
            case "work-assistant-message.created", "work-assistant-message.updated":
                upsert(try event.payload.decode(WorkAssistantMessage.self), in: &state.workAssistantMessages)
            case "agent-run.created", "agent-run.updated":
                let run = try event.payload.decode(AgentRun.self)
                if let index = state.runs.firstIndex(where: { $0.run.id == run.id }) { state.runs[index].run = run }
                else { state.runs.append(RunDetail(run: run, messages: [], artifacts: [])) }
            case "model-labels.updated":
                state.modelLabels = try event.payload.decode(AgentModelLabels.self)
            case "agent-run.archived":
                state.runs.removeAll { $0.run.id == event.entityId }
            case "agent-message.created":
                let message = try event.payload.decode(AgentMessage.self)
                upsertAgentMessage(message, in: &state.runs)
            case "artifact.updated":
                if let enriched = try? event.payload.decode(ArtifactEventPayload.self) {
                    upsertArtifact(enriched.artifact)
                    if let attachment = enriched.attachment { state.attachments[enriched.artifact.id] = attachment }
                } else {
                    upsertArtifact(try event.payload.decode(AgentArtifact.self))
                }
            case "command.updated":
                let command = try event.payload.decode(CommandResult.self)
                eventError = applyCommandResult(command)
        default:
            break
        }
        return eventError
    }

    private func applyCommandResult(_ command: CommandResult) -> String? {
        if command.type == "artifact.request-upload" {
            if command.status == "failed" {
                commandErrors[command.commandId] = command.error ?? "Mac 上传附件失败。"
            } else if command.status == "completed",
                      let result = command.result,
                      let upload = try? result.decode(ArtifactUploadResult.self) {
                state.attachments[upload.artifactId] = upload.attachment
                persistCache()
            }
            return nil
        }
        if command.status == "failed" {
            removePendingAgentMessage(command.commandId)
            return command.error ?? "Mac 执行远程操作失败。"
        }
        if ["delivered", "executing", "completed"].contains(command.status) {
            markPendingAgentMessageAcknowledged(command.commandId)
        }
        return nil
    }

    private func upsert<T: Identifiable>(_ value: T, in values: inout [T]) where T.ID: Equatable {
        if let index = values.firstIndex(where: { $0.id == value.id }) { values[index] = value }
        else { values.append(value) }
    }

    private func upsertArtifact(_ artifact: AgentArtifact) {
        guard let index = state.runs.firstIndex(where: { $0.run.id == artifact.runId }) else { return }
        upsert(artifact, in: &state.runs[index].artifacts)
    }

    private func removePendingAgentMessage(_ messageID: String) {
        guard let runIndex = state.runs.firstIndex(where: { detail in
            detail.messages.contains(where: { $0.id == messageID && $0.eventType == "pending" })
        }) else { return }
        state.runs[runIndex].messages.removeAll { $0.id == messageID && $0.eventType == "pending" }
        persistCache()
    }

    private func markPendingAgentMessageAcknowledged(_ messageID: String) {
        guard acknowledgePendingAgentMessage(messageID, in: &state.runs) else { return }
        persistCache()
    }

    private func upload(_ attachments: [PendingAttachment], using client: RelayClient) async throws -> [AttachmentDescriptor] {
        var uploaded: [AttachmentDescriptor] = []
        for attachment in attachments {
            uploaded.append(try await client.uploadAttachment(attachment))
        }
        return uploaded
    }

    private func loadCache() {
        guard let data = try? Data(contentsOf: cacheURL), let saved = try? JSONDecoder().decode(CachedState.self, from: data) else { return }
        state = saved
    }

    private func persistCache() {
        do {
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(state).write(to: cacheURL, options: .atomic)
        } catch {
            operationError = "本地缓存保存失败：\(error.localizedDescription)"
        }
    }

#if DEBUG
    private func seedDesignPreview() {
        let now = "2026-08-08T03:40:00.000Z"
        state.projects = [Project(
            id: "roombase",
            name: "Roombase",
            summary: "空间与服务预订平台",
            focus: "处理平台入驻与上线事项",
            status: "active",
            accent: "indigo",
            profile: ProjectProfile(
                productType: "SaaS + Marketplace",
                stage: "Growth",
                mission: "",
                vision: "",
                repoPath: "/Users/kai/Code/shopmy",
                workspaceRoots: [ProjectWorkspaceRoot(id: "primary", label: "Shopmy", path: "/Users/kai/Code/shopmy")],
                primaryWorkspaceRootId: "primary",
                defaultAgent: "claude",
                websiteUrl: "https://roombase.cn",
                surfaces: ["商家工作台", "用户端小程序"],
                focusAreas: ["平台入驻", "支付与结算"],
                dataSources: ["Production PostgreSQL", "Cloudflare Analytics"],
                nextMoves: ["处理长期等待的平台入驻事项", "确认支付回调监控"],
                currentState: .empty
            )
        )]
        state.morningBriefings = [MorningBriefing(
            id: "morning-preview",
            reportDate: "2026-08-08",
            timezone: "Asia/Shanghai",
            status: "completed",
            headline: "今天先处理 2 个需要你介入的事项",
            body: """
            ## 今天需要关注

            **Roombase** 有 4 个小程序入驻仍在等待平台处理，最老一项已经等待 72.8 天。建议先确认各条记录卡在哪个审核节点，再决定是否需要人工跟进平台。

            ## 已恢复

            昨日的支付回调监控已经恢复稳定，当前没有新的失败记录，可以继续观察而不需要立即介入。

            ## 建议顺序

            1. 处理长期等待的平台入驻事项。
            2. 核对首次预订下降是否集中在特定来源或门店。
            3. 保持支付回调监控，暂不新增动作。
            """,
            narration: "早上好。今天先处理两个需要你介入的事项。Roombase 有四个小程序入驻仍在等待平台处理，最老一项已经等待七十二点八天，建议先确认它们分别卡在哪个审核节点。昨日的支付回调监控已经恢复稳定，当前没有新的失败记录，可以继续观察。",
            estimatedDurationSeconds: 82,
            sourceBriefingIds: [],
            signalIds: [],
            generatedAt: now,
            error: nil,
            generation: "agent"
        )]
        state.workAssistantMessages = [
            WorkAssistantMessage(
                id: "assistant-preview",
                role: "assistant",
                content: "早上好。每日总结已经准备好了，你可以直接从卡片里的重点继续聊。",
                createdAt: "2026-08-08T03:39:00.000Z"
            ),
            WorkAssistantMessage(
                id: "assistant-preview-user",
                role: "user",
                content: "先帮我确认最需要跟进的项目。",
                createdAt: "2026-08-08T03:41:00.000Z"
            ),
            WorkAssistantMessage(
                id: "assistant-preview-reply",
                role: "assistant",
                content: "Roombase 的平台入驻等待时间最长，建议先确认这 4 条记录当前卡在哪个审核节点。",
                createdAt: "2026-08-08T03:42:00.000Z"
            )
        ]
        state.decisions = [Decision(id: "decision-preview", projectId: "roombase", title: "Roombase 有长期等待平台处理的入驻事项", summary: "当前 4 个小程序入驻等待平台处理，最老一项已等待 72.8 天。", impact: "可能延迟商家上线", urgency: "high", status: "inbox", source: "每日巡检", createdAt: now)]
        state.runs = [
            RunDetail(
                run: AgentRun(id: "run-preview", projectId: "roombase", provider: "claude", title: "分析长期等待平台处理的入驻事项", status: "running", workingDirectory: "/Users/kai/Code/shopmy", summary: "", createdAt: now, updatedAt: now),
                messages: [
                    AgentMessage(id: "reasoning-1", runId: "run-preview", role: "assistant", content: "我先确认项目的工作区说明和入驻数据所在位置。", eventType: "reasoning", toolName: nil, createdAt: now),
                    AgentMessage(id: "tool-1", runId: "run-preview", role: "tool", content: "{\"file_path\":\"/Users/kai/Code/shopmy/AGENTS.md\"}", eventType: "tool", toolName: "Read", createdAt: now),
                    AgentMessage(id: "tool-2", runId: "run-preview", role: "tool", content: "{\"command\":\"rg onboarding packages/api\"}", eventType: "tool", toolName: "Bash", createdAt: now),
                    AgentMessage(id: "reasoning-2", runId: "run-preview", role: "assistant", content: "已经找到生产库连接方式，接下来核对这 4 条入驻记录。", eventType: "reasoning", toolName: nil, createdAt: now),
                    AgentMessage(id: "tool-3", runId: "run-preview", role: "tool", content: "{\"command\":\"pnpm db:query onboarding\"}", eventType: "tool", toolName: "Bash", createdAt: now)
                ],
                artifacts: []
            ),
            RunDetail(
                run: AgentRun(id: "run-preview-completed", projectId: "roombase", provider: "codex", title: "汇总平台入驻状态", status: "idle", workingDirectory: "/Users/kai/Code/shopmy", summary: "已核对 3 条入驻记录", createdAt: now, updatedAt: now),
                messages: [
                    AgentMessage(id: "completed-reasoning", runId: "run-preview-completed", role: "assistant", content: "我先核对入驻记录和最近一次平台回执。", eventType: "reasoning", toolName: nil, createdAt: "2026-08-08T03:40:01.000Z"),
                    AgentMessage(id: "completed-tool", runId: "run-preview-completed", role: "tool", content: "{\"command\":\"pnpm db:query onboarding\"}", eventType: "tool", toolName: "Bash", createdAt: "2026-08-08T03:40:12.000Z"),
                    AgentMessage(id: "completed-result", runId: "run-preview-completed", role: "assistant", content: """
                    已完成核对：

                    | 项目 | 状态 | 等待时间 |
                    | :--- | :---: | ---: |
                    | Roombase | 待平台处理 | 3 天 |
                    | Vows | 已通过 | 1 天 |
                    | Studio | 需补充资料 | 5 天 |
                    """, eventType: nil, toolName: nil, createdAt: "2026-08-08T03:41:05.000Z")
                ],
                artifacts: []
            )
        ]
    }
#endif
}
