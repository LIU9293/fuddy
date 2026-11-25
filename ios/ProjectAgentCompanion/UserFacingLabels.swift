import Foundation

let companionAgentProviderIDs = ["codex", "claude", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "pi", "muse"]

func isCompanionAgentProvider(_ provider: String) -> Bool {
    companionAgentProviderIDs.contains(provider)
        || provider.range(of: #"^acp-[a-zA-Z0-9_-]{1,60}$"#, options: .regularExpression) != nil
}

func companionAgentProviderLabel(_ provider: String) -> String {
    switch provider {
    case "pi": "Pi"
    case "codex": "Codex"
    case "claude": "Claude Code"
    case "opencode": "OpenCode"
    case "cursor": "Cursor"
    case "grok": "Grok Build"
    case "fx": "Fx"
    case "antigravity": "Antigravity"
    case "kiro": "Kiro"
    case "muse": "Muse"
    default: provider.hasPrefix("acp-") ? String(provider.dropFirst(4)) : "Agent"
    }
}

func companionRunStatusLabel(_ status: String) -> String {
    switch status {
    case "draft": "草稿"
    case "queued": "等待中"
    case "running": "运行中"
    case "completed", "idle": "已完成"
    case "failed": "失败"
    case "cancelled": "已取消"
    default: "状态更新中"
    }
}
