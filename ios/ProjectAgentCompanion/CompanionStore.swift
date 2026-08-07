import Combine
import Foundation
import UIKit

@MainActor
final class CompanionStore: ObservableObject {
    enum ConnectionState: Equatable { case unpaired, connecting, connected, offline, error(String) }

    @Published private(set) var state = CachedState()
    @Published private(set) var connection: ConnectionState = .unpaired
    @Published private(set) var credentials: CompanionCredentials?
    @Published var operationError: String?

    private var client: RelayClient?
    private var pollingTask: Task<Void, Never>?
    private var notificationObservers: [NSObjectProtocol] = []
    private let cacheURL: URL

    init() {
        cacheURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ProjectAgentCompanion/state.json")
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
            forName: .companionRemoteUpdate,
            object: nil,
            queue: .main
        ) { [weak self] _ in Task { @MainActor in await self?.sync() } })
    }

    var isPaired: Bool { credentials != nil }
    var runs: [RunDetail] { state.runs.sorted { $0.run.updatedAt > $1.run.updatedAt } }
    var decisions: [Decision] { state.decisions.sorted { $0.createdAt > $1.createdAt } }
    var workAssistantMessages: [WorkAssistantMessage] { state.workAssistantMessages.sorted { $0.createdAt < $1.createdAt } }

    func start() {
        guard isPaired else { return }
        UIApplication.shared.registerForRemoteNotifications()
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.sync()
                try? await Task.sleep(for: .seconds(2))
            }
        }
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
        pollingTask?.cancel()
        pollingTask = nil
        client?.disconnect()
        client = nil
        KeychainStore.delete()
        credentials = nil
        connection = .unpaired
    }

    func sync() async {
        guard let client else { return }
        do {
            let page = try await client.events(after: state.lastSequence)
            for event in page.events { apply(event) }
            state.lastSequence = max(state.lastSequence, page.lastSequence)
            persistCache()
            connection = .connected
        } catch {
            connection = .offline
            operationError = error.localizedDescription
        }
    }

    func sendMessage(runID: String, prompt: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "agent.send-message",
            payload: AgentSendMessagePayload(runId: runID, prompt: prompt)
        )
    }

    func sendWorkAssistantMessage(_ prompt: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "assistant.send-message",
            payload: AssistantSendMessagePayload(prompt: prompt)
        )
    }

    func rename(runID: String, title: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "agent.rename-session",
            payload: AgentRenamePayload(runId: runID, title: title)
        )
    }

    func archive(runID: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(type: "agent.archive-session", payload: AgentArchivePayload(runId: runID))
    }

    func updateDecision(id: String, status: String) async throws {
        guard let client else { throw RelayError.invalidResponse }
        _ = try await client.sendCommand(
            type: "decision.update-status",
            payload: DecisionStatusPayload(decisionId: id, status: status)
        )
    }

    func download(_ attachment: AttachmentDescriptor) async throws -> URL {
        guard let client else { throw RelayError.invalidResponse }
        return try await client.downloadAttachment(id: attachment.id, filename: attachment.filename)
    }

    func attachment(for artifactID: String) -> AttachmentDescriptor? { state.attachments[artifactID] }

    private func registerPushToken(_ token: String) async {
        guard let client else { return }
        do { try await client.registerPushToken(token) }
        catch { operationError = "推送注册失败：\(error.localizedDescription)" }
    }

    private func configureClient(_ credentials: CompanionCredentials) {
        let client = RelayClient(credentials: credentials)
        self.client = client
        client.connect { [weak self] in
            Task { @MainActor in await self?.sync() }
        }
    }

    private func apply(_ event: SyncEvent) {
        do {
            switch event.type {
            case "snapshot.created":
                let snapshot = try event.payload.decode(SnapshotPayload.self)
                state.projects = snapshot.projects
                state.goals = snapshot.goals
                state.decisions = snapshot.decisions
                state.workAssistantMessages = snapshot.workAssistantMessages
                state.runs = snapshot.runs
                state.attachments = Dictionary(
                    uniqueKeysWithValues: (snapshot.attachments ?? []).compactMap { attachment in
                        attachment.artifactId.map { ($0, attachment) }
                    }
                )
            case "project.updated":
                upsert(try event.payload.decode(Project.self), in: &state.projects)
            case "goal.created", "goal.updated":
                upsert(try event.payload.decode(ProjectGoal.self), in: &state.goals)
            case "decision.created", "decision.updated":
                upsert(try event.payload.decode(Decision.self), in: &state.decisions)
            case "work-assistant-message.created":
                upsert(try event.payload.decode(WorkAssistantMessage.self), in: &state.workAssistantMessages)
            case "agent-run.created", "agent-run.updated":
                let run = try event.payload.decode(AgentRun.self)
                if let index = state.runs.firstIndex(where: { $0.run.id == run.id }) { state.runs[index].run = run }
                else { state.runs.append(RunDetail(run: run, messages: [], artifacts: [])) }
            case "agent-run.archived":
                state.runs.removeAll { $0.run.id == event.entityId }
            case "agent-message.created":
                let message = try event.payload.decode(AgentMessage.self)
                if let index = state.runs.firstIndex(where: { $0.run.id == message.runId }),
                   !state.runs[index].messages.contains(where: { $0.id == message.id }) {
                    state.runs[index].messages.append(message)
                }
            case "artifact.updated":
                if let enriched = try? event.payload.decode(ArtifactEventPayload.self) {
                    upsertArtifact(enriched.artifact)
                    if let attachment = enriched.attachment { state.attachments[enriched.artifact.id] = attachment }
                } else {
                    upsertArtifact(try event.payload.decode(AgentArtifact.self))
                }
            default: break
            }
        } catch {
            operationError = "无法读取同步事件 \(event.type)：\(error.localizedDescription)"
        }
    }

    private func upsert<T: Identifiable>(_ value: T, in values: inout [T]) where T.ID: Equatable {
        if let index = values.firstIndex(where: { $0.id == value.id }) { values[index] = value }
        else { values.append(value) }
    }

    private func upsertArtifact(_ artifact: AgentArtifact) {
        guard let index = state.runs.firstIndex(where: { $0.run.id == artifact.runId }) else { return }
        upsert(artifact, in: &state.runs[index].artifacts)
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
}
