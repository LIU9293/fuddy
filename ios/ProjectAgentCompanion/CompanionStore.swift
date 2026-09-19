import Combine
import CryptoKit
import Foundation
import UIKit
@preconcurrency import UserNotifications

@MainActor
extension CompanionStore {
    private var accountSources: [(id: String, store: CompanionStore)] {
        guard !isPeerTransport else { return [(credentials?.syncSpaceID ?? "legacy", self)] }
        return [(credentials?.syncSpaceID ?? "legacy", self)] + peerStores.keys.sorted().compactMap { id in
            peerStores[id].map { (id, $0) }
        }
    }

    var accountProjects: [Project] {
        if isPeerTransport { return state.projects }
        return mergedAccountProjects(accountSources.map { ($0.id, $0.store.state.projects) })
    }

    var accountRuns: [RunDetail] {
        if isPeerTransport { return state.runs.sorted { $0.run.updatedAt > $1.run.updatedAt } }
        return accountSources.flatMap { source in
            source.store.state.runs.map { original in
                var detail = original
                detail.run.id = accountRunID(spaceID: source.id, runID: original.id)
                detail.run.projectId = source.store.state.projects.first { $0.id == original.run.projectId }
                    .map { accountProjectID($0, spaceID: source.id) }
                return detail
            }
        }.sorted { $0.run.updatedAt > $1.run.updatedAt }
    }

    func accountRunTarget(_ id: String) -> (store: CompanionStore, id: String)? {
        guard let route = parseAccountRunID(id),
              let source = accountSources.first(where: { $0.id == route.spaceID }) else { return nil }
        return (source.store, route.runID)
    }

    func notificationRunID(_ nativeID: String) -> String? {
        if parseAccountRunID(nativeID) != nil { return nativeID }
        let matches = accountSources.filter { $0.store.state.runs.contains { $0.id == nativeID } }
        guard matches.count == 1, let source = matches.first else { return nil }
        return accountRunID(spaceID: source.id, runID: nativeID)
    }

    func executionHosts(projectID: String?) -> [MobileExecutionHost] {
        availableAccountSyncSpaces.map { space in
            let source = accountSources.first { $0.id == space.id }?.store
            let project = source?.state.projects.first { accountProjectID($0, spaceID: space.id) == projectID }
            let configured = projectID == nil || project.map(accountProjectIsConfigured) == true
            return MobileExecutionHost(id: space.id, name: space.hostName,
                online: source?.connection == .connected && source?.macOnline == true, configured: configured)
        }
    }

    func runHostStatus(_ id: String) -> (name: String, online: Bool) {
        let spaceID = parseAccountRunID(id)?.spaceID ?? credentials?.syncSpaceID
        let source = accountSources.first { $0.id == spaceID }?.store ?? self
        let name = availableAccountSyncSpaces.first { $0.id == spaceID }?.hostName ?? "执行 Mac"
        return (name, source.connection == .connected && source.macOnline)
    }

    func runHostLabel(_ id: String) -> String {
        let host = runHostStatus(id)
        return "\(host.name) · \(host.online ? "在线" : "离线")"
    }

    func createAccountRun(projectID: String?, title: String, spaceID: String) async throws -> String {
        guard executionHosts(projectID: projectID).contains(where: { $0.id == spaceID && $0.selectable }),
              let source = accountSources.first(where: { $0.id == spaceID }) else {
            throw RelayError.server("请选择在线且已配置主文件夹的 Mac。")
        }
        await source.store.sync()
        guard executionHosts(projectID: projectID).contains(where: { $0.id == spaceID && $0.selectable }) else {
            throw RelayError.server("执行 Mac 已离线或目录配置已变化，请重新选择。")
        }
        let project = source.store.state.projects.first { accountProjectID($0, spaceID: spaceID) == projectID }
        if projectID != nil && project == nil { throw RelayError.invalidResponse }
        let id = try await source.store.createRun(projectID: project?.id, title: title)
        return accountRunID(spaceID: spaceID, runID: id)
    }

    func projectGoals(_ id: String) -> [ProjectGoal] {
        var goals: [String: ProjectGoal] = [:]
        for source in accountSources {
            guard let project = source.store.state.projects.first(where: { accountProjectID($0, spaceID: source.id) == id }) else { continue }
            for goal in source.store.state.goals where goal.projectId == project.id {
                if let existing = goals[goal.id], existing.updatedAt >= goal.updatedAt { continue }
                goals[goal.id] = goal
            }
        }
        return goals.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    func updateAccountProject(_ project: Project) async throws {
        for source in accountSources where source.store.connection == .connected && source.store.macOnline {
            guard let original = source.store.state.projects.first(where: { accountProjectID($0, spaceID: source.id) == project.id }),
                  original.shared == project.shared else { continue }
            var local = project
            local.id = original.id
            local.profile.workspaceRoots = original.profile.workspaceRoots
            local.profile.primaryWorkspaceRootId = original.profile.primaryWorkspaceRootId
            local.profile.repoPath = original.profile.repoPath
            local.profile.defaultAgent = original.profile.defaultAgent
            try await source.store.updateProject(local)
            return
        }
        throw RelayError.server("没有在线且持有最新项目信息的 Mac，请同步后重试。")
    }

    private func startAccountPeers() {
        guard !isPeerTransport, peersTask == nil else { return }
        if let session = accountSession, peerStores.isEmpty {
            let key = "account.peer-spaces.\(session.user.id)"
            let cached = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([AccountSyncSpace].self, from: $0) } ?? []
            if availableAccountSyncSpaces.isEmpty { availableAccountSyncSpaces = cached }
            for space in cached where space.id != (credentials?.syncSpaceID ?? selectedAccountSyncSpaceID) {
                if let grant = try? KeychainStore.load(syncSpaceID: space.id),
                   !accountCredentialsNeedEnrollment(grant, accountUserID: session.user.id, accountDeviceID: session.device.id, selectedSpace: space) {
                    installPeer(grant, session: session, space: space)
                }
            }
        }
        for peer in peerStores.values { peer.start() }
        peersTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshAccountPeers()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private func installPeer(_ grant: CompanionCredentials, session: MobileAccountSession, space: AccountSyncSpace) {
        let peer = CompanionStore(peerCredentials: grant, session: session)
        peer.availableAccountSyncSpaces = [space]
        peerStores[space.id] = peer
        peerSubscriptions[space.id] = peer.objectWillChange.sink { [weak self] in
            Task { @MainActor in self?.objectWillChange.send() }
        }
    }

    private func refreshAccountPeers() async {
        guard let api = AccountClient.configured(), let session = accountSession, accountSessionValidated else { return }
        do {
            let (page, refreshed) = try await api.listSyncSpaces(accountSession: session)
            guard !Task.isCancelled, accountSession?.user.id == session.user.id else { return }
            var current = try persistRefreshedAccountSession(refreshed)
            availableAccountSyncSpaces = page.syncSpaces
            UserDefaults.standard.set(try JSONEncoder().encode(page.syncSpaces), forKey: "account.peer-spaces.\(session.user.id)")
            for id in Array(peerStores.keys) where !page.syncSpaces.contains(where: { $0.id == id }) || id == credentials?.syncSpaceID {
                await peerStores[id]?.quiesceRelaySync()
                peerStores[id] = nil
                peerSubscriptions[id] = nil
            }
            for space in page.syncSpaces where space.id != (credentials?.syncSpaceID ?? selectedAccountSyncSpaceID) {
                guard !Task.isCancelled, accountSession?.user.id == session.user.id else { return }
                if let peer = peerStores[space.id] {
                    if peer.isPaired && !accountCredentialsNeedEnrollment(peer.credentials, accountUserID: current.user.id, accountDeviceID: current.device.id, selectedSpace: space) {
                        peer.availableAccountSyncSpaces = [space]
                        continue
                    }
                    await peer.quiesceRelaySync()
                    peerStores[space.id] = nil
                    peerSubscriptions[space.id] = nil
                }
                do {
                    var grant = try KeychainStore.load(syncSpaceID: space.id)
                    if accountCredentialsNeedEnrollment(grant, accountUserID: current.user.id, accountDeviceID: current.device.id, selectedSpace: space) { grant = nil }
                    if grant == nil {
                        let key = "account.peer-enrollment.\(current.user.id).\(space.id)"
                        if let enrollmentID = UserDefaults.standard.string(forKey: key) {
                            let (status, afterPoll) = try await api.enrollment(spaceID: space.id, enrollmentID: enrollmentID, accountSession: current)
                            guard !Task.isCancelled, accountSession?.user.id == session.user.id else { return }
                            current = try persistRefreshedAccountSession(afterPoll)
                            if status.enrollment.status == "active", let wrapped = status.enrollment.wrappedSpaceKey,
                               let privateKey = try AccountKeychainStore.loadDevicePrivateKey() {
                                grant = try AccountDeviceGrant.open(wrapped, enrollmentID: enrollmentID, spaceID: space.id,
                                    deviceID: current.device.id, ownerUserID: current.user.id, privateKeyData: privateKey)
                                try KeychainStore.save(grant!)
                            } else if status.enrollment.status != "pending" || status.enrollment.expiresAt.flatMap(parseCompanionDate).map({ $0 <= Date() }) == true {
                                UserDefaults.standard.removeObject(forKey: key)
                            }
                        } else {
                            let (created, afterCreate) = try await api.createEnrollment(spaceID: space.id, accountSession: current)
                            guard !Task.isCancelled, accountSession?.user.id == session.user.id else { return }
                            current = try persistRefreshedAccountSession(afterCreate)
                            UserDefaults.standard.set(created.enrollment.id, forKey: key)
                        }
                    }
                    guard let grant else { continue }
                    installPeer(grant, session: current, space: space)
                    peerStores[space.id]?.start()
                } catch {
                    UserDefaults.standard.removeObject(forKey: "account.peer-enrollment.\(session.user.id).\(space.id)")
                }
            }
        } catch { /* Retain isolated caches; each transport reports its own availability. */ }
    }
}

@MainActor
final class CompanionStore: ObservableObject {
    enum ConnectionState: Equatable {
        case unpaired, connecting, connected, offline
        case error(String)
    }

    @Published private(set) var state = CachedState()
    @Published private(set) var connection: ConnectionState = .unpaired
    @Published private(set) var macOnline = false
    @Published private(set) var credentials: CompanionCredentials?
    @Published private(set) var accountSession: MobileAccountSession?
    @Published private(set) var emailChallenge: EmailSignInChallenge?
    @Published private(set) var accountBusy = false
    @Published private(set) var restoringAccountSession = false
    @Published private(set) var accountEnrollmentInProgress = false
    @Published private(set) var accountEnrollmentMessage: String?
    @Published private(set) var availableAccountSyncSpaces: [AccountSyncSpace] = []
    @Published private(set) var selectedAccountSyncSpaceID: String?
    @Published private(set) var loadingOlderChatIDs: Set<String> = []
    @Published var operationError: String?

    private var client: RelayClient?
    private var pollingTask: Task<Void, Never>?
    private var accountEnrollmentTask: Task<Void, Never>?
    private var accountEnrollmentTaskID: UUID?
    private var accountValidationTask: Task<Void, Never>?
    private var relayCredentialCleanupTask: Task<Void, Never>?
    private var pendingRelayCredentialCleanup: [CompanionCredentials] = []
    private var accountSessionValidated = false
    private var activeSync: Task<Void, Never>?
    private var activeSyncID: UUID?
    private var spaceSwitchTask: Task<Void, Never>?
    private var spaceSwitchTaskID: UUID?
    private var syncRequested = false
    private var commandErrors: [String: String] = [:]
    private var historyRequestChatIDs: [String: String] = [:]
    private var notificationObservers: [NSObjectProtocol] = []
    private var notificationAuthorizationRequested = false
    private let cacheRootURL: URL
    private var sendingOutgoingAgentIDs: Set<String> = []
    private var cancelledOutgoingAgentIDs: Set<String> = []
    #if DEBUG
    private var previewAttachmentFiles: [String: URL] = [:]
    #endif

    private var agentMessageOutbox: AgentMessageOutbox {
        let account = SHA256.hash(data: Data((credentials?.accountID ?? "unpaired").utf8)).map { String(format: "%02x", $0) }.joined()
        return AgentMessageOutbox(directory: outgoingAccountDirectory.appendingPathComponent(account, isDirectory: true))
    }

    private var outgoingAccountDirectory: URL {
        let owner = SHA256.hash(data: Data((credentials?.ownerUserID ?? credentials?.accountID ?? "unpaired").utf8)).map { String(format: "%02x", $0) }.joined()
        return cacheRootURL.appendingPathComponent("outgoing-agent-messages", isDirectory: true).appendingPathComponent(owner, isDirectory: true)
    }
    private let previewMode = ProcessInfo.processInfo.arguments.contains("--design-preview")
    private let accountHostsPreviewMode = ProcessInfo.processInfo.arguments.contains(
        "--design-preview-account-hosts")
    private let chatScrollPositionKeyPrefix = "chat.scroll-position."
    private let isPeerTransport: Bool
    private var peerStores: [String: CompanionStore] = [:]
    private var peerSubscriptions: [String: AnyCancellable] = [:]
    private var peersTask: Task<Void, Never>?

    init(peerCredentials: CompanionCredentials? = nil, session: MobileAccountSession? = nil) {
        isPeerTransport = peerCredentials != nil
        cacheRootURL = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("ProjectAgentCompanion")
        if let peerCredentials, let session {
            credentials = peerCredentials
            accountSession = session
            accountSessionValidated = true
            selectedAccountSyncSpaceID = peerCredentials.syncSpaceID
            configureClient(peerCredentials)
            loadCache(spaceID: peerCredentials.syncSpaceID, allowLegacyMigration: false)
            connection = .offline
            return
        }
#if DEBUG
        if accountHostsPreviewMode {
            accountSession = MobileAccountSession(
                user: AccountUser(id: "preview-user", email: "kai@example.com", displayName: "Kai"),
                device: AccountDevice(
                    id: "preview-device", platform: "ios", name: "Kai 的 iPhone", hostId: nil,
                    syncSpaceId: nil),
                session: AccountSessionTokens(
                    accessToken: "preview", refreshToken: "preview", accessExpiresAt: "",
                    refreshExpiresAt: "")
            )
            availableAccountSyncSpaces = [
                AccountSyncSpace(
                    id: "space-studio",
                    hostId: "host-studio",
                    name: "工作室 Mac 的工作空间",
                    keyVersion: 1,
                    relayUrl: "https://relay.example.com",
                    relayAccountId: "preview-studio",
                    hostName: "工作室 Mac",
                    hostLastSeenAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-45))
                ),
                AccountSyncSpace(
                    id: "space-laptop",
                    hostId: "host-laptop",
                    name: "MacBook Pro 的工作空间",
                    keyVersion: 1,
                    relayUrl: "https://relay.example.com",
                    relayAccountId: "preview-laptop",
                    hostName: "MacBook Pro",
                    hostLastSeenAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3_600))
                ),
            ]
            credentials = CompanionCredentials(
                relayURL: "https://relay.example.com",
                accountID: "preview-studio",
                deviceID: "preview-device",
                deviceToken: "preview",
                syncSpaceID: "space-studio",
                ownerUserID: "preview-user"
            )
            accountSessionValidated = true
            selectedAccountSyncSpaceID = "space-studio"
            connection = .connected
            macOnline = true
            seedDesignPreview()
            reconcileChatPages()
            if !state.projects.isEmpty {
                state.projects[0].shared = SharedProjectRevision(id: "11111111-1111-4111-8111-111111111111", revision: 1, author: "preview")
                let other = CompanionStore(peerCredentials: CompanionCredentials(
                    relayURL: "https://relay.example.com", accountID: "preview-laptop", deviceID: "preview-device",
                    deviceToken: "preview", syncSpaceID: "space-laptop", ownerUserID: "preview-user"), session: accountSession)
                other.state = CachedState()
                other.state.projects = [state.projects[0]]
                other.availableAccountSyncSpaces = [availableAccountSyncSpaces[1]]
                if var run = state.runs.first {
                    run.run.id = "laptop-preview-run"
                    run.run.title = "MacBook 上的项目分析"
                    run.run.projectId = state.projects[0].id
                    other.state.runs = [run]
                }
                other.connection = .offline
                peerStores["space-laptop"] = other
            }
            return
        }
        if previewMode {
            accountSession = MobileAccountSession(
                user: AccountUser(
                    id: "preview-user", email: "preview@example.com", displayName: "Preview"),
                device: AccountDevice(
                    id: "preview-device", platform: "ios", name: "Preview iPhone", hostId: nil,
                    syncSpaceId: nil),
                session: AccountSessionTokens(
                    accessToken: "preview", refreshToken: "preview", accessExpiresAt: "",
                    refreshExpiresAt: "")
            )
            credentials = CompanionCredentials(
                relayURL: "https://relay.example.com", accountID: "preview", deviceID: "iphone-preview",
                deviceToken: "preview", ownerUserID: "preview-user")
            accountSessionValidated = true
            connection = .connected
            macOnline = true
            seedDesignPreview()
            reconcileChatPages()
            return
        }
#endif
        do {
            accountSession = try AccountKeychainStore.loadSession()
            if let expiry = accountSession?.session.refreshExpiresAt,
                let date = parseCompanionDate(expiry),
                date <= Date()
            {
                AccountKeychainStore.deleteSession()
                accountSession = nil
            }
            if let userID = accountSession?.user.id {
                restoringAccountSession = true
                selectedAccountSyncSpaceID = UserDefaults.standard.string(
                    forKey: accountSelectedSyncSpaceKey(userID: userID)
                )
            }
            credentials = try KeychainStore.load(syncSpaceID: selectedAccountSyncSpaceID)
            if let stored = credentials,
                stored.ownerUserID == nil,
                stored.syncSpaceID != nil,
                let userID = accountSession?.user.id
            {
                let scoped = CompanionCredentials(
                    relayURL: stored.relayURL,
                    accountID: stored.accountID,
                    deviceID: stored.deviceID,
                    deviceToken: stored.deviceToken,
                    encryptionKey: stored.encryptionKey,
                    encryptionKeyId: stored.encryptionKeyId,
                    syncSpaceID: stored.syncSpaceID,
                    ownerUserID: userID
                )
                try KeychainStore.save(scoped)
                credentials = scoped
            }
            if let credentials {
                if selectedAccountSyncSpaceID == nil, let credentialSpaceID = credentials.syncSpaceID {
                    selectedAccountSyncSpaceID = credentialSpaceID
                }
                if credentials.ownerUserID == accountSession?.user.id {
                    configureClient(credentials)
                    connection = .offline
                }
            }
            pendingRelayCredentialCleanup = accountRelayCredentialsRequiringCleanup(
                try KeychainStore.loadAll(),
                activeOwnerUserID: accountSession?.user.id
            )
            if accountSession == nil, credentials?.ownerUserID != nil {
                credentials = nil
                client = nil
                connection = .unpaired
            }
        } catch {
            operationError = error.localizedDescription
        }
        loadCache(
            spaceID: selectedAccountSyncSpaceID ?? credentials?.syncSpaceID,
            allowLegacyMigration: credentials?.syncSpaceID != nil
        )
        notificationObservers.append(
            NotificationCenter.default.addObserver(
                forName: .companionPushToken,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                guard let token = notification.object as? String else { return }
                Task { @MainActor in await self?.registerPushToken(token) }
            })
        notificationObservers.append(
            NotificationCenter.default.addObserver(
                forName: .companionPushRegistrationFailed,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                guard let error = notification.object as? Error else { return }
                Task { @MainActor in self?.operationError = "推送注册失败：\(error.localizedDescription)" }
            })
    }

    var isPaired: Bool {
        guard accountSessionValidated, let accountSession else { return false }
        return credentials?.ownerUserID == accountSession.user.id || peerStores.values.contains { $0.isPaired }
    }
    var isSignedIn: Bool { accountSession != nil }
    var currentAccountSyncSpace: AccountSyncSpace? {
        let activeID = credentials?.syncSpaceID ?? selectedAccountSyncSpaceID
        return availableAccountSyncSpaces.first { $0.id == activeID }
    }
    var runs: [RunDetail] { accountRuns }
    var decisions: [Decision] { state.decisions.sorted { $0.createdAt > $1.createdAt } }
    var morningBriefings: [MorningBriefing] {
        state.morningBriefings.sorted { $0.generatedAt < $1.generatedAt }
    }
    var workAssistantMessages: [WorkAssistantMessage] {
        state.workAssistantMessages.sorted { $0.createdAt < $1.createdAt }
    }

    func chatPage(chatID: String) -> CompanionChatPage? {
        state.chatPages.first { $0.chatId == chatID }
    }

    func savedChatScrollPosition(chatID: String) -> String? {
        UserDefaults.standard.string(forKey: chatScrollPositionKeyPrefix + chatID)
    }

    func saveChatScrollPosition(_ position: String?, chatID: String) {
        let key = chatScrollPositionKeyPrefix + chatID
        if let position {
            UserDefaults.standard.set(position, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    func loadOlderChatRecords(chatID: String) async {
        guard !previewMode,
              !loadingOlderChatIDs.contains(chatID),
              let page = chatPage(chatID: chatID),
              page.hasMore,
            let client
        else { return }
        let commandID = UUID().uuidString
        loadingOlderChatIDs.insert(chatID)
        historyRequestChatIDs[commandID] = chatID
        do {
            _ = try await client.sendCommand(
                commandID: commandID,
                type: .chatLoadHistory,
                payload: ChatLoadHistoryPayload(
                    chatKind: page.chatKind,
                    chatId: page.chatId,
                    before: page.nextBefore,
                    limit: companionInitialChatBlockLimit
                )
            )
        } catch {
            loadingOlderChatIDs.remove(chatID)
            historyRequestChatIDs[commandID] = nil
            operationError = error.localizedDescription
        }
    }

    func start(validateAccountSession: Bool = false) {
        guard !previewMode, !accountHostsPreviewMode else { return }
        beginRelayCredentialCleanupIfNeeded()
        guard isSignedIn else { return }
        if validateAccountSession {
            beginAccountValidationIfNeeded()
            return
        }
        guard accountSessionValidated else {
            beginAccountValidationIfNeeded()
            return
        }
        startAccountPeers()
        if needsAccountEnrollment {
            beginAccountEnrollmentIfNeeded()
            return
        }
        guard isPaired else {
            return
        }
        requestNotificationAuthorizationIfNeeded()
        UIApplication.shared.registerForRemoteNotifications()
        client?.connect { [weak self] envelope in
            Task { @MainActor in await self?.handleSocketEnvelope(envelope) }
        }
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            await self?.sync()
            var elapsedSeconds: TimeInterval = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(companionFallbackSyncIntervalSeconds))
                guard !Task.isCancelled else { return }
                elapsedSeconds += companionFallbackSyncIntervalSeconds
                let interval = companionFallbackSyncIntervalSeconds(
                    realtimeConnected: self?.client?.realtimeConnected == true
                )
                guard elapsedSeconds >= interval else { continue }
                elapsedSeconds = 0
                await self?.sync()
            }
        }
    }

    func suspendForegroundTransport() {
        peersTask?.cancel()
        peersTask = nil
        for peer in peerStores.values { peer.suspendForegroundTransport() }
        pollingTask?.cancel()
        pollingTask = nil
        client?.disconnect()
        macOnline = false
        if credentials != nil { connection = .offline }
    }

    func startEmailSignIn(email: String) async {
        guard let client = AccountClient.configured() else {
            operationError = AccountClientError.notConfigured.localizedDescription
            return
        }
        accountBusy = true
        operationError = nil
        defer { accountBusy = false }
        do {
            emailChallenge = try await client.startEmailSignIn(email: email)
        } catch {
            operationError = error.localizedDescription
        }
    }

    func verifyEmailSignIn(code: String) async {
        guard let client = AccountClient.configured(), let emailChallenge else { return }
        accountBusy = true
        operationError = nil
        defer { accountBusy = false }
        do {
            let session = try await client.verifyEmailSignIn(
                challengeID: emailChallenge.challengeId, code: code)
            try AccountKeychainStore.saveSession(session)
            accountSession = session
            accountSessionValidated = false
            self.emailChallenge = nil
            start()
        } catch {
            operationError = error.localizedDescription
        }
    }

    func signInWithGoogle(idToken: String) async {
        guard let client = AccountClient.configured() else {
            operationError = AccountClientError.notConfigured.localizedDescription
            return
        }
        accountBusy = true
        operationError = nil
        defer { accountBusy = false }
        do {
            let session = try await client.acceptGoogleIDToken(idToken)
            try AccountKeychainStore.saveSession(session)
            accountSession = session
            accountSessionValidated = false
            emailChallenge = nil
            start()
        } catch {
            operationError = error.localizedDescription
        }
    }

    func cancelEmailSignIn() {
        emailChallenge = nil
        operationError = nil
    }

    func signOutAccount() async {
        accountBusy = true
        operationError = nil
        defer { accountBusy = false }
        guard let current = accountSession else {
            if let client, let credentials {
                do {
                    try await client.revokeSelf()
                    KeychainStore.delete(syncSpaceID: credentials.syncSpaceID)
                } catch { /* Retain the credential so remote revocation remains possible. */ }
            }
            await unpair()
            return
        }
        guard let accountClient = AccountClient.configured() else {
            operationError = AccountClientError.notConfigured.localizedDescription
            return
        }
        do {
            _ = try await accountClient.logout(accountSession: current)
        } catch {
            operationError = error.localizedDescription
            return
        }
        // Account logout durably revokes this phone's grants in every Sync Space.
        // Remove all local credentials covered by that successful operation instead
        // of retrying only the currently selected Relay with an already-revoked token.
        KeychainStore.deleteAll(ownerUserID: current.user.id)
        await unpair()
        AccountKeychainStore.deleteSession()
        accountSession = nil
        accountSessionValidated = false
        restoringAccountSession = false
        availableAccountSyncSpaces = []
        selectedAccountSyncSpaceID = nil
        emailChallenge = nil
    }

    func unpair() async {
        let outgoingDirectory = outgoingAccountDirectory
        await quiesceAccountConnections(cancelValidation: true)
        try? FileManager.default.removeItem(at: outgoingDirectory)
        client = nil
        // Credentials for inactive Sync Spaces stay in Keychain until their own
        // Relay grants can be revoked; deleting them here would orphan live tokens.
        credentials = nil
        state = CachedState()
        macOnline = false
        connection = .unpaired
    }

    private func quiesceAccountConnections(cancelValidation: Bool) async {
        peersTask?.cancel()
        let oldPeersTask = peersTask
        peersTask = nil
        await oldPeersTask?.value
        for peer in peerStores.values { await peer.quiesceRelaySync() }
        peerStores = [:]
        peerSubscriptions = [:]
        let enrollmentTask = accountEnrollmentTask
        enrollmentTask?.cancel()
        accountEnrollmentTask = nil
        accountEnrollmentTaskID = nil
        await enrollmentTask?.value
        let switchTask = spaceSwitchTask
        switchTask?.cancel()
        spaceSwitchTask = nil
        spaceSwitchTaskID = nil
        await switchTask?.value
        if cancelValidation {
            accountValidationTask?.cancel()
            accountValidationTask = nil
        }
        accountEnrollmentInProgress = false
        accountEnrollmentMessage = nil
        await quiesceRelaySync()
        macOnline = false
        connection = credentials == nil ? .unpaired : .offline
    }

    private func beginAccountEnrollmentIfNeeded() {
        guard accountEnrollmentTask == nil, needsAccountEnrollment else { return }
        let taskID = UUID()
        accountEnrollmentTaskID = taskID
        accountEnrollmentTask = Task { @MainActor [weak self] in
            await self?.connectSameAccount(taskID: taskID)
            guard self?.accountEnrollmentTaskID == taskID else { return }
            self?.accountEnrollmentTask = nil
            self?.accountEnrollmentTaskID = nil
        }
    }

    func retryAccountEnrollment() {
        guard isSignedIn, needsAccountEnrollment else { return }
        operationError = nil
        accountEnrollmentTask?.cancel()
        accountEnrollmentTask = nil
        accountEnrollmentTaskID = nil
        accountEnrollmentInProgress = false
        accountEnrollmentMessage = "正在重新查找你的 Mac…"
        beginAccountEnrollmentIfNeeded()
    }

    func switchAccountSyncSpace(_ id: String) {
        guard id != selectedAccountSyncSpaceID else { return }
        spaceSwitchTask?.cancel()
        let taskID = UUID()
        spaceSwitchTaskID = taskID
        spaceSwitchTask = Task { @MainActor [weak self] in
            await self?.performAccountSyncSpaceSwitch(id, taskID: taskID)
        }
    }

    private func performAccountSyncSpaceSwitch(_ id: String, taskID: UUID) async {
        defer {
            if spaceSwitchTaskID == taskID {
                spaceSwitchTask = nil
                spaceSwitchTaskID = nil
            }
        }
        guard let userID = accountSession?.user.id,
            availableAccountSyncSpaces.contains(where: { $0.id == id })
        else { return }
        let enrollmentTask = accountEnrollmentTask
        enrollmentTask?.cancel()
        accountEnrollmentTask = nil
        accountEnrollmentTaskID = nil
        await enrollmentTask?.value
        guard spaceSwitchTaskID == taskID, !Task.isCancelled else { return }

        await quiesceRelaySync()
        guard spaceSwitchTaskID == taskID, !Task.isCancelled else { return }
        selectedAccountSyncSpaceID = id
        UserDefaults.standard.set(id, forKey: accountSelectedSyncSpaceKey(userID: userID))
        do {
            let storedCredentials = try KeychainStore.load(syncSpaceID: id)
            credentials = storedCredentials?.ownerUserID == userID ? storedCredentials : nil
            client = nil
            if let credentials { configureClient(credentials) }
            state = cachedState(spaceID: id, allowLegacyMigration: false)
            reconcileChatPages()
            connection = credentials == nil ? .connecting : .offline
            macOnline = false
            operationError = nil
            beginAccountEnrollmentIfNeeded()
            start()
        } catch {
            credentials = nil
            client = nil
            state = CachedState()
            connection = .unpaired
            operationError = error.localizedDescription
        }
    }

    private func connectSameAccount(taskID: UUID) async {
        guard let accountClient = AccountClient.configured(), var currentSession = accountSession else {
            return
        }
        let replacingLegacyPairing = isPaired
        let shouldMigrateLegacyCache = credentials?.syncSpaceID == nil
        accountEnrollmentInProgress = true
        accountEnrollmentMessage = "正在查找你的 Mac…"
        if !replacingLegacyPairing { connection = .connecting }
        defer {
            if accountEnrollmentTaskID == taskID {
                accountEnrollmentInProgress = false
            }
        }
        let deadline = Date().addingTimeInterval(10 * 60)
        do {
            while !Task.isCancelled && Date() < deadline {
                let (spaces, refreshedSession) = try await accountClient.listSyncSpaces(
                    accountSession: currentSession)
                currentSession = try persistRefreshedAccountSession(refreshedSession)
                availableAccountSyncSpaces = spaces.syncSpaces
                guard !spaces.syncSpaces.isEmpty else {
                    accountEnrollmentMessage = "还没有找到你的 Mac。请确认 Mac 上的 Fuddy 已打开。"
                    try await Task.sleep(for: .seconds(5))
                    continue
                }
                guard
                    let space = preferredAccountSyncSpace(
                        from: spaces.syncSpaces,
                        preferredID: selectedAccountSyncSpaceID
                    )
                else {
                    accountEnrollmentMessage = "暂时没有找到可连接的 Mac，请稍后重试。"
                    if !replacingLegacyPairing { connection = .unpaired }
                    return
                }
                if selectedAccountSyncSpaceID != space.id {
                    selectedAccountSyncSpaceID = space.id
                    UserDefaults.standard.set(
                        space.id,
                        forKey: accountSelectedSyncSpaceKey(userID: currentSession.user.id)
                    )
                }
                let (created, afterCreate) = try await accountClient.createEnrollment(
                    spaceID: space.id,
                    accountSession: currentSession
                )
                currentSession = try persistRefreshedAccountSession(afterCreate)
                guard accountEnrollmentTaskID == taskID, !Task.isCancelled else { return }
                accountEnrollmentMessage = "已找到 \(space.hostName)，正在连接…"

                while !Task.isCancelled && Date() < deadline {
                    let (status, afterPoll) = try await accountClient.enrollment(
                        spaceID: space.id,
                        enrollmentID: created.enrollment.id,
                        accountSession: currentSession
                    )
                    currentSession = try persistRefreshedAccountSession(afterPoll)
                    guard accountEnrollmentTaskID == taskID, !Task.isCancelled else { return }
                    if status.enrollment.status == "active",
                        let wrappedGrant = status.enrollment.wrappedSpaceKey,
                        let privateKey = try AccountKeychainStore.loadDevicePrivateKey()
                    {
                        let relayCredentials = try AccountDeviceGrant.open(
                            wrappedGrant,
                            enrollmentID: status.enrollment.id,
                            spaceID: space.id,
                            deviceID: currentSession.device.id,
                            ownerUserID: currentSession.user.id,
                            privateKeyData: privateKey
                        )
                        await quiesceRelaySync()
                        guard accountEnrollmentTaskID == taskID, !Task.isCancelled else { return }
                        try KeychainStore.save(relayCredentials)
                        credentials = relayCredentials
                        configureClient(relayCredentials)
                        state = cachedState(
                            spaceID: space.id,
                            allowLegacyMigration: shouldMigrateLegacyCache
                        )
                        reconcileChatPages()
                        accountEnrollmentMessage = nil
                        connection = .connected
                        start()
                        await sync()
                        return
                    }
                    if status.enrollment.status == "revoked" { break }
                    try await Task.sleep(for: .seconds(2))
                }
            }
            if !Task.isCancelled {
                accountEnrollmentMessage = "暂时没有连接成功。请确认 Mac 在线后重试。"
                if !replacingLegacyPairing { connection = .unpaired }
            }
        } catch is CancellationError {
            return
        } catch {
            accountEnrollmentMessage = "暂时没有连接成功。请确认 Mac 在线后重试。"
            if !replacingLegacyPairing { connection = .unpaired }
            if error is AccountClientError { operationError = error.localizedDescription }
        }
    }

    private var needsAccountEnrollment: Bool {
        guard let accountSession else { return false }
        let selectedSpace = availableAccountSyncSpaces.first {
            $0.id == selectedAccountSyncSpaceID
        }
        return accountCredentialsNeedEnrollment(
            credentials,
            accountUserID: accountSession.user.id,
            accountDeviceID: accountSession.device.id,
            selectedSpace: selectedSpace
        )
    }

    private func beginAccountValidationIfNeeded() {
        guard accountValidationTask == nil else { return }
        restoringAccountSession = !accountSessionValidated
        accountValidationTask = Task { @MainActor [weak self] in
            await self?.validateAccountSession()
            self?.accountValidationTask = nil
        }
    }

    private func beginRelayCredentialCleanupIfNeeded() {
        guard relayCredentialCleanupTask == nil, !pendingRelayCredentialCleanup.isEmpty else {
            return
        }
        let credentialsToRevoke = pendingRelayCredentialCleanup
        pendingRelayCredentialCleanup.removeAll { credentialsToRevoke.contains($0) }
        relayCredentialCleanupTask = Task { @MainActor [weak self] in
            guard let self else { return }
            var remaining: [CompanionCredentials] = []
            for credentials in credentialsToRevoke {
                do {
                    try await RelayClient(credentials: credentials).revokeSelf()
                    KeychainStore.deleteIfMatching(credentials)
                } catch RelayError.unauthorized {
                    KeychainStore.deleteIfMatching(credentials)
                } catch {
                    remaining.append(credentials)
                }
            }
            for credentials in remaining where !self.pendingRelayCredentialCleanup.contains(credentials) {
                self.pendingRelayCredentialCleanup.append(credentials)
            }
            self.relayCredentialCleanupTask = nil
        }
    }

    private func queueRelayCredentialCleanup(ownerUserID: String) {
        guard let stored = try? KeychainStore.loadAll() else { return }
        for credentials in stored where credentials.ownerUserID == ownerUserID {
            if !pendingRelayCredentialCleanup.contains(credentials) {
                pendingRelayCredentialCleanup.append(credentials)
            }
        }
        beginRelayCredentialCleanupIfNeeded()
    }

    private func validateAccountSession() async {
        guard let current = accountSession, let accountClient = AccountClient.configured() else {
            restoringAccountSession = false
            accountSessionValidated = true
            start()
            return
        }
        do {
            let refreshed = try await accountClient.validateSession(accountSession: current)
            var activeSession = try persistRefreshedAccountSession(refreshed)
            let (spaces, afterSpaces) = try await accountClient.listSyncSpaces(accountSession: activeSession)
            activeSession = try persistRefreshedAccountSession(afterSpaces)
            availableAccountSyncSpaces = spaces.syncSpaces
            if let credentialSpaceID = credentials?.syncSpaceID,
                spaces.syncSpaces.contains(where: { $0.id == credentialSpaceID })
            {
                selectedAccountSyncSpaceID = credentialSpaceID
            } else if let selected = preferredAccountSyncSpace(
                from: spaces.syncSpaces,
                preferredID: selectedAccountSyncSpaceID
            ) {
                selectedAccountSyncSpaceID = selected.id
                UserDefaults.standard.set(
                    selected.id,
                    forKey: accountSelectedSyncSpaceKey(userID: activeSession.user.id)
                )
            }
            try await reconcileRelayCredentials(for: activeSession)
            accountSessionValidated = true
            restoringAccountSession = false
            start()
        } catch AccountClientError.authenticationRequired {
            // Relay grants can outlive an Account session. Queue every credential
            // owned by this user for direct Relay revocation before removing local access.
            await quiesceAccountConnections(cancelValidation: false)
            queueRelayCredentialCleanup(ownerUserID: current.user.id)
            AccountKeychainStore.deleteSession()
            accountSession = nil
            credentials = nil
            client = nil
            connection = .unpaired
            accountSessionValidated = false
            restoringAccountSession = false
            availableAccountSyncSpaces = []
            operationError = AccountClientError.authenticationRequired.localizedDescription
        } catch {
            accountSessionValidated = true
            restoringAccountSession = false
            operationError = error.localizedDescription
            start()
        }
    }

    private func accountSelectedSyncSpaceKey(userID: String) -> String {
        "account.selected-sync-space.\(userID)"
    }

    private func reconcileRelayCredentials(for session: MobileAccountSession) async throws {
        let selectedSpaceID = selectedAccountSyncSpaceID
        if credentials?.ownerUserID == session.user.id,
            credentials?.syncSpaceID == selectedSpaceID
        {
            return
        }
        await quiesceRelaySync()
        let stored = try KeychainStore.load(syncSpaceID: selectedSpaceID)
        credentials = stored?.ownerUserID == session.user.id ? stored : nil
        client = nil
        if let credentials { configureClient(credentials) }
        state = cachedState(spaceID: selectedSpaceID, allowLegacyMigration: false)
        reconcileChatPages()
        macOnline = false
        connection = credentials == nil ? .unpaired : .offline
    }

    @discardableResult
    private func persistRefreshedAccountSession(_ session: MobileAccountSession) throws
        -> MobileAccountSession
    {
        if session != accountSession {
            try AccountKeychainStore.saveSession(session)
            accountSession = session
        }
        return session
    }

    func sync() async {
        if !isPeerTransport {
            for peer in peerStores.values { await peer.sync() }
        }
        guard isPaired, client != nil else { return }
        if let activeSync {
            syncRequested = true
            await activeSync.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performSyncLoop()
        }
        let syncID = UUID()
        activeSyncID = syncID
        activeSync = task
        await task.value
        if activeSyncID == syncID {
            activeSync = nil
            activeSyncID = nil
        }
    }

    private func performSyncLoop() async {
        repeat {
            syncRequested = false
            await performSync()
        } while syncRequested && client != nil
    }

    private func performSync() async {
        guard isPaired, let client else { return }
        do {
            var replayedOperationError: String?
            while true {
                let page = try await client.events(after: state.lastSequence)
                guard !Task.isCancelled else { return }
                if let presence = page.presence { macOnline = presence.macOnline }
                if let remoteCurrentVersion = page.protocolVersion {
                    guard
                        companionProtocolRangeSupportsLocalVersion(
                        minimumVersion: page.minimumProtocolVersion ?? remoteCurrentVersion,
                        currentVersion: remoteCurrentVersion
                        )
                    else { throw RelayError.protocolMismatch }
                }
                companionApplyReplayResetIfNeeded(
                    state: &state,
                    replayResetSequence: page.replayResetSequence
                )
                for event in page.events where event.sequence > state.lastSequence {
                    if page.protocolVersion == nil
                        && !companionProtocolVersionIsSupported(event.protocolVersion)
                    {
                        throw RelayError.protocolMismatch
                    }
                    if let eventError = try apply(event) { replayedOperationError = eventError }
                    state.lastSequence = event.sequence
                }
                persistCache()
                if page.events.count < 200 { break }
            }
            connection = .connected
            if let replayedOperationError {
                operationError = replayedOperationError
            } else if operationError?.hasPrefix("同步失败：") == true {
                operationError = nil
            }
            for outgoing in (try? agentMessageOutbox.list()) ?? [] {
                do { try await deliverOutgoingAgentMessage(outgoing, using: client) }
                catch { operationError = "附件消息等待重试：\(error.localizedDescription)"; break }
            }
        } catch {
            if Task.isCancelled { return }
            connection = .offline
            macOnline = false
            if isPeerTransport, case RelayError.unauthorized = error {
                KeychainStore.delete(syncSpaceID: credentials?.syncSpaceID)
                credentials = nil
                client.disconnect()
            }
            operationError = "同步失败：\(error.localizedDescription)"
        }
    }

    func sendMessage(runID: String, prompt: String, attachments: [PendingAttachment] = [])
        async throws
    {
        let client = try activeRelayClient()
        guard let runIndex = state.runs.firstIndex(where: { $0.run.id == runID }) else {
            throw RelayError.invalidResponse
        }
        let outgoing = try agentMessageOutbox.prepare(runID: runID, prompt: prompt, attachments: attachments)
        let commandID = outgoing.id
        let now = ISO8601DateFormatter().string(from: Date())
        let localAttachments = attachments.map {
            (try? client.cachePendingAttachment($0, messageID: commandID, createdAt: outgoing.createdAt))
                ?? $0.descriptor(messageID: commandID, createdAt: outgoing.createdAt)
        }
        upsertAgentMessage(
            AgentMessage(
            id: commandID,
            runId: runID,
            role: "user",
            content: prompt,
            eventType: "pending",
            toolName: nil,
            attachments: localAttachments,
            createdAt: now
        ), in: &state.runs)
        rebuildAgentChatPage(runID: runID)
        state.runs[runIndex].run.status = "running"
        state.runs[runIndex].run.updatedAt = now
        persistCache()
        do {
            try await deliverOutgoingAgentMessage(outgoing, using: client)
        } catch {
            // Already durable: keep the optimistic message and replay this exact
            // command on reconnect instead of asking the user to submit it again.
            if !(error is CancellationError) {
                operationError = "消息已保存在本机，连接恢复后重试：\(error.localizedDescription)"
            }
        }
    }

    func stopMessage(runID: String) async throws {
        for message in try agentMessageOutbox.list() where message.runID == runID {
            if sendingOutgoingAgentIDs.contains(message.id) { cancelledOutgoingAgentIDs.insert(message.id) }
            try agentMessageOutbox.remove(message)
            removePendingAgentMessage(message.id)
        }
        let client = try activeRelayClient()
        _ = try await client.sendCommand(
            type: .agentStopMessage,
            payload: AgentStopMessagePayload(runId: runID)
        )
    }

    private func deliverOutgoingAgentMessage(_ original: OutgoingAgentMessage, using client: RelayClient) async throws {
        guard !sendingOutgoingAgentIDs.contains(original.id) else { return }
        sendingOutgoingAgentIDs.insert(original.id)
        defer { sendingOutgoingAgentIDs.remove(original.id); cancelledOutgoingAgentIDs.remove(original.id) }
        let outbox = agentMessageOutbox
        let accountID = credentials?.accountID
        var outgoing = original
        for attachment in outgoing.attachments where !outgoing.uploaded.contains(where: { $0.id == attachment.id }) {
            outgoing.uploaded.append(try await client.uploadAttachment(attachment))
            guard !cancelledOutgoingAgentIDs.contains(original.id), credentials?.accountID == accountID, self.client === client else { throw CancellationError() }
            try outbox.save(outgoing)
        }
        guard !cancelledOutgoingAgentIDs.contains(original.id), credentials?.accountID == accountID, self.client === client else { throw CancellationError() }
        _ = try await client.sendCommand(commandID: outgoing.id, type: .agentSendMessage,
            payload: AgentSendMessagePayload(runId: outgoing.runID, prompt: outgoing.prompt, attachments: outgoing.uploaded, clientMessageId: outgoing.id), originalCreatedAt: outgoing.createdAt)
        try outbox.remove(outgoing)
    }

    func createRun(projectID: String?, title: String) async throws -> String {
        let client = try activeRelayClient()
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { throw RelayError.invalidResponse }
        let project = projectID.flatMap { id in state.projects.first(where: { $0.id == id }) }
        if projectID != nil && project == nil { throw RelayError.invalidResponse }

        let commandID = UUID().uuidString
        let runID = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())
        state.pendingCreatedRunIDs[commandID] = runID
        state.runs.append(
            RunDetail(
                run: AgentRun(
                    id: runID,
                    projectId: projectID,
                    provider: project?.profile.defaultAgent ?? "pi",
                    title: trimmedTitle,
                    status: "draft",
                    workingDirectory: nil,
                    summary: "等待首次消息",
                    createdAt: now,
                    updatedAt: now
                ),
                messages: [],
                artifacts: []
            ))
        state.chatPages.append(
            CompanionChatPage(
                chatId: runID,
                chatKind: "agent",
                records: [],
                hasMore: false,
                nextBefore: nil
            ))
        persistCache()

        do {
            _ = try await client.sendCommand(
                commandID: commandID,
                type: .agentCreateSession,
                payload: AgentCreateSessionPayload(runId: runID, projectId: projectID, title: trimmedTitle, provider: nil, goalId: nil, milestoneId: nil, draftPrompt: nil)
            )
            return runID
        } catch {
            state.pendingCreatedRunIDs[commandID] = nil
            state.runs.removeAll { $0.run.id == runID }
            state.chatPages.removeAll { $0.chatId == runID }
            persistCache()
            throw error
        }
    }

    func sendWorkAssistantMessage(_ prompt: String, attachments: [PendingAttachment] = [])
        async throws
    {
        let client = try activeRelayClient()
        let uploaded = try await upload(attachments, using: client)
        _ = try await client.sendCommand(
            type: .assistantSendMessage,
            payload: AssistantSendMessagePayload(prompt: prompt, attachments: uploaded)
        )
    }

    func executeWorkAssistantAction(messageID: String, proposalID: String, optionID: String)
        async throws -> String?
    {
        let client = try activeRelayClient()
        _ = try await client.sendCommand(
            type: .assistantExecuteAction,
            payload: AssistantExecuteActionPayload(
                messageId: messageID, proposalId: proposalID, optionId: optionID)
        )
        for _ in 0..<12 {
            try await Task.sleep(for: .milliseconds(500))
            await sync()
            guard let message = state.workAssistantMessages.first(where: { $0.id == messageID }),
                let proposal = message.actions.first(where: { $0.id == proposalID })
            else { continue }
            if proposal.status != "pending" { return message.linkedRunId }
        }
        return nil
    }

    func handleDecision(_ decision: Decision) async throws -> String {
        let client = try activeRelayClient()
        if let existing = state.runs.first(where: {
            $0.run.decisionId == decision.id && $0.run.status != "completed"
                && $0.run.status != "cancelled"
        }) {
            try await updateDecision(id: decision.id, status: "in_progress")
            return existing.run.id
        }
        let runID = UUID().uuidString
        let now = ISO8601DateFormatter().string(from: Date())
        let previousStatus = state.decisions.first(where: { $0.id == decision.id })?.status
        if let decisionIndex = state.decisions.firstIndex(where: { $0.id == decision.id }) {
            state.decisions[decisionIndex].status = "in_progress"
        }
        state.runs.append(
            RunDetail(
            run: AgentRun(
                id: runID,
                projectId: decision.projectId,
                decisionId: decision.id,
                provider: "agent",
                title: "处理 · \(decision.title)",
                status: "idle",
                workingDirectory: nil,
                summary: "",
                createdAt: now,
                updatedAt: now
            ),
            messages: [],
            artifacts: []
        ))
        state.chatPages.append(
            CompanionChatPage(
            chatId: runID,
            chatKind: "agent",
            records: [],
            hasMore: false,
            nextBefore: nil
        ))
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: .decisionHandle,
                payload: DecisionHandlePayload(decisionId: decision.id, runId: runID)
            )
            return runID
        } catch {
            state.runs.removeAll { $0.run.id == runID }
            state.chatPages.removeAll { $0.chatId == runID }
            if let previousStatus,
                let decisionIndex = state.decisions.firstIndex(where: { $0.id == decision.id })
            {
                state.decisions[decisionIndex].status = previousStatus
            }
            persistCache()
            throw error
        }
    }

    func rename(runID: String, title: String) async throws {
        if let target = accountRunTarget(runID) { return try await target.store.rename(runID: target.id, title: title) }
        let client = try activeRelayClient()
        _ = try await client.sendCommand(
            type: .agentRenameSession,
            payload: AgentRenameSessionPayload(runId: runID, title: title)
        )
    }

    func updateDraftPrompt(runID: String, draftPrompt: String) async throws {
        let client = try activeRelayClient()
        guard let index = state.runs.firstIndex(where: { $0.run.id == runID }) else {
            throw RelayError.invalidResponse
        }
        let previous = state.runs[index].run.draftPrompt
        state.runs[index].run.draftPrompt = draftPrompt.isEmpty ? nil : draftPrompt
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: .agentUpdateDraftPrompt,
                payload: AgentUpdateDraftPromptPayload(runId: runID, draftPrompt: draftPrompt)
            )
        } catch {
            if let current = state.runs.firstIndex(where: { $0.run.id == runID }) {
                state.runs[current].run.draftPrompt = previous
            }
            persistCache()
            throw error
        }
    }

    func archive(runID: String) async throws {
        if let target = accountRunTarget(runID) { return try await target.store.archive(runID: target.id) }
        let client = try activeRelayClient()
        _ = try await client.sendCommand(
            type: .agentArchiveSession, payload: AgentArchiveSessionPayload(runId: runID))
    }

    func updateDecision(id: String, status: String) async throws {
        let client = try activeRelayClient()
        let previousStatus = state.decisions.first(where: { $0.id == id })?.status
        if let index = state.decisions.firstIndex(where: { $0.id == id }) {
            state.decisions[index].status = status
        }
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: .decisionUpdateStatus,
                payload: DecisionUpdateStatusPayload(decisionId: id, status: status)
            )
        } catch {
            if let previousStatus, let index = state.decisions.firstIndex(where: { $0.id == id }) {
                state.decisions[index].status = previousStatus
            }
            persistCache()
            throw error
        }
    }

    func updateProject(_ project: Project) async throws {
#if DEBUG
        if previewMode {
            upsert(project, in: &state.projects)
            persistCache()
            return
        }
#endif
        let client = try activeRelayClient()
        let previous = state.projects.first(where: { $0.id == project.id })
        upsert(project, in: &state.projects)
        persistCache()
        do {
            _ = try await client.sendCommand(
                type: .projectUpdate, payload: ProjectUpdatePayload(project: project))
        } catch {
            if let previous { upsert(previous, in: &state.projects) }
            persistCache()
            throw error
        }
    }

    func download(_ attachment: AttachmentDescriptor) async throws -> URL {
        #if DEBUG
        if let file = previewAttachmentFiles[attachment.id],
           let bytes = try? Data(contentsOf: file), RelayClient.attachmentMatches(bytes, attachment) { return file }
        #endif
        let client = try activeRelayClient()
        return try await client.downloadAttachment(attachment)
    }

    func openArtifact(_ artifact: AgentArtifact) async throws -> URL {
        if let attachment = attachment(for: artifact.id) {
            return try await download(attachment)
        }
        guard macOnline else {
            throw RelayError.server("Mac 当前不在线，暂时无法上传这个附件。")
        }
        let client = try activeRelayClient()
        let commandID = UUID().uuidString
        commandErrors[commandID] = nil
        defer { commandErrors[commandID] = nil }
        _ = try await client.sendCommand(
            commandID: commandID,
            type: .artifactRequestUpload,
            payload: ArtifactRequestUploadPayload(artifactId: artifact.id)
        )

        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            await sync()
            if let attachment = attachment(for: artifact.id) {
                return try await download(attachment)
            }
            if let message = commandErrors[commandID] {
                throw RelayError.server(message)
            }
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(400))
        }
        throw RelayError.server("Mac 未在 30 秒内完成附件上传，请稍后重试。")
    }

    func attachment(for artifactID: String) -> AttachmentDescriptor? { state.attachments[artifactID] }

    private func registerPushToken(_ token: String) async {
        for peer in peerStores.values { await peer.registerPushToken(token) }
        guard isPaired, let client else { return }
        do { try await client.registerPushToken(token) } catch {
            operationError = "推送注册失败：\(error.localizedDescription)"
        }
    }

    private func requestNotificationAuthorizationIfNeeded() {
        guard !notificationAuthorizationRequested else { return }
        notificationAuthorizationRequested = true
        Task { @MainActor [weak self] in
            do {
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                if settings.authorizationStatus == .notDetermined {
                    let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                    if !granted {
                        self?.operationError = "通知权限未开启；可在系统设置中开启 Agent Run 完成提醒。"
                    }
                }
                UIApplication.shared.registerForRemoteNotifications()
            } catch {
                self?.operationError = "通知授权失败：\(error.localizedDescription)"
            }
        }
    }

    private func configureClient(_ credentials: CompanionCredentials) {
        client = RelayClient(credentials: credentials)
        client?.onConnectionLost = { [weak self] in
            self?.macOnline = false
            self?.connection = .offline
        }
    }

    private func activeRelayClient() throws -> RelayClient {
        guard isPaired, let client else { throw RelayError.invalidResponse }
        return client
    }

    private func handleSocketEnvelope(_ envelope: SocketEnvelope) async {
        if let presence = envelope.presence {
            macOnline = presence.macOnline
        }
        if envelope.type == "sync.ready", let remoteSequence = envelope.lastSequence {
            if companionResetReplayCursorIfNeeded(state: &state, remoteSequence: remoteSequence) {
                persistCache()
            }
        }
        if envelope.type == "presence.updated" { return }
        await sync()
    }

    private func apply(_ event: SyncEvent) throws -> String? {
        var eventError: String?
        switch event.type {
            case .snapshotCreated:
                let snapshot = try event.payload.decode(SnapshotPayload.self)
                var nextState = state
                nextState.modelLabels = snapshot.modelLabels ?? .fallback
                nextState.projects = snapshot.projects
                nextState.goals = snapshot.goals
                nextState.decisions = snapshot.decisions
                nextState.morningBriefings = snapshot.morningBriefings ?? []
                nextState.workAssistantMessages = snapshot.workAssistantMessages
                nextState.runs = snapshot.runs
                nextState.chatPages = snapshot.chatPages ?? []
                nextState.attachments = Dictionary(
                    uniqueKeysWithValues: (snapshot.attachments ?? []).compactMap { attachment in
                        attachment.artifactId.map { ($0, attachment) }
                    }
                )
                state = nextState
                reconcileChatPages()
            case .chatPageUpdated:
                let page = try event.payload.decode(CompanionChatPage.self)
                if let index = state.chatPages.firstIndex(where: { $0.chatId == page.chatId }) {
                    state.chatPages[index] = page
                } else {
                    state.chatPages.append(page)
                }
                updateLegacyChatCollections(from: page)
            case .projectCreated, .projectUpdated:
                upsert(try event.payload.decode(Project.self), in: &state.projects)
            case .goalCreated, .goalUpdated:
                upsert(try event.payload.decode(ProjectGoal.self), in: &state.goals)
            case .decisionCreated, .decisionUpdated:
                upsert(try event.payload.decode(Decision.self), in: &state.decisions)
            case .morningBriefingUpdated:
                upsert(try event.payload.decode(MorningBriefing.self), in: &state.morningBriefings)
                rebuildAssistantChatPage()
            case .workAssistantMessageCreated, .workAssistantMessageUpdated:
                upsert(try event.payload.decode(WorkAssistantMessage.self), in: &state.workAssistantMessages)
                rebuildAssistantChatPage()
            case .agentRunCreated, .agentRunUpdated:
                let run = try event.payload.decode(AgentRun.self)
                if let index = state.runs.firstIndex(where: { $0.run.id == run.id }) {
                    state.runs[index].run = run
                } else {
                    state.runs.append(RunDetail(run: run, messages: [], artifacts: []))
                    state.chatPages.append(
                        CompanionChatPage(
                            chatId: run.id,
                            chatKind: "agent",
                            records: [],
                            hasMore: false,
                            nextBefore: nil
                        ))
                }
            case .modelLabelsUpdated:
                state.modelLabels = try event.payload.decode(AgentModelLabels.self)
            case .agentRunArchived:
                state.runs.removeAll { $0.run.id == event.entityId }
                state.chatPages.removeAll { $0.chatId == event.entityId }
            case .agentMessageCreated:
                let message = try event.payload.decode(AgentMessage.self)
                upsertAgentMessage(message, in: &state.runs)
                rebuildAgentChatPage(runID: message.runId)
            case .artifactUpdated:
                if let enriched = try? event.payload.decode(ArtifactEventPayload.self) {
                    upsertArtifact(enriched.artifact)
                    if let attachment = enriched.attachment {
                        state.attachments[enriched.artifact.id] = attachment
                    }
                } else {
                    upsertArtifact(try event.payload.decode(AgentArtifact.self))
                }
            case .commandUpdated:
                let command = try event.payload.decode(CommandResult.self)
                eventError = applyCommandResult(command)
            case .agentTurnSettled, .unknown:
                break
        }
        return eventError
    }

    private func applyCommandResult(_ command: CommandResult) -> String? {
        if command.type == .agentCreateSession {
            guard let runID = state.pendingCreatedRunIDs[command.commandId] else { return nil }
            if command.status == "failed" {
                state.pendingCreatedRunIDs[command.commandId] = nil
                state.runs.removeAll { $0.run.id == runID }
                state.chatPages.removeAll { $0.chatId == runID }
                persistCache()
                return command.error ?? "Mac 创建 Agent Run 失败。"
            }
            if command.status == "completed" {
                state.pendingCreatedRunIDs[command.commandId] = nil
                persistCache()
            }
            return nil
        }
        if command.type == .chatLoadHistory {
            if command.status == "completed" {
                guard let result = command.result,
                    let olderPage = try? result.decode(CompanionChatPage.self)
                else {
                    if let chatID = historyRequestChatIDs.removeValue(forKey: command.commandId) {
                        loadingOlderChatIDs.remove(chatID)
                    }
                    return "Mac 返回的聊天历史格式无效。"
                }
                mergeOlderChatPage(olderPage)
                loadingOlderChatIDs.remove(olderPage.chatId)
                historyRequestChatIDs[command.commandId] = nil
                persistCache()
            } else if command.status == "failed" {
                if let chatID = historyRequestChatIDs.removeValue(forKey: command.commandId) {
                    loadingOlderChatIDs.remove(chatID)
                }
                return command.error ?? "加载更早聊天记录失败。"
            }
            return nil
        }
        if command.type == .artifactRequestUpload {
            if command.status == "failed" {
                commandErrors[command.commandId] = command.error ?? "Mac 上传附件失败。"
            } else if command.status == "completed",
                      let result = command.result,
                let upload = try? result.decode(ArtifactUploadResult.self)
            {
                state.attachments[upload.artifactId] = upload.attachment
                persistCache()
            }
            return nil
        }
        if command.status == "failed" {
            removePendingAgentMessage(command.commandId)
            return command.error ?? "Mac 执行远程操作失败。"
        }
        if ["delivered", "executing", "completed"].contains(command.status) {
            markPendingAgentMessageAcknowledged(command.commandId)
        }
        return nil
    }

    private func upsert<T: Identifiable>(_ value: T, in values: inout [T]) where T.ID: Equatable {
        if let index = values.firstIndex(where: { $0.id == value.id }) {
            values[index] = value
        } else {
            values.append(value)
        }
    }

    private func upsertArtifact(_ artifact: AgentArtifact) {
        guard let index = state.runs.firstIndex(where: { $0.run.id == artifact.runId }) else { return }
        upsert(artifact, in: &state.runs[index].artifacts)
    }

    private func removePendingAgentMessage(_ messageID: String) {
        guard
            let runIndex = state.runs.firstIndex(where: { detail in
            detail.messages.contains(where: { $0.id == messageID && $0.eventType == "pending" })
            })
        else { return }
        state.runs[runIndex].messages.removeAll { $0.id == messageID && $0.eventType == "pending" }
        rebuildAgentChatPage(runID: state.runs[runIndex].run.id)
        persistCache()
    }

    private func markPendingAgentMessageAcknowledged(_ messageID: String) {
        guard acknowledgePendingAgentMessage(messageID, in: &state.runs) else { return }
        if let runID = state.runs.first(where: { detail in
            detail.messages.contains(where: { $0.id == messageID })
        })?.run.id {
            rebuildAgentChatPage(runID: runID)
        }
        persistCache()
    }

    private func reconcileChatPages() {
        if state.chatPages.isEmpty {
            state.chatPages.append(
                companionChatPage(
                chatId: workAssistantChatId,
                chatKind: "assistant",
                records: buildWorkAssistantChatRecords(
                    messages: state.workAssistantMessages,
                    briefings: state.morningBriefings
                )
            ))
        }
        if !state.chatPages.contains(where: { $0.chatId == workAssistantChatId }) {
            state.chatPages.append(
                CompanionChatPage(
                chatId: workAssistantChatId,
                chatKind: "assistant",
                records: [],
                hasMore: false,
                nextBefore: nil
            ))
        }
        for detail in state.runs where !state.chatPages.contains(where: { $0.chatId == detail.run.id })
        {
            state.chatPages.append(
                companionChatPage(
                chatId: detail.run.id,
                chatKind: "agent",
                records: buildAgentChatRecords(runID: detail.run.id, messages: detail.messages)
            ))
        }
    }

    private func rebuildAssistantChatPage() {
        let records = buildWorkAssistantChatRecords(
            messages: state.workAssistantMessages,
            briefings: state.morningBriefings
        )
        replaceLiveChatPage(chatID: workAssistantChatId, chatKind: "assistant", records: records)
        if let page = chatPage(chatID: workAssistantChatId) {
            state.workAssistantMessages = page.records.compactMap(\.assistantMessage)
            state.morningBriefings = page.records.compactMap(\.morningBriefing)
        }
    }

    private func rebuildAgentChatPage(runID: String) {
        guard let detail = state.runs.first(where: { $0.run.id == runID }) else { return }
        replaceLiveChatPage(
            chatID: runID,
            chatKind: "agent",
            records: buildAgentChatRecords(runID: runID, messages: detail.messages)
        )
        if let page = chatPage(chatID: runID),
            let runIndex = state.runs.firstIndex(where: { $0.run.id == runID })
        {
            state.runs[runIndex].messages = flattenAgentChatRecords(page.records)
        }
    }

    private func replaceLiveChatPage(
        chatID: String,
        chatKind: String,
        records: [CompanionChatRecord]
    ) {
        if let index = state.chatPages.firstIndex(where: { $0.chatId == chatID }) {
            let existing = state.chatPages[index]
            let shouldRetainLoadedHistory = existing.records.count > companionInitialChatBlockLimit
            let visibleRecords =
                shouldRetainLoadedHistory
                ? records
                : Array(records.suffix(companionInitialChatBlockLimit))
            let trimmed = visibleRecords.count < records.count
            state.chatPages[index] = CompanionChatPage(
                chatId: chatID,
                chatKind: chatKind,
                records: visibleRecords,
                hasMore: existing.hasMore || trimmed,
                nextBefore: (existing.hasMore || trimmed) ? visibleRecords.first?.id : nil
            )
        } else {
            state.chatPages.append(
                companionChatPage(
                chatId: chatID,
                chatKind: chatKind,
                records: records
            ))
        }
    }

    private func mergeOlderChatPage(_ olderPage: CompanionChatPage) {
        guard let index = state.chatPages.firstIndex(where: { $0.chatId == olderPage.chatId }) else {
            state.chatPages.append(olderPage)
            updateLegacyChatCollections(from: olderPage)
            return
        }
        let merged = mergeOlderCompanionChatPage(olderPage, into: state.chatPages[index])
        state.chatPages[index] = merged
        updateLegacyChatCollections(from: merged)
    }

    private func updateLegacyChatCollections(from page: CompanionChatPage) {
        if page.chatKind == "assistant" {
            for record in page.records {
                if let message = record.assistantMessage {
                    upsert(message, in: &state.workAssistantMessages)
                }
                if let briefing = record.morningBriefing { upsert(briefing, in: &state.morningBriefings) }
            }
            return
        }
        guard let runIndex = state.runs.firstIndex(where: { $0.run.id == page.chatId }) else { return }
        state.runs[runIndex].messages = flattenAgentChatRecords(page.records)
    }

    private func upload(_ attachments: [PendingAttachment], using client: RelayClient) async throws
        -> [AttachmentDescriptor]
    {
        var uploaded: [AttachmentDescriptor] = []
        for attachment in attachments {
            uploaded.append(try await client.uploadAttachment(attachment))
        }
        return uploaded
    }

    private func cacheURL(spaceID: String?) -> URL {
        let directory = spaceID == nil
            ? cacheRootURL
            : cacheRootURL.appendingPathComponent("spaces", isDirectory: true)
        return directory.appendingPathComponent(companionCacheFileName(spaceID: spaceID))
    }

    private func cachedState(spaceID: String?, allowLegacyMigration: Bool) -> CachedState {
        let targetURL = cacheURL(spaceID: spaceID)
        if let data = try? Data(contentsOf: targetURL),
            let saved = try? JSONDecoder().decode(CachedState.self, from: data)
        {
            return saved
        }
        guard allowLegacyMigration, spaceID != nil,
            let data = try? Data(contentsOf: cacheURL(spaceID: nil)),
            let legacy = try? JSONDecoder().decode(CachedState.self, from: data)
        else { return CachedState() }
        do {
            try FileManager.default.createDirectory(
                at: targetURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try JSONEncoder().encode(legacy).write(to: targetURL, options: .atomic)
        } catch {
            operationError = "本地缓存保存失败：\(error.localizedDescription)"
        }
        return legacy
    }

    private func loadCache(spaceID: String?, allowLegacyMigration: Bool) {
        state = cachedState(spaceID: spaceID, allowLegacyMigration: allowLegacyMigration)
        reconcileChatPages()
    }

    private func persistCache() {
        let cacheURL = cacheURL(spaceID: credentials?.syncSpaceID ?? selectedAccountSyncSpaceID)
        do {
            try FileManager.default.createDirectory(
                at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(state).write(to: cacheURL, options: .atomic)
        } catch {
            operationError = "本地缓存保存失败：\(error.localizedDescription)"
        }
    }

    private func quiesceRelaySync() async {
        suspendForegroundTransport()
        let task = activeSync
        let taskID = activeSyncID
        task?.cancel()
        await task?.value
        if activeSyncID == taskID {
            activeSync = nil
            activeSyncID = nil
        }
        syncRequested = false
    }

#if DEBUG
    private func seedDesignPreview() {
        let now = "2026-08-08T03:40:00.000Z"
            state.projects = [
                Project(
            id: "sample-project",
            name: "示例项目",
            summary: "空间与服务预订平台",
            focus: "处理平台入驻与上线事项",
            status: "active",
            accent: "indigo",
            profile: ProjectProfile(
                productType: "SaaS + Marketplace",
                stage: "Growth",
                mission: "",
                vision: "",
                repoPath: "/Users/demo/Code/sample-project",
                        workspaceRoots: [
                            ProjectWorkspaceRoot(
                                id: "primary", label: "示例项目", path: "/Users/demo/Code/sample-project")
                        ],
                primaryWorkspaceRootId: "primary",
                defaultAgent: "claude",
                websiteUrl: "https://example.com",
                surfaces: ["商家工作台", "用户端小程序"],
                focusAreas: ["平台入驻", "支付与结算"],
                dataSources: ["Production PostgreSQL", "Cloudflare Analytics"],
                nextMoves: ["处理长期等待的平台入驻事项", "确认支付回调监控"],
                currentState: .empty
            )
                )
            ]
            state.morningBriefings = [
                MorningBriefing(
            id: "morning-preview",
            reportDate: "2026-08-08",
            timezone: "Asia/Shanghai",
            status: "completed",
            headline: "今天先处理 2 个需要你介入的事项",
            body: """
            ## 今天需要关注

            **示例项目** 有 4 个渠道申请仍在等待平台处理，最老一项已经等待 72.8 天。建议先确认各条记录卡在哪个审核节点，再决定是否需要人工跟进平台。

            ## 已恢复

            昨日的支付回调监控已经恢复稳定，当前没有新的失败记录，可以继续观察而不需要立即介入。

            ## 建议顺序

            1. 处理长期等待的平台入驻事项。
            2. 核对首次预订下降是否集中在特定来源或门店。
            3. 保持支付回调监控，暂不新增动作。
            """,
                    narration:
                        "早上好。今天先处理两个需要你介入的事项。示例项目有四个渠道申请仍在等待平台处理，最老一项已经等待七十二点八天，建议先确认它们分别卡在哪个审核节点。昨日的支付回调监控已经恢复稳定，当前没有新的失败记录，可以继续观察。",
            estimatedDurationSeconds: 82,
            sourceBriefingIds: [],
            signalIds: [],
            generatedAt: now,
            error: nil,
            generation: "agent"
                )
            ]
        state.workAssistantMessages = [
            WorkAssistantMessage(
                id: "assistant-preview",
                role: "assistant",
                content: "早上好。每日总结已经准备好了，你可以直接从卡片里的重点继续聊。",
                createdAt: "2026-08-08T03:39:00.000Z"
            ),
            WorkAssistantMessage(
                id: "assistant-preview-user",
                role: "user",
                content: "先帮我确认最需要跟进的项目。",
                createdAt: "2026-08-08T03:41:00.000Z"
            ),
            WorkAssistantMessage(
                id: "assistant-preview-reply",
                role: "assistant",
                content: "示例项目的平台申请等待时间最长，建议先确认这 4 条记录当前卡在哪个审核节点。",
                createdAt: "2026-08-08T03:42:00.000Z"
                ),
            ]
            state.decisions = [
                Decision(
                    id: "decision-preview", projectId: "sample-project", title: "示例项目有长期等待平台处理的申请",
                    summary: "当前 4 个渠道申请等待平台处理，最老一项已等待 72.8 天。", impact: "可能延迟项目上线", urgency: "high",
                    status: "inbox", source: "每日巡检", createdAt: now)
        ]
        state.runs = [
            RunDetail(
                    run: AgentRun(
                        id: "run-preview", projectId: "sample-project", provider: "claude",
                        title: "分析长期等待平台处理的申请", status: "running",
                        workingDirectory: "/Users/demo/Code/sample-project", summary: "", createdAt: now,
                        updatedAt: now),
                messages: [
                        AgentMessage(
                            id: "reasoning-1", runId: "run-preview", role: "assistant",
                            content: "我先确认项目的工作区说明和入驻数据所在位置。", eventType: "reasoning", toolName: nil,
                            createdAt: now),
                        AgentMessage(
                            id: "tool-1", runId: "run-preview", role: "tool",
                            content: "{\"file_path\":\"/Users/demo/Code/sample-project/AGENTS.md\"}",
                            eventType: "tool", toolName: "Read", toolStatus: "completed", toolKind: "read",
                            toolSummary: "AGENTS.md", createdAt: now),
                        AgentMessage(
                            id: "tool-2", runId: "run-preview", role: "tool",
                            content: "{\"command\":\"rg onboarding packages/api\"}", eventType: "tool",
                            toolName: "Bash", toolStatus: "completed", toolKind: "command",
                            toolSummary: "rg onboarding packages/api", createdAt: now),
                        AgentMessage(
                            id: "reasoning-2", runId: "run-preview", role: "assistant",
                            content: "已经找到生产库连接方式，接下来核对这 4 条入驻记录。", eventType: "reasoning", toolName: nil,
                            createdAt: now),
                        AgentMessage(
                            id: "tool-3", runId: "run-preview", role: "tool",
                            content: "{\"command\":\"pnpm db:query onboarding\"}", eventType: "tool",
                            toolName: "Bash", toolStatus: "completed", toolKind: "command",
                            toolSummary: "pnpm db:query onboarding", createdAt: now),
                ],
                artifacts: []
            ),
            RunDetail(
                    run: AgentRun(
                        id: "run-preview-completed", projectId: "sample-project", provider: "codex",
                        title: "汇总平台申请状态", status: "idle", workingDirectory: "/Users/demo/Code/sample-project",
                        summary: "已核对 3 条申请记录", createdAt: now, updatedAt: now),
                messages: [
                        AgentMessage(
                            id: "completed-reasoning", runId: "run-preview-completed", role: "assistant",
                            content: "我先核对入驻记录和最近一次平台回执。", eventType: "reasoning", toolName: nil,
                            createdAt: "2026-08-08T03:40:01.000Z"),
                        AgentMessage(
                            id: "completed-tool", runId: "run-preview-completed", role: "tool",
                            content: "{\"command\":\"pnpm db:query onboarding\"}", eventType: "tool",
                            toolName: "Bash", toolStatus: "completed", toolKind: "command",
                            toolSummary: "pnpm db:query onboarding", createdAt: "2026-08-08T03:40:12.000Z"),
                        AgentMessage(
                            id: "completed-result", runId: "run-preview-completed", role: "assistant",
                            content: """
                            已完成核对：

                            | 项目 | 状态 | 等待时间 |
                            | :--- | :---: | ---: |
                            | 示例项目 | 待平台处理 | 3 天 |
                            | 活动项目 | 已通过 | 1 天 |
                            | Studio | 需补充资料 | 5 天 |
                            """, eventType: nil, toolName: nil, createdAt: "2026-08-08T03:41:05.000Z"),
                ],
                artifacts: []
                ),
        ]
        if ProcessInfo.processInfo.arguments.contains("--design-preview-attachments") {
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 160))
            let image = renderer.pngData { context in
                UIColor.systemIndigo.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 160))
                ("Fuddy · 附件测试" as NSString).draw(at: CGPoint(x: 30, y: 60), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 28), .foregroundColor: UIColor.white])
            }
            let data = [PendingAttachment(id: "preview-image", name: "结果图片.png", mimeType: "image/png", data: image),
                PendingAttachment(id: "preview-report", name: "检查报告.md", mimeType: "text/markdown", data: Data("# 附件测试\n\n图片和报告已准备好。".utf8))]
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("attachment-design-preview")
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let descriptors = data.map { file in
                let url = directory.appendingPathComponent(file.name)
                try? file.data.write(to: url)
                previewAttachmentFiles[file.id] = url
                return file.descriptor(messageID: "preview-attachments", createdAt: now)
            }
            state.runs[1].messages = [AgentMessage(id: "preview-attachments", runId: "run-preview-completed", role: "assistant",
                content: "已收到图片，结果和报告如下。", eventType: nil, toolName: nil, attachments: descriptors, createdAt: now)]
        }
        if ProcessInfo.processInfo.arguments.contains("--design-preview-keyboard") {
            let messages = (1...16).map { index in
                AgentMessage(
                    id: "keyboard-message-\(index)", runId: "run-preview-completed", role: "assistant",
                    content: "键盘布局测试消息 \(index)\n\n这是一段用于验证长对话滚动位置的示例内容。打开键盘后，最新消息应保持在输入框上方；阅读历史消息时，不应跳回底部。",
                    eventType: nil, toolName: nil, createdAt: now)
            }
            state.runs[1].messages = messages
            state.workAssistantMessages = messages.map {
                WorkAssistantMessage(id: $0.id, role: "assistant", content: $0.content, createdAt: now)
            }
        }
    }
#endif
}
