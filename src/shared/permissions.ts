import type {
  PermissionEvaluation,
  PermissionIntent,
  PermissionRisk
} from './contracts'

const BROAD_DELETE_PATTERNS = [
  /\brm\s+-[^\n]*r[^\n]*f[^\n]*(?:\s\/\s*$|\s~\/?\s*$|\s\/Users\/?[^\s]*\s*$)/i,
  /\bdiskutil\s+(?:erase|partition)/i,
  /\b(?:mkfs|format)\b/i,
  /\bDROP\s+(?:DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i
]

const SECURITY_PATTERNS = [
  /\bsecurity\s+(?:delete-keychain|export)\b/i,
  /\b(?:disable|bypass)\b.*\b(?:SIP|Gatekeeper|firewall|sandbox)\b/i,
  /\bTCC\.db\b/i
]

const FINANCIAL_PATTERNS = [
  /\b(?:transfer|wire|withdraw|purchase|buy|sell)\b.*\b(?:money|funds?|crypto|BTC|ETH|USD|CNY)\b/i,
  /(?:转账|付款|提现|购买|卖出).*(?:资金|人民币|美元|加密货币|BTC|ETH)/i
]

const ACCOUNT_PATTERNS = [
  /\b(?:delete|close|terminate)\b.*\baccount\b/i,
  /(?:删除|注销|关闭).*(?:账户|账号)/i
]

const SECRET_TRANSMISSION_PATTERNS = [
  /\b(?:upload|send|post|publish|exfiltrate)\b.*\b(?:secret|credential|private key|api key|token)\b/i,
  /(?:上传|发送|公开|外传).*(?:密钥|凭证|私钥|令牌|token)/i
]

const SENSITIVE_ACTION_PATTERNS = [
  /\bdeploy\b/i,
  /\bpublish\b/i,
  /\bsend\b.*\b(?:email|message)\b/i,
  /(?:部署|发布|发送).*(?:邮件|消息)?/i
]

function combinedText(intent: PermissionIntent): string {
  return [intent.tool, intent.action, intent.target, intent.command, intent.description]
    .filter(Boolean)
    .join(' ')
}

function hasMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function classifyRisk(intent: PermissionIntent): { risk: PermissionRisk; reason: string } {
  const text = combinedText(intent)

  if (intent.affectsMoney || hasMatch(text, FINANCIAL_PATTERNS)) {
    return { risk: 'dangerous', reason: '操作会直接影响资金或资产。' }
  }

  if (intent.deletesAccount || hasMatch(text, ACCOUNT_PATTERNS)) {
    return { risk: 'dangerous', reason: '操作可能不可逆地删除或关闭账户。' }
  }

  if (intent.transmitsCredentials || hasMatch(text, SECRET_TRANSMISSION_PATTERNS)) {
    return { risk: 'dangerous', reason: '操作可能把密钥或凭证发送到外部。' }
  }

  if (intent.changesSecuritySettings || hasMatch(text, SECURITY_PATTERNS)) {
    return { risk: 'dangerous', reason: '操作会修改系统安全、隐私或凭证设置。' }
  }

  if (intent.irreversible || hasMatch(text, BROAD_DELETE_PATTERNS)) {
    return { risk: 'dangerous', reason: '操作可能造成大范围且不可逆的数据损失。' }
  }

  if (intent.production || intent.handlesCredentials || hasMatch(text, SENSITIVE_ACTION_PATTERNS)) {
    return { risk: 'sensitive', reason: '操作具有外部影响或接触敏感上下文，但通常可恢复。' }
  }

  return { risk: 'routine', reason: '操作属于可恢复的日常项目工作。' }
}

export function evaluateAggressivePermission(intent: PermissionIntent): PermissionEvaluation {
  const { risk, reason } = classifyRisk(intent)

  return {
    risk,
    reason,
    decision: 'auto-approved',
    auditLevel: risk === 'dangerous' ? 'critical' : risk === 'sensitive' ? 'highlighted' : 'standard',
    evaluatedAt: new Date().toISOString()
  }
}
