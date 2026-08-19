import CryptoKit
import Foundation

let companionFallbackSyncIntervalSeconds: TimeInterval = 60
let companionConnectedFallbackSyncIntervalSeconds: TimeInterval = 5 * 60
let companionSocketHeartbeatIntervalSeconds: TimeInterval = 20

func companionFallbackSyncIntervalSeconds(realtimeConnected: Bool) -> TimeInterval {
    realtimeConnected ? companionConnectedFallbackSyncIntervalSeconds : companionFallbackSyncIntervalSeconds
}

func companionReconnectDelaySeconds(forAttempt attempt: Int) -> TimeInterval {
    [5, 15, 60][min(max(0, attempt), 2)]
}

func companionSocketHeartbeatShouldReconnect(awaitingPong: Bool) -> Bool {
    awaitingPong
}

func companionRelayURLComponents(baseURL: String, path: String) -> URLComponents? {
    guard var components = URLComponents(string: baseURL),
          components.host != nil,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil else { return nil }
    let basePath = components.path == "/" ? "" : components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let requestPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    components.path = "/" + [basePath, requestPath].filter { !$0.isEmpty }.joined(separator: "/")
    return components
}

@MainActor
final class RelayClient {
    private let credentials: CompanionCredentials
    private lazy var session = URLSession(configuration: .default)
    private var socket: URLSessionWebSocketTask?
    private var onPush: ((SocketEnvelope) -> Void)?
    private var reconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var awaitingPong = false
    private(set) var realtimeConnected = false

    init(credentials: CompanionCredentials) { self.credentials = credentials }

    func events(after: Int) async throws -> SyncEventPage {
        var components = authenticatedComponents(path: "/v1/events")
        components.queryItems?.append(URLQueryItem(name: "after", value: String(after)))
        let (data, response) = try await session.data(for: authorizedRequest(url: components.url!))
        try Self.validate(response: response, data: data)
        let encrypted = try JSONDecoder().decode(EncryptedSyncEventPage.self, from: data)
        let key = try encryptionKey()
        let events = try encrypted.events.map { event in
            let associatedData = CompanionCrypto.eventAssociatedData(
                eventId: event.eventId,
                protocolVersion: event.protocolVersion,
                type: event.type,
                entityType: event.entityType,
                entityId: event.entityId,
                revision: event.revision,
                occurredAt: event.occurredAt
            )
            return SyncEvent(
                eventId: event.eventId,
                sequence: event.sequence,
                protocolVersion: event.protocolVersion,
                type: event.type,
                entityType: event.entityType,
                entityId: event.entityId,
                revision: event.revision,
                payload: try CompanionCrypto.openJSON(
                    JSONValue.self,
                    envelope: event.payload,
                    key: key,
                    associatedData: associatedData
                ),
                sourceDeviceId: event.sourceDeviceId,
                occurredAt: event.occurredAt
            )
        }
        return SyncEventPage(
            minimumProtocolVersion: encrypted.minimumProtocolVersion,
            protocolVersion: encrypted.protocolVersion,
            events: events,
            lastSequence: encrypted.lastSequence,
            presence: encrypted.presence
        )
    }

    func sendCommand<Payload: Codable>(
        commandID: String = UUID().uuidString,
        type: CompanionCommandType,
        payload: Payload
    ) async throws -> CommandResult {
        let createdAt = ISO8601DateFormatter().string(from: Date())
        let key = try encryptionKey()
        let encryptedPayload = try CompanionCrypto.sealJSON(
            payload,
            key: key,
            associatedData: CompanionCrypto.commandAssociatedData(
                commandId: commandID,
                protocolVersion: companionProtocolVersion,
                type: type,
                createdAt: createdAt
            )
        )
        let command = EncryptedCommandInput(
            commandId: commandID,
            protocolVersion: companionProtocolVersion,
            type: type,
            payload: encryptedPayload,
            createdAt: createdAt
        )
        var request = authorizedRequest(url: authenticatedComponents(path: "/v1/commands").url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(command)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
        let encrypted = try JSONDecoder().decode(EncryptedCommandResult.self, from: data)
        return CommandResult(
            commandId: encrypted.commandId,
            type: encrypted.type,
            status: encrypted.status,
            result: nil,
            error: nil
        )
    }

    func registerPushToken(_ token: String) async throws {
        var request = authorizedRequest(url: authenticatedComponents(path: "/v1/devices/push-token").url!)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(PushTokenRegistration(token: token))
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func revokeSelf() async throws {
        var request = authorizedRequest(url: authenticatedComponents(path: "/v1/devices/self").url!)
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func uploadAttachment(_ attachment: PendingAttachment) async throws -> AttachmentDescriptor {
        let digest = SHA256.hash(data: attachment.data).map { String(format: "%02x", $0) }.joined()
        let sealed = try CompanionCrypto.sealAttachment(
            attachment.data,
            key: encryptionKey(),
            associatedData: CompanionCrypto.attachmentAssociatedData(
                accountId: credentials.accountID,
                attachmentId: attachment.id
            )
        )
        let encryptedDigest = SHA256.hash(data: sealed).map { String(format: "%02x", $0) }.joined()
        var request = authorizedRequest(url: authenticatedComponents(path: "/v1/attachments/\(attachment.id)").url!)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(String(sealed.count), forHTTPHeaderField: "Content-Length")
        request.setValue(encryptedDigest, forHTTPHeaderField: "X-Content-SHA256")
        request.setValue("A256GCM", forHTTPHeaderField: "X-Companion-Encryption")
        let (data, response) = try await session.upload(for: request, from: sealed)
        try Self.validate(response: response, data: data)
        return AttachmentDescriptor(
            id: attachment.id,
            messageId: nil,
            artifactId: nil,
            filename: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.data.count,
            sha256: digest,
            width: nil,
            height: nil,
            thumbnailAttachmentId: nil,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    func downloadAttachment(_ attachment: AttachmentDescriptor) async throws -> URL {
        let url = authenticatedComponents(path: "/v1/attachments/\(attachment.id)").url!
        let (sealed, response) = try await session.data(for: authorizedRequest(url: url))
        try Self.validate(response: response, data: sealed)
        let plaintext = try CompanionCrypto.openAttachment(
            sealed,
            key: encryptionKey(),
            associatedData: CompanionCrypto.attachmentAssociatedData(
                accountId: credentials.accountID,
                attachmentId: attachment.id
            )
        )
        guard plaintext.count == attachment.size else {
            throw RelayError.integrity("附件大小不一致。")
        }
        let downloadedHash = SHA256.hash(data: plaintext).map { String(format: "%02x", $0) }.joined()
        guard downloadedHash.caseInsensitiveCompare(attachment.sha256) == .orderedSame else {
            throw RelayError.integrity("附件校验失败。")
        }
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CompanionAttachments", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeFilename = URL(fileURLWithPath: attachment.filename).lastPathComponent
        let destination = directory.appendingPathComponent("\(attachment.id)-\(safeFilename)")
        try? FileManager.default.removeItem(at: destination)
        try plaintext.write(to: destination, options: .atomic)
        return destination
    }

    func connect(onPush: @escaping (SocketEnvelope) -> Void) {
        self.onPush = onPush
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        openSocket()
    }

    private func openSocket() {
        guard socket == nil, onPush != nil else { return }
        var components = authenticatedComponents(path: "/v1/connect")
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        var request = authorizedRequest(url: components.url!)
        request.timeoutInterval = 30
        let task = session.webSocketTask(with: request)
        socket = task
        task.resume()
        startHeartbeat(on: task)
        receiveNext(on: task)
    }

    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        reconnectAttempt = 0
        awaitingPong = false
        realtimeConnected = false
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        onPush = nil
    }

    private func receiveNext(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    self.realtimeConnected = true
                    self.reconnectAttempt = 0
                    self.awaitingPong = false
                    if !self.isPong(message), let envelope = self.decodeEnvelope(message) {
                        self.onPush?(envelope)
                    }
                    self.receiveNext(on: task)
                case .failure:
                    self.handleSocketFailure(task)
                }
            }
        }
    }

    private func startHeartbeat(on task: URLSessionWebSocketTask) {
        heartbeatTask?.cancel()
        awaitingPong = false
        heartbeatTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(companionSocketHeartbeatIntervalSeconds)) }
                catch { return }
                guard let self, self.socket === task else { return }
                if companionSocketHeartbeatShouldReconnect(awaitingPong: self.awaitingPong) {
                    self.handleSocketFailure(task)
                    return
                }
                self.awaitingPong = true
                do { try await task.send(.string("ping")) }
                catch {
                    self.handleSocketFailure(task)
                    return
                }
            }
        }
    }

    private func handleSocketFailure(_ task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        awaitingPong = false
        realtimeConnected = false
        task.cancel(with: .goingAway, reason: nil)
        socket = nil
        scheduleReconnect()
    }

    private func isPong(_ message: URLSessionWebSocketTask.Message) -> Bool {
        if case .string(let value) = message { return value == "pong" }
        return false
    }

    private func decodeEnvelope(_ message: URLSessionWebSocketTask.Message) -> SocketEnvelope? {
        let data: Data
        switch message {
        case .string(let value): data = Data(value.utf8)
        case .data(let value): data = value
        @unknown default: return nil
        }
        return try? JSONDecoder().decode(SocketEnvelope.self, from: data)
    }

    private func encryptionKey() throws -> String {
        guard let key = credentials.encryptionKey, !key.isEmpty,
              let keyId = credentials.encryptionKeyId, !keyId.isEmpty else {
            throw RelayError.integrity("同步密钥不存在，请退出 Fuddy 后重新登录。")
        }
        return key
    }

    private func scheduleReconnect() {
        guard onPush != nil, reconnectTask == nil else { return }
        let delay = companionReconnectDelaySeconds(forAttempt: reconnectAttempt)
        reconnectAttempt += 1
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.onPush != nil else { return }
            self.reconnectTask = nil
            self.openSocket()
        }
    }

    private func authenticatedComponents(path: String) -> URLComponents {
        var components = companionRelayURLComponents(baseURL: credentials.relayURL, path: path)!
        components.queryItems = [
            URLQueryItem(name: "accountId", value: credentials.accountID),
            URLQueryItem(name: "deviceId", value: credentials.deviceID)
        ]
        return components
    }

    private func authorizedRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(credentials.deviceToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else { throw RelayError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let message = switch response.statusCode {
            case 401: "登录已过期，请重新登录。"
            case 403: "这台设备暂时无法访问同步内容。"
            case 404: "没有找到要同步的内容。"
            case 409: "同步状态已更新，请重试。"
            case 413: "文件太大，无法同步。"
            case 429: "操作太频繁，请稍后重试。"
            default: "同步暂时不可用，请稍后重试。"
            }
            throw RelayError.server(message)
        }
    }

    private static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            digest.update(data: chunk)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

private struct PushTokenRegistration: Codable { let token: String }
enum RelayError: LocalizedError {
    case protocolMismatch, invalidRelayURL, invalidResponse, integrity(String), server(String)
    var errorDescription: String? {
        switch self {
        case .protocolMismatch: "请更新 Mac 和 iPhone 上的 Fuddy 后重试。"
        case .invalidRelayURL: "暂时无法连接同步服务，请稍后重试。"
        case .invalidResponse: "连接没有完成，请重试。"
        case .integrity(let message): message
        case .server(let message): message
        }
    }
}
