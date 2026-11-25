import Foundation

let companionInitialChatBlockLimit = 100
let workAssistantChatId = "work-assistant"

func visibleRunMessages(provider: String, messages: [AgentMessage]) -> [AgentMessage] {
    let visible = messages.filter { message in
        provider != "claude" || message.eventType != "reasoning"
            || !(message.metadata?.segmentId?.hasPrefix("claude-thinking-") ?? false)
    }
    var hasFeedback = false
    var hasNewerError = false
    return visible.reversed().filter { message in
        if message.role == "user" {
            hasFeedback = false
            hasNewerError = false
        } else if message.role == "system" && message.eventType == "error" {
            let superseded = hasFeedback || hasNewerError
            hasNewerError = true
            return !superseded
        } else if message.role == "tool" || (message.role == "assistant"
            && !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
            hasFeedback = true
        }
        return true
    }.reversed()
}

/// Display projection only: retain authoritative IDs and pagination cursors.
func visibleAgentChatPage(provider: String, page: CompanionChatPage) -> CompanionChatPage {
    let visibleIDs = Set(visibleRunMessages(provider: provider,
        messages: page.records.flatMap(\.agentMessages)).map(\.id))
    let records = page.records.compactMap { record -> CompanionChatRecord? in
        let messages = record.agentMessages.filter { visibleIDs.contains($0.id) }
        guard !messages.isEmpty else { return nil }
        return CompanionChatRecord(
            id: record.id, chatId: record.chatId, chatKind: record.chatKind, kind: record.kind,
            createdAt: record.createdAt, completedAt: record.completedAt,
            assistantMessage: record.assistantMessage, agentMessages: messages, morningBriefing: record.morningBriefing
        )
    }
    return CompanionChatPage(chatId: page.chatId, chatKind: page.chatKind, records: records,
        hasMore: page.hasMore, nextBefore: page.nextBefore)
}

func buildWorkAssistantChatRecords(
    messages: [WorkAssistantMessage],
    briefings: [MorningBriefing]
) -> [CompanionChatRecord] {
    let messageRecords = messages.map { message in
        CompanionChatRecord(
            id: "assistant-message-\(message.id)",
            chatId: workAssistantChatId,
            chatKind: "assistant",
            kind: "message",
            createdAt: message.createdAt,
            completedAt: nil,
            assistantMessage: message,
            agentMessages: [],
            morningBriefing: nil
        )
    }
    let briefingRecords = briefings.filter { $0.status == "completed" }.map { briefing in
        CompanionChatRecord(
            id: "morning-briefing-\(briefing.id)",
            chatId: workAssistantChatId,
            chatKind: "assistant",
            kind: "briefing",
            createdAt: briefing.generatedAt,
            completedAt: nil,
            assistantMessage: nil,
            agentMessages: [],
            morningBriefing: briefing
        )
    }
    return (messageRecords + briefingRecords).sorted(by: companionChatRecordPrecedes)
}

private func orderAgentTimelineMessages(_ messages: [AgentMessage]) -> [AgentMessage] {
    var ordered: [AgentMessage] = []
    var turn: [AgentMessage] = []

    func appendTurn() {
        let positions = turn.indices.filter { turn[$0].metadata?.timelineOrdinal != nil }
        let nativeOrder = positions.sorted {
            let left = turn[$0].metadata?.timelineOrdinal ?? 0
            let right = turn[$1].metadata?.timelineOrdinal ?? 0
            return left == right ? $0 < $1 : left < right
        }
        var sortedTurn = turn
        for (position, source) in zip(positions, nativeOrder) { sortedTurn[position] = turn[source] }
        ordered.append(contentsOf: sortedTurn)
        turn.removeAll(keepingCapacity: true)
    }

    for message in messages {
        if message.role == "user" && message.metadata?.steered != true {
            appendTurn()
            ordered.append(message)
        } else {
            turn.append(message)
        }
    }
    appendTurn()
    return ordered
}

func buildAgentChatRecords(runID: String, messages: [AgentMessage]) -> [CompanionChatRecord] {
    var records: [CompanionChatRecord] = []
    var processMessages: [AgentMessage] = []

    func processRecord(completedAt: String?) -> CompanionChatRecord? {
        guard let first = processMessages.first else { return nil }
        return CompanionChatRecord(
            id: "process-\(first.id)",
            chatId: runID,
            chatKind: "agent",
            kind: "process",
            createdAt: first.createdAt,
            completedAt: completedAt,
            assistantMessage: nil,
            agentMessages: processMessages,
            morningBriefing: nil
        )
    }

    for message in orderAgentTimelineMessages(messages) {
        if message.eventType == "reasoning" || message.role == "tool" {
            processMessages.append(message)
            continue
        }
        if let record = processRecord(completedAt: message.role == "assistant" && message.eventType == nil
            ? message.createdAt : nil) {
            records.append(record)
            processMessages.removeAll(keepingCapacity: true)
        }
        records.append(CompanionChatRecord(
            id: "agent-message-\(message.id)",
            chatId: runID,
            chatKind: "agent",
            kind: "message",
            createdAt: message.createdAt,
            completedAt: nil,
            assistantMessage: nil,
            agentMessages: [message],
            morningBriefing: nil
        ))
    }
    if let record = processRecord(completedAt: nil) { records.append(record) }
    return records
}

func companionChatPage(
    chatId: String,
    chatKind: String,
    records: [CompanionChatRecord],
    hasMore: Bool = false,
    nextBefore: String? = nil
) -> CompanionChatPage {
    CompanionChatPage(
        chatId: chatId,
        chatKind: chatKind,
        records: Array(records.suffix(companionInitialChatBlockLimit)),
        hasMore: hasMore || records.count > companionInitialChatBlockLimit,
        nextBefore: records.count > companionInitialChatBlockLimit
            ? records.suffix(companionInitialChatBlockLimit).first?.id
            : nextBefore
    )
}

func mergeOlderCompanionChatPage(
    _ olderPage: CompanionChatPage,
    into currentPage: CompanionChatPage
) -> CompanionChatPage {
    let olderIDs = Set(olderPage.records.map(\.id))
    let records = olderPage.records + currentPage.records.filter { !olderIDs.contains($0.id) }
    return CompanionChatPage(
        chatId: currentPage.chatId,
        chatKind: currentPage.chatKind,
        records: currentPage.chatKind == "agent" ? records : records.sorted(by: companionChatRecordPrecedes),
        hasMore: olderPage.hasMore,
        nextBefore: olderPage.nextBefore
    )
}

func flattenAgentChatRecords(_ records: [CompanionChatRecord]) -> [AgentMessage] {
    records.flatMap(\.agentMessages)
}

private func companionChatRecordPrecedes(
    _ left: CompanionChatRecord,
    _ right: CompanionChatRecord
) -> Bool {
    left.createdAt == right.createdAt ? left.id < right.id : left.createdAt < right.createdAt
}
