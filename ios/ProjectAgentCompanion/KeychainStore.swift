import Foundation
import Security

enum KeychainStore {
    private static let service = "dev.ainative.projectagent.companion"
    private static let legacyAccount = "relay-credentials"

    private static func account(syncSpaceID: String?) -> String {
        guard let syncSpaceID else { return legacyAccount }
        return "relay-credentials:\(syncSpaceID)"
    }

    static func save(_ credentials: CompanionCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let account = account(syncSpaceID: credentials.syncSpaceID)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        if credentials.syncSpaceID != nil {
            delete(account: legacyAccount)
        }
    }

    static func load(syncSpaceID: String? = nil) throws -> CompanionCredentials? {
        let account = account(syncSpaceID: syncSpaceID)
        if let credentials = try load(account: account) { return credentials }
        guard let syncSpaceID,
            let legacy = try load(account: legacyAccount),
            legacy.syncSpaceID == syncSpaceID
        else { return nil }
        try save(legacy)
        return legacy
    }

    private static func load(account: String) throws -> CompanionCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError.status(status) }
        return try JSONDecoder().decode(CompanionCredentials.self, from: data)
    }

    static func delete(syncSpaceID: String? = nil) {
        delete(account: account(syncSpaceID: syncSpaceID))
    }

    static func deleteAll() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ] as CFDictionary)
    }

    private static func delete(account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}

enum AccountKeychainStore {
    private static let service = "dev.ainative.projectagent.companion.account"
    private static let sessionAccount = "account-session"
    private static let deviceKeyAccount = "account-device-private-key"

    static func saveSession(_ session: MobileAccountSession) throws {
        try save(JSONEncoder().encode(session), account: sessionAccount)
    }

    static func loadSession() throws -> MobileAccountSession? {
        guard let data = try load(account: sessionAccount) else { return nil }
        return try JSONDecoder().decode(MobileAccountSession.self, from: data)
    }

    static func deleteSession() {
        delete(account: sessionAccount)
    }

    static func loadDevicePrivateKey() throws -> Data? {
        try load(account: deviceKeyAccount)
    }

    static func saveDevicePrivateKey(_ data: Data) throws {
        try save(data, account: deviceKeyAccount)
    }

    private static func save(_ data: Data, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    private static func load(account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError.status(status) }
        return data
    }

    private static func delete(account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}

enum KeychainError: LocalizedError {
    case status(OSStatus)
    var errorDescription: String? {
        switch self { case .status(let value): "Keychain error: \(value)" }
    }
}
