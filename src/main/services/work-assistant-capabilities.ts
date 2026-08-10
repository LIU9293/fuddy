import type { WorkAssistantCapabilityDescriptor } from '../../shared/contracts'

export const workAssistantCapabilities: readonly WorkAssistantCapabilityDescriptor[] = [
  { id: 'project.list', label: '查看项目', access: 'read', description: '查看所有项目、状态与当前重点。' },
  { id: 'project.inspect', label: '检查项目', access: 'read', description: '读取项目配置、目标、收件箱、Runs 和已配置 Workspace 的证据。' },
  { id: 'project.create', label: '新建项目', access: 'confirm', description: '先生成项目草案，用户确认后创建。' },
  { id: 'project.update', label: '更新项目', access: 'confirm', description: '更新项目资料、Workspace、默认 Agent 与当前状态。' },
  { id: 'project.pause', label: '暂停项目', access: 'confirm', description: '暂停项目但保留全部历史；不支持自然语言硬删除。' },
  { id: 'agent-run.find', label: '查找 Agent Run', access: 'read', description: '按项目、Ticket、PR、目标和消息上下文查找相关 Run。' },
  { id: 'agent-run.inspect', label: '检查 Agent Run', access: 'read', description: '查看 Run 状态、摘要、消息与产物。' },
  { id: 'agent-run.open', label: '打开 Agent Run', access: 'read', description: '以普通链接跳转到已有 Run，不修改 Run、收件箱或消息状态。' },
  { id: 'agent-run.create', label: '创建 Agent Run', access: 'confirm', description: '确认后创建 Draft Run 并预填首条任务，不自动发送。' },
  { id: 'agent-run.update', label: '修改 Agent Run', access: 'confirm', description: '修改标题或尚未发送的 Draft Prompt。' },
  { id: 'agent-run.archive', label: '归档 Agent Run', access: 'explicit', description: '必须明确指定；运行中的 Run 不能归档。' },
  { id: 'agent-run.send', label: '启动或继续 Agent Run', access: 'explicit', description: '只有用户明确发送后才让项目 Agent 执行。' },
  { id: 'goal.manage', label: '管理目标', access: 'confirm', description: '创建、检查、调整优先级、暂停或完成目标与里程碑。' },
  { id: 'inbox.manage', label: '管理收件箱', access: 'confirm', description: '创建事项并维护待处理、进行中、等待、完成和忽略状态。' },
  { id: 'files.search', label: '查找本机项目文件', access: 'read', description: '只搜索项目文件空间和项目已配置的 Workspace Roots。' },
  { id: 'files.read', label: '读取本机项目文件', access: 'read', description: '只读取受支持的文本文件，不扫描项目范围之外的磁盘。' },
  { id: 'web.search', label: '联网搜索', access: 'read', description: '搜索网页并保留来源 URL。' },
  { id: 'web.read', label: '读取网页', access: 'read', description: '读取 HTTP/HTTPS 页面，包括本机与私有网络服务；结果作为外部证据而非项目事实。' },
  { id: 'briefing.read', label: '读取每日简报', access: 'read', description: '读取最近简报、项目脉冲和历史简报。' },
  { id: 'briefing.generate', label: '生成每日简报', access: 'confirm', description: '手动触发跨项目巡检与简报；定时任务也复用同一能力。' },
  { id: 'automation.manage', label: '管理自动化', access: 'confirm', description: '查看、创建、启停和运行定时工作。' }
]

export function capabilityPromptCatalog(): string {
  return workAssistantCapabilities
    .map((item) => `- ${item.id}（${item.access}）：${item.description}`)
    .join('\n')
}
