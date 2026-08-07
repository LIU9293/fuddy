import Foundation

final class RelayClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let credentials: CompanionCredentials
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private var socket: URLSessionWebSocketTask?
    private var onPush: (@Sendable () -> Void)?

    init(credentials: CompanionCredentials) { self.credentials = credentials }

    static func claim(pairing: PairingPayload, deviceName: String) async throws -> CompanionCredentials {
        guard pairing.protocolVersion == companionProtocolVersion else { throw RelayError.protocolMismatch }
        let deviceID = UUID().uuidString
        let url = URL(string: pairing.relayUrl + "/v1/pairings/claim")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "accountId": pairing.accountId,
            "pairingSecret": pairing.pairingSecret,
            "deviceId": deviceID,
            "deviceName": deviceName
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        let result = try JSONDecoder().decode(PairingClaimResult.self, from: data)
        return CompanionCredentials(
            relayURL: pairing.relayUrl,
            accountID: result.accountId,
            deviceID: result.device.id,
            deviceToken: result.deviceToken
        )
    }

    func events(after: Int) async throws -> SyncEventPage {
        var components = authenticatedComponents(path: "/v1/events")
        components.queryItems?.append(URLQueryItem(name: "after", value: String(after)))
        let (data, response) = try await session.data(for: authorizedRequest(url: components.url!))
        try Self.validate(response: response, data: data)
        return try JSONDecoder().decode(SyncEventPage.self, from: data)
    }

    func sendCommand<Payload: Codable>(type: String, payload: Payload) async throws -> CommandResult {
        let command = CommandInput(
            commandId: UUID().uuidString,
            protocolVersion: companionProtocolVersion,
            type: type,
            payload: payload,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
        var request = authorizedRequest(url: authenticatedComponents(path: "/v1/commands").url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(command)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
        return try JSONDecoder().decode(CommandResult.self, from: data)
    }

    func registerPushToken(_ token: String) async throws {
        var request = authorizedRequest(url: authenticatedComponents(path: "/v1/devices/push-token").url!)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(PushTokenRegistration(token: token))
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func downloadAttachment(id: String, filename: String) async throws -> URL {
        let url = authenticatedComponents(path: "/v1/attachments/\(id)").url!
        let (temporaryURL, response) = try await session.download(for: authorizedRequest(url: url))
        try Self.validate(response: response, data: Data())
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CompanionAttachments", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeFilename = URL(fileURLWithPath: filename).lastPathComponent
        let destination = directory.appendingPathComponent("\(id)-\(safeFilename)")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporaryURL, to: destination)
        return destination
    }

    func connect(onPush: @escaping @Sendable () -> Void) {
        self.onPush = onPush
        var components = authenticatedComponents(path: "/v1/connect")
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        var request = authorizedRequest(url: components.url!)
        request.timeoutInterval = 30
        socket = session.webSocketTask(with: request)
        socket?.resume()
        receiveNext()
    }

    func disconnect() {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        onPush = nil
    }

    private func receiveNext() {
        socket?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.onPush?()
                self.receiveNext()
            case .failure:
                self.socket = nil
                guard let onPush = self.onPush else { return }
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    guard self.onPush != nil else { return }
                    self.connect(onPush: onPush)
                }
            }
        }
    }

    private func authenticatedComponents(path: String) -> URLComponents {
        var components = URLComponents(string: credentials.relayURL + path)!
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
            let body = try? JSONDecoder().decode(RelayErrorBody.self, from: data)
            throw RelayError.server(body?.error ?? "Relay request failed (\(response.statusCode))")
        }
    }
}

private struct RelayErrorBody: Codable { let error: String }
private struct PushTokenRegistration: Codable { let token: String }
enum RelayError: LocalizedError {
    case protocolMismatch, invalidResponse, server(String)
    var errorDescription: String? {
        switch self {
        case .protocolMismatch: "Mac 与 iPhone 的协议版本不一致。"
        case .invalidResponse: "Relay 返回了无效响应。"
        case .server(let message): message
        }
    }
}
