import Foundation
import CryptoKit

extension PendingAttachment {
    func descriptor(messageID: String, createdAt: String) -> AttachmentDescriptor {
        AttachmentDescriptor(id: id, messageId: messageID, artifactId: nil, filename: name, mimeType: mimeType,
            size: data.count, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            width: nil, height: nil, thumbnailAttachmentId: nil, createdAt: createdAt)
    }
}

struct OutgoingAgentMessage: Codable, Identifiable {
    let id: String
    let runID: String
    let prompt: String
    let attachments: [PendingAttachment]
    var uploaded: [AttachmentDescriptor]
    let createdAt: String
}

/// Files contain user messages/attachments, never account credentials. Each Sync Space owns a directory.
struct AgentMessageOutbox {
    let directory: URL

    func list() throws -> [OutgoingAgentMessage] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { try JSONDecoder().decode(OutgoingAgentMessage.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func prepare(runID: String, prompt: String, attachments: [PendingAttachment]) throws -> OutgoingAgentMessage {
        guard attachments.count <= 4, attachments.allSatisfy({ !$0.data.isEmpty && $0.data.count <= 20 * 1024 * 1024 - 32 }) else {
            throw RelayError.server("每条消息最多 4 个附件，单个附件不能为空或超过 20 MiB。")
        }
        if let existing = try list().first(where: { $0.runID == runID && $0.prompt == prompt && $0.attachments == attachments }) { return existing }
        let message = OutgoingAgentMessage(id: UUID().uuidString, runID: runID, prompt: prompt, attachments: attachments,
            uploaded: [], createdAt: ISO8601DateFormatter().string(from: Date()))
        try save(message)
        return message
    }

    func save(_ message: OutgoingAgentMessage) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(message).write(to: directory.appendingPathComponent(message.id + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func remove(_ message: OutgoingAgentMessage) throws {
        let file = directory.appendingPathComponent(message.id + ".json")
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}
