import type { AccountState } from '../../shared/account'
import type { AgentRunDetail, AppBootstrap, Project, WorkspaceFileContent } from '../../shared/contracts'
import { dailyInspectionJobId, defaultBriefingPrompt } from '../../shared/briefing-prompt'

export const previewTime = '2026-09-21T02:24:00.000Z'
export const previewOnly = 'Web 预览不会调用原生服务或真实 Agent，请在 Fuddy Dev 中验证。'

// Synthetic outputs for repeatable chat layout and file-preview checks.
const previewOutputs = [
  'tia-rebalance-recovery-2026-09-19.md',
  'tia-rebalance-recovery-2026-09-19-data.json',
  'tia-2402-expiry-evidence-2026-09-19.json',
  'injective-dual-dex-progress-2026-09-19.md'
].map((name, index) => ({
  id: `preview-output-${index}`, name,
  mimeType: name.endsWith('.json') ? 'application/json' : 'text/markdown'
}))

export function previewProject(id = 'preview-project', name = 'Fuddy 示例项目'): Project {
  return {
    id, name, summary: '用于前端开发的虚构项目，数据不代表真实项目状态。',
    focus: '打磨工作助理与 Agent Run 的交互', status: 'active', accent: '#607b68',
    profile: {
      productType: 'macOS App', stage: 'UI 预览', mission: '让多个项目的工作更清晰。',
      vision: '从对话到行动。', repoPath: '', workspaceRoots: [], primaryWorkspaceRootId: null,
      defaultAgent: 'codex', websiteUrl: null, surfaces: ['macOS', 'iOS'],
      focusAreas: ['交互体验'], dataSources: [], nextMoves: ['检查聊天页与设置页'],
      currentState: {
        summary: '这是可随时重置的示例状态。', facts: ['所有数据只存在于当前预览页面的内存中。'],
        source: 'user', updatedAt: previewTime
      }
    }
  }
}

export function previewAccount(): AccountState {
  return {
    status: 'signed-in', serviceStatus: 'ready', serviceMessage: '本地 Web 预览，没有登录真实账户。',
    user: { id: 'preview-user', email: 'preview@example.invalid', displayName: 'Web 预览' },
    device: { id: 'preview-device', platform: 'macos', name: 'Web 预览', hostId: null, syncSpaceId: null },
    onboarding: { step: 'complete', completedAt: previewTime },
    availableProviders: { email: true, google: false }, existingProjectCount: 2
  }
}

export function previewRunDetails(): AgentRunDetail[] {
  return [{
    run: {
      id: 'preview-run', projectId: 'preview-project', provider: 'codex', title: '检查聊天页面的布局',
      accountContext: { provider: 'codex', observedAt: previewTime, authMode: 'subscription', plan: 'pro', apiProvider: 'openai',
        limits: [{ name: '示例额度', usedPercent: 25, windowMinutes: 300, resetsAt: previewTime }] },
      status: 'completed', sessionId: null, workingDirectory: null, startedAt: previewTime,
      completedAt: previewTime, summary: '示例对话，仅用于检查界面。', draftPrompt: null,
      createdAt: previewTime, updatedAt: previewTime
    },
    messages: [{
      id: 'preview-run-user', runId: 'preview-run', role: 'user', content: '帮我检查聊天页面的间距和信息层级。',
      eventType: null, toolName: null, metadata: null, createdAt: previewTime
    }, {
      id: 'preview-run-tool', runId: 'preview-run', role: 'tool', content: '读取示例文件，仅用于 UI 预览。',
      eventType: 'tool', toolName: 'read_file', metadata: { status: 'completed' }, createdAt: previewTime
    }, {
      id: 'preview-run-assistant', runId: 'preview-run', role: 'assistant',
      content: '已整理好检查记录。\n\n这是聊天页面间距和信息层级的示例，主要调整如下：\n\n- 统一页面留白与文字层级\n- 文件合并展示，逐行打开\n- 精简输入区域，聚焦下一步',
      attachments: previewOutputs.map(output => ({
        id: output.id, artifactId: output.id, messageId: 'preview-run-assistant', filename: output.name,
        mimeType: output.mimeType, size: 128, sha256: '0'.repeat(64), width: null, height: null,
        thumbnailAttachmentId: null, createdAt: previewTime
      })),
      eventType: null, toolName: null, metadata: null, createdAt: previewTime
    }],
    artifacts: [{
      id: 'preview-artifact', runId: 'preview-run', projectId: 'preview-project', relativePath: 'ui-notes.md',
      label: 'UI 检查记录', mimeType: 'text/markdown', createdAt: previewTime
    }, ...previewOutputs.map(output => ({
      id: output.id, runId: 'preview-run', projectId: 'preview-project', relativePath: output.name,
      label: output.name, mimeType: output.mimeType, createdAt: previewTime
    }))]
  }, {
    run: {
      id: 'preview-draft', projectId: 'preview-project', provider: 'pi', title: '整理下一步工作',
      status: 'draft', sessionId: null, workingDirectory: null, startedAt: null, completedAt: null,
      summary: '', draftPrompt: '请梳理这个示例项目的下一步工作。', createdAt: previewTime, updatedAt: previewTime
    }, messages: [], artifacts: []
  }]
}

export function previewFiles(): WorkspaceFileContent[] {
  const content = '# UI 检查记录\n\n这是虚构的示例文件。\n\n- 对比 Light / Dark\n- 调整窗口宽度\n- 检查输入框与侧栏\n'
  return [{
    entry: {
      projectId: 'preview-project', relativePath: 'ui-notes.md', name: 'ui-notes.md', kind: 'file',
      size: new TextEncoder().encode(content).length, modifiedAt: previewTime, mimeType: 'text/markdown', editable: true
    },
    kind: 'markdown', content,
    previewUrl: null, previewMessage: null
  }, ...previewOutputs.map((output): WorkspaceFileContent => ({
    entry: { projectId: 'preview-project', relativePath: output.name, name: output.name, kind: 'file',
      size: 128, modifiedAt: previewTime, mimeType: output.mimeType, editable: true },
    kind: output.mimeType === 'text/markdown' ? 'markdown' : 'text',
    content: output.mimeType === 'text/markdown' ? content : '{"preview": true, "note": "仅用于 UI 预览，不代表真实项目状态"}',
    previewUrl: null, previewMessage: null
  }))]
}

export function previewBootstrap(empty = false): AppBootstrap {
  const agentEndpoint = { mode: 'openai-compatible' as const, baseUrl: '', model: '', apiKeyConfigured: false }
  const ttsEndpoint = { mode: 'system' as const, baseUrl: '', model: '', voice: '', instructions: '', apiKeyConfigured: false }
  return {
    projects: empty ? [] : [previewProject(), previewProject('preview-studio', '创作工作室（示例）')],
    goals: empty ? [] : [{
      id: 'preview-goal', projectId: 'preview-project', title: '完成主要页面的 UI 检查',
      description: '示例目标，用于查看目标列表、里程碑与操作菜单。', status: 'active', priority: 'P1',
      metric: { label: '检查页面', unit: '个', baseline: null, current: null, target: null },
      deadline: null, nextCheckInAt: null, progress: 0, confidence: 0,
      agentSummary: '尚未执行真实检查。', monitoringSources: [], checkIns: [],
      milestones: [{
        id: 'preview-milestone', goalId: 'preview-goal', title: '检查工作助理与聊天页', status: 'pending',
        dueAt: null, evidenceRefs: [], sortOrder: 0, createdAt: previewTime, updatedAt: previewTime, completedAt: null
      }], createdBy: 'user', createdAt: previewTime, updatedAt: previewTime, completedAt: null
    }],
    decisions: empty ? [] : [{
      id: 'preview-decision', projectId: 'preview-project', kind: 'decision', title: '确认聊天页的布局方向',
      summary: '示例事项：比较工作助理和 Agent Run 的标题、内容宽度与输入框。',
      impact: '帮助检查收件箱的详情、状态切换与「去处理」交互。', urgency: 'medium', confidence: 0,
      suggestedActions: ['检查共享布局与 Light / Dark 模式'], evidenceRefs: [], status: 'inbox',
      source: 'Web 预览示例', createdAt: previewTime
    }],
    decisionRemediations: [], runs: empty ? [] : previewRunDetails().map((detail) => detail.run),
    connectors: [], connectorRuns: [], dailyBriefings: [], morningBriefings: [],
    briefingMessages: empty ? [] : [{
      id: 'preview-assistant', briefingId: null, role: 'assistant',
      content: '欢迎来到 **Fuddy Web 预览**。\n\n这里复用桌面端的页面与样式，所有项目和聊天都是示例数据。你可以打开收件箱、项目、Agent Run、文件和设置，直接调整 UI。\n\n真实 Agent、账户、语音和 Companion 服务不会启动。',
      attachments: [], taskContext: null, createdAt: previewTime
    }],
    automations: empty ? [] : [{
      id: dailyInspectionJobId, projectId: null, name: '每日项目巡检',
      scheduleDescription: '每天上午 09:00', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai',
      action: 'generate-briefing', prompt: defaultBriefingPrompt, agentProvider: 'pi', enabled: true,
      requiresConfirmation: false, maxRetries: 1, retryDelaySeconds: 30, status: 'idle',
      lastRunAt: null, nextRunAt: '2026-09-17T01:00:00.000Z', lastError: null, createdAt: previewTime, updatedAt: previewTime
    }, {
      id: 'preview-automation', projectId: 'preview-project', name: '每日 UI 检查（示例）',
      scheduleDescription: '每天 09:00', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai',
      action: 'agent-task', prompt: '检查主要页面的布局。', agentProvider: 'codex', enabled: false,
      requiresConfirmation: true, maxRetries: 0, retryDelaySeconds: 60, status: 'paused',
      lastRunAt: null, nextRunAt: null, lastError: null, createdAt: previewTime, updatedAt: previewTime
    }], automationRuns: [],
    providerSettings: {
      agent: { primary: { ...agentEndpoint }, backup: { ...agentEndpoint }, backupEnabled: false },
      codingAgents: {
        defaultAgent: 'codex', codex: { defaultModel: '', defaultReasoningEffort: '' },
        claude: { defaultModel: '', defaultReasoningEffort: '' }, opencode: { defaultModel: '', defaultReasoningEffort: '' }
      },
      asr: { mode: 'local-first', cloudBaseUrl: '', cloudModel: '', cloudApiKeyConfigured: false, fallbackToCloud: false },
      tts: { primary: { ...ttsEndpoint }, backup: { ...ttsEndpoint }, backupEnabled: false }
    },
    connectorCatalog: [], analyticsProfiles: [],
    capabilities: [
      { id: 'codex', label: 'Codex（预览）', status: 'unavailable', detail: previewOnly },
      { id: 'pi', label: 'Pi（预览）', status: 'unavailable', detail: previewOnly }
    ],
    credentialStorage: { available: false, backend: 'unavailable', detail: 'Web 预览不读取或保存凭证。' },
    permissionMode: 'full-access'
  }
}
