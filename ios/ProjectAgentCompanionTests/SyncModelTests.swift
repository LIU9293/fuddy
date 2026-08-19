import CryptoKit
import SwiftUI
import XCTest
@testable import ProjectAgentCompanion

private final class AccountClientURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class SyncModelTests: XCTestCase {
    func testPreferredAccountSyncSpaceUsesSavedHostOrMostRecentHost() {
        let first = AccountSyncSpace(
            id: "space-a",
            hostId: "host-a",
            name: "A",
            keyVersion: 1,
            relayUrl: "https://relay.example.com",
            relayAccountId: "relay-a",
            hostName: "Mac A",
            hostLastSeenAt: "2026-08-19T00:00:00Z"
        )
        let second = AccountSyncSpace(
            id: "space-b",
            hostId: "host-b",
            name: "B",
            keyVersion: 1,
            relayUrl: "https://relay.example.com",
            relayAccountId: "relay-b",
            hostName: "Mac B",
            hostLastSeenAt: "2026-08-19T00:00:00Z"
        )

        XCTAssertEqual(preferredAccountSyncSpace(from: [first], preferredID: nil)?.id, "space-a")
        XCTAssertEqual(preferredAccountSyncSpace(from: [first, second], preferredID: nil)?.id, "space-a")
        XCTAssertEqual(preferredAccountSyncSpace(from: [first, second], preferredID: "space-b")?.id, "space-b")
        XCTAssertEqual(preferredAccountSyncSpace(from: [first, second], preferredID: "removed-space")?.id, "space-a")
    }

    func testAccountSpacesUseDistinctCacheFiles() {
        XCTAssertEqual(companionCacheFileName(spaceID: nil), "state.json")
        XCTAssertNotEqual(
            companionCacheFileName(spaceID: "space-a"),
            companionCacheFileName(spaceID: "space-b")
        )
        XCTAssertFalse(companionCacheFileName(spaceID: "space/a").contains("/"))
    }

    func testRelayCredentialsRemainIsolatedPerAccountSpace() throws {
        KeychainStore.deleteAll()
        defer { KeychainStore.deleteAll() }
        let first = CompanionCredentials(
            relayURL: "https://fuddy.ai/api/relay",
            accountID: "relay-a",
            deviceID: "phone-a",
            deviceToken: "token-a",
            syncSpaceID: "space-a"
        )
        let second = CompanionCredentials(
            relayURL: "https://fuddy.ai/api/relay",
            accountID: "relay-b",
            deviceID: "phone-a",
            deviceToken: "token-b",
            syncSpaceID: "space-b"
        )

        try KeychainStore.save(first)
        try KeychainStore.save(second)

        XCTAssertEqual(try KeychainStore.load(syncSpaceID: "space-a")?.accountID, "relay-a")
        XCTAssertEqual(try KeychainStore.load(syncSpaceID: "space-b")?.accountID, "relay-b")
        XCTAssertNil(try KeychainStore.load(syncSpaceID: "space-c"))
    }

    func testAccountCredentialsReenrollWhenSpaceRelayIdentityRotates() {
        let space = AccountSyncSpace(
            id: "space-a",
            hostId: "host-a",
            name: "A",
            keyVersion: 1,
            relayUrl: "https://fuddy.ai/api/relay/",
            relayAccountId: "next-relay-account",
            hostName: "Mac A",
            hostLastSeenAt: "2026-08-19T00:00:00Z"
        )
        let current = CompanionCredentials(
            relayURL: "https://fuddy.ai/api/relay",
            accountID: "next-relay-account",
            deviceID: "phone-a",
            deviceToken: "token",
            syncSpaceID: "space-a"
        )
        let stale = CompanionCredentials(
            relayURL: "https://fuddy.ai/api/relay",
            accountID: "old-relay-account",
            deviceID: "phone-a",
            deviceToken: "token",
            syncSpaceID: "space-a"
        )

        XCTAssertFalse(accountCredentialsNeedEnrollment(
            current,
            accountDeviceID: "phone-a",
            selectedSpace: space
        ))
        XCTAssertTrue(accountCredentialsNeedEnrollment(
            stale,
            accountDeviceID: "phone-a",
            selectedSpace: space
        ))
    }

    func testAccountDeviceGrantUsesSPKIAndOpensOnlyForTheRequestedPhone() throws {
        let phone = P256.KeyAgreement.PrivateKey()
        let mac = P256.KeyAgreement.PrivateKey()
        let phoneSPKI = AccountDeviceGrant.subjectPublicKeyInfo(phone.publicKey)
        XCTAssertEqual(phoneSPKI.count, 91)
        XCTAssertEqual(phoneSPKI.suffix(65), phone.publicKey.x963Representation)

        let salt = Data(repeating: 7, count: 32)
        let nonceData = Data(repeating: 5, count: 12)
        let sharedSecret = try mac.sharedSecretFromKeyAgreement(with: phone.publicKey)
        let key = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: Data("fuddy-sync-space-grant-v1".utf8),
            outputByteCount: 32
        )
        let credentials = CompanionCredentials(
            relayURL: "https://fuddy.ai/api/relay/",
            accountID: "relay-account",
            deviceID: "phone-1",
            deviceToken: "secret-token",
            encryptionKey: "secret-key",
            encryptionKeyId: "key-id"
        )
        let associatedData = Data("fuddy-enrollment:grant-1:space-1:phone-1:v1".utf8)
        let sealed = try AES.GCM.seal(
            JSONEncoder().encode(credentials),
            using: key,
            nonce: AES.GCM.Nonce(data: nonceData),
            authenticating: associatedData
        )
        let envelope = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "algorithm": "P256-HKDF-SHA256-A256GCM",
            "senderPublicKey": AccountDeviceGrant.subjectPublicKeyInfo(mac.publicKey).base64EncodedString(),
            "salt": salt.base64EncodedString(),
            "nonce": nonceData.base64EncodedString(),
            "ciphertext": sealed.ciphertext.base64EncodedString(),
            "tag": sealed.tag.base64EncodedString()
        ])
        let opened = try AccountDeviceGrant.open(
            String(decoding: envelope, as: UTF8.self),
            enrollmentID: "grant-1",
            spaceID: "space-1",
            deviceID: "phone-1",
            privateKeyData: phone.rawRepresentation
        )
        XCTAssertEqual(opened.deviceToken, "secret-token")
        XCTAssertEqual(opened.relayURL, "https://fuddy.ai/api/relay/")
        XCTAssertThrowsError(try AccountDeviceGrant.open(
            String(decoding: envelope, as: UTF8.self),
            enrollmentID: "grant-1",
            spaceID: "space-1",
            deviceID: "another-phone",
            privateKeyData: phone.rawRepresentation
        ))
    }

    func testAccountSessionDecodesMacAccountAPIResponse() throws {
        let json = #"{"user":{"id":"user-1","email":"kai@example.com","displayName":null},"device":{"id":"device-1","platform":"ios","name":"iPhone","hostId":null,"syncSpaceId":null},"session":{"accessToken":"access","refreshToken":"refresh","accessExpiresAt":"2026-08-19T01:00:00.000Z","refreshExpiresAt":"2026-09-18T01:00:00.000Z"}}"#
        let session = try JSONDecoder().decode(MobileAccountSession.self, from: Data(json.utf8))
        XCTAssertEqual(session.user.email, "kai@example.com")
        XCTAssertEqual(session.device.platform, "ios")
        XCTAssertEqual(session.session.refreshToken, "refresh")
    }

    @MainActor
    func testAccountRefreshesAreCoalescedAndLateStaleCallersReuseTheRotation() async throws {
        let coordinator = AccountRefreshCoordinator()
        let stale = MobileAccountSession(
            user: AccountUser(id: "user-1", email: "kai@example.com", displayName: nil),
            device: AccountDevice(
                id: "phone-1",
                platform: "ios",
                name: "iPhone",
                hostId: nil,
                syncSpaceId: nil
            ),
            session: AccountSessionTokens(
                accessToken: "old-access",
                refreshToken: "old-refresh",
                accessExpiresAt: "2026-08-19T00:00:00.000Z",
                refreshExpiresAt: "2099-08-19T00:00:00.000Z"
            )
        )
        let refreshed = MobileAccountSession(
            user: stale.user,
            device: stale.device,
            session: AccountSessionTokens(
                accessToken: "new-access",
                refreshToken: "new-refresh",
                accessExpiresAt: "2099-08-19T00:15:00.000Z",
                refreshExpiresAt: "2099-09-18T00:00:00.000Z"
            )
        )
        var refreshCount = 0
        let operation: @MainActor (MobileAccountSession) async throws -> MobileAccountSession = { _ in
            refreshCount += 1
            try await Task.sleep(for: .milliseconds(20))
            return refreshed
        }

        async let first = coordinator.refreshedSession(accountSession: stale, operation: operation)
        async let second = coordinator.refreshedSession(accountSession: stale, operation: operation)
        let results = try await [first, second]
        XCTAssertEqual(results, [refreshed, refreshed])
        XCTAssertEqual(refreshCount, 1)

        let late = try await coordinator.refreshedSession(accountSession: stale, operation: operation)
        XCTAssertEqual(late, refreshed)
        XCTAssertEqual(refreshCount, 1)
    }

    @MainActor
    func testAccountLogoutRefreshesAnExpiredAccessTokenBeforeRevokingTheSession() async throws {
        let stale = MobileAccountSession(
            user: AccountUser(id: "logout-user", email: "logout@example.com", displayName: nil),
            device: AccountDevice(
                id: "logout-phone",
                platform: "ios",
                name: "iPhone",
                hostId: nil,
                syncSpaceId: nil
            ),
            session: AccountSessionTokens(
                accessToken: "expired-access",
                refreshToken: "valid-refresh",
                accessExpiresAt: "2026-08-19T00:00:00.000Z",
                refreshExpiresAt: "2099-08-19T00:00:00.000Z"
            )
        )
        var observations: [String] = []
        AccountClientURLProtocolStub.handler = { request in
            let path = request.url?.path ?? ""
            let authorization = request.value(forHTTPHeaderField: "Authorization") ?? ""
            observations.append("\(path)|\(authorization)")
            let status: Int
            let body: Data
            switch (path, authorization) {
            case ("/v1/auth/logout", "Bearer expired-access"):
                status = 401
                body = Data(#"{"error":{"code":"session_expired","message":"expired"}}"#.utf8)
            case ("/v1/auth/refresh", ""):
                status = 200
                body = Data(#"{"session":{"accessToken":"fresh-access","refreshToken":"fresh-refresh","accessExpiresAt":"2099-08-19T00:15:00.000Z","refreshExpiresAt":"2099-09-18T00:00:00.000Z"}}"#.utf8)
            case ("/v1/auth/logout", "Bearer fresh-access"):
                status = 204
                body = Data()
            default:
                status = 500
                body = Data()
            }
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                body
            )
        }
        defer { AccountClientURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountClientURLProtocolStub.self]
        let client = AccountClient(
            baseURL: URL(string: "https://account.test")!,
            urlSession: URLSession(configuration: configuration)
        )

        let refreshed = try await client.logout(accountSession: stale)

        XCTAssertEqual(refreshed.session.accessToken, "fresh-access")
        XCTAssertEqual(refreshed.session.refreshToken, "fresh-refresh")
        XCTAssertEqual(observations, [
            "/v1/auth/logout|Bearer expired-access",
            "/v1/auth/refresh|",
            "/v1/auth/logout|Bearer fresh-access"
        ])
    }

    func testCompanionContractFingerprintRejectsMixedClientBuilds() {
        XCTAssertTrue(companionContractFingerprintIsSupported(companionContractFingerprint))
        XCTAssertTrue(companionContractFingerprintIsSupported(nil))
        XCTAssertFalse(companionContractFingerprintIsSupported("different-contract"))
    }

    func testPendingCreatedRunCorrelationSurvivesCacheRoundTrip() throws {
        var state = CachedState()
        state.pendingCreatedRunIDs["command-1"] = "run-1"

        let restored = try JSONDecoder().decode(CachedState.self, from: JSONEncoder().encode(state))
        let legacy = try JSONDecoder().decode(CachedState.self, from: Data(#"{"lastSequence":4}"#.utf8))

        XCTAssertEqual(restored.pendingCreatedRunIDs, ["command-1": "run-1"])
        XCTAssertEqual(legacy.pendingCreatedRunIDs, [:])
    }

    func testGeneratedSnapshotPayloadKeepsLegacyOptionalCollectionsCompatible() throws {
        let payload = """
        {
          "generatedAt": "2026-08-14T15:00:00.000Z",
          "projects": [],
          "goals": [],
          "decisions": [],
          "workAssistantMessages": [],
          "runs": []
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(SnapshotPayload.self, from: payload)
        XCTAssertNil(snapshot.modelLabels)
        XCTAssertNil(snapshot.morningBriefings)
        XCTAssertNil(snapshot.attachments)
        XCTAssertNil(snapshot.chatPages)
    }

    func testNotificationRunIDAcceptsOnlyNonEmptyRunIdentifiers() {
        XCTAssertEqual(companionNotificationRunID(["runId": "run-1"]), "run-1")
        XCTAssertNil(companionNotificationRunID(["runId": "   "]))
        XCTAssertNil(companionNotificationRunID(["sequence": 42]))
    }

    func testCompanionDateParsesFractionalAndWholeSecondTimestamps() {
        XCTAssertNotNil(parseCompanionDate("2026-08-07T17:55:03.145Z"))
        XCTAssertNotNil(parseCompanionDate("2026-08-07T17:55:03Z"))
        XCTAssertNil(parseCompanionDate("not-a-date"))
    }

    func testRelayURLComponentsPreserveCanonicalBasePath() throws {
        let components = try XCTUnwrap(companionRelayURLComponents(
            baseURL: "https://fuddy.ai/api/relay/",
            path: "/v1/events"
        ))
        XCTAssertEqual(components.url?.absoluteString, "https://fuddy.ai/api/relay/v1/events")
        XCTAssertNil(companionRelayURLComponents(
            baseURL: "https://user:secret@fuddy.ai/api/relay",
            path: "/v1/events"
        ))
    }

    func testCompanionCryptoRoundTripsJSONAndAttachments() throws {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let envelope = try CompanionCrypto.sealJSON(
            ["prompt": "private command"],
            key: key,
            associatedData: "command:test"
        )
        XCTAssertFalse(envelope.ciphertext.contains("private command"))
        let decoded = try CompanionCrypto.openJSON(
            [String: String].self,
            envelope: envelope,
            key: key,
            associatedData: "command:test"
        )
        XCTAssertEqual(decoded["prompt"], "private command")

        let plaintext = Data("private attachment".utf8)
        let sealed = try CompanionCrypto.sealAttachment(plaintext, key: key, associatedData: "attachment:test")
        XCTAssertFalse(String(decoding: sealed, as: UTF8.self).contains("private attachment"))
        XCTAssertEqual(
            try CompanionCrypto.openAttachment(sealed, key: key, associatedData: "attachment:test"),
            plaintext
        )
        XCTAssertThrowsError(try CompanionCrypto.openAttachment(sealed, key: key, associatedData: "attachment:other"))
    }

    func testUnknownFutureEventTypeRemainsDecodable() throws {
        let payload = #"{"eventId":"event-1","sequence":1,"protocolVersion":1,"type":"future.created","entityType":"future","entityId":"future-1","revision":1,"payload":{},"sourceDeviceId":"mac-1","occurredAt":"2026-08-12T05:00:00.000Z"}"#
        let event = try JSONDecoder().decode(SyncEvent.self, from: Data(payload.utf8))
        XCTAssertEqual(event.type, .unknown("future.created"))
    }

    func testCompanionProtocolSupportUsesGeneratedCompatibilityRange() {
        XCTAssertTrue(companionProtocolVersionIsSupported(companionProtocolVersion))
        XCTAssertTrue(companionProtocolVersionIsSupported(companionMinimumProtocolVersion))
        XCTAssertFalse(companionProtocolVersionIsSupported(companionMinimumProtocolVersion - 1))
        XCTAssertFalse(companionProtocolVersionIsSupported(companionProtocolVersion + 1))
        XCTAssertTrue(companionProtocolRangeSupportsLocalVersion(
            minimumVersion: companionProtocolVersion,
            currentVersion: companionProtocolVersion + 1
        ))
        XCTAssertFalse(companionProtocolRangeSupportsLocalVersion(
            minimumVersion: companionProtocolVersion + 1,
            currentVersion: companionProtocolVersion + 2
        ))
    }

    func testGenericEventPayloadDecodesAgentRun() throws {
        let json = #"{"eventId":"e1","sequence":1,"protocolVersion":1,"type":"agent-run.updated","entityType":"agent-run","entityId":"r1","revision":1,"payload":{"id":"r1","projectId":null,"decisionId":"d1","provider":"codex","title":"Test","status":"draft","workingDirectory":null,"summary":"Done","draftPrompt":"先检查素材，不要发送。","createdAt":"2026-08-07T00:00:00.000Z","updatedAt":"2026-08-07T00:00:00.000Z"},"sourceDeviceId":"mac","occurredAt":"2026-08-07T00:00:00.000Z"}"#
        let event = try JSONDecoder().decode(SyncEvent.self, from: Data(json.utf8))
        let run = try event.payload.decode(AgentRun.self)
        XCTAssertEqual(run.title, "Test")
        XCTAssertEqual(run.decisionId, "d1")
        XCTAssertEqual(run.draftPrompt, "先检查素材，不要发送。")
    }

    func testModelLabelsDecodeForBothChatComposers() throws {
        let json = #"{"workAssistant":"5.6 Medium","providers":{"pi":"5.6","codex":"5.6 Sol High"}}"#
        let labels = try JSONDecoder().decode(AgentModelLabels.self, from: Data(json.utf8))
        XCTAssertEqual(labels.workAssistant, "5.6 Medium")
        XCTAssertEqual(labels.label(for: "codex"), "5.6 Sol High")
        XCTAssertEqual(labels.label(for: "claude"), "Claude Default")
    }

    func testCompletedDecisionDecodesResolutionEvidence() throws {
        let json = #"{"id":"d1","projectId":"roombase","title":"处理长期等待事项","summary":"仍有待处理记录","impact":"影响上线","urgency":"high","status":"resolved","source":"每日巡检","createdAt":"2026-08-07T00:00:00.000Z","evidenceRefs":[{"label":"GitHub PR #351","uri":"https://github.com/example/repo/pull/351"}],"resolvedAt":"2026-08-09T10:00:00.000Z","resolutionSummary":"关联 PR #351 已合并。"}"#
        let decision = try JSONDecoder().decode(Decision.self, from: Data(json.utf8))
        XCTAssertEqual(decision.status, "resolved")
        XCTAssertEqual(decision.resolutionSummary, "关联 PR #351 已合并。")
        XCTAssertEqual(decision.evidenceRefs.first?.label, "GitHub PR #351")
    }

    func testWorkAssistantMessageDecodesLinkedRunCard() throws {
        let json = #"{"id":"m1","briefingId":null,"role":"assistant","content":"已创建草稿 Run。","attachments":[],"linkedRunId":"r1","createdAt":"2026-08-07T00:00:00.000Z"}"#
        let message = try JSONDecoder().decode(WorkAssistantMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.linkedRunId, "r1")
    }

    func testWorkAssistantRunCardDoesNotLeakOntoLaterUserMessages() throws {
        let json = #"{"id":"m1","briefingId":null,"role":"user","content":"创建 Fuddy Run","attachments":[],"linkedRunId":"old-roombase-run","createdAt":"2026-08-07T00:00:00.000Z"}"#
        let message = try JSONDecoder().decode(WorkAssistantMessage.self, from: Data(json.utf8))
        XCTAssertEqual(workAssistantLinkedRunIDs(for: message), [])
    }

    func testPendingCreateRunDoesNotDisplayAStaleLinkedRun() throws {
        let json = #"{"id":"m1","briefingId":null,"role":"assistant","content":"请确认","attachments":[],"linkedRunId":"old-roombase-run","actions":[{"id":"p1","title":"创建 Run","description":"确认后创建","status":"pending","context":null,"options":[{"id":"create","label":"创建并打开","style":"primary","capability":"agent-run.create","payload":{"runId":null,"draftPrompt":"开始","projectId":"fuddy","decisionId":null,"goalId":null,"milestoneId":null,"title":"Fuddy 任务","name":null,"summary":null,"focus":null,"mission":null,"vision":null,"productType":null,"stage":null,"websiteUrl":null,"workspacePath":null,"defaultAgent":null}}],"acceptedOptionId":null,"createdAt":"2026-08-07T00:00:00.000Z","resolvedAt":null}],"createdAt":"2026-08-07T00:00:00.000Z"}"#
        let message = try JSONDecoder().decode(WorkAssistantMessage.self, from: Data(json.utf8))
        XCTAssertEqual(workAssistantLinkedRunIDs(for: message), [])
    }

    func testProjectDecodesCurrentProfileAndLegacyCache() throws {
        let current = #"{"id":"roombase","name":"Roombase","icon":"🏠","summary":"Summary","focus":"Focus","status":"active","accent":"indigo","profile":{"productType":"SaaS","stage":"Growth","mission":"","vision":"","repoPath":"/code/room","workspaceRoots":[{"id":"primary","label":"Room","path":"/code/room"}],"primaryWorkspaceRootId":"primary","defaultAgent":"claude","websiteUrl":"https://example.com","surfaces":["Dashboard"],"focusAreas":[],"dataSources":[],"nextMoves":[],"currentState":{"summary":"","facts":[],"source":"user","updatedAt":null}}}"#
        let decoded = try JSONDecoder().decode(Project.self, from: Data(current.utf8))
        XCTAssertEqual(decoded.profile.workspaceRoots.first?.path, "/code/room")
        XCTAssertEqual(decoded.profile.defaultAgent, "claude")
        XCTAssertEqual(decoded.icon, "🏠")

        let legacy = #"{"id":"legacy","name":"Legacy","summary":"Summary","focus":"Focus","status":"watching","accent":"gray"}"#
        let legacyDecoded = try JSONDecoder().decode(Project.self, from: Data(legacy.utf8))
        XCTAssertEqual(legacyDecoded.profile, .empty)
        XCTAssertNil(legacyDecoded.icon)
    }

    func testProjectIconDecodesRasterImageDataURL() {
        let bytes = Data([0x89, 0x50, 0x4e, 0x47])
        let icon = "data:image/png;base64,\(bytes.base64EncodedString())"
        XCTAssertEqual(projectIconImageData(icon), bytes)
        XCTAssertNil(projectIconImageData("🚀"))
        XCTAssertNil(projectIconImageData("data:image/svg+xml;base64,PHN2Zz4="))
    }

    func testRunListGroupsByProjectAndKeepsSharedRunsSeparate() {
        let projects = [
            Project(id: "project-b", name: "Project B", summary: "", focus: "", status: "active", accent: "blue"),
            Project(id: "project-a", name: "Project A", summary: "", focus: "", status: "active", accent: "purple")
        ]
        func detail(_ id: String, _ projectID: String?) -> RunDetail {
            RunDetail(
                run: AgentRun(
                    id: id,
                    projectId: projectID,
                    provider: "codex",
                    title: id,
                    status: "draft",
                    workingDirectory: nil,
                    summary: "",
                    createdAt: "1",
                    updatedAt: "1"
                ),
                messages: [],
                artifacts: []
            )
        }

        let groups = groupRunDetailsByProject([
            detail("a-1", "project-a"),
            detail("shared-1", nil),
            detail("b-1", "project-b"),
            detail("orphaned-1", "removed-project")
        ], projects: projects)

        XCTAssertEqual(groups.map(\.title), ["Project B", "Project A", "共享任务"])
        XCTAssertEqual(groups.map { $0.runs.map(\.id) }, [["b-1"], ["a-1"], ["shared-1", "orphaned-1"]])
    }

    func testToolCallsAreGroupedIntoTheSameStagesAsMac() {
        let messages = [
            AgentMessage(id: "thinking-1", runId: "run", role: "assistant", content: "先检查", eventType: "reasoning", toolName: nil, createdAt: "1"),
            AgentMessage(id: "tool-1", runId: "run", role: "tool", content: "one", eventType: "tool", toolName: "Read", createdAt: "2"),
            AgentMessage(id: "tool-2", runId: "run", role: "tool", content: "two", eventType: "tool", toolName: "Bash", createdAt: "3"),
            AgentMessage(id: "thinking-2", runId: "run", role: "assistant", content: "继续分析", eventType: "reasoning", toolName: nil, createdAt: "4"),
            AgentMessage(id: "tool-3", runId: "run", role: "tool", content: "three", eventType: "tool", toolName: "Read", createdAt: "5")
        ]

        let stages = groupRunActivityStages(messages)
        XCTAssertEqual(stages.count, 2)
        XCTAssertEqual(stages[0].reasoning?.id, "thinking-1")
        XCTAssertEqual(stages[0].tools.map(\.id), ["tool-1", "tool-2"])
        XCTAssertEqual(stages[1].reasoning?.id, "thinking-2")
        XCTAssertEqual(stages[1].tools.map(\.id), ["tool-3"])
    }

    func testCompletedRunProcessCollapsesBeforeResultMessage() {
        let messages = [
            AgentMessage(id: "user", runId: "run", role: "user", content: "开始", eventType: nil, toolName: nil, createdAt: "2026-08-09T00:00:00.000Z"),
            AgentMessage(id: "thinking", runId: "run", role: "assistant", content: "先检查", eventType: "reasoning", toolName: nil, createdAt: "2026-08-09T00:00:01.000Z"),
            AgentMessage(id: "tool", runId: "run", role: "tool", content: "完成", eventType: "tool", toolName: "Bash", createdAt: "2026-08-09T00:00:15.000Z"),
            AgentMessage(id: "result", runId: "run", role: "assistant", content: "结果", eventType: nil, toolName: nil, createdAt: "2026-08-09T00:01:05.000Z")
        ]

        let blocks = buildAgentChatRecords(runID: "run", messages: messages)
        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks[1].kind, "process")
        XCTAssertEqual(blocks[1].agentMessages.map(\.id), ["thinking", "tool"])
        XCTAssertEqual(blocks[1].completedAt, messages[3].createdAt)
        XCTAssertEqual(
            formatRunProcessDuration(startedAt: messages[1].createdAt, completedAt: messages[3].createdAt),
            "耗时 1 分 4 秒"
        )
    }

    func testUnfinishedRunProcessStaysVisible() {
        let messages = [
            AgentMessage(id: "thinking", runId: "run", role: "assistant", content: "先检查", eventType: "reasoning", toolName: nil, createdAt: "1"),
            AgentMessage(id: "tool", runId: "run", role: "tool", content: "读取", eventType: "tool", toolName: "Read", createdAt: "2")
        ]

        let records = buildAgentChatRecords(runID: "run", messages: messages)
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].kind, "process")
        XCTAssertNil(records[0].completedAt)
        XCTAssertEqual(records[0].agentMessages.map(\.id), ["thinking", "tool"])
    }

    func testRunProcessKeepsItsScrollIdentityWhenItCompletes() {
        let processMessages = [
            AgentMessage(id: "thinking", runId: "run", role: "assistant", content: "先检查", eventType: "reasoning", toolName: nil, createdAt: "1"),
            AgentMessage(id: "tool", runId: "run", role: "tool", content: "读取", eventType: "tool", toolName: "Read", createdAt: "2")
        ]
        let activeID = buildAgentChatRecords(runID: "run", messages: processMessages)[0].id
        let completedID = buildAgentChatRecords(runID: "run", messages: processMessages + [
            AgentMessage(id: "result", runId: "run", role: "assistant", content: "完成", eventType: nil, toolName: nil, createdAt: "3")
        ])[0].id

        XCTAssertEqual(activeID, "process-thinking")
        XCTAssertEqual(completedID, activeID)
    }

    func testCodexClaudeAndOpenCodeFixturesShareOneStageContract() {
        let providerFixtures: [[AgentMessage]] = [
            [
                AgentMessage(id: "codex-reasoning", runId: "codex", role: "assistant", content: "先检查迁移。", eventType: "reasoning", toolName: nil, createdAt: "1"),
                AgentMessage(id: "codex-command", runId: "codex", role: "tool", content: "npm test", eventType: "tool", toolName: "command", toolStatus: "completed", toolKind: "command", toolSummary: "npm test", createdAt: "2")
            ],
            [
                AgentMessage(id: "claude-reasoning", runId: "claude", role: "assistant", content: "先梳理组件。", eventType: "reasoning", toolName: nil, createdAt: "1"),
                AgentMessage(id: "claude-read", runId: "claude", role: "tool", content: "raw", eventType: "tool", toolName: "Read", toolStatus: "completed", toolKind: "read", toolSummary: "RootViews.swift", createdAt: "2")
            ],
            [
                AgentMessage(id: "opencode-reasoning", runId: "opencode", role: "assistant", content: "先核对依赖。", eventType: "reasoning", toolName: nil, createdAt: "1"),
                AgentMessage(id: "opencode-read", runId: "opencode", role: "tool", content: "raw", eventType: "tool", toolName: "read", toolStatus: "completed", toolKind: "read", toolSummary: "package.json", createdAt: "2")
            ]
        ]

        for messages in providerFixtures {
            let stages = groupRunActivityStages(messages)
            XCTAssertEqual(stages.count, 1)
            XCTAssertNotNil(stages[0].reasoning)
            XCTAssertEqual(stages[0].tools.count, 1)
            XCTAssertFalse(stages[0].tools[0].toolSummary?.isEmpty ?? true)
        }
    }

    func testMobileMarkdownParsesBlockElements() {
        let markdown = """
        # 标题

        这是 **重点**。

        - 第一项
        - 第二项

        1. 步骤一
        2. 步骤二

        > 一条引用

        ```swift
        let ready = true
        ```
        """

        XCTAssertEqual(parseMobileMarkdown(markdown), [
            .heading(level: 1, text: "标题"),
            .paragraph("这是 **重点**。"),
            .unorderedList(["第一项", "第二项"]),
            .orderedList(["步骤一", "步骤二"]),
            .quote("一条引用"),
            .code("let ready = true")
        ])
    }

    func testMobileMarkdownParsesGFMTable() {
        let markdown = """
        | 项目 | 状态 | 等待时间 |
        | :--- | :---: | ---: |
        | Roombase | 待处理 | 3 天 |
        | Vows | 已完成 | 1 天 |
        """

        XCTAssertEqual(parseMobileMarkdown(markdown), [
            .table(
                headers: ["项目", "状态", "等待时间"],
                alignments: [.leading, .center, .trailing],
                rows: [
                    ["Roombase", "待处理", "3 天"],
                    ["Vows", "已完成", "1 天"]
                ]
            )
        ])
    }

    func testConfirmedAgentMessageReplacesOptimisticMessage() {
        let run = AgentRun(
            id: "run",
            projectId: nil,
            provider: "claude",
            title: "Test",
            status: "running",
            workingDirectory: nil,
            summary: "",
            createdAt: "1",
            updatedAt: "1"
        )
        let pending = AgentMessage(
            id: "command-1",
            runId: "run",
            role: "user",
            content: "Hello",
            eventType: "pending",
            toolName: nil,
            createdAt: "2"
        )
        var runs = [RunDetail(run: run, messages: [pending], artifacts: [])]
        let confirmed = AgentMessage(
            id: "command-1",
            runId: "run",
            role: "user",
            content: "Hello",
            eventType: nil,
            toolName: nil,
            createdAt: "2"
        )

        upsertAgentMessage(confirmed, in: &runs)

        XCTAssertEqual(runs[0].messages.count, 1)
        XCTAssertNil(runs[0].messages[0].eventType)
    }

    func testExecutingCommandAcknowledgesOptimisticAgentMessage() {
        let run = AgentRun(
            id: "run",
            projectId: nil,
            provider: "claude",
            title: "Test",
            status: "running",
            workingDirectory: nil,
            summary: "",
            createdAt: "1",
            updatedAt: "1"
        )
        let pending = AgentMessage(
            id: "command-1",
            runId: "run",
            role: "user",
            content: "Hello",
            eventType: "pending",
            toolName: nil,
            createdAt: "2"
        )
        var runs = [RunDetail(run: run, messages: [pending], artifacts: [])]

        XCTAssertTrue(acknowledgePendingAgentMessage("command-1", in: &runs))
        XCTAssertNil(runs[0].messages[0].eventType)
        XCTAssertFalse(acknowledgePendingAgentMessage("missing", in: &runs))
    }

    func testCompanionTransportUsesEventDrivenFallbackPolicy() {
        XCTAssertEqual(companionFallbackSyncIntervalSeconds, 60)
        XCTAssertEqual(companionConnectedFallbackSyncIntervalSeconds, 300)
        XCTAssertEqual(companionFallbackSyncIntervalSeconds(realtimeConnected: false), 60)
        XCTAssertEqual(companionFallbackSyncIntervalSeconds(realtimeConnected: true), 300)
        XCTAssertEqual([0, 1, 2, 3, 10].map(companionReconnectDelaySeconds), [5, 15, 60, 60, 60])
    }

    func testRelayToolSummaryDecodesStatus() throws {
        let json = #"{"id":"tool-1","runId":"run-1","role":"tool","content":"raw output","eventType":"tool","toolName":"Bash","toolStatus":"failed","toolKind":"command","toolSummary":"npm test","createdAt":"2026-08-11T00:00:00Z"}"#
        let message = try JSONDecoder().decode(AgentMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.toolStatus, "failed")
        XCTAssertEqual(message.toolKind, "command")
        XCTAssertEqual(message.toolSummary, "npm test")
        XCTAssertEqual(message.content, "raw output")
    }

    func testCompanionTransportRunsOnlyWhileSceneIsActive() {
        XCTAssertTrue(companionShouldRunForegroundTransport(for: .active))
        XCTAssertFalse(companionShouldRunForegroundTransport(for: .inactive))
        XCTAssertFalse(companionShouldRunForegroundTransport(for: .background))
    }

    func testCommandStatusSocketEnvelopeDecodesWithoutOutcomeDetails() throws {
        let json = #"{"type":"command.updated","command":{"commandId":"command-1","protocolVersion":2,"type":"agent.send-message","payload":{"algorithm":"A256GCM","keyId":"abcdefghijklmnop","nonce":"abcdefghijklmnop","ciphertext":"encrypted"},"sourceDeviceId":"ios-1","status":"failed","result":null,"error":null,"createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:01Z"}}"#
        let envelope = try JSONDecoder().decode(SocketEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.command?.commandId, "command-1")
        XCTAssertEqual(envelope.command?.status, "failed")
        XCTAssertNil(envelope.command?.result)
        XCTAssertNil(envelope.command?.error)
    }

    func testArtifactUploadCommandSocketDoesNotExposeAttachmentResult() throws {
        let json = #"{"type":"command.updated","command":{"commandId":"upload-1","protocolVersion":2,"type":"artifact.request-upload","payload":{"algorithm":"A256GCM","keyId":"abcdefghijklmnop","nonce":"abcdefghijklmnop","ciphertext":"encrypted"},"sourceDeviceId":"ios-1","status":"completed","result":null,"error":null,"createdAt":"2026-08-10T00:00:00Z","updatedAt":"2026-08-10T00:00:01Z"}}"#
        let envelope = try JSONDecoder().decode(SocketEnvelope.self, from: Data(json.utf8))

        XCTAssertEqual(envelope.command?.type, .artifactRequestUpload)
        XCTAssertNil(envelope.command?.result)
        XCTAssertNil(envelope.command?.error)
    }

    func testSyncReadyResetsCursorWhenPairingAccountHasEarlierSequence() throws {
        let json = #"{"type":"sync.ready","lastSequence":136,"presence":{"macOnline":true,"iosDevicesOnline":1,"updatedAt":"2026-08-08T00:00:00Z"}}"#
        let envelope = try JSONDecoder().decode(SocketEnvelope.self, from: Data(json.utf8))

        XCTAssertEqual(envelope.lastSequence, 136)
        XCTAssertEqual(envelope.presence?.macOnline, true)
        XCTAssertEqual(companionReplayCursor(cachedSequence: 141, remoteSequence: 136), 0)
        XCTAssertEqual(companionReplayCursor(cachedSequence: 120, remoteSequence: 136), 120)

        var cachedState = CachedState()
        cachedState.lastSequence = 141
        cachedState.modelLabels.workAssistant = "保留现有聊天"
        XCTAssertTrue(companionResetReplayCursorIfNeeded(state: &cachedState, remoteSequence: 136))
        XCTAssertEqual(cachedState.lastSequence, 0)
        XCTAssertEqual(cachedState.modelLabels.workAssistant, "保留现有聊天")
    }

    func testCompanionSocketReconnectsAfterMissedHeartbeat() {
        XCTAssertEqual(companionSocketHeartbeatIntervalSeconds, 20)
        XCTAssertFalse(companionSocketHeartbeatShouldReconnect(awaitingPong: false))
        XCTAssertTrue(companionSocketHeartbeatShouldReconnect(awaitingPong: true))
    }

    func testCompanionDrawerUsesContinuousRevealAndProjectedSnap() {
        XCTAssertEqual(companionClampedDrawerReveal(
            origin: 0,
            translation: 500,
            drawerWidth: 300
        ), 300)
        XCTAssertEqual(companionClampedDrawerReveal(
            origin: 300,
            translation: -40,
            drawerWidth: 300
        ), 260)
        XCTAssertTrue(companionDrawerTargetIsPresented(
            currentReveal: 80,
            predictedReveal: 190,
            drawerWidth: 300
        ))
        XCTAssertTrue(companionDrawerTargetIsPresented(
            currentReveal: 190,
            predictedReveal: 190,
            drawerWidth: 300
        ))
        XCTAssertFalse(companionDrawerTargetIsPresented(
            currentReveal: 220,
            predictedReveal: 100,
            drawerWidth: 300
        ))
    }

    func testDrawerCanOpenFromRootListsAndSettingsOnly() {
        XCTAssertTrue(companionCanOpenDrawer(section: .assistant, pathIsEmpty: true))
        XCTAssertTrue(companionCanOpenDrawer(section: .projects, pathIsEmpty: true))
        XCTAssertTrue(companionCanOpenDrawer(section: .inbox, pathIsEmpty: true))
        XCTAssertTrue(companionCanOpenDrawer(section: .settings, pathIsEmpty: true))
        XCTAssertFalse(companionCanOpenDrawer(section: .runs, pathIsEmpty: true))
        XCTAssertFalse(companionCanOpenDrawer(section: .projects, pathIsEmpty: false))
    }

    func testChatLatestDistanceUsesVisibleAreaAboveComposer() {
        XCTAssertEqual(companionChatLatestDistanceThreshold, 50)
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 700, viewportHeight: 844, bottomInset: 144),
            0
        )
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 745, viewportHeight: 844, bottomInset: 144),
            45
        )
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 750, viewportHeight: 844, bottomInset: 144),
            companionChatLatestDistanceThreshold
        )
        XCTAssertGreaterThan(
            companionDistanceFromLatest(bottomY: 751, viewportHeight: 844, bottomInset: 144),
            companionChatLatestDistanceThreshold
        )
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 12, viewportHeight: 100, bottomInset: 120),
            12
        )
    }

    func testCompanionChatPageKeepsNewestHundredBlocks() {
        let messages = (0..<125).map { index in
            WorkAssistantMessage(
                id: "message-\(index)",
                role: index.isMultiple(of: 2) ? "user" : "assistant",
                content: "Message \(index)",
                createdAt: String(format: "2026-01-01T00:00:00.%03dZ", index)
            )
        }
        let page = companionChatPage(
            chatId: workAssistantChatId,
            chatKind: "assistant",
            records: buildWorkAssistantChatRecords(messages: messages, briefings: [])
        )

        XCTAssertEqual(page.records.count, companionInitialChatBlockLimit)
        XCTAssertEqual(page.records.first?.assistantMessage?.id, "message-25")
        XCTAssertEqual(page.records.last?.assistantMessage?.id, "message-124")
        XCTAssertTrue(page.hasMore)
        XCTAssertEqual(page.nextBefore, "assistant-message-message-25")
    }

    func testAgentChatRecordsKeepProcessEventsInOneBlock() {
        let messages = [
            AgentMessage(id: "user", runId: "run", role: "user", content: "Go", eventType: nil, toolName: nil, createdAt: "2026-01-01T00:00:00.000Z"),
            AgentMessage(id: "reasoning", runId: "run", role: "assistant", content: "Think", eventType: "reasoning", toolName: nil, createdAt: "2026-01-01T00:00:01.000Z"),
            AgentMessage(id: "tool", runId: "run", role: "tool", content: "Read", eventType: "tool", toolName: "Read", createdAt: "2026-01-01T00:00:02.000Z"),
            AgentMessage(id: "answer", runId: "run", role: "assistant", content: "Done", eventType: nil, toolName: nil, createdAt: "2026-01-01T00:00:03.000Z")
        ]
        let records = buildAgentChatRecords(runID: "run", messages: messages)

        XCTAssertEqual(records.map(\.id), ["agent-message-user", "process-reasoning", "agent-message-answer"])
        XCTAssertEqual(records[1].agentMessages.map(\.id), ["reasoning", "tool"])
        XCTAssertEqual(records[1].completedAt, "2026-01-01T00:00:03.000Z")
    }

    func testMergingOlderChatPagePreservesCurrentRecordsAndCursor() {
        let oldRecord = buildWorkAssistantChatRecords(
            messages: [WorkAssistantMessage(id: "old", role: "assistant", content: "Old", createdAt: "2026-01-01T00:00:00.000Z")],
            briefings: []
        )[0]
        let currentRecord = buildWorkAssistantChatRecords(
            messages: [WorkAssistantMessage(id: "current", role: "assistant", content: "Current", createdAt: "2026-01-01T00:01:00.000Z")],
            briefings: []
        )[0]
        let current = CompanionChatPage(chatId: workAssistantChatId, chatKind: "assistant", records: [currentRecord], hasMore: true, nextBefore: currentRecord.id)
        let older = CompanionChatPage(chatId: workAssistantChatId, chatKind: "assistant", records: [oldRecord], hasMore: false, nextBefore: nil)

        let merged = mergeOlderCompanionChatPage(older, into: current)
        XCTAssertEqual(merged.records.map(\.id), [oldRecord.id, currentRecord.id])
        XCTAssertFalse(merged.hasMore)
        XCTAssertNil(merged.nextBefore)
    }
}
