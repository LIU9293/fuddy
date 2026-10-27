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

    static func loadAll() throws -> [CompanionCredentials] {
        try storedItems().map(\.credentials)
    }

    static func deleteIfMatching(_ credentials: CompanionCredentials) {
        let storedAccount = account(syncSpaceID: credentials.syncSpaceID)
        guard (try? load(account: storedAccount)) == credentials else { return }
        delete(account: storedAccount)
    }

    static func deleteAll() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ] as CFDictionary)
    }

    static func deleteAll(ownerUserID: String) {
        guard let items = try? storedItems() else { return }
        for item in items where item.credentials.ownerUserID == ownerUserID {
            delete(account: item.account)
        }
    }

    private static func storedItems() throws -> [(account: String, credentials: CompanionCredentials)] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        let items: [[String: Any]]
        if let matches = result as? [[String: Any]] {
            items = matches
        } else if let match = result as? [String: Any] {
            items = [match]
        } else {
            return []
        }
        return items.compactMap { item in
            guard let data = item[kSecValueData as String] as? Data,
                let account = item[kSecAttrAccount as String] as? String,
                let credentials = try? JSONDecoder().decode(CompanionCredentials.self, from: data)
            else { return nil }
            return (account, credentials)
        }
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
    private static let projectKeyIndexPrefix = "account-project-keys."
    private static func projectSharesAccount(userID: String) -> String { "project-shares.\(userID)" }

    static func saveProjectShares(_ shares: [MobileProjectShare], userID: String) throws {
        try save(JSONEncoder().encode(shares), account: projectSharesAccount(userID: userID))
    }

    static func loadProjectShares(userID: String) throws -> [MobileProjectShare]? {
        guard let data = try load(account: projectSharesAccount(userID: userID)) else { return nil }
        return try JSONDecoder().decode([MobileProjectShare].self, from: data)
    }

    private static func projectKeyAccount(userID: String, projectID: String, epoch: Int) -> String {
        "project-key.\(userID).\(projectID).\(epoch)"
    }

    static func saveProjectKey(_ key: String, userID: String, projectID: String, epoch: Int) throws {
        let account = projectKeyAccount(userID: userID, projectID: projectID, epoch: epoch)
        try save(Data(key.utf8), account: account)
        let indexKey = projectKeyIndexPrefix + userID
        var accounts = UserDefaults.standard.stringArray(forKey: indexKey) ?? []
        if !accounts.contains(account) { accounts.append(account) }
        UserDefaults.standard.set(accounts, forKey: indexKey)
    }

    static func loadProjectKey(userID: String, projectID: String, epoch: Int) throws -> String? {
        guard let data = try load(account: projectKeyAccount(
            userID: userID, projectID: projectID, epoch: epoch
        )) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteProjectKeys(userID: String) {
        let indexKey = projectKeyIndexPrefix + userID
        for account in UserDefaults.standard.stringArray(forKey: indexKey) ?? [] { delete(account: account) }
        UserDefaults.standard.removeObject(forKey: indexKey)
        delete(account: projectSharesAccount(userID: userID))
    }

    static func deleteProject(userID: String, projectID: String) {
        let indexKey = projectKeyIndexPrefix + userID
        let prefix = "project-key.\(userID).\(projectID)."
        let accounts = UserDefaults.standard.stringArray(forKey: indexKey) ?? []
        for account in accounts where account.hasPrefix(prefix) { delete(account: account) }
        UserDefaults.standard.set(accounts.filter { !$0.hasPrefix(prefix) }, forKey: indexKey)
        if let shares = try? loadProjectShares(userID: userID) {
            try? saveProjectShares(shares.filter { $0.projectId != projectID }, userID: userID)
        }
    }

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
