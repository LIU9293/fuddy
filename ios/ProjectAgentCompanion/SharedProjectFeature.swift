import CryptoKit
import Foundation
import SwiftUI

struct MobileProjectShare: Codable, Identifiable {
    let projectId: String
    let role: String
    let executionHostId: String
    let keyEpoch: Int
    var id: String { projectId }
}

struct MobileSharedAuthor: Codable, Hashable {
    let displayName: String
    let avatarRef: String?
}

struct MobileSharedProject: Codable, Hashable {
    let id: String
    let revision: Int?
    let name: String
    let icon: String?
    let summary: String
    let status: String
    let productType: String
    let stage: String
}

struct MobileSharedChat: Codable, Hashable, Identifiable {
    let id: String
    let projectId: String
    let title: String
    let status: String
    let provider: String
    let executionHostId: String?
    let createdByUserId: String?
    let createdBySnapshot: MobileSharedAuthor?
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
}

struct MobileSharedMessage: Codable, Hashable, Identifiable {
    let id: String
    let runId: String
    let role: String
    let content: String
    let authorUserId: String?
    let authorSnapshot: MobileSharedAuthor?
    let createdAt: String
    let attachments: [MobileSharedAttachment]?
}

struct MobileSharedAttachment: Codable, Hashable, Identifiable {
    let id: String
    let filename: String
    let mimeType: String
    let size: Int
    let sha256: String
    let createdAt: String
    let kind: String
    let runId: String
    let messageId: String?
    let artifactId: String?
    let inputId: String?
}

struct MobileSharedSnapshot: Codable {
    let version: Int
    var project: MobileSharedProject
    var chats: [MobileSharedChat]
    var messages: [MobileSharedMessage]
    var artifacts: [MobileSharedAttachment]?
    var pendingSources: [String]?
}

enum MobileProjectSharingCache {
    private static func directory(userID: String) throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        let identity = Data(SHA256.hash(data: Data(userID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent("shared-projects/\(identity)", isDirectory: true)
    }

    private static func file(userID: String, projectID: String, epoch: Int) throws -> URL {
        let identity = Data(SHA256.hash(data: Data(projectID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        return try directory(userID: userID).appendingPathComponent("\(identity)-\(epoch).json")
    }

    private static func associatedData(userID: String, projectID: String, epoch: Int) -> String {
        "fuddy:mobile-shared-cache:v1:\(userID):\(projectID):\(epoch)"
    }

    static func save(_ snapshot: MobileSharedSnapshot, key: String,
                     userID: String, projectID: String, epoch: Int) throws {
        let url = try file(userID: userID, projectID: projectID, epoch: epoch)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        let envelope = try CompanionCrypto.sealJSON(
            snapshot, key: key,
            associatedData: associatedData(userID: userID, projectID: projectID, epoch: epoch)
        )
        try JSONEncoder().encode(envelope).write(to: url, options: .atomic)
    }

    static func load(key: String, userID: String, projectID: String,
                     epoch: Int) throws -> MobileSharedSnapshot? {
        let url = try file(userID: userID, projectID: projectID, epoch: epoch)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let envelope = try JSONDecoder().decode(
            CompanionEncryptedEnvelope.self, from: Data(contentsOf: url)
        )
        let snapshot = try CompanionCrypto.openJSON(
            MobileSharedSnapshot.self, envelope: envelope, key: key,
            associatedData: associatedData(userID: userID, projectID: projectID, epoch: epoch)
        )
        guard snapshot.project.id == projectID, snapshot.version == 1 else {
            throw AccountClientError.invalidResponse
        }
        return snapshot
    }

    static func clear(userID: String) {
        if let url = try? directory(userID: userID) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    static func clearProject(userID: String, projectID: String) {
        guard let root = try? directory(userID: userID) else { return }
        let identity = Data(SHA256.hash(data: Data(projectID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        if let entries = try? FileManager.default.contentsOfDirectory(at: root,
            includingPropertiesForKeys: nil) {
            for entry in entries where entry.lastPathComponent.hasPrefix("\(identity)-") {
                try? FileManager.default.removeItem(at: entry)
            }
        }
        try? FileManager.default.removeItem(at: root.appendingPathComponent("files/\(identity)"))
    }

    static func verifiedFile(filename: String, attachmentID: String, userID: String,
                             projectID: String, epoch: Int, size: Int, sha256: String) -> URL? {
        let projectDirectory = Data(SHA256.hash(data: Data(projectID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        let safeID = Data(SHA256.hash(data: Data(attachmentID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        let safeName = URL(fileURLWithPath: filename).lastPathComponent
            .replacingOccurrences(of: ":", with: "_")
        guard let root = try? directory(userID: userID) else { return nil }
        let url = root.appendingPathComponent("files/\(projectDirectory)/\(epoch)/\(safeID)-\(safeName)")
        guard let bytes = try? Data(contentsOf: url), bytes.count == size else { return nil }
        let digest = Data(SHA256.hash(data: bytes)).map { String(format: "%02x", $0) }.joined()
        return digest == sha256 ? url : nil
    }

    static func saveVerifiedFile(_ bytes: Data, filename: String, attachmentID: String,
                                 userID: String, projectID: String, epoch: Int) throws -> URL {
        let projectDirectory = Data(SHA256.hash(data: Data(projectID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        let safeID = Data(SHA256.hash(data: Data(attachmentID.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        let directory = try directory(userID: userID)
            .appendingPathComponent("files/\(projectDirectory)/\(epoch)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: filename).lastPathComponent
            .replacingOccurrences(of: ":", with: "_")
        let url = directory.appendingPathComponent("\(safeID)-\(safeName)")
        try bytes.write(to: url, options: .atomic)
        return url
    }
}

private struct MobileProjectGrant: Decodable {
    let id: String
    let status: String
    let keyEpoch: Int
    let wrappedProjectKey: String?
}

private struct MobileProjectBaseline: Decodable {
    let baselineId: String
    let projectId: String
    let sourceDeviceId: String
    let keyEpoch: Int
    let watermark: Int
    let chunkCount: Int
}

private struct MobileProjectChunk: Decodable {
    let baselineId: String
    let index: Int
    let envelope: CompanionEncryptedEnvelope
}

private struct MobileProjectEvent: Decodable {
    let eventId: String
    let projectId: String
    let keyEpoch: Int
    let kind: String
    let envelope: CompanionEncryptedEnvelope
    let sourceDeviceId: String
    let sequence: Int
}

struct MobileProjectCommand: Decodable {
    let commandId: String
    let status: String
    let resultRunId: String?
    let errorCode: String?
    let requestId: String?
    let runId: String?
    let type: String?
    let keyEpoch: Int?
    let actorUserId: String?
    let envelope: CompanionEncryptedEnvelope?
}

extension MobileProjectCommand: Identifiable {
    var id: String { commandId }
}

struct MobileSharedDraft: Identifiable {
    let id: String
    let title: String
    let provider: String?
}

@MainActor
struct MobileProjectSharingClient {
    let store: CompanionStore

    private var client: AccountClient {
        get throws {
            guard let value = AccountClient.configured() else { throw AccountClientError.notConfigured }
            return value
        }
    }

    private var session: MobileAccountSession {
        get throws {
            guard let value = store.accountSession else { throw AccountClientError.authenticationRequired }
            return value
        }
    }

    private func request<T: Decodable>(
        _ path: String, method: String = "GET", body: Data? = nil
    ) async throws -> T {
        let (value, refreshed): (T, MobileAccountSession) = try await client.projectRequest(
            path: path, method: method, body: body, accountSession: session
        )
        try store.persistRefreshedAccountSession(refreshed)
        return value
    }

    func listShares() async throws -> [MobileProjectShare] {
        struct Page: Decodable { let projectShares: [MobileProjectShare] }
        let userID = try session.user.id
        do {
            let page: Page = try await request("/v1/project-shares")
            let previous = (try? AccountKeychainStore.loadProjectShares(userID: userID)) ?? []
            for missing in previous where !page.projectShares.contains(where: { $0.projectId == missing.projectId }) {
                AccountKeychainStore.deleteProject(userID: userID, projectID: missing.projectId)
                MobileProjectSharingCache.clearProject(userID: userID, projectID: missing.projectId)
            }
            try AccountKeychainStore.saveProjectShares(page.projectShares, userID: userID)
            return page.projectShares
        } catch AccountClientError.networkUnavailable {
            if let cached = try AccountKeychainStore.loadProjectShares(userID: userID) {
                return cached
            }
            throw AccountClientError.networkUnavailable
        }
    }

    func accept(_ token: String) async throws {
        struct Accepted: Decodable { let projectId: String }
        let _: Accepted = try await request(
            "/v1/project-invitations/accept", method: "POST",
            body: try JSONEncoder().encode(["token": token.trimmingCharacters(in: .whitespacesAndNewlines)])
        )
    }

    func leave(_ share: MobileProjectShare) async throws {
        guard share.role == "member" else { throw AccountClientError.invalidResponse }
        let userID = try session.user.id
        let refreshed = try await client.projectDelete(
            path: "/v1/project-shares/\(share.projectId)/members/\(session.user.id)",
            accountSession: session
        )
        try store.persistRefreshedAccountSession(refreshed)
        AccountKeychainStore.deleteProject(userID: userID, projectID: share.projectId)
        MobileProjectSharingCache.clearProject(userID: userID, projectID: share.projectId)
    }

    func openKey(_ share: MobileProjectShare) async throws -> String {
        struct GrantResponse: Decodable { let grant: MobileProjectGrant }
        let response: GrantResponse
        do {
            response = try await request(
                "/v1/project-shares/\(share.projectId)/device-grant", method: "POST"
            )
        } catch AccountClientError.networkUnavailable {
            if let cached = try AccountKeychainStore.loadProjectKey(
                userID: session.user.id, projectID: share.projectId, epoch: share.keyEpoch
            ) { return cached }
            throw AccountClientError.networkUnavailable
        }
        let grant = response.grant
        guard grant.status == "active", grant.keyEpoch == share.keyEpoch,
              let wrapped = grant.wrappedProjectKey,
              let privateKey = try AccountKeychainStore.loadDevicePrivateKey() else {
            throw AccountClientError.service("正在等待项目所有者授权这台 iPhone。")
        }
        let projectKey = try AccountDeviceGrant.openProjectKey(
            wrapped, grantID: grant.id, projectID: share.projectId,
            deviceID: session.device.id, keyEpoch: share.keyEpoch, privateKeyData: privateKey
        )
        try AccountKeychainStore.saveProjectKey(
            projectKey, userID: session.user.id, projectID: share.projectId, epoch: share.keyEpoch
        )
        return projectKey
    }

    func read(_ share: MobileProjectShare, key: String) async throws -> MobileSharedSnapshot {
        do {
            let snapshot = try await readRemote(share, key: key)
            try? MobileProjectSharingCache.save(
                snapshot, key: key, userID: session.user.id,
                projectID: share.projectId, epoch: share.keyEpoch
            )
            return snapshot
        } catch AccountClientError.networkUnavailable {
            if let cached = try MobileProjectSharingCache.load(
                key: key, userID: session.user.id,
                projectID: share.projectId, epoch: share.keyEpoch
            ) { return cached }
            throw AccountClientError.networkUnavailable
        }
    }

    private func readRemote(_ share: MobileProjectShare, key: String) async throws -> MobileSharedSnapshot {
        struct BaselinePage: Decodable { let baselines: [MobileProjectBaseline] }
        struct ChunkPage: Decodable { let chunks: [MobileProjectChunk]; let nextIndex: Int }
        struct EventPage: Decodable { let events: [MobileProjectEvent]; let nextCursor: Int }
        struct PublisherPage: Decodable {
            struct Publisher: Decodable { let sourceDeviceId: String; let hostName: String }
            let publishers: [Publisher]
        }
        let path = "/v1/project-shares/\(share.projectId)"
        let page: BaselinePage = try await request("\(path)/baselines")
        guard !page.baselines.isEmpty else {
            throw AccountClientError.service("执行 Mac 尚未同步项目历史。")
        }
        var project: MobileSharedProject?
        var chats: [String: MobileSharedChat] = [:]
        var messages: [String: MobileSharedMessage] = [:]
        var artifacts: [String: MobileSharedAttachment] = [:]
        var watermarks: [String: Int] = [:]
        for baseline in page.baselines where baseline.keyEpoch == share.keyEpoch {
            guard baseline.projectId == share.projectId, baseline.chunkCount > 0 else {
                throw AccountClientError.invalidResponse
            }
            var bytes = Data()
            var next = -1
            for expected in 0..<baseline.chunkCount {
                if expected == 0 || expected > next {
                    let chunkPage: ChunkPage = try await request(
                        "\(path)/baselines/\(baseline.baselineId)/chunks?after=\(next)&limit=100"
                    )
                    guard !chunkPage.chunks.isEmpty else { throw AccountClientError.invalidResponse }
                    for chunk in chunkPage.chunks {
                        guard chunk.baselineId == baseline.baselineId, chunk.index == next + 1 else {
                            throw AccountClientError.invalidResponse
                        }
                        let aad = "fuddy:shared-project-baseline:v1:\(share.projectId):\(baseline.sourceDeviceId):\(share.keyEpoch):\(baseline.baselineId):\(chunk.index)"
                        bytes.append(try CompanionCrypto.openBytes(
                            envelope: chunk.envelope, key: key, associatedData: aad
                        ))
                        next = chunk.index
                    }
                }
            }
            guard next + 1 == baseline.chunkCount else { throw AccountClientError.invalidResponse }
            let snapshot = try JSONDecoder().decode(MobileSharedSnapshot.self, from: bytes)
            guard snapshot.version == 1, snapshot.project.id == share.projectId else {
                throw AccountClientError.invalidResponse
            }
            if project == nil || (snapshot.project.revision ?? 0) >= (project?.revision ?? 0) {
                project = snapshot.project
            }
            for chat in snapshot.chats where chat.projectId == share.projectId {
                if let previous = chats[chat.id], previous.updatedAt > chat.updatedAt { continue }
                chats[chat.id] = chat
            }
            for message in snapshot.messages { messages[message.id] = message }
            for artifact in snapshot.artifacts ?? [] { artifacts[artifact.id] = artifact }
            watermarks[baseline.sourceDeviceId] = baseline.watermark
        }
        var cursor = 0
        while true {
            let events: EventPage = try await request("\(path)/events?after=\(cursor)&limit=100")
            for event in events.events {
                guard event.projectId == share.projectId, event.keyEpoch == share.keyEpoch,
                      event.sequence > (watermarks[event.sourceDeviceId] ?? 0) else { continue }
                let aad = "fuddy:shared-project-event:v1:\(event.projectId):\(event.keyEpoch):\(event.eventId):\(event.kind)"
                switch event.kind {
                case "settings":
                    let updated = try CompanionCrypto.openJSON(
                        MobileSharedProject.self, envelope: event.envelope, key: key, associatedData: aad
                    )
                    guard updated.id == share.projectId else { throw AccountClientError.invalidResponse }
                    if project == nil || (updated.revision ?? 0) >= (project?.revision ?? 0) {
                        project = updated
                    }
                case "chat":
                    let updated = try CompanionCrypto.openJSON(
                        MobileSharedChat.self, envelope: event.envelope, key: key, associatedData: aad
                    )
                    guard updated.projectId == share.projectId else { throw AccountClientError.invalidResponse }
                    if let previous = chats[updated.id], previous.updatedAt > updated.updatedAt { continue }
                    chats[updated.id] = updated
                case "message":
                    let updated = try CompanionCrypto.openJSON(
                        MobileSharedMessage.self, envelope: event.envelope, key: key, associatedData: aad
                    )
                    messages[updated.id] = updated
                case "artifact":
                    let updated = try CompanionCrypto.openJSON(
                        MobileSharedAttachment.self, envelope: event.envelope, key: key, associatedData: aad
                    )
                    artifacts[updated.id] = updated
                default: throw AccountClientError.invalidResponse
                }
            }
            if events.events.count < 100 { break }
            guard events.nextCursor > cursor else { throw AccountClientError.invalidResponse }
            cursor = events.nextCursor
        }
        guard let project else { throw AccountClientError.invalidResponse }
        let publisherPage: PublisherPage = try await request("\(path)/publishers")
        return MobileSharedSnapshot(
            version: 1, project: project,
            chats: chats.values.sorted { $0.createdAt < $1.createdAt },
            messages: messages.values.filter { chats[$0.runId] != nil }
                .sorted { $0.createdAt < $1.createdAt },
            artifacts: artifacts.values.filter { chats[$0.runId] != nil },
            pendingSources: publisherPage.publishers
                .filter { watermarks[$0.sourceDeviceId] == nil }.map(\.hostName)
        )
    }

    func submit(
        _ share: MobileProjectShare, key: String, type: String,
        runID: String? = nil, requestID: String? = nil, title: String? = nil,
        prompt: String? = nil, provider: String? = nil
    ) async throws -> MobileProjectCommand {
        struct CommandBody: Encodable {
            let commandId: String
            let type: String
            let runId: String?
            let requestId: String?
            let keyEpoch: Int
            let envelope: CompanionEncryptedEnvelope
        }
        struct CommandResponse: Decodable { let command: MobileProjectCommand }
        var payload = ["type": type]
        if let title { payload["title"] = title }
        if let prompt { payload["prompt"] = prompt }
        if let provider { payload["provider"] = provider }
        let commandID = UUID().uuidString.lowercased()
        let current = try session
        let aad = ["fuddy:shared-project-command:v1", share.projectId, String(share.keyEpoch),
                   commandID, type, runID ?? "-", requestID ?? "-", current.user.id].joined(separator: ":")
        let body = CommandBody(
            commandId: commandID, type: type, runId: runID, requestId: requestID,
            keyEpoch: share.keyEpoch,
            envelope: try CompanionCrypto.sealJSON(payload, key: key, associatedData: aad)
        )
        let response: CommandResponse = try await request(
            "/v1/project-shares/\(share.projectId)/commands", method: "POST",
            body: try JSONEncoder().encode(body)
        )
        return response.command
    }

    func command(_ share: MobileProjectShare, id: String) async throws -> MobileProjectCommand {
        struct CommandResponse: Decodable { let command: MobileProjectCommand }
        let response: CommandResponse = try await request(
            "/v1/project-shares/\(share.projectId)/commands/\(id)"
        )
        return response.command
    }

    func download(_ share: MobileProjectShare, key: String,
                  attachment: MobileSharedAttachment) async throws -> URL {
        guard attachment.id.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil,
              attachment.size > 0, attachment.size <= 20 * 1024 * 1024 - 32 else {
            throw AccountClientError.invalidResponse
        }
        let userID = try session.user.id
        if let cached = MobileProjectSharingCache.verifiedFile(
            filename: attachment.filename, attachmentID: attachment.id,
            userID: userID, projectID: share.projectId, epoch: share.keyEpoch,
            size: attachment.size, sha256: attachment.sha256
        ) { return cached }
        let (ciphertext, response, refreshed) = try await client.projectDownload(
            path: "/v1/project-shares/\(share.projectId)/attachments/\(attachment.id)",
            accountSession: session
        )
        try store.persistRefreshedAccountSession(refreshed)
        let cipherHash = Data(SHA256.hash(data: ciphertext))
            .map { String(format: "%02x", $0) }.joined()
        guard response.value(forHTTPHeaderField: "X-Content-SHA256") == cipherHash,
              response.value(forHTTPHeaderField: "X-Project-Run-Id") == attachment.runId,
              response.value(forHTTPHeaderField: "X-Project-Attachment-Kind") == attachment.kind,
              response.value(forHTTPHeaderField: "X-Project-Key-Epoch") == String(share.keyEpoch) else {
            throw AccountClientError.invalidResponse
        }
        let associatedData = "fuddy:shared-project-attachment:v1:\(share.projectId):\(share.keyEpoch):\(attachment.id)"
        let bytes = try CompanionCrypto.openAttachment(
            ciphertext, key: key, associatedData: associatedData
        )
        let sha256 = Data(SHA256.hash(data: bytes))
            .map { String(format: "%02x", $0) }.joined()
        guard bytes.count == attachment.size, sha256 == attachment.sha256 else {
            throw AccountClientError.invalidResponse
        }
        return try MobileProjectSharingCache.saveVerifiedFile(
            bytes, filename: attachment.filename, attachmentID: attachment.id,
            userID: session.user.id, projectID: share.projectId, epoch: share.keyEpoch
        )
    }

    func ownCommands(_ share: MobileProjectShare) async throws -> [MobileProjectCommand] {
        struct Commands: Decodable { let commands: [MobileProjectCommand] }
        let page: Commands = try await request(
            "/v1/project-shares/\(share.projectId)/commands?mine=1"
        )
        return page.commands
    }

    func ownDrafts(_ share: MobileProjectShare, key: String) async throws -> [MobileSharedDraft] {
        var drafts: [MobileSharedDraft] = []
        for command in try await ownCommands(share) where command.type == "create-chat"
            && command.status == "completed" {
            guard let runID = command.resultRunId else { continue }
            var title = "新 Chat"
            var provider: String?
            if let envelope = command.envelope, let actor = command.actorUserId,
               command.keyEpoch == share.keyEpoch {
                let aad = ["fuddy:shared-project-command:v1", share.projectId,
                           String(share.keyEpoch), command.commandId, "create-chat", "-", "-", actor]
                    .joined(separator: ":")
                if let payload = try? CompanionCrypto.openJSON(
                    [String: String].self, envelope: envelope, key: key, associatedData: aad
                ) {
                    title = payload["title"] ?? title
                    provider = payload["provider"]
                }
            }
            drafts.append(MobileSharedDraft(id: runID, title: title, provider: provider))
        }
        return drafts
    }
}

struct SharedProjectsView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var shares: [MobileProjectShare] = []
    @State private var names: [String: String] = [:]
    @State private var invitation = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("邀请令牌", text: $invitation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("加入") { Task { await accept() } }
                        .disabled(busy || invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } footer: {
                Text("加入后可查看已发布的 Chat 和附件、新建 Chat 并发送消息。设备授权前不显示项目名称。")
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            Section("与我共享") {
                ForEach(shares.filter { $0.role == "member" }) { share in
                    NavigationLink {
                        SharedProjectDetailView(share: share)
                    } label: {
                        Label(names[share.projectId] ?? "共享项目", systemImage: "person.2")
                    }
                }
                if shares.allSatisfy({ $0.role != "member" }) {
                    ContentUnavailableView("还没有共享项目", systemImage: "person.2")
                }
            }
        }
        .refreshable { await refresh() }
        .onAppear { Task { await refresh() } }
        .task(id: store.accountSession?.user.id) {
            shares = []
            names = [:]
            await refresh()
        }
    }

    private func refresh() async {
        guard store.accountSession != nil else { return }
        do {
            let client = MobileProjectSharingClient(store: store)
            let updated = try await client.listShares()
            shares = updated
            error = nil
            for share in updated where share.role == "member" {
                guard let key = try? await client.openKey(share),
                      let snapshot = try? await client.read(share, key: key) else { continue }
                names[share.projectId] = snapshot.project.name
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func accept() async {
        busy = true
        defer { busy = false }
        do {
            try await MobileProjectSharingClient(store: store).accept(invitation)
            invitation = ""
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SharedProjectDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    let share: MobileProjectShare
    @State private var snapshot: MobileSharedSnapshot?
    @State private var drafts: [MobileSharedDraft] = []
    @State private var key: String?
    @State private var provider = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            if let snapshot {
                Section("项目设置") {
                    LabeledContent("名称", value: snapshot.project.name)
                    if !snapshot.project.summary.isEmpty {
                        Text(snapshot.project.summary).foregroundStyle(.secondary)
                    }
                    LabeledContent("阶段", value: snapshot.project.stage)
                    LabeledContent("类型", value: snapshot.project.productType)
                    LabeledContent("状态", value: snapshot.project.status == "active" ? "进行中"
                        : snapshot.project.status == "paused" ? "已暂停" : "观察中")
                }
                if let sources = snapshot.pendingSources, !sources.isEmpty {
                    Text("部分历史尚未同步：\(sources.joined(separator: "、"))")
                        .font(.caption).foregroundStyle(.orange)
                }
                Section("Chats") {
                    ForEach(drafts) { draft in
                        NavigationLink {
                            SharedProjectChatView(share: share, chat: MobileSharedChat(
                                id: draft.id, projectId: share.projectId, title: draft.title,
                                status: "draft", provider: draft.provider ?? "agent", executionHostId: share.executionHostId,
                                createdByUserId: store.accountSession?.user.id,
                                createdBySnapshot: MobileSharedAuthor(
                                    displayName: store.accountSession?.user.displayName ?? "你", avatarRef: nil
                                ), createdAt: "", updatedAt: "", archivedAt: nil
                            ), key: key ?? "")
                        } label: {
                            Label(draft.title, systemImage: "square.and.pencil")
                        }
                    }
                    ForEach(snapshot.chats.filter { $0.archivedAt == nil }) { chat in
                        NavigationLink {
                            SharedProjectChatView(share: share, chat: chat, key: key ?? "")
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(chat.title)
                                Text(chat.createdBySnapshot?.displayName ?? "历史用户")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(key == nil)
                    }
                    if snapshot.chats.isEmpty { Text("还没有 Chat").foregroundStyle(.secondary) }
                }
                Section("新建 Chat") {
                    Picker("执行 Agent", selection: $provider) {
                        Text("项目默认 Agent").tag("")
                        ForEach(companionAgentProviderIDs, id: \.self) { id in
                            Text(companionAgentProviderLabel(id)).tag(id)
                        }
                    }
                    Button("新建") { Task { await createChat() } }
                        .disabled(busy || key == nil)
                }
            } else {
                ProgressView("读取共享项目…")
            }
            Section {
                Button("退出共享项目", role: .destructive) { Task { await leave() } }
                    .disabled(busy)
            }
        }
        .navigationTitle(snapshot?.project.name ?? "共享项目")
        .refreshable { await refresh() }
        .task(id: store.accountSession?.user.id) {
            key = nil
            snapshot = nil
            await refresh()
        }
    }

    private func refresh() async {
        guard store.accountSession != nil else { return }
        do {
            let client = MobileProjectSharingClient(store: store)
            let opened = try await client.openKey(share)
            let value = try await client.read(share, key: opened)
            key = opened
            snapshot = value
            drafts = ((try? await client.ownDrafts(share, key: opened)) ?? [])
                .filter { draft in !value.chats.contains(where: { $0.id == draft.id }) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func createChat() async {
        guard let key else { return }
        busy = true
        defer { busy = false }
        do {
            let client = MobileProjectSharingClient(store: store)
            let command = try await client.submit(share, key: key, type: "create-chat",
                                                  title: "新建 Chat", provider: provider.isEmpty ? nil : provider)
            provider = ""
            for _ in 0..<20 {
                let current = try await client.command(share, id: command.commandId)
                if current.status == "completed" {
                    await refresh()
                    return
                }
                if ["failed", "cancelled", "interrupted"].contains(current.status) {
                    throw AccountClientError.service("新建 Chat 未完成，请检查执行 Mac。")
                }
                try await Task.sleep(for: .milliseconds(500))
            }
            error = "Chat 正在创建，请下拉刷新。"
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func leave() async {
        busy = true
        defer { busy = false }
        do {
            try await MobileProjectSharingClient(store: store).leave(share)
            key = nil
            snapshot = nil
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SharedProjectChatView: View {
    @EnvironmentObject private var store: CompanionStore
    let share: MobileProjectShare
    let chat: MobileSharedChat
    let key: String
    @State private var messages: [MobileSharedMessage] = []
    @State private var artifacts: [MobileSharedAttachment] = []
    @State private var prompt = ""
    @State private var activeCommand: MobileProjectCommand?
    @State private var error: String?
    @State private var busy = false
    @State private var previewItem: PreviewItem?
    @State private var didInitialScroll = false

    var body: some View {
        VStack(spacing: 0) {
            if let error {
                Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(messages) { message in
                            HStack(alignment: .top, spacing: 10) {
                                Text(String((message.authorSnapshot?.displayName ?? (message.role == "assistant" ? "Agent" : "历史用户")).prefix(1)))
                                    .font(.caption.weight(.bold))
                                    .frame(width: 30, height: 30)
                                    .background(Color.accentColor.opacity(0.14), in: Circle())
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(message.authorSnapshot?.displayName ?? (message.role == "assistant" ? "Agent" : "历史用户"))
                                        .font(.caption.weight(.semibold))
                                    Text(message.content).textSelection(.enabled)
                                    ForEach(message.attachments ?? []) { attachment in
                                        Button(attachment.filename) { Task { await open(attachment) } }
                                            .font(.caption)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .id(message.id)
                            .accessibilityElement(children: .combine)
                        }
                        ForEach(artifacts.filter { $0.kind == "artifact" }) { artifact in
                            Button("打开产物：\(artifact.filename)") { Task { await open(artifact) } }
                                .font(.caption)
                        }
                    }
                    .padding()
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.last?.id) { _, latestID in
                    guard !didInitialScroll, let latestID else { return }
                    didInitialScroll = true
                    proxy.scrollTo(latestID, anchor: .bottom)
                }
            }
            if let command = activeCommand {
                HStack {
                    Text(command.status == "pending" ? "等待执行 Mac 接收" : "正在运行")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("停止") { Task { await stop(command) } }
                }
                .padding(.horizontal)
            }
            HStack(alignment: .bottom) {
                TextField("发送消息", text: $prompt, axis: .vertical)
                    .lineLimit(1...5)
                Button("发送") { Task { await send() } }
                    .disabled(busy || chat.archivedAt != nil || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding()
        }
        .navigationTitle(chat.title)
        .sheet(item: $previewItem) { QuickLookPreview(url: $0.url) }
        .refreshable { await refresh() }
        .task(id: store.accountSession?.user.id) {
            messages = []
            artifacts = []
            activeCommand = nil
            didInitialScroll = false
            await refresh()
        }
        .task(id: activeCommand?.commandId) {
            await pollActiveCommand()
        }
        .task(id: chat.id) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled { return }
                await refresh()
            }
        }
    }

    private func refresh() async {
        guard store.accountSession != nil else { return }
        do {
            let client = MobileProjectSharingClient(store: store)
            let current = try await client.read(share, key: key)
            messages = current.messages.filter { $0.runId == chat.id }
            artifacts = (current.artifacts ?? []).filter { $0.runId == chat.id }
            let own = try await client.ownCommands(share)
            activeCommand = own.first {
                $0.runId == chat.id && $0.requestId != nil
                    && ["pending", "claimed"].contains($0.status)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func open(_ attachment: MobileSharedAttachment) async {
        do {
            let url = try await MobileProjectSharingClient(store: store).download(
                share, key: key, attachment: attachment
            )
            previewItem = PreviewItem(url: url)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send() async {
        busy = true
        defer { busy = false }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let command = try await MobileProjectSharingClient(store: store).submit(
                share, key: key, type: "send-message", runID: chat.id,
                requestID: UUID().uuidString.lowercased(), prompt: text
            )
            prompt = ""
            activeCommand = command
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func stop(_ command: MobileProjectCommand) async {
        guard let requestID = command.requestId else { return }
        do {
            _ = try await MobileProjectSharingClient(store: store).submit(
                share, key: key, type: "stop-turn", runID: chat.id, requestID: requestID
            )
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func pollActiveCommand() async {
        guard let id = activeCommand?.commandId else { return }
        let client = MobileProjectSharingClient(store: store)
        while !Task.isCancelled {
            do {
                let current = try await client.command(share, id: id)
                guard activeCommand?.commandId == id else { return }
                if ["completed", "failed", "cancelled", "interrupted"].contains(current.status) {
                    activeCommand = nil
                    if current.status != "completed" {
                        error = "消息未完成，请检查执行 Mac 后重试。"
                    }
                    await refresh()
                    return
                }
                activeCommand = current
                try await Task.sleep(for: .seconds(3))
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
    }
}
