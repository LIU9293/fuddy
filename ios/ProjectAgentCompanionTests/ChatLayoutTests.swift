import SwiftUI
import XCTest
@testable import ProjectAgentCompanion

@MainActor
private final class ChatLayoutState: ObservableObject {
    let viewport: CGSize
    let expanded: Bool
    var frames: [String: CGRect] = [:]

    init(viewport: CGSize, expanded: Bool) {
        self.viewport = viewport
        self.expanded = expanded
    }
}

private struct ChatRowFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private struct ChatLayoutHarness: View {
    @ObservedObject var state: ChatLayoutState
    @State private var isAtLatest = true
    let page: CompanionChatPage

    var body: some View {
        CompanionChatTimeline(
            page: page, viewportSize: state.viewport, topInset: 80, bottomInset: 100,
            isAtLatestMessage: $isAtLatest, scrollToLatestRequest: 0,
            latestContentRevision: "fixture"
        ) { record, _ in
            VStack(alignment: .leading) {
                Text(record.id)
                if state.expanded {
                    MarkdownText(String(repeating: "展开消息后，正文应始终保持左右留白。\n\n", count: 12))
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(key: ChatRowFramesKey.self,
                        value: [record.id: geometry.frame(in: .named("layout-test"))])
                }
            }
        } tail: {
            Text("待处理消息").frame(maxWidth: .infinity, alignment: .leading)
        }
        .coordinateSpace(name: "layout-test")
        .onPreferenceChange(ChatRowFramesKey.self) { state.frames = $0 }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

final class ChatLayoutTests: XCTestCase {
    @MainActor
    func testMessageInsetsAtCompactAndExpandedViewportSizes() async throws {
        let messages = (0..<18).map { index in
            AgentMessage(id: "row-\(index)", runId: "layout-test", role: "assistant",
                content: "布局测试", eventType: nil, toolName: nil, createdAt: "2026-09-19T00:00:00Z")
        }
        let page = companionChatPage(chatId: "layout-test", chatKind: "agent",
            records: buildAgentChatRecords(runID: "layout-test", messages: messages))
        for (width, height, expanded) in [(402.0, 820.0, false),
                                         (402.0, 500.0, true), (350.0, 700.0, false)] {
            let state = ChatLayoutState(viewport: CGSize(width: width, height: height),
                                        expanded: expanded)
            let host = UIHostingController(rootView: ChatLayoutHarness(state: state, page: page)
                .environmentObject(CompanionStore()))
            let window = UIWindow(frame: CGRect(origin: .zero, size: state.viewport))
            window.rootViewController = host
            window.makeKeyAndVisible()
            for _ in 0..<20 where state.frames.isEmpty {
                try await Task.sleep(for: .milliseconds(50))
                host.view.layoutIfNeeded()
            }
            let visibleFrames = state.frames.values.filter { $0.maxY > 0 && $0.minY < height }
            XCTAssertFalse(visibleFrames.isEmpty)
            for frame in visibleFrames {
                XCTAssertEqual(frame.minX, 20, accuracy: 0.5)
                XCTAssertEqual(frame.width, width - 40, accuracy: 0.5)
            }
            window.isHidden = true
            window.rootViewController = nil
        }
    }
}
