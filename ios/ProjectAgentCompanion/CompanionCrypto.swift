import CryptoKit
import Foundation

struct CompanionEncryptedEnvelope: Codable, Equatable {
    let algorithm: String
    let keyId: String
    let nonce: String
    let ciphertext: String
}

enum CompanionCrypto {
    private static let attachmentMagic = Data([0x50, 0x41, 0x45, 0x32])

    static func eventAssociatedData(
        eventId: String,
        protocolVersion: Int,
        type: CompanionEventType,
        entityType: String,
        entityId: String,
        revision: Int64,
        occurredAt: String
    ) -> String {
        [
            "project-agent:event", eventId, String(protocolVersion), type.rawValue,
            entityType, entityId, String(revision), occurredAt
        ].joined(separator: ":")
    }

    static func commandAssociatedData(
        commandId: String,
        protocolVersion: Int,
        type: CompanionCommandType,
        createdAt: String
    ) -> String {
        ["project-agent:command", commandId, String(protocolVersion), type.rawValue, createdAt]
            .joined(separator: ":")
    }

    static func attachmentAssociatedData(accountId: String, attachmentId: String) -> String {
        ["project-agent:attachment", accountId, attachmentId].joined(separator: ":")
    }

    static func sealJSON<T: Encodable>(_ value: T, key encodedKey: String, associatedData: String) throws -> CompanionEncryptedEnvelope {
        let plaintext = try JSONEncoder().encode(value)
        let key = try symmetricKey(encodedKey)
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: Data(associatedData.utf8))
        return CompanionEncryptedEnvelope(
            algorithm: "A256GCM",
            keyId: try keyIdentifier(encodedKey),
            nonce: Data(sealed.nonce).base64URLEncodedString(),
            ciphertext: (sealed.ciphertext + sealed.tag).base64URLEncodedString()
        )
    }

    static func openJSON<T: Decodable>(
        _ type: T.Type,
        envelope: CompanionEncryptedEnvelope,
        key encodedKey: String,
        associatedData: String
    ) throws -> T {
        try JSONDecoder().decode(type, from: open(envelope: envelope, key: encodedKey, associatedData: associatedData))
    }

    static func sealAttachment(_ plaintext: Data, key encodedKey: String, associatedData: String) throws -> Data {
        let sealed = try AES.GCM.seal(
            plaintext,
            using: symmetricKey(encodedKey),
            authenticating: Data(associatedData.utf8)
        )
        return attachmentMagic + Data(sealed.nonce) + sealed.ciphertext + sealed.tag
    }

    static func openAttachment(_ envelope: Data, key encodedKey: String, associatedData: String) throws -> Data {
        guard envelope.count >= attachmentMagic.count + 12 + 16,
              envelope.prefix(attachmentMagic.count) == attachmentMagic else {
            throw RelayError.integrity("附件加密信封无效。")
        }
        let body = envelope.dropFirst(attachmentMagic.count)
        let nonce = body.prefix(12)
        let ciphertextAndTag = body.dropFirst(12)
        guard ciphertextAndTag.count >= 16 else { throw RelayError.integrity("附件加密信封无效。") }
        let sealedBox = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertextAndTag.dropLast(16),
            tag: ciphertextAndTag.suffix(16)
        )
        return try AES.GCM.open(
            sealedBox,
            using: symmetricKey(encodedKey),
            authenticating: Data(associatedData.utf8)
        )
    }

    private static func open(envelope: CompanionEncryptedEnvelope, key encodedKey: String, associatedData: String) throws -> Data {
        guard envelope.algorithm == "A256GCM",
              envelope.keyId == (try keyIdentifier(encodedKey)),
              let nonce = Data(base64URLEncoded: envelope.nonce), nonce.count == 12,
              let ciphertextAndTag = Data(base64URLEncoded: envelope.ciphertext), ciphertextAndTag.count >= 16 else {
            throw RelayError.integrity("Companion 加密信封无效或密钥不匹配。")
        }
        let sealedBox = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertextAndTag.dropLast(16),
            tag: ciphertextAndTag.suffix(16)
        )
        return try AES.GCM.open(
            sealedBox,
            using: symmetricKey(encodedKey),
            authenticating: Data(associatedData.utf8)
        )
    }

    private static func symmetricKey(_ encoded: String) throws -> SymmetricKey {
        guard let bytes = Data(base64URLEncoded: encoded), bytes.count == 32 else {
            throw RelayError.integrity("同步密钥无效，请退出 Fuddy 后重新登录。")
        }
        return SymmetricKey(data: bytes)
    }

    private static func keyIdentifier(_ encoded: String) throws -> String {
        guard let bytes = Data(base64URLEncoded: encoded), bytes.count == 32 else {
            throw RelayError.integrity("同步密钥无效，请退出 Fuddy 后重新登录。")
        }
        return Data(SHA256.hash(data: bytes)).base64URLEncodedString().prefix(16).description
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        self.init(base64Encoded: normalized)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
