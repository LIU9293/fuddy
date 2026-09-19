import CryptoKit
import Foundation
import XCTest
@testable import ProjectAgentCompanion

private final class AttachmentURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class AttachmentTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    private var credentials: CompanionCredentials {
        CompanionCredentials(relayURL: "https://relay.example.test", accountID: "test-account", deviceID: "phone", deviceToken: "test-token", encryptionKey: key, encryptionKeyId: "test-key")
    }
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AttachmentURLProtocol.self]
        return URLSession(configuration: config)
    }
    private func descriptor(_ data: Data) -> AttachmentDescriptor {
        AttachmentDescriptor(id: "test-image", messageId: "message", artifactId: "artifact", filename: "image.png", mimeType: "image/png",
            size: data.count, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), width: nil, height: nil, thumbnailAttachmentId: nil, createdAt: "2026-09-18T00:00:00Z")
    }

    func testOutboxSurvivesRestartAndReusesOnlyUnacknowledgedCommands() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = AgentMessageOutbox(directory: directory)
        let file = PendingAttachment(id: "input", name: "photo.jpg", mimeType: "image/jpeg", data: Data("photo bytes".utf8))
        let first = try outbox.prepare(runID: "run", prompt: "看图", attachments: [file])
        let reopened = AgentMessageOutbox(directory: directory)
        var retry = try reopened.prepare(runID: "run", prompt: "看图", attachments: [file])
        XCTAssertEqual(first.id, retry.id)
        XCTAssertEqual(first.createdAt, retry.createdAt)
        XCTAssertEqual(retry.attachments, [file])
        retry.uploaded = [descriptor(file.data)]
        try reopened.save(retry)
        XCTAssertEqual(try outbox.list().first?.uploaded, retry.uploaded)
        try outbox.remove(retry)
        let next = try outbox.prepare(runID: "run", prompt: "看图", attachments: [file])
        XCTAssertNotEqual(next.id, first.id)
    }

    @MainActor
    func testUploadRetryAcceptsVerifiedExistingPlaintextDespiteDifferentEncryptionNonce() async throws {
        let bytes = Data("image data".utf8)
        let sealed = try CompanionCrypto.sealAttachment(bytes, key: key, associatedData: CompanionCrypto.attachmentAssociatedData(accountId: "test-account", attachmentId: "test-image"))
        var methods: [String] = []
        AttachmentURLProtocol.handler = { request in
            methods.append(request.httpMethod ?? "GET")
            return request.httpMethod == "PUT" ? (409, Data()) : (200, sealed)
        }
        defer { AttachmentURLProtocol.handler = nil }
        let result = try await RelayClient(credentials: credentials, session: session()).uploadAttachment(
            PendingAttachment(id: "test-image", name: "image.png", mimeType: "image/png", data: bytes))
        XCTAssertEqual(result.sha256, descriptor(bytes).sha256)
        XCTAssertEqual(methods, ["PUT", "GET"])
    }

    @MainActor
    func testDownloadVerifiesBytesAndReusesVerifiedCacheAfterClientRestartOffline() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory); AttachmentURLProtocol.handler = nil }
        let bytes = Data("image data".utf8), file = descriptor(Data("image data".utf8))
        let sealed = try CompanionCrypto.sealAttachment(bytes, key: key, associatedData: CompanionCrypto.attachmentAssociatedData(accountId: "test-account", attachmentId: file.id))
        AttachmentURLProtocol.handler = { _ in (200, sealed) }
        let first = RelayClient(credentials: credentials, session: session(), attachmentCacheDirectory: directory)
        let url = try await first.downloadAttachment(file)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        AttachmentURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let reopened = RelayClient(credentials: credentials, session: session(), attachmentCacheDirectory: directory)
        let cached = try await reopened.downloadAttachment(file)
        XCTAssertEqual(cached, url)
        try Data("corrupted".utf8).write(to: url)
        do { _ = try await reopened.downloadAttachment(file); XCTFail("Corrupt cache must not open") } catch {}
    }

    @MainActor
    func testWrongHashNeverProducesAPreviewFile() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory); AttachmentURLProtocol.handler = nil }
        let sealed = try CompanionCrypto.sealAttachment(Data("wrong".utf8), key: key,
            associatedData: CompanionCrypto.attachmentAssociatedData(accountId: "test-account", attachmentId: "test-image"))
        AttachmentURLProtocol.handler = { _ in (200, sealed) }
        do {
            _ = try await RelayClient(credentials: credentials, session: session(), attachmentCacheDirectory: directory).downloadAttachment(descriptor(Data("right".utf8)))
            XCTFail("Hash mismatch must fail")
        } catch RelayError.integrity {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testAgentMessageKeepsAttachmentsThroughCacheEncodingAndAcceptsLegacyMessages() throws {
        var message = AgentMessage(id: "m", runId: "r", role: "user", content: "看图", eventType: nil, toolName: nil, createdAt: "2026-09-18T00:00:00Z")
        let legacy = try JSONDecoder().decode(AgentMessage.self, from: JSONEncoder().encode(message))
        XCTAssertNil(legacy.attachments)
        message.attachments = [descriptor(Data("image data".utf8))]
        let restored = try JSONDecoder().decode(AgentMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(restored.attachments, message.attachments)
    }
}
