import Foundation

func companionAgentProviderLabel(_ provider: String) -> String {
    switch provider {
    case "pi": "Fuddy Agent"
    case "codex": "Codex"
    case "claude": "Claude Code"
    case "opencode": "OpenCode"
    default: "Agent"
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
