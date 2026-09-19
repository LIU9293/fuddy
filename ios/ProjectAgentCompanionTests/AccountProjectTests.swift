import XCTest
@testable import ProjectAgentCompanion

final class AccountProjectTests: XCTestCase {
    private func project(_ id: String, shared: String? = nil, revision: Int64 = 1, author: String = "a") -> Project {
        var value = Project(id: id, name: "同名项目", summary: "简介", focus: "开发", status: "active", accent: "blue")
        if let shared { value.shared = SharedProjectRevision(id: shared, revision: revision, author: author) }
        return value
    }

    func testSharedProjectIdentitySurvivesDifferentMacLocalIDs() {
        let a = project("local-a", shared: "shared-project")
        let b = project("local-b", shared: "shared-project")
        XCTAssertEqual(accountProjectID(a, spaceID: "mac-a"), accountProjectID(b, spaceID: "mac-b"))
        XCTAssertNotEqual(accountProjectID(project("same"), spaceID: "mac-a"), accountProjectID(project("same"), spaceID: "mac-b"))
        XCTAssertNotEqual(accountProjectID(a, spaceID: "mac-a"), accountProjectID(project("local-a", shared: "independent"), spaceID: "mac-a"))
    }

    func testMetadataUsesRevisionThenAuthorForDeterministicWinner() {
        let a = project("a", shared: "shared", revision: 2)
        let b = project("b", shared: "shared", revision: 3)
        XCTAssertTrue(accountProjectWins(b, over: a))
        XCTAssertFalse(accountProjectWins(a, over: b))
        XCTAssertTrue(accountProjectWins(project("c", shared: "shared", revision: 3, author: "z"), over: b))
    }

    func testAggregationDeduplicatesSharedProjectsButRetainsIndependentNamesakes() {
        let a = project("a", shared: "shared", revision: 1)
        var b = project("b", shared: "shared", revision: 2)
        b.summary = "最新信息"
        let sources = [(spaceID: "mac-a", projects: [a, project("same")]), (spaceID: "mac-b", projects: [b, project("same")])]
        let merged = mergedAccountProjects(sources)
        XCTAssertEqual(merged.count, 3)
        XCTAssertEqual(merged.first { $0.id == "shared:shared" }?.summary, "最新信息")
        XCTAssertEqual(merged, mergedAccountProjects(sources.reversed()))
    }

    func testHostRequiresItsOwnPrimaryFolder() {
        var value = project("project")
        XCTAssertFalse(accountProjectIsConfigured(value))
        value.profile.workspaceRoots = [ProjectWorkspaceRoot(id: "root", label: "主目录", path: "/local/project")]
        value.profile.primaryWorkspaceRootId = "root"
        XCTAssertTrue(accountProjectIsConfigured(value))
        value.profile.workspaceRoots[0].path = "  "
        XCTAssertFalse(accountProjectIsConfigured(value))
    }

    func testRunRoutesRetainOwningMacEvenWithIdenticalNativeIDs() {
        let a = accountRunID(spaceID: "mac-a", runID: "native:session")
        let b = accountRunID(spaceID: "mac-b", runID: "native:session")
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(parseAccountRunID(a)?.spaceID, "mac-a")
        XCTAssertEqual(parseAccountRunID(a)?.runID, "native:session")
        XCTAssertNil(parseAccountRunID("native-session"))
        XCTAssertNil(parseAccountRunID("mac-run::"))
    }

    func testOfflineAndUnconfiguredHostsCannotStartRuns() {
        XCTAssertTrue(MobileExecutionHost(id: "a", name: "A", online: true, configured: true).selectable)
        XCTAssertFalse(MobileExecutionHost(id: "b", name: "B", online: false, configured: true).selectable)
        XCTAssertFalse(MobileExecutionHost(id: "c", name: "C", online: true, configured: false).selectable)
    }
}
