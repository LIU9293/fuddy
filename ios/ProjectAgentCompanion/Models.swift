import Foundation

let companionProtocolVersion = 1
let defaultCompanionRelayURL = "https://project-agent-companion-relay.moghub.workers.dev"

func parseCompanionDate(_ value: String) -> Date? {
    let fractionalFormatter = ISO8601DateFormatter()
    fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractionalFormatter.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
}

struct PairingPayload: Codable {
    let protocolVersion: Int
    let relayUrl: String
    let accountId: String
    let pairingSecret: String
}

struct PairingClaimResult: Codable {
    let protocolVersion: Int
    let accountId: String
    let device: CompanionDevice
    let deviceToken: String
}

struct CompanionDevice: Codable {
    let id: String
    let role: String
    let platform: String
    let name: String
    let publicKey: String?
    let createdAt: String
    let lastSeenAt: String?
}

struct CompanionCredentials: Codable {
    let relayURL: String
    let accountID: String
    let deviceID: String
    let deviceToken: String
}

struct SyncEventPage: Codable {
    let events: [SyncEvent]
    let lastSequence: Int
    let presence: CompanionPresence?
}

struct CompanionPresence: Codable {
    let macOnline: Bool
    let iosDevicesOnline: Int
    let updatedAt: String
}

struct SyncEvent: Codable, Identifiable {
    let eventId: String
    let sequence: Int
    let protocolVersion: Int
    let type: String
    let entityType: String
    let entityId: String
    let revision: Int64
    let payload: JSONValue
    let sourceDeviceId: String
    let occurredAt: String

    var id: String { eventId }
}

struct SocketEnvelope: Codable {
    let type: String
    let event: SyncEvent?
    let command: CommandResult?
    let lastSequence: Int?
    let presence: CompanionPresence?
}

func companionReplayCursor(cachedSequence: Int, remoteSequence: Int) -> Int {
    remoteSequence < cachedSequence ? 0 : cachedSequence
}

struct CommandInput<Payload: Codable>: Codable {
    let commandId: String
    let protocolVersion: Int
    let type: String
    let payload: Payload
    let createdAt: String
}

struct CommandResult: Codable {
    let commandId: String
    let type: String?
    let status: String
    let result: JSONValue?
    let error: String?
}

struct AgentSendMessagePayload: Codable {
    let runId: String
    let prompt: String
    let attachments: [AttachmentDescriptor]
    let clientMessageId: String
}
struct AssistantSendMessagePayload: Codable { let prompt: String; let attachments: [AttachmentDescriptor] }
struct AssistantExecuteActionPayload: Codable { let messageId: String; let proposalId: String; let optionId: String }
struct AgentRenamePayload: Codable { let runId: String; let title: String }
struct AgentDraftPromptPayload: Codable { let runId: String; let draftPrompt: String }
struct AgentArchivePayload: Codable { let runId: String }
struct DecisionStatusPayload: Codable { let decisionId: String; let status: String }
struct DecisionHandlePayload: Codable { let decisionId: String; let runId: String }
struct ProjectUpdatePayload: Codable { let project: Project }
struct ArtifactUploadRequestPayload: Codable { let artifactId: String }
struct ArtifactUploadResult: Codable {
    let artifactId: String
    let attachment: AttachmentDescriptor
}

struct ProjectWorkspaceRoot: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var path: String
}

struct ProjectCurrentState: Codable, Hashable {
    var summary: String
    var facts: [String]
    var source: String
    var updatedAt: String?

    static let empty = ProjectCurrentState(summary: "", facts: [], source: "user", updatedAt: nil)
}

struct ProjectProfile: Codable, Hashable {
    var productType: String
    var stage: String
    var mission: String
    var vision: String
    var repoPath: String
    var workspaceRoots: [ProjectWorkspaceRoot]
    var primaryWorkspaceRootId: String?
    var defaultAgent: String
    var websiteUrl: String?
    var surfaces: [String]
    var focusAreas: [String]
    var dataSources: [String]
    var nextMoves: [String]
    var currentState: ProjectCurrentState

    static let empty = ProjectProfile(
        productType: "",
        stage: "",
        mission: "",
        vision: "",
        repoPath: "",
        workspaceRoots: [],
        primaryWorkspaceRootId: nil,
        defaultAgent: "pi",
        websiteUrl: nil,
        surfaces: [],
        focusAreas: [],
        dataSources: [],
        nextMoves: [],
        currentState: .empty
    )
}

struct Project: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var icon: String?
    var summary: String
    var focus: String
    var status: String
    var accent: String
    var profile: ProjectProfile

    init(
        id: String,
        name: String,
        icon: String? = nil,
        summary: String,
        focus: String,
        status: String,
        accent: String,
        profile: ProjectProfile = .empty
    ) {
        self.id = id
        self.name = name
        self.icon = icon
        self.summary = summary
        self.focus = focus
        self.status = status
        self.accent = accent
        self.profile = profile
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        icon = try container.decodeIfPresent(String.self, forKey: .icon)
        summary = try container.decode(String.self, forKey: .summary)
        focus = try container.decode(String.self, forKey: .focus)
        status = try container.decode(String.self, forKey: .status)
        accent = try container.decode(String.self, forKey: .accent)
        profile = try container.decodeIfPresent(ProjectProfile.self, forKey: .profile) ?? .empty
    }
}

struct GoalMilestone: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let status: String
    let dueAt: String?
}

struct ProjectGoal: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    var title: String
    var description: String
    var status: String
    var priority: String
    var progress: Double
    var agentSummary: String
    var milestones: [GoalMilestone]
    var updatedAt: String
}

struct WorkAssistantActionPayload: Codable, Hashable {
    let runId: String?
    let draftPrompt: String?
    let projectId: String?
    let decisionId: String?
    let goalId: String?
    let milestoneId: String?
    let title: String?
    let name: String?
    let summary: String?
    let focus: String?
    let mission: String?
    let vision: String?
    let productType: String?
    let stage: String?
    let websiteUrl: String?
    let workspacePath: String?
    let defaultAgent: String?
}

struct WorkAssistantActionOption: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let style: String
    let capability: String
    let payload: WorkAssistantActionPayload
}

struct WorkAssistantActionProposal: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let description: String
    let status: String
    let context: String?
    let options: [WorkAssistantActionOption]
    let acceptedOptionId: String?
    let createdAt: String
    let resolvedAt: String?
}

struct WorkAssistantMessage: Codable, Identifiable, Hashable {
    let id: String
    let briefingId: String?
    let role: String
    let content: String
    let attachments: [AttachmentDescriptor]
    let linkedRunId: String?
    let actions: [WorkAssistantActionProposal]
    let createdAt: String

    init(
        id: String,
        briefingId: String? = nil,
        role: String,
        content: String,
        attachments: [AttachmentDescriptor] = [],
        linkedRunId: String? = nil,
        actions: [WorkAssistantActionProposal] = [],
        createdAt: String
    ) {
        self.id = id
        self.briefingId = briefingId
        self.role = role
        self.content = content
        self.attachments = attachments
        self.linkedRunId = linkedRunId
        self.actions = actions
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        briefingId = try container.decodeIfPresent(String.self, forKey: .briefingId)
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        attachments = try container.decodeIfPresent([AttachmentDescriptor].self, forKey: .attachments) ?? []
        linkedRunId = try container.decodeIfPresent(String.self, forKey: .linkedRunId)
        actions = try container.decodeIfPresent([WorkAssistantActionProposal].self, forKey: .actions) ?? []
        createdAt = try container.decode(String.self, forKey: .createdAt)
    }
}

struct MorningBriefing: Codable, Identifiable, Hashable {
    let id: String
    let reportDate: String
    let timezone: String
    let status: String
    let headline: String
    let body: String
    let narration: String
    let estimatedDurationSeconds: Int
    let sourceBriefingIds: [String]
    let signalIds: [String]
    let generatedAt: String
    let error: String?
    let generation: String
}

struct Decision: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String?
    var title: String
    var summary: String
    var impact: String
    var urgency: String
    var status: String
    var waitingReason: String? = nil
    var statusSummary: String? = nil
    var statusUpdatedAt: String? = nil
    var reopenCount: Int? = nil
    var source: String
    var createdAt: String
    var evidenceRefs: [DecisionEvidence] = []
    var resolvedAt: String? = nil
    var resolutionSummary: String? = nil
}

struct DecisionEvidence: Codable, Hashable {
    let label: String
    let uri: String
}

struct AgentRun: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String?
    var decisionId: String? = nil
    var provider: String
    var title: String
    var status: String
    var workingDirectory: String?
    var summary: String
    var draftPrompt: String? = nil
    var createdAt: String
    var updatedAt: String
}

struct AgentMessage: Codable, Identifiable, Hashable {
    let id: String
    let runId: String
    let role: String
    let content: String
    let eventType: String?
    let toolName: String?
    let createdAt: String
}

struct AgentArtifact: Codable, Identifiable, Hashable {
    let id: String
    let runId: String
    let projectId: String?
    let relativePath: String
    let label: String
    let mimeType: String?
    let createdAt: String
}

struct AttachmentDescriptor: Codable, Identifiable, Hashable {
    let id: String
    let messageId: String?
    let artifactId: String?
    let filename: String
    let mimeType: String
    let size: Int
    let sha256: String
    let width: Int?
    let height: Int?
    let thumbnailAttachmentId: String?
    let createdAt: String
}

struct RunDetail: Codable, Identifiable {
    var run: AgentRun
    var messages: [AgentMessage]
    var artifacts: [AgentArtifact]
    var id: String { run.id }
}

func upsertAgentMessage(_ message: AgentMessage, in runs: inout [RunDetail]) {
    guard let runIndex = runs.firstIndex(where: { $0.run.id == message.runId }) else { return }
    if let messageIndex = runs[runIndex].messages.firstIndex(where: { $0.id == message.id }) {
        runs[runIndex].messages[messageIndex] = message
    } else {
        runs[runIndex].messages.append(message)
    }
}

@discardableResult
func acknowledgePendingAgentMessage(_ messageID: String, in runs: inout [RunDetail]) -> Bool {
    guard let runIndex = runs.firstIndex(where: { detail in
        detail.messages.contains(where: { $0.id == messageID && $0.eventType == "pending" })
    }), let messageIndex = runs[runIndex].messages.firstIndex(where: {
        $0.id == messageID && $0.eventType == "pending"
    }) else { return false }

    let pending = runs[runIndex].messages[messageIndex]
    runs[runIndex].messages[messageIndex] = AgentMessage(
        id: pending.id,
        runId: pending.runId,
        role: pending.role,
        content: pending.content,
        eventType: nil,
        toolName: pending.toolName,
        createdAt: pending.createdAt
    )
    return true
}

struct SnapshotPayload: Codable {
    let generatedAt: String
    let projects: [Project]
    let goals: [ProjectGoal]
    let decisions: [Decision]
    let morningBriefings: [MorningBriefing]?
    let workAssistantMessages: [WorkAssistantMessage]
    let attachments: [AttachmentDescriptor]?
    let runs: [RunDetail]
}

struct ArtifactEventPayload: Codable {
    let artifact: AgentArtifact
    let attachment: AttachmentDescriptor?
}

struct CachedState: Codable {
    var projects: [Project] = []
    var goals: [ProjectGoal] = []
    var decisions: [Decision] = []
    var morningBriefings: [MorningBriefing] = []
    var workAssistantMessages: [WorkAssistantMessage] = []
    var runs: [RunDetail] = []
    var attachments: [String: AttachmentDescriptor] = [:]
    var lastSequence = 0

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projects = try container.decodeIfPresent([Project].self, forKey: .projects) ?? []
        goals = try container.decodeIfPresent([ProjectGoal].self, forKey: .goals) ?? []
        decisions = try container.decodeIfPresent([Decision].self, forKey: .decisions) ?? []
        morningBriefings = try container.decodeIfPresent([MorningBriefing].self, forKey: .morningBriefings) ?? []
        workAssistantMessages = try container.decodeIfPresent([WorkAssistantMessage].self, forKey: .workAssistantMessages) ?? []
        runs = try container.decodeIfPresent([RunDetail].self, forKey: .runs) ?? []
        attachments = try container.decodeIfPresent([String: AttachmentDescriptor].self, forKey: .attachments) ?? [:]
        lastSequence = try container.decodeIfPresent(Int.self, forKey: .lastSequence) ?? 0
    }
}

enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    func decode<T: Decodable>(_ type: T.Type, using decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: JSONEncoder().encode(self))
    }
}
