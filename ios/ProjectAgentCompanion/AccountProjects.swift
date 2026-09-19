import Foundation

func accountProjectID(_ project: Project, spaceID: String) -> String {
    project.shared.map { "shared:\($0.id)" } ?? "local:\(spaceID):\(project.id)"
}

func accountRunID(spaceID: String, runID: String) -> String { "mac-run:\(spaceID):\(runID)" }

func parseAccountRunID(_ id: String) -> (spaceID: String, runID: String)? {
    guard id.hasPrefix("mac-run:") else { return nil }
    let parts = id.dropFirst(8).split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
    return (String(parts[0]), String(parts[1]))
}

func accountProjectWins(_ candidate: Project, over existing: Project) -> Bool {
    let a = candidate.shared
    let b = existing.shared
    if a?.revision != b?.revision { return (a?.revision ?? 0) > (b?.revision ?? 0) }
    return (a?.author ?? "") > (b?.author ?? "")
}

func mergedAccountProjects(_ sources: [(spaceID: String, projects: [Project])]) -> [Project] {
    var projects: [String: Project] = [:]
    for source in sources {
        for original in source.projects {
            var project = original
            project.id = accountProjectID(original, spaceID: source.spaceID)
            if let existing = projects[project.id], !accountProjectWins(project, over: existing) { continue }
            projects[project.id] = project
        }
    }
    return projects.values.sorted { $0.name == $1.name ? $0.id < $1.id : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
}

func accountProjectIsConfigured(_ project: Project) -> Bool {
    let primary = project.profile.workspaceRoots.first { $0.id == project.profile.primaryWorkspaceRootId }
    return !(primary?.path ?? project.profile.repoPath).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

struct MobileExecutionHost: Identifiable {
    let id: String
    let name: String
    let online: Bool
    let configured: Bool
    var selectable: Bool { online && configured }
    var label: String { "\(name) · \(!online ? "离线" : configured ? "在线" : "未配置主文件夹")" }
}
