import CryptoKit
import Foundation

private struct WrappedAccountDeviceGrant: Decodable {
    let version: Int
    let algorithm: String
    let senderPublicKey: String
    let salt: String
    let nonce: String
    let ciphertext: String
    let tag: String
}

enum AccountDeviceGrant {
    private static let algorithm = "P256-HKDF-SHA256-A256GCM"
    private static let p256SPKIPrefix = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
        0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
    ])

    static func subjectPublicKeyInfo(_ publicKey: P256.KeyAgreement.PublicKey) -> Data {
        p256SPKIPrefix + publicKey.x963Representation
    }

    static func open(
        _ wrappedGrant: String,
        enrollmentID: String,
        spaceID: String,
        deviceID: String,
        privateKeyData: Data
    ) throws -> CompanionCredentials {
        guard let envelopeData = wrappedGrant.data(using: .utf8) else {
            throw AccountClientError.invalidResponse
        }
        let envelope = try JSONDecoder().decode(WrappedAccountDeviceGrant.self, from: envelopeData)
        guard envelope.version == 1,
              envelope.algorithm == algorithm,
              let senderSPKI = Data(base64Encoded: envelope.senderPublicKey),
              senderSPKI.count == p256SPKIPrefix.count + 65,
              senderSPKI.prefix(p256SPKIPrefix.count) == p256SPKIPrefix,
              let salt = Data(base64Encoded: envelope.salt), salt.count == 32,
              let nonce = Data(base64Encoded: envelope.nonce), nonce.count == 12,
              let ciphertext = Data(base64Encoded: envelope.ciphertext),
              let tag = Data(base64Encoded: envelope.tag), tag.count == 16 else {
            throw AccountClientError.invalidResponse
        }
        let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKeyData)
        let senderKey = try P256.KeyAgreement.PublicKey(
            x963Representation: senderSPKI.dropFirst(p256SPKIPrefix.count)
        )
        let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: senderKey)
        let key = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: Data("fuddy-sync-space-grant-v1".utf8),
            outputByteCount: 32
        )
        let sealedBox = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertext,
            tag: tag
        )
        let associatedData = Data(
            "fuddy-enrollment:\(enrollmentID):\(spaceID):\(deviceID):v1".utf8
        )
        let plaintext = try AES.GCM.open(sealedBox, using: key, authenticating: associatedData)
        let credentials = try JSONDecoder().decode(CompanionCredentials.self, from: plaintext)
        let relayPath = relayURLPathForValidation(credentials.relayURL)
        guard credentials.deviceID == deviceID,
              let relayURL = URL(string: credentials.relayURL),
              relayURL.host != nil, relayURL.user == nil, relayURL.password == nil,
              relayURL.query == nil, relayURL.fragment == nil,
              relayPath == "" || relayPath == "/api/relay" else {
            throw AccountClientError.invalidResponse
        }
#if DEBUG
        let validRelayScheme = relayURL.scheme == "https"
            || (
                relayURL.scheme == "http"
                    && relayURL.host.map(["127.0.0.1", "localhost"].contains) == true
            )
#else
        let validRelayScheme = relayURL.scheme == "https"
#endif
        guard validRelayScheme else { throw AccountClientError.invalidResponse }
        return CompanionCredentials(
            relayURL: credentials.relayURL,
            accountID: credentials.accountID,
            deviceID: credentials.deviceID,
            deviceToken: credentials.deviceToken,
            encryptionKey: credentials.encryptionKey,
            encryptionKeyId: credentials.encryptionKeyId,
            syncSpaceID: spaceID
        )
    }

    private static func relayURLPathForValidation(_ value: String) -> String? {
        guard let url = URL(string: value) else { return nil }
        var path = url.path
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        return path == "/" ? "" : path
    }
}
