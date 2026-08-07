import Foundation

let companionProtocolVersion = 1
let defaultCompanionRelayURL = "https://project-agent-companion-relay.moghub.workers.dev"

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
    let status: String
    let error: String?
}

struct AgentSendMessagePayload: Codable { let runId: String; let prompt: String }
struct AssistantSendMessagePayload: Codable { let prompt: String }
struct AgentRenamePayload: Codable { let runId: String; let title: String }
struct AgentArchivePayload: Codable { let runId: String }
struct DecisionStatusPayload: Codable { let decisionId: String; let status: String }

struct Project: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var summary: String
    var focus: String
    var status: String
    var accent: String
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

struct WorkAssistantMessage: Codable, Identifiable, Hashable {
    let id: String
    let briefingId: String?
    let role: String
    let content: String
    let attachments: [AttachmentDescriptor]
    let createdAt: String

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        briefingId = try container.decodeIfPresent(String.self, forKey: .briefingId)
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        attachments = try container.decodeIfPresent([AttachmentDescriptor].self, forKey: .attachments) ?? []
        createdAt = try container.decode(String.self, forKey: .createdAt)
    }
}

struct Decision: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String?
    var title: String
    var summary: String
    var impact: String
    var urgency: String
    var status: String
    var source: String
    var createdAt: String
}

struct AgentRun: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String?
    var provider: String
    var title: String
    var status: String
    var workingDirectory: String?
    var summary: String
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

struct SnapshotPayload: Codable {
    let generatedAt: String
    let projects: [Project]
    let goals: [ProjectGoal]
    let decisions: [Decision]
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
