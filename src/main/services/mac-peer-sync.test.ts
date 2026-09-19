import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacPeerSyncService, parseRemoteRunId, remoteRunId } from './mac-peer-sync'
import { AppDatabase } from './database'
import type { AccountService } from './account-service'
import type { AccountState } from '../../shared/account'
import type { CompanionEncryptedSyncEvent, CompanionEventType } from '../../shared/companion-sync'
import { companionProtocolVersion, companionEventDefinitions } from '../../shared/companion-sync'
import { companionCommandAssociatedData, companionEventAssociatedData, generateCompanionAccountKey, openCompanionJson, sealCompanionJson } from '../../shared/companion-crypto'
import { emptyAgentModelLabels } from '../../shared/model-display'
import type { AgentRun } from '../../shared/contracts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const operation of cleanup.splice(0).reverse()) operation() })

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'fuddy-peers-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const local = new AppDatabase(join(directory, 'local.sqlite'))
  const remote = new AppDatabase(join(directory, 'remote.sqlite'))
  cleanup.push(() => local.close(), () => remote.close())
  const project = remote.createProject({ name: '远程项目', summary: '共享简介', focus: '开发', mission: '完成产品', vision: '产品愿景', stage: '开发中', productType: '软件', workspacePath: directory })
  const encryptionKey = generateCompanionAccountKey()
  const secrets = new Map<string, string>([['mac-peer:user:space', JSON.stringify({ relayURL: 'http://localhost:9999', accountID: 'relay', deviceID: 'device-local', deviceToken: 'secret-token', encryptionKey, encryptionKeyId: 'key' })]])
  const events: CompanionEncryptedSyncEvent[] = []
  async function event(type: CompanionEventType, payload: unknown, entityId = randomUUID() as string) {
    const base = { eventId: randomUUID(), protocolVersion: companionProtocolVersion, type, entityType: companionEventDefinitions[type], entityId, revision: Date.now(), occurredAt: new Date().toISOString() }
    events.push({ ...base, payload: await sealCompanionJson(encryptionKey, payload, companionEventAssociatedData(base)), sequence: events.length + 1, sourceDeviceId: 'remote' } as CompanionEncryptedSyncEvent)
  }
  await event('snapshot.created', { generatedAt: new Date().toISOString(), modelLabels: emptyAgentModelLabels, projects: [project], goals: [], decisions: [], morningBriefings: [], workAssistantMessages: [], runs: [], attachments: [] })
  let state = { status: 'signed-in', user: { id: 'user' }, device: { id: 'device-local', hostId: 'local-host', name: '本机' } } as AccountState
  let online = true
  let discoveryAvailable = true
  let pageSize = 200
  let publishCommandOutcomes = true
  const commands: Array<{ commandId: string; type: string; payload: Record<string, string> }> = []
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
    if (url.pathname === '/v1/events') {
      const after = Number(url.searchParams.get('after'))
      const page = events.filter((item) => item.sequence > after).slice(0, pageSize)
      return Response.json({ protocolVersion: companionProtocolVersion, minimumProtocolVersion: companionProtocolVersion, events: page, lastSequence: page.at(-1)?.sequence ?? after, presence: { macOnline: online, iosDevicesOnline: 0, updatedAt: new Date().toISOString() } })
    }
    if (url.pathname === '/v1/commands') {
      const encrypted = JSON.parse(String(init?.body))
      const payload = await openCompanionJson<Record<string, string>>(encryptionKey, encrypted.payload, companionCommandAssociatedData(encrypted))
      if (!commands.some((command) => command.commandId === encrypted.commandId)) {
        commands.push({ ...encrypted, payload })
        if (encrypted.type === 'agent.create-session') {
          const now = new Date().toISOString()
          await event('agent-run.created', { id: payload.runId, projectId: payload.projectId, provider: (payload.provider ?? 'codex') as AgentRun['provider'], title: payload.title, status: 'draft', sessionId: null, workingDirectory: directory, startedAt: null, completedAt: null, summary: '', draftPrompt: null, createdAt: now, updatedAt: now } satisfies AgentRun)
        }
        if (publishCommandOutcomes) await event('command.updated', { ...encrypted, payload: {}, sourceDeviceId: 'device-local', result: null, error: null, status: 'completed', updatedAt: new Date().toISOString() })
      }
      return Response.json({ ...encrypted, sourceDeviceId: 'device-local', result: null, error: null, status: 'completed', updatedAt: new Date().toISOString() })
    }
    throw new Error('unexpected request')
  }) as unknown as typeof fetch
  const account = { getState: () => state, listSyncSpaces: async () => {
    if (!discoveryAvailable) throw new Error('offline')
    return [{ id: 'space', hostId: 'host-remote', hostName: '远程 Mac', relayUrl: 'http://localhost:9999', relayAccountId: 'relay', relayBound: true }]
  } } as unknown as AccountService
  const vault = { get: (key: string) => secrets.get(key) ?? null, set: (key: string, value: string) => { secrets.set(key, value) }, delete: (key: string) => { secrets.delete(key) } }
  const service = new MacPeerSyncService(local, account, vault, 'development', () => undefined, request, false)
  cleanup.push(() => service.stop())
  service.start()
  await service.syncNow()
  async function persistPending() {
    const command = { commandId: randomUUID(), protocolVersion: companionProtocolVersion, type: 'agent.rename-session', createdAt: new Date().toISOString() }
    const payload = await sealCompanionJson(encryptionKey, { runId: 'native-session', title: '恢复原操作' }, companionCommandAssociatedData(command))
    local.setSetting('mac-peer:user:space:pending', { [command.commandId]: { ...command, payload } })
    return command.commandId
  }
  return { local, remote, project, service, commands, event, request, vault, account, persistPending, omitCommandOutcomes: () => { publishCommandOutcomes = false }, setPageSize: (value: number) => { pageSize = value }, setOnline: (value: boolean) => { online = value }, signOut: () => { state = { ...state, status: 'signed-out', user: null } }, setDiscovery: (value: boolean) => { discoveryAvailable = value } }
}

describe('encrypted Mac peer routing', () => {
  it('clears retried commands from their durable receipt after the outcome event was compacted', async () => {
    const { local, service, commands, persistPending, omitCommandOutcomes } = await setup()
    omitCommandOutcomes()
    const id = await persistPending()
    await service.syncNow()
    await service.syncNow()
    expect(commands.map((command) => command.commandId)).toEqual([id])
    expect(local.getSetting('mac-peer:user:space:pending', {})).toEqual({})
  })
  it('drains all event pages when lastSequence only describes the current page', async () => {
    const { local, remote, project, service, event, setPageSize } = await setup()
    setPageSize(1)
    const first = remote.updateProject({ ...project, summary: '第一页' })
    const second = remote.updateProject({ ...first, summary: '第二页' })
    await event('project.updated', first)
    await event('project.updated', second)
    await service.syncNow()
    expect(local.listProjects()[0].summary).toBe('第二页')
  })
  it('imports a project without adopting its path and creates a draft on the selected host', async () => {
    const { local, project, service, commands } = await setup()
    const imported = local.listProjects()[0]
    expect(imported.shared).toEqual(project.shared)
    expect(imported.profile.repoPath).toBe('')
    expect(service.listHosts(imported.id)).toMatchObject([{ isCurrent: true, workspaceConfigured: false }, { id: 'host-remote', online: true, workspaceConfigured: true }])
    const detail = await service.createDraft({ projectId: imported.id, executionHostId: 'host-remote', title: '远程草稿', provider: 'claude' })
    expect(detail.run.projectId).toBe(imported.id)
    expect(detail.run.status).toBe('draft')
    expect(detail.run.executionHost?.id).toBe('host-remote')
    expect(detail.run.workingDirectory).toBeNull()
    expect(commands[0].payload).toMatchObject({ projectId: project.id, provider: 'claude' })
    await service.mutate(detail.run.id, 'agent.rename-session', { title: '重命名' })
    expect(commands[1].payload.runId).toBe(parseRemoteRunId(detail.run.id)!.runId)
    expect(local.listRuns()).toEqual([])
  })
  it('rejects new commands while offline and hides peer caches after sign-out', async () => {
    const { local, service, setOnline, commands, signOut } = await setup()
    setOnline(false)
    await service.syncNow()
    expect(service.listHosts(local.listProjects()[0].id)[1].online).toBe(false)
    await expect(service.createDraft({ projectId: local.listProjects()[0].id, executionHostId: 'host-remote', title: '不可执行' })).rejects.toThrow()
    expect(commands).toHaveLength(0)
    signOut()
    expect(service.listRuns()).toEqual([])
    expect(() => service.getDetail(remoteRunId('host-remote', 'anything'))).toThrow()
  })
  it('keeps cached host names after restart while treating unavailable presence as offline', async () => {
    const { local, service, setDiscovery, account, vault, request } = await setup()
    service.stop()
    setDiscovery(false)
    const restarted = new MacPeerSyncService(local, account, vault, 'development', () => undefined, request, false)
    cleanup.push(() => restarted.stop())
    restarted.start()
    await restarted.syncNow()
    expect(restarted.listHosts(null)[1]).toMatchObject({ name: '远程 Mac', online: false })
  })
  it('resumes persisted delivery after restart using the same command ID', async () => {
    const { local, service, account, vault, request, persistPending, commands } = await setup()
    const commandId = await persistPending()
    service.stop()
    const restarted = new MacPeerSyncService(local, account, vault, 'development', () => undefined, request, false)
    cleanup.push(() => restarted.stop())
    restarted.start()
    await restarted.syncNow()
    await restarted.syncNow()
    expect(commands).toHaveLength(1)
    expect(commands[0].commandId).toBe(commandId)
    expect(local.getSetting('mac-peer:user:space:pending', {})).toEqual({})
  })
})
