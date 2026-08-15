import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  companionCommandPayloadDefinitions,
  companionCommandTypes,
  companionEventDefinitions,
  companionProtocol,
  companionSwiftWireDefinitions
} from '../src/shared/companion-protocol.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const swiftDestination = resolve(repositoryRoot, 'ios/ProjectAgentCompanion/CompanionProtocol.generated.swift')
const typescriptDestination = resolve(repositoryRoot, 'src/shared/companion-contract.generated.ts')

const contractDeclarations = {
  'src/shared/contracts.ts': [
    'ProjectWorkspaceRoot', 'ProjectCurrentState', 'ProjectProfile', 'Project', 'EvidenceRef',
    'DecisionItem', 'GoalMetric', 'GoalMilestone', 'GoalCheckIn', 'ProjectGoal', 'AgentRun',
    'AgentRunMessage', 'AgentRunArtifact', 'MorningBriefing', 'BriefingMessage',
    'WorkAssistantTaskReference', 'WorkAssistantTaskContext', 'WorkAssistantImageAttachment',
    'WorkAssistantActionOption', 'WorkAssistantActionProposal'
  ],
  'src/shared/companion-sync.ts': [
    'CompanionAttachmentDescriptor', 'CompanionSnapshotPayload', 'CompanionArtifactEventPayload',
    'CompanionChatRecord', 'CompanionChatPage',
  ],
  'src/shared/model-display.ts': ['AgentModelLabels']
}

function declarationText(relativePath, names) {
  const path = resolve(repositoryRoot, relativePath)
  const sourceText = readFileSync(path, 'utf8')
  const found = new Map()
  for (const name of names) {
    const start = sourceText.indexOf(`export interface ${name}`)
    if (start < 0) continue
    const bodyStart = sourceText.indexOf('{', start)
    let depth = 0
    let end = bodyStart
    for (; end < sourceText.length; end += 1) {
      if (sourceText[end] === '{') depth += 1
      if (sourceText[end] === '}') depth -= 1
      if (depth === 0) break
    }
    found.set(name, sourceText.slice(start, end + 1))
  }
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) {
    throw new Error(`Missing Companion contract declarations in ${relativePath}: ${missing.join(', ')}`)
  }
  return names.map((name) => found.get(name).replace(/\s+/g, ' ').trim()).join('\n')
}

function canonicalSourceFile(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const contractSource = [
  JSON.stringify({
    companionProtocol,
    companionEventDefinitions,
    companionCommandPayloadDefinitions,
    companionSwiftWireDefinitions
  }),
  canonicalSourceFile('src/shared/companion-schemas.ts'),
  ...Object.entries(contractDeclarations).map(([path, names]) => declarationText(path, names))
].join('\n')
const contractFingerprint = createHash('sha256').update(contractSource).digest('hex').slice(0, 24)

function swiftCase(value) {
  const words = value.split(/[.-]/g)
  return words[0] + words.slice(1).map((word) => word[0].toUpperCase() + word.slice(1)).join('')
}

function swiftStringEnum(name, values) {
  const cases = values.map((value) => `    case ${swiftCase(value)}`).join('\n')
  const rawValues = values.map((value) => `        case .${swiftCase(value)}: ${JSON.stringify(value)}`).join('\n')
  const decodeCases = values.map((value) => `        case ${JSON.stringify(value)}: self = .${swiftCase(value)}`).join('\n')
  return `enum ${name}: Hashable, Codable {
${cases}
    case unknown(String)

    var rawValue: String {
        switch self {
${rawValues}
        case .unknown(let value): value
        }
    }

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value {
${decodeCases}
        default: self = .unknown(value)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}`
}

const swiftFieldTypes = {
  string: 'String',
  'optional-string': 'String?',
  int: 'Int',
  int64: 'Int64',
  'optional-json': 'JSONValue?',
  attachments: '[AttachmentDescriptor]',
  'optional-attachments': '[AttachmentDescriptor]?',
  'decision-status': 'String',
  project: 'Project'
}

function swiftFieldType(type) {
  if (swiftFieldTypes[type]) return swiftFieldTypes[type]
  for (const [prefix, render] of [
    ['ref:', (value) => value],
    ['optional-ref:', (value) => `${value}?`],
    ['array:', (value) => `[${value}]`],
    ['optional-array:', (value) => `[${value}]?`]
  ]) {
    if (type.startsWith(prefix)) return render(type.slice(prefix.length))
  }
  throw new Error(`Unsupported Swift wire field type: ${type}`)
}

function swiftPayloadStruct({ swiftName, fields }) {
  const properties = Object.entries(fields)
    .map(([name, type]) => `    let ${name}: ${swiftFieldType(type)}`)
    .join('\n')
  return `struct ${swiftName}: Codable {\n${properties}\n}`
}

const swiftCommandPayloads = companionCommandTypes
  .map((type) => swiftPayloadStruct(companionCommandPayloadDefinitions[type]))
  .join('\n\n')

const swiftWirePayloads = Object.values(companionSwiftWireDefinitions)
  .map(swiftPayloadStruct)
  .join('\n\n')

const generated = `// Generated by scripts/generate-companion-contracts.mjs. Do not edit by hand.
import Foundation

let companionMinimumProtocolVersion = ${companionProtocol.minimumVersion}
let companionProtocolVersion = ${companionProtocol.currentVersion}
let companionContractFingerprint = ${JSON.stringify(contractFingerprint)}

func companionProtocolVersionIsSupported(_ version: Int) -> Bool {
    version >= companionMinimumProtocolVersion && version <= companionProtocolVersion
}

func companionProtocolRangeSupportsLocalVersion(minimumVersion: Int, currentVersion: Int) -> Bool {
    companionProtocolVersion >= minimumVersion && companionProtocolVersion <= currentVersion
}

func companionContractFingerprintIsSupported(_ fingerprint: String?) -> Bool {
    fingerprint == nil || fingerprint == companionContractFingerprint
}

${swiftStringEnum('CompanionEventType', Object.keys(companionEventDefinitions))}

${swiftStringEnum('CompanionCommandType', companionCommandTypes)}

${swiftCommandPayloads}

${swiftWirePayloads}
`

const generatedTypescript = `// Generated by scripts/generate-companion-contracts.mjs. Do not edit by hand.\nexport const companionContractFingerprint = ${JSON.stringify(contractFingerprint)} as const\n`

if (process.argv.includes('--check')) {
  let currentSwift = ''
  let currentTypescript = ''
  try { currentSwift = readFileSync(swiftDestination, 'utf8') } catch {}
  try { currentTypescript = readFileSync(typescriptDestination, 'utf8') } catch {}
  if (currentSwift !== generated || currentTypescript !== generatedTypescript) {
    console.error('Generated Companion contracts are stale. Run npm run generate:companion-contracts.')
    process.exit(1)
  }
} else {
  writeFileSync(swiftDestination, generated)
  writeFileSync(typescriptDestination, generatedTypescript)
}
