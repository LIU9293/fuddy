import Foundation

let companionInitialChatBlockLimit = 100
let workAssistantChatId = "work-assistant"

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

    for message in messages {
        if message.eventType == "reasoning" || message.role == "tool" {
            processMessages.append(message)
            continue
        }
        if let record = processRecord(completedAt: message.role == "assistant" ? message.createdAt : nil) {
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
    var recordsByID = Dictionary(uniqueKeysWithValues: currentPage.records.map { ($0.id, $0) })
    for record in olderPage.records { recordsByID[record.id] = record }
    return CompanionChatPage(
        chatId: currentPage.chatId,
        chatKind: currentPage.chatKind,
        records: recordsByID.values.sorted(by: companionChatRecordPrecedes),
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
