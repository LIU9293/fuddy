import SwiftUI
import XCTest
@testable import ProjectAgentCompanion

final class SyncModelTests: XCTestCase {
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

    func testPairingPayloadDecodesMacPayload() throws {
        let payload = #"{"minimumProtocolVersion":1,"protocolVersion":2,"relayUrl":"https://relay.example.com","accountId":"account","pairingSecret":"secret"}"#
        let decoded = try JSONDecoder().decode(PairingPayload.self, from: Data(payload.utf8))
        XCTAssertEqual(decoded.minimumProtocolVersion, 1)
        XCTAssertEqual(decoded.protocolVersion, 2)
        XCTAssertEqual(decoded.accountId, "account")
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

    func testToolCallsAreGroupedOnlyBetweenThinkingMessages() {
        let messages = [
            AgentMessage(id: "thinking-1", runId: "run", role: "assistant", content: "先检查", eventType: "reasoning", toolName: nil, createdAt: "1"),
            AgentMessage(id: "tool-1", runId: "run", role: "tool", content: "one", eventType: "tool", toolName: "Read", createdAt: "2"),
            AgentMessage(id: "tool-2", runId: "run", role: "tool", content: "two", eventType: "tool", toolName: "Bash", createdAt: "3"),
            AgentMessage(id: "thinking-2", runId: "run", role: "assistant", content: "继续分析", eventType: "reasoning", toolName: nil, createdAt: "4"),
            AgentMessage(id: "tool-3", runId: "run", role: "tool", content: "three", eventType: "tool", toolName: "Read", createdAt: "5")
        ]

        let blocks = groupRunMessages(messages)
        XCTAssertEqual(blocks.count, 4)
        if case .toolGroup(let firstGroup) = blocks[1] { XCTAssertEqual(firstGroup.map(\.id), ["tool-1", "tool-2"]) }
        else { XCTFail("Expected first tool group") }
        if case .toolGroup(let secondGroup) = blocks[3] { XCTAssertEqual(secondGroup.map(\.id), ["tool-3"]) }
        else { XCTFail("Expected second tool group") }
    }

    func testCompletedRunProcessCollapsesBeforeResultMessage() {
        let messages = [
            AgentMessage(id: "user", runId: "run", role: "user", content: "开始", eventType: nil, toolName: nil, createdAt: "2026-08-09T00:00:00.000Z"),
            AgentMessage(id: "thinking", runId: "run", role: "assistant", content: "先检查", eventType: "reasoning", toolName: nil, createdAt: "2026-08-09T00:00:01.000Z"),
            AgentMessage(id: "tool", runId: "run", role: "tool", content: "完成", eventType: "tool", toolName: "Bash", createdAt: "2026-08-09T00:00:15.000Z"),
            AgentMessage(id: "result", runId: "run", role: "assistant", content: "结果", eventType: nil, toolName: nil, createdAt: "2026-08-09T00:01:05.000Z")
        ]

        let blocks = groupRunMessages(messages)
        XCTAssertEqual(blocks.count, 3)
        if case .process(let processMessages, let completedAt) = blocks[1] {
            XCTAssertEqual(processMessages.map(\.id), ["thinking", "tool"])
            XCTAssertEqual(completedAt, messages[3].createdAt)
        } else {
            XCTFail("Expected a collapsed process block")
        }
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

        XCTAssertEqual(groupRunMessages(messages).count, 2)
        if case .message(let message) = groupRunMessages(messages)[0] {
            XCTAssertEqual(message.id, "thinking")
        } else {
            XCTFail("Expected visible thinking")
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
        let json = #"{"id":"tool-1","runId":"run-1","role":"tool","content":"short summary","eventType":"tool","toolName":"Bash","toolStatus":"failed","createdAt":"2026-08-11T00:00:00Z"}"#
        let message = try JSONDecoder().decode(AgentMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.toolStatus, "failed")
        XCTAssertEqual(message.content, "short summary")
    }

    func testCompanionTransportRunsOnlyWhileSceneIsActive() {
        XCTAssertTrue(companionShouldRunForegroundTransport(for: .active))
        XCTAssertFalse(companionShouldRunForegroundTransport(for: .inactive))
        XCTAssertFalse(companionShouldRunForegroundTransport(for: .background))
    }

    func testCommandFailureSocketEnvelopeDecodesWithoutPayloadDetails() throws {
        let json = #"{"type":"command.updated","command":{"commandId":"command-1","protocolVersion":1,"type":"agent.send-message","payload":{},"sourceDeviceId":"ios-1","status":"failed","result":null,"error":"Run 不存在","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:01Z"}}"#
        let envelope = try JSONDecoder().decode(SocketEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.command?.commandId, "command-1")
        XCTAssertEqual(envelope.command?.error, "Run 不存在")
    }

    func testArtifactUploadCommandDecodesAttachmentResult() throws {
        let json = #"{"type":"command.updated","command":{"commandId":"upload-1","protocolVersion":1,"type":"artifact.request-upload","payload":{"artifactId":"artifact-1"},"sourceDeviceId":"ios-1","status":"completed","result":{"artifactId":"artifact-1","attachment":{"id":"artifact-1","messageId":null,"artifactId":"artifact-1","filename":"launch.md","mimeType":"text/markdown","size":8,"sha256":"abc","width":null,"height":null,"thumbnailAttachmentId":null,"createdAt":"2026-08-10T00:00:00Z"}},"error":null,"createdAt":"2026-08-10T00:00:00Z","updatedAt":"2026-08-10T00:00:01Z"}}"#
        let envelope = try JSONDecoder().decode(SocketEnvelope.self, from: Data(json.utf8))
        let result = try XCTUnwrap(envelope.command?.result).decode(ArtifactUploadResult.self)

        XCTAssertEqual(envelope.command?.type, .artifactRequestUpload)
        XCTAssertEqual(result.artifactId, "artifact-1")
        XCTAssertEqual(result.attachment.filename, "launch.md")
    }

    func testSyncReadyResetsCursorWhenPairingAccountHasEarlierSequence() throws {
        let json = #"{"type":"sync.ready","lastSequence":136,"presence":{"macOnline":true,"iosDevicesOnline":1,"updatedAt":"2026-08-08T00:00:00Z"}}"#
        let envelope = try JSONDecoder().decode(SocketEnvelope.self, from: Data(json.utf8))

        XCTAssertEqual(envelope.lastSequence, 136)
        XCTAssertEqual(envelope.presence?.macOnline, true)
        XCTAssertEqual(companionReplayCursor(cachedSequence: 141, remoteSequence: 136), 0)
        XCTAssertEqual(companionReplayCursor(cachedSequence: 120, remoteSequence: 136), 120)
    }

    func testCompanionSocketReconnectsAfterMissedHeartbeat() {
        XCTAssertEqual(companionSocketHeartbeatIntervalSeconds, 20)
        XCTAssertFalse(companionSocketHeartbeatShouldReconnect(awaitingPong: false))
        XCTAssertTrue(companionSocketHeartbeatShouldReconnect(awaitingPong: true))
    }

    func testCompanionPagingClampsAtBothOuterEdges() {
        XCTAssertEqual(companionClampedPageDrag(translation: 90, pageWidth: 390, isLeadingPage: true), 0)
        XCTAssertEqual(companionClampedPageDrag(translation: -500, pageWidth: 390, isLeadingPage: true), -390)
        XCTAssertEqual(companionClampedPageDrag(translation: -90, pageWidth: 390, isLeadingPage: false), 0)
        XCTAssertEqual(companionClampedPageDrag(translation: 500, pageWidth: 390, isLeadingPage: false), 390)
    }

    func testCompanionPagingChangesOnlyTowardTheOtherPage() {
        XCTAssertTrue(companionShouldChangePage(
            translation: -80,
            predictedTranslation: -90,
            pageWidth: 390,
            towardTrailingPage: true
        ))
        XCTAssertFalse(companionShouldChangePage(
            translation: 80,
            predictedTranslation: 90,
            pageWidth: 390,
            towardTrailingPage: true
        ))
        XCTAssertTrue(companionShouldChangePage(
            translation: 80,
            predictedTranslation: 90,
            pageWidth: 390,
            towardTrailingPage: false
        ))
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
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 700, viewportHeight: 844, bottomInset: 144),
            0
        )
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 745, viewportHeight: 844, bottomInset: 144),
            45
        )
        XCTAssertEqual(
            companionDistanceFromLatest(bottomY: 12, viewportHeight: 100, bottomInset: 120),
            12
        )
    }
}
