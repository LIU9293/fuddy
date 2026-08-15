import AVFoundation
import SwiftUI
import UIKit

private let companionChatItemSpacing: CGFloat = 20
private let companionChatHorizontalPadding: CGFloat = 20
let companionChatLatestDistanceThreshold: CGFloat = 50

enum CompanionSection: String, CaseIterable, Identifiable {
    case assistant, runs, inbox, projects, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .assistant: "助理"
        case .runs: "Runs"
        case .inbox: "收件箱"
        case .projects: "项目"
        case .settings: "设置"
        }
    }

    var icon: String {
        switch self {
        case .assistant: "sparkles"
        case .runs: "bubble.left.and.bubble.right"
        case .inbox: "tray"
        case .projects: "square.grid.2x2"
        case .settings: "gearshape"
        }
    }
}

enum CompanionRoute: Hashable {
    case run(id: String, prefill: String)
    case decision(id: String)
    case project(id: String)
}

@MainActor
final class CompanionRouter: ObservableObject {
    @Published var section: CompanionSection = .assistant
    @Published var path: [CompanionRoute] = []
    @Published var drawerPresented = false

    func select(_ section: CompanionSection) {
        self.section = section
        path.removeAll()
        drawerPresented = false
    }

    func openRun(id: String, prefill: String = "") {
        section = .runs
        path = [.run(id: id, prefill: prefill)]
        drawerPresented = false
    }
}

private struct CompanionStatusBannerHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct CompanionTopSafeAreaInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

private extension EnvironmentValues {
    var companionTopSafeAreaInset: CGFloat {
        get { self[CompanionTopSafeAreaInsetKey.self] }
        set { self[CompanionTopSafeAreaInsetKey.self] = newValue }
    }
}

func companionClampedPageDrag(translation: CGFloat, pageWidth: CGFloat, isLeadingPage: Bool) -> CGFloat {
    guard pageWidth > 0 else { return 0 }
    if isLeadingPage { return min(0, max(-pageWidth, translation)) }
    return max(0, min(pageWidth, translation))
}

func companionShouldChangePage(
    translation: CGFloat,
    predictedTranslation: CGFloat,
    pageWidth: CGFloat,
    towardTrailingPage: Bool
) -> Bool {
    let threshold = max(64, pageWidth * 0.18)
    if towardTrailingPage {
        return translation < -threshold || predictedTranslation < -pageWidth * 0.45
    }
    return translation > threshold || predictedTranslation > pageWidth * 0.45
}

func companionClampedDrawerReveal(
    origin: CGFloat,
    translation: CGFloat,
    drawerWidth: CGFloat
) -> CGFloat {
    guard drawerWidth > 0 else { return 0 }
    return min(drawerWidth, max(0, origin + translation))
}

func companionDrawerTargetIsPresented(
    currentReveal: CGFloat,
    predictedReveal: CGFloat,
    drawerWidth: CGFloat
) -> Bool {
    guard drawerWidth > 0 else { return false }
    let clampedCurrent = min(drawerWidth, max(0, currentReveal))
    let clampedPrediction = min(drawerWidth, max(0, predictedReveal))
    let projectedReveal = abs(clampedPrediction - clampedCurrent) >= 24
        ? clampedPrediction
        : clampedCurrent
    return projectedReveal >= drawerWidth * 0.5
}

func companionCanOpenDrawer(section: CompanionSection, pathIsEmpty: Bool) -> Bool {
    guard pathIsEmpty else { return false }
    switch section {
    case .assistant, .inbox, .projects, .settings: return true
    case .runs: return false
    }
}

struct CompanionRootView: View {
    @EnvironmentObject private var store: CompanionStore
    @StateObject private var router = CompanionRouter()
    @State private var statusBannerHeight: CGFloat = 0
    @State private var drawerRevealOffset: CGFloat = 0
    @State private var drawerDragOrigin: CGFloat?
    @State private var drawerDragRejected = false
    @State private var containerBottomSafeAreaInset: CGFloat = 0

    private var drawerWidth: CGFloat { min(300, UIScreen.main.bounds.width * 0.78) }
    private var drawerAnimation: Animation { .spring(duration: 0.26, bounce: 0) }

    var body: some View {
        GeometryReader { geometry in
            appSurface
                .environment(\.companionTopSafeAreaInset, geometry.safeAreaInsets.top)
                .environment(\.companionBottomSafeAreaInset, containerBottomSafeAreaInset)
                .onPreferenceChange(CompanionStatusBannerHeightKey.self) { height in
                    statusBannerHeight = height
                }
                .onChange(of: statusMessage) { _, message in
                    if message == nil { statusBannerHeight = 0 }
                }
                .onAppear {
                    updateContainerBottomSafeAreaInset(geometry.safeAreaInsets.bottom)
                    openPendingNotificationRun()
                }
                .onChange(of: geometry.safeAreaInsets.bottom) { _, inset in
                    updateContainerBottomSafeAreaInset(inset)
                }
                .onReceive(NotificationCenter.default.publisher(for: .companionOpenRun)) { notification in
                    guard let runID = CompanionNotificationNavigationBridge.shared.consumePendingRunID()
                        ?? notification.object as? String else { return }
                    openNotificationRun(id: runID)
                }
        }
    }

    private func openPendingNotificationRun() {
        guard let runID = CompanionNotificationNavigationBridge.shared.consumePendingRunID() else { return }
        openNotificationRun(id: runID)
    }

    private func openNotificationRun(id: String) {
        Task { @MainActor in
            await store.sync()
            router.openRun(id: id)
        }
    }

    private func updateContainerBottomSafeAreaInset(_ inset: CGFloat) {
        guard inset.isFinite, inset >= 0, inset <= 64 else { return }
        guard inset > 0 || containerBottomSafeAreaInset == 0 else { return }
        containerBottomSafeAreaInset = inset
    }

    private var appSurface: some View {
        ZStack(alignment: .leading) {
            NavigationStack(path: $router.path) {
                rootSectionContent
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { withAnimation(.snappy) { router.drawerPresented = true } } label: {
                            Image(systemName: "line.3.horizontal")
                        }
                        .accessibilityLabel("打开侧边栏")
                    }
                    ToolbarItem(placement: .principal) {
                        if router.section == .assistant || router.section == .runs {
                            CompanionCompactTabBar(
                                selection: Binding(
                                    get: { router.section },
                                    set: { router.select($0) }
                                ),
                                items: [.assistant, .runs],
                                title: { $0.title }
                            )
                        } else {
                            Text(router.section.title).font(.headline)
                        }
                    }
                }
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: CompanionRoute.self) { route in
                    switch route {
                    case .run(let id, let prefill): RunDetailView(runID: id, prefilledPrompt: prefill)
                    case .decision(let id): DecisionDetailView(decisionID: id)
                    case .project(let id):
                        if let project = store.state.projects.first(where: { $0.id == id }) {
                            ProjectDetailView(project: project)
                        } else {
                            ContentUnavailableView("项目不存在", systemImage: "questionmark.folder")
                        }
                    }
                }
            }
            .environmentObject(router)
            .allowsHitTesting(!router.drawerPresented)
            .offset(x: drawerRevealOffset)

            Color.clear
                .contentShape(Rectangle())
                .ignoresSafeArea()
                .allowsHitTesting(router.drawerPresented)
                .onTapGesture { withAnimation(.snappy) { router.drawerPresented = false } }

            CompanionSidebar()
                .environmentObject(router)
                .frame(width: drawerWidth)
                .offset(x: drawerRevealOffset - drawerWidth)
                .allowsHitTesting(router.drawerPresented)
                .accessibilityHidden(!router.drawerPresented)
        }
        .simultaneousGesture(drawerGesture)
        .onChange(of: router.drawerPresented) { _, isPresented in
            guard drawerDragOrigin == nil else { return }
            withAnimation(drawerAnimation) {
                drawerRevealOffset = isPresented ? drawerWidth : 0
            }
        }
    }

    @ViewBuilder private var rootSectionContent: some View {
        if router.section == .assistant || router.section == .runs {
            ZStack(alignment: .top) {
                primarySectionPager
                    .ignoresSafeArea(.container, edges: [.top, .bottom])

                statusBanner
            }
        } else {
            VStack(spacing: 0) {
                statusBanner
                sectionContent
            }
        }
    }

    @ViewBuilder private var statusBanner: some View {
        if let statusMessage {
            Label(statusMessage, systemImage: store.connection == .offline ? "wifi.slash" : "desktopcomputer.trianglebadge.exclamationmark")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(
                            key: CompanionStatusBannerHeightKey.self,
                            value: geometry.size.height
                        )
                    }
                }
        }
    }

    @ViewBuilder private var sectionContent: some View {
        switch router.section {
        case .assistant, .runs: primarySectionPager
        case .inbox: DecisionListView()
        case .projects: ProjectListView()
        case .settings: CompanionSettingsView()
        }
    }

    private var primarySectionPager: some View {
        CompanionTwoPageContainer(
            selection: Binding(
                get: { router.section },
                set: { router.select($0) }
            ),
            leadingSelection: .assistant,
            trailingSelection: .runs
        ) {
            WorkAssistantView(topChromeHeight: 62 + statusBannerHeight)
        } trailing: {
            RunsListView(topContentInset: 62 + statusBannerHeight)
        }
    }

    private var statusMessage: String? {
        if let operationError = store.operationError, operationError.hasPrefix("同步失败：") { return operationError }
        if store.connection == .offline { return "Relay 暂时不可达，当前显示本地缓存" }
        if store.connection == .connected && !store.macOnline { return "Mac 当前离线，操作会在它上线后执行" }
        return nil
    }

    private var drawerGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard !drawerDragRejected else { return }

                if drawerDragOrigin == nil {
                    guard abs(value.translation.width) > abs(value.translation.height) * 1.15 else {
                        drawerDragRejected = true
                        return
                    }
                    let canOpen = companionCanOpenDrawer(section: router.section, pathIsEmpty: router.path.isEmpty)
                    guard router.drawerPresented || (canOpen && value.translation.width > 0) else {
                        drawerDragRejected = true
                        return
                    }
                    drawerDragOrigin = drawerRevealOffset
                }

                guard let origin = drawerDragOrigin else { return }
                drawerRevealOffset = companionClampedDrawerReveal(
                    origin: origin,
                    translation: value.translation.width,
                    drawerWidth: drawerWidth
                )
            }
            .onEnded { value in
                defer {
                    drawerDragOrigin = nil
                    drawerDragRejected = false
                }
                guard let origin = drawerDragOrigin else { return }
                let currentReveal = companionClampedDrawerReveal(
                    origin: origin,
                    translation: value.translation.width,
                    drawerWidth: drawerWidth
                )
                let predictedReveal = companionClampedDrawerReveal(
                    origin: origin,
                    translation: value.predictedEndTranslation.width,
                    drawerWidth: drawerWidth
                )
                let target = companionDrawerTargetIsPresented(
                    currentReveal: currentReveal,
                    predictedReveal: predictedReveal,
                    drawerWidth: drawerWidth
                )
                router.drawerPresented = target
                withAnimation(drawerAnimation) {
                    drawerRevealOffset = target ? drawerWidth : 0
                }
            }
    }
}

private struct CompanionCompactTabBar<Selection: Hashable>: View {
    @Binding var selection: Selection
    let items: [Selection]
    let title: (Selection) -> String

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                switchButton(item)
            }
        }
        .padding(4)
        .companionLiquidGlass(in: Capsule())
        .shadow(color: .black.opacity(0.08), radius: 12, y: 5)
    }

    private func switchButton(_ item: Selection) -> some View {
        Button {
            withAnimation(.spring(duration: 0.25, bounce: 0)) { selection = item }
        } label: {
            Text(title(item))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(selection == item ? Color.primary : Color.primary.opacity(0.68))
                .frame(minWidth: 72)
                .padding(.vertical, 7)
                .background(
                    selection == item
                        ? AnyShapeStyle(Color.primary.opacity(0.1))
                        : AnyShapeStyle(.clear),
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
    }
}

private struct CompanionTwoPageContainer<Selection: Hashable, Leading: View, Trailing: View>: View {
    @Binding var selection: Selection
    let leadingSelection: Selection
    let trailingSelection: Selection
    let leading: Leading
    let trailing: Trailing

    @GestureState private var dragOffset: CGFloat = 0

    init(
        selection: Binding<Selection>,
        leadingSelection: Selection,
        trailingSelection: Selection,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        _selection = selection
        self.leadingSelection = leadingSelection
        self.trailingSelection = trailingSelection
        self.leading = leading()
        self.trailing = trailing()
    }

    private var isLeadingPage: Bool { selection == leadingSelection }

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                page(leading, selection: leadingSelection, size: geometry.size)
                page(trailing, selection: trailingSelection, size: geometry.size)
            }
            .frame(width: geometry.size.width * 2, alignment: .leading)
            .offset(x: (isLeadingPage ? 0 : -geometry.size.width) + dragOffset)
            .animation(.spring(duration: 0.25, bounce: 0), value: selection)
            .simultaneousGesture(pageGesture(pageWidth: geometry.size.width))
        }
        .clipped()
    }

    private func page<Page: View>(_ page: Page, selection pageSelection: Selection, size: CGSize) -> some View {
        page
            .frame(width: size.width, height: size.height)
            .clipped()
            .allowsHitTesting(selection == pageSelection)
            .accessibilityHidden(selection != pageSelection)
    }

    private func pageGesture(pageWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragOffset) { value, offset, _ in
                guard abs(value.translation.width) > abs(value.translation.height) * 1.15 else { return }
                offset = companionClampedPageDrag(
                    translation: value.translation.width,
                    pageWidth: pageWidth,
                    isLeadingPage: isLeadingPage
                )
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) * 1.15 else { return }
                let shouldChange = companionShouldChangePage(
                    translation: value.translation.width,
                    predictedTranslation: value.predictedEndTranslation.width,
                    pageWidth: pageWidth,
                    towardTrailingPage: isLeadingPage
                )
                guard shouldChange else { return }
                withAnimation(.spring(duration: 0.25, bounce: 0)) {
                    selection = isLeadingPage ? trailingSelection : leadingSelection
                }
            }
    }
}

private struct CompanionSidebar: View {
    @EnvironmentObject private var store: CompanionStore
    @EnvironmentObject private var router: CompanionRouter

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Image("FuddyWordmark")
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .foregroundStyle(.primary)
                        .frame(width: 92, height: 36, alignment: .leading)
                        .accessibilityLabel("Fuddy")
                    Text(store.macOnline ? "Mac 在线" : "Mac 离线")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { withAnimation(.snappy) { router.drawerPresented = false } } label: {
                    Image(systemName: "xmark").frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
            }
            .padding(.bottom, 22)

            ForEach([CompanionSection.assistant, .runs]) { section in
                Button { withAnimation(.snappy) { router.select(section) } } label: {
                    Label(section.title, systemImage: section.icon)
                        .font(.body.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .background(router.section == section ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }

            Divider().padding(.vertical, 8)

            ForEach([CompanionSection.inbox, .projects, .settings]) { section in
                Button { withAnimation(.snappy) { router.select(section) } } label: {
                    Label(section.title, systemImage: section.icon)
                        .font(.body.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .background(router.section == section ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }

            Spacer()
            Text("所有任务仍在已绑定的 Mac 上执行")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 28)
        .frame(maxHeight: .infinity)
        .background {
            Rectangle().fill(.regularMaterial).ignoresSafeArea()
        }
    }
}

struct WorkAssistantView: View {
    @EnvironmentObject private var store: CompanionStore
    let topChromeHeight: CGFloat
    @State private var prompt = ""
    @State private var attachments: [PendingAttachment] = []
    @State private var sending = false
    @State private var error: String?
    @State private var isAtLatestMessage = true
    @State private var scrollToLatestRequest = 0

    private var page: CompanionChatPage {
        store.chatPage(chatID: workAssistantChatId) ?? CompanionChatPage(
            chatId: workAssistantChatId,
            chatKind: "assistant",
            records: [],
            hasMore: false,
            nextBefore: nil
        )
    }

    var body: some View {
        CompanionChatSurface(
            topChromeHeight: topChromeHeight,
            isAtLatestMessage: isAtLatestMessage,
            onScrollToLatest: { scrollToLatestRequest += 1 }
        ) { viewportSize, topInset, bottomInset in
            CompanionChatTimeline(
                page: page,
                viewportSize: viewportSize,
                topInset: topInset,
                bottomInset: bottomInset,
                isAtLatestMessage: $isAtLatestMessage,
                scrollToLatestRequest: scrollToLatestRequest,
                latestContentRevision: page.records.last.map { "\($0.id)-\($0.hashValue)" } ?? "empty"
            ) { record, _ in
                if let message = record.assistantMessage {
                    AssistantMessageView(message: message)
                } else if let briefing = record.morningBriefing {
                    MorningBriefingCard(briefing: briefing)
                }
            } tail: {
                EmptyView()
            }
        } composer: {
            VStack(spacing: 0) {
                if let error { Text(error).font(.caption).foregroundStyle(.red).padding(.top, 6) }
                CompanionChatComposer(
                    text: $prompt,
                    attachments: $attachments,
                    placeholder: "询问工作助理",
                    sending: sending,
                    imageOnly: true,
                    onSend: { Task { await send() } }
                )
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
        .overlay {
            if page.records.isEmpty {
                ContentUnavailableView("开始和工作助理对话", systemImage: "sparkles", description: Text("每日总结也会出现在这里"))
            }
        }
    }

    private func send() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return }
        sending = true; error = nil
        do {
            try await store.sendWorkAssistantMessage(text.isEmpty ? "请查看我附加的图片。" : text, attachments: attachments)
            prompt = ""; attachments = []
            await store.sync()
        } catch { self.error = error.localizedDescription }
        sending = false
    }
}

private struct CompanionConversationMessage<Supplement: View>: View {
    let role: String
    let content: String
    let pending: Bool
    @ViewBuilder let supplement: () -> Supplement

    var body: some View {
        if role == "user" {
            VStack(alignment: .trailing, spacing: 5) {
                HStack(alignment: .top) {
                    Spacer(minLength: 56)
                    messageContent
                        .padding(.horizontal, 15)
                        .padding(.vertical, 11)
                        .background(
                            .secondary.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                        )
                }
                if pending {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("正在发送到 Mac")
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 6)
                }
            }
        } else if role == "system" {
            messageContent
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        } else {
            messageContent
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var messageContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            MarkdownText(content)
                .font(role == "system" ? .caption : .subheadline)
            supplement()
        }
    }
}

private struct AssistantMessageView: View {
    @EnvironmentObject private var store: CompanionStore
    @EnvironmentObject private var router: CompanionRouter
    let message: WorkAssistantMessage
    @State private var executingProposalID: String?
    @State private var actionError: String?

    var body: some View {
        CompanionConversationMessage(
            role: message.role,
            content: displayedContent,
            pending: false
        ) {
            ForEach(message.attachments) { attachment in
                RemoteAttachmentRow(attachment: attachment)
            }
            ForEach(actionProposals) { proposal in
                WorkAssistantActionCard(
                    proposal: proposal,
                    options: actionOptions(for: proposal),
                    busy: executingProposalID == proposal.id,
                    onExecute: { option in
                        Task { await execute(proposal: proposal, option: option) }
                    }
                )
            }
            if let actionError {
                Text(actionError).font(.caption).foregroundStyle(.red)
            }
            ForEach(linkedRunIDs, id: \.self) { runID in
                if let run = store.state.runs.first(where: { $0.run.id == runID })?.run {
                    Button {
                        router.openRun(id: runID)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "bubble.left.and.text.bubble.right")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(run.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(run.status == "draft" ? "草稿 · 首条消息尚未发送" : "\(run.provider) · \(run.status)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        }
                        .padding(12)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var actionProposals: [WorkAssistantActionProposal] {
        message.actions.filter { proposal in
            let acceptedOption = proposal.options.first(where: { $0.id == proposal.acceptedOptionId })
            return acceptedOption?.capability != "agent-run.open"
                && proposal.options.contains(where: { $0.capability != "agent-run.open" })
        }
    }

    private var displayedContent: String {
        guard message.actions.contains(where: { proposal in
            proposal.options.contains(where: { $0.capability == "agent-run.open" })
        }) else { return message.content }
        return message.content
            .replacingOccurrences(of: "确认后会打开它并预填建议消息，不会自动发送。", with: "可以通过下方链接直接回到这个 Run。")
            .replacingOccurrences(of: "确认后会打开这个 Run 并预填建议消息，不会自动发送。", with: "可以通过下方链接直接打开这个 Run。")
            .replacingOccurrences(of: "确认后会打开这个 Run，不会追加或发送消息。", with: "可以通过下方链接直接打开这个 Run。")
            .replacingOccurrences(of: "请确认后打开。", with: "可以通过下方链接直接打开。")
    }

    private func actionOptions(for proposal: WorkAssistantActionProposal) -> [WorkAssistantActionOption] {
        proposal.options.filter { $0.capability != "agent-run.open" }
    }

    private var linkedRunIDs: [String] {
        workAssistantLinkedRunIDs(for: message)
    }

    private func execute(proposal: WorkAssistantActionProposal, option: WorkAssistantActionOption) async {
        guard executingProposalID == nil else { return }
        executingProposalID = proposal.id
        actionError = nil
        do {
            let runID = try await store.executeWorkAssistantAction(
                messageID: message.id,
                proposalID: proposal.id,
                optionID: option.id
            )
            if let runID { router.openRun(id: runID) }
        } catch {
            actionError = error.localizedDescription
        }
        executingProposalID = nil
    }
}

func workAssistantLinkedRunIDs(for message: WorkAssistantMessage) -> [String] {
    guard message.role == "assistant" else { return [] }

    var result: [String] = []
    let acceptedCreateRun = message.actions.contains { proposal in
        guard proposal.status == "accepted", let acceptedOptionID = proposal.acceptedOptionId else { return false }
        return proposal.options.first(where: { $0.id == acceptedOptionID })?.capability == "agent-run.create"
    }
    if let linkedRunID = message.linkedRunId,
       message.actions.isEmpty || acceptedCreateRun {
        result.append(linkedRunID)
    }
    for proposal in message.actions {
        for option in proposal.options where option.capability == "agent-run.open" {
            if let runID = option.payload.runId, !result.contains(runID) { result.append(runID) }
        }
    }
    return result
}

private struct WorkAssistantActionCard: View {
    let proposal: WorkAssistantActionProposal
    let options: [WorkAssistantActionOption]
    let busy: Bool
    let onExecute: (WorkAssistantActionOption) -> Void

    private var includesLegacyRunLink: Bool {
        options.count != proposal.options.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: proposal.status == "accepted" ? "checkmark.circle.fill" : "sparkles")
                    .foregroundStyle(proposal.status == "accepted" ? .green : .primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(includesLegacyRunLink ? "创建新的 Agent Run" : proposal.title).font(.subheadline.weight(.semibold))
                    if let context = proposal.context { Text(context).font(.caption).foregroundStyle(.secondary) }
                }
            }
            Text(includesLegacyRunLink ? "如果不继续已有 Run，也可以确认后创建一个新的 Draft Run。" : proposal.description)
                .font(.caption).foregroundStyle(.secondary)
            if proposal.status == "pending" {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(options) { option in
                        Button {
                            onExecute(option)
                        } label: {
                            HStack(spacing: 5) {
                                if busy { ProgressView().controlSize(.mini) }
                                Text(option.label)
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(option.style == "primary" ? Color.white : Color.primary)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 36)
                            .background(
                                option.style == "primary" ? Color.primary : Color.secondary.opacity(0.11),
                                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                }
            } else {
                Label(
                    proposal.status == "dismissed"
                        ? "已取消"
                        : "已确认：\(options.first(where: { $0.id == proposal.acceptedOptionId })?.label ?? "已处理")",
                    systemImage: "checkmark"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(13)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(.primary.opacity(0.08)))
    }
}

private struct MorningBriefingCard: View {
    let briefing: MorningBriefing
    @State private var showingFullBriefing = false
    @State private var speechSynthesizer = AVSpeechSynthesizer()
    @State private var playbackMonitor: Task<Void, Never>?
    @State private var playing = false
    @State private var paused = false
    @State private var playbackError: String?

    private var durationMinutes: Int {
        max(1, Int(ceil(Double(briefing.estimatedDurationSeconds) / 60)))
    }

    private var narration: String {
        let value = briefing.narration.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "\(briefing.headline)。\(briefing.body)" : value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label("每日总结", systemImage: "sun.max.fill")
                        .font(.caption.bold())
                    Text("\(briefing.reportDate) · 全部项目")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.68))
                }
                Spacer()
                Text("约 \(durationMinutes) 分钟 · 中文")
                    .font(.caption2).foregroundStyle(.white.opacity(0.72))
            }
            Text(briefing.headline).font(.headline.bold())

            HStack(spacing: 10) {
                Button(action: togglePlayback) {
                    Label(
                        playing && !paused ? "暂停" : paused ? "继续播放" : "播放简报",
                        systemImage: playing && !paused ? "pause.fill" : "play.fill"
                    )
                    .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.indigo)
                .accessibilityHint("使用 iPhone 中文语音朗读每日总结")

                if playing {
                    Button(action: stopPlayback) {
                        Image(systemName: "stop.fill")
                    }
                    .buttonStyle(.bordered)
                    .tint(.white)
                    .accessibilityLabel("停止播放")
                }

                Spacer(minLength: 4)

                Button {
                    showingFullBriefing = true
                } label: {
                    HStack(spacing: 5) {
                        Text("阅读全文")
                        Image(systemName: "chevron.right")
                    }
                }
                .font(.footnote.bold())
                .foregroundStyle(.white)
            }

            if let playbackError {
                Text(playbackError)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.82))
            }
        }
        .foregroundStyle(.white)
        .padding(18)
        .background(Color.indigo.opacity(0.92), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .sheet(isPresented: $showingFullBriefing) {
            MorningBriefingFullArticle(briefing: briefing)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .onDisappear(perform: stopPlayback)
    }

    private func togglePlayback() {
        playbackError = nil

        if speechSynthesizer.isPaused {
            speechSynthesizer.continueSpeaking()
            playing = true
            paused = false
            return
        }

        if speechSynthesizer.isSpeaking {
            speechSynthesizer.pauseSpeaking(at: .word)
            playing = true
            paused = true
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)

            let utterance = AVSpeechUtterance(string: narration)
            utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
            utterance.rate = 0.48
            utterance.pitchMultiplier = 0.98
            speechSynthesizer.speak(utterance)
            playing = true
            paused = false
            monitorPlayback()
        } catch {
            playbackError = "暂时无法播放语音：\(error.localizedDescription)"
            playing = false
            paused = false
        }
    }

    private func monitorPlayback() {
        playbackMonitor?.cancel()
        playbackMonitor = Task { @MainActor in
            while !Task.isCancelled && (speechSynthesizer.isSpeaking || speechSynthesizer.isPaused) {
                try? await Task.sleep(for: .milliseconds(200))
            }
            guard !Task.isCancelled else { return }
            playing = false
            paused = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func stopPlayback() {
        playbackMonitor?.cancel()
        playbackMonitor = nil
        speechSynthesizer.stopSpeaking(at: .immediate)
        playing = false
        paused = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

private struct MorningBriefingFullArticle: View {
    @Environment(\.dismiss) private var dismiss
    let briefing: MorningBriefing

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("\(briefing.reportDate) · 全部项目")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(briefing.headline)
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Divider()
                    MarkdownText(briefing.body)
                        .font(.subheadline)
                        .lineSpacing(4)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 22)
            }
            .navigationTitle("每日总结")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

struct RunsListView: View {
    @EnvironmentObject private var store: CompanionStore
    @Environment(\.companionTopSafeAreaInset) private var screenTopSafeAreaInset
    let topContentInset: CGFloat

    init(topContentInset: CGFloat = 0) {
        self.topContentInset = topContentInset
    }

    var body: some View {
        List(store.runs) { detail in
            NavigationLink(value: CompanionRoute.run(id: detail.run.id, prefill: "")) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(detail.run.title).font(.headline).lineLimit(2)
                        Text(runMetadata(detail.run)).font(.caption).foregroundStyle(.secondary)
                        if !detail.run.summary.isEmpty { Text(detail.run.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                    }
                    Spacer(minLength: 8)
                    if detail.run.status == "running" || detail.run.status == "queued" { ProgressView().controlSize(.small) }
                }
                .padding(.vertical, 3)
            }
        }
        .listStyle(.plain)
        .contentMargins(.top, screenTopSafeAreaInset + topContentInset, for: .scrollContent)
        .refreshable { await store.sync() }
        .overlay { if store.runs.isEmpty { ContentUnavailableView("暂无 Agent Run", systemImage: "bubble.left.and.bubble.right") } }
    }

    private func runMetadata(_ run: AgentRun) -> String {
        let project = store.state.projects.first { $0.id == run.projectId }?.name ?? "无项目"
        return "\(project) · \(run.provider) · \(relativeDate(run.updatedAt))"
    }
}

struct RunActivityStage: Identifiable {
    let id: String
    let reasoning: AgentMessage?
    var tools: [AgentMessage]
}

func groupRunActivityStages(_ messages: [AgentMessage]) -> [RunActivityStage] {
    var stages: [RunActivityStage] = []
    for message in messages {
        if message.eventType == "reasoning" {
            stages.append(RunActivityStage(id: message.id, reasoning: message, tools: []))
        } else if message.role == "tool" {
            if stages.isEmpty {
                stages.append(RunActivityStage(id: "stage-\(message.id)", reasoning: nil, tools: [message]))
            } else {
                stages[stages.count - 1].tools.append(message)
            }
        }
    }
    return stages
}

func formatRunProcessDuration(startedAt: String, completedAt: String) -> String {
    guard let start = parseCompanionDate(startedAt),
          let completion = parseCompanionDate(completedAt) else {
        return "思考过程"
    }
    let elapsedSeconds = max(1, Int(completion.timeIntervalSince(start).rounded()))
    let minutes = elapsedSeconds / 60
    let seconds = elapsedSeconds % 60
    return minutes > 0 ? "耗时 \(minutes) 分 \(seconds) 秒" : "耗时 \(seconds) 秒"
}

private struct CompanionChatBottomPositionKey: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

func companionDistanceFromLatest(
    bottomY: CGFloat,
    viewportHeight: CGFloat,
    bottomInset: CGFloat
) -> CGFloat {
    bottomY - max(0, viewportHeight - bottomInset)
}

private struct CompanionChatTimeline<RecordContent: View, TailContent: View>: View {
    @EnvironmentObject private var store: CompanionStore
    let page: CompanionChatPage
    let viewportSize: CGSize
    let topInset: CGFloat
    let bottomInset: CGFloat
    @Binding var isAtLatestMessage: Bool
    let scrollToLatestRequest: Int
    let latestContentRevision: String
    @ViewBuilder let recordContent: (CompanionChatRecord, String?) -> RecordContent
    @ViewBuilder let tail: () -> TailContent

    @State private var scrollPosition: String?
    @State private var didRestoreScrollPosition = false

    private var latestAnchorID: String { "chat-latest-\(page.chatId)" }
    private var historyLoaderID: String { "chat-history-loader-\(page.chatId)" }
    private var scrollCoordinateSpace: String { "chat-scroll-\(page.chatId)" }
    private var lastRecordID: String? { page.records.last?.id }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: companionChatItemSpacing) {
                    if page.hasMore {
                        historyLoader
                            .id(historyLoaderID)
                            .task(id: page.nextBefore) {
                                await store.loadOlderChatRecords(chatID: page.chatId)
                            }
                    }
                    ForEach(page.records) { record in
                        recordContent(record, lastRecordID)
                            .id(record.id)
                    }
                    tail()
                    Color.clear
                        .frame(height: bottomInset)
                        .id(latestAnchorID)
                        .background {
                            GeometryReader { anchor in
                                Color.clear.preference(
                                    key: CompanionChatBottomPositionKey.self,
                                    value: anchor.frame(in: .named(scrollCoordinateSpace)).minY
                                )
                            }
                        }
                }
                .scrollTargetLayout()
                .frame(
                    width: max(0, viewportSize.width - companionChatHorizontalPadding * 2),
                    alignment: .leading
                )
                .padding(.horizontal, companionChatHorizontalPadding)
                .padding(.top, topInset)
            }
            .defaultScrollAnchor(.bottom)
            .coordinateSpace(name: scrollCoordinateSpace)
            .scrollPosition(id: $scrollPosition, anchor: .center)
            .refreshable { await store.sync() }
            .onPreferenceChange(CompanionChatBottomPositionKey.self) { bottomY in
                guard bottomY.isFinite else { return }
                isAtLatestMessage = companionDistanceFromLatest(
                    bottomY: bottomY,
                    viewportHeight: viewportSize.height,
                    bottomInset: bottomInset
                ) <= companionChatLatestDistanceThreshold
            }
            .onAppear {
                guard !didRestoreScrollPosition else { return }
                didRestoreScrollPosition = true
                let recordIDs = Set(page.records.map(\.id))
                let savedPosition = store.savedChatScrollPosition(chatID: page.chatId)
                let destination = savedPosition.flatMap { recordIDs.contains($0) ? $0 : nil }
                    ?? latestAnchorID
                DispatchQueue.main.async {
                    proxy.scrollTo(destination, anchor: destination == latestAnchorID ? .bottom : .center)
                }
            }
            .onDisappear {
                if isAtLatestMessage {
                    store.saveChatScrollPosition(nil, chatID: page.chatId)
                } else if let scrollPosition,
                          scrollPosition != latestAnchorID,
                          scrollPosition != historyLoaderID {
                    store.saveChatScrollPosition(scrollPosition, chatID: page.chatId)
                }
            }
            .onChange(of: latestContentRevision) { oldRevision, newRevision in
                guard oldRevision != newRevision, isAtLatestMessage else { return }
                proxy.scrollTo(latestAnchorID, anchor: .bottom)
            }
            .onChange(of: scrollToLatestRequest) { _, _ in
                withAnimation(.easeOut(duration: 0.24)) {
                    proxy.scrollTo(latestAnchorID, anchor: .bottom)
                }
            }
        }
    }

    private var historyLoader: some View {
        Button {
            Task { await store.loadOlderChatRecords(chatID: page.chatId) }
        } label: {
            HStack(spacing: 8) {
                if store.loadingOlderChatIDs.contains(page.chatId) {
                    ProgressView().controlSize(.small)
                    Text("正在加载更早记录")
                } else {
                    Image(systemName: "clock.arrow.circlepath")
                    Text("加载更早记录")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
        .disabled(store.loadingOlderChatIDs.contains(page.chatId))
        .accessibilityElement(children: .combine)
    }
}

struct RunDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    let runID: String
    @State private var prompt: String
    @State private var attachments: [PendingAttachment] = []
    @State private var sending = false
    @State private var showRename = false
    @State private var showSessionInfo = false
    @State private var renamedTitle = ""
    @State private var error: String?
    @State private var isAtLatestMessage = true
    @State private var scrollToLatestRequest = 0

    init(runID: String, prefilledPrompt: String = "") {
        self.runID = runID
        _prompt = State(initialValue: prefilledPrompt)
    }

    private var detail: RunDetail? { store.state.runs.first { $0.run.id == runID } }
    private var page: CompanionChatPage {
        store.chatPage(chatID: runID) ?? CompanionChatPage(
            chatId: runID,
            chatKind: "agent",
            records: [],
            hasMore: false,
            nextBefore: nil
        )
    }

    var body: some View {
        Group {
            if let detail {
                CompanionChatSurface(
                    isAtLatestMessage: isAtLatestMessage,
                    onScrollToLatest: {
                        scrollToLatestRequest += 1
                    }
                ) { viewportSize, topInset, bottomInset in
                    CompanionChatTimeline(
                        page: page,
                        viewportSize: viewportSize,
                        topInset: topInset,
                        bottomInset: bottomInset,
                        isAtLatestMessage: $isAtLatestMessage,
                        scrollToLatestRequest: scrollToLatestRequest,
                        latestContentRevision: "\(page.records.last?.hashValue ?? 0)-\(detail.run.status)"
                    ) { record, lastRecordID in
                        runRecordView(
                            record,
                            active: record.id == lastRecordID && ["running", "queued"].contains(detail.run.status)
                        )
                    } tail: {
                        if ["running", "queued"].contains(detail.run.status),
                           page.records.last?.agentMessages.last?.role == "user" {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("\(detail.run.provider) 正在处理")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } composer: {
                    VStack(spacing: 4) {
                        if let error {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                                .padding(.horizontal, 20)
                        }
                        CompanionChatComposer(
                            text: $prompt,
                            attachments: $attachments,
                            placeholder: "给 \(detail.run.provider) 发送消息",
                            sending: sending,
                            active: ["running", "queued"].contains(detail.run.status),
                            onSend: { Task { await send() } },
                            onStop: { Task { await stop() } }
                        )
                    }
                }
                .navigationTitle(detail.run.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.hidden, for: .navigationBar)
                .toolbar { toolbar(detail.run) }
                .alert("重命名 Session", isPresented: $showRename) {
                    TextField("Session 标题", text: $renamedTitle)
                    Button("取消", role: .cancel) {}
                    Button("保存") { Task { await rename() } }
                }
                .sheet(isPresented: $showSessionInfo) {
                    RunInfoSheet(runID: runID).environmentObject(store)
                }
            } else {
                ProgressView("正在从 Mac 同步 Session…")
            }
        }
        .task(id: runID) {
            await store.sync()
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let detail,
               detail.messages.isEmpty,
               let draftPrompt = detail.run.draftPrompt {
                prompt = draftPrompt
            }
        }
        .task(id: prompt) {
            guard let detail,
                  detail.run.status == "draft",
                  detail.messages.isEmpty,
                  (detail.run.draftPrompt ?? "") != prompt else { return }
            do {
                try await Task.sleep(for: .milliseconds(350))
                try Task.checkCancellation()
                try await store.updateDraftPrompt(runID: runID, draftPrompt: prompt)
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    @ViewBuilder
    private func runRecordView(_ record: CompanionChatRecord, active: Bool) -> some View {
        if record.kind == "process" {
            if let completedAt = record.completedAt {
                RunProcessDisclosureView(messages: record.agentMessages, completedAt: completedAt)
            } else {
                RunActivityStagesView(messages: record.agentMessages, active: active)
            }
        } else if let message = record.agentMessages.first {
            MessageView(message: message, active: active)
        }
    }

    @ToolbarContentBuilder private func toolbar(_ run: AgentRun) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("信息与文件", systemImage: "sidebar.right") { showSessionInfo = true }
                Button("重命名", systemImage: "pencil") { renamedTitle = run.title; showRename = true }
                Button("归档", systemImage: "archivebox", role: .destructive) { Task { await archive() } }
                    .disabled(["running", "queued"].contains(run.status))
            } label: { Image(systemName: "ellipsis") }
        }
    }

    private func send() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return }
        sending = true; error = nil
        do {
            try await store.sendMessage(runID: runID, prompt: text.isEmpty ? "请查看我附加的文件。" : text, attachments: attachments)
            prompt = ""; attachments = []
            await store.sync()
        } catch { self.error = error.localizedDescription }
        sending = false
    }

    private func stop() async {
        sending = true; error = nil
        do {
            try await store.stopMessage(runID: runID)
            await store.sync()
        } catch { self.error = error.localizedDescription }
        sending = false
    }

    private func rename() async {
        do { try await store.rename(runID: runID, title: renamedTitle); await store.sync() }
        catch { self.error = error.localizedDescription }
    }

    private func archive() async {
        do { try await store.archive(runID: runID); await store.sync(); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}

private struct RunProcessDisclosureView: View {
    let messages: [AgentMessage]
    let completedAt: String
    @State private var expanded = false

    private var stages: [RunActivityStage] { groupRunActivityStages(messages) }
    private var operationCount: Int { stages.reduce(0) { $0 + $1.tools.count } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                    Text(formatRunProcessDuration(
                        startedAt: messages.first?.createdAt ?? completedAt,
                        completedAt: completedAt
                    ))
                        .font(.subheadline.weight(.medium))
                    if operationCount > 0 {
                        Text("· \(operationCount) 次操作")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("思考过程")
            .accessibilityValue(formatRunProcessDuration(
                startedAt: messages.first?.createdAt ?? completedAt,
                completedAt: completedAt
            ))
            .accessibilityHint(expanded ? "轻点收起" : "轻点展开")

            if expanded {
                RunActivityStagesView(messages: messages, active: false)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RunActivityStagesView: View {
    let messages: [AgentMessage]
    let active: Bool

    private var stages: [RunActivityStage] { groupRunActivityStages(messages) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(stages.enumerated()), id: \.element.id) { index, stage in
                let current = active && index == stages.count - 1
                VStack(alignment: .leading, spacing: 9) {
                    if let reasoning = stage.reasoning {
                        ThinkingText(content: reasoning.content, active: current && stage.tools.isEmpty)
                    }
                    if !stage.tools.isEmpty {
                        ToolCallGroupView(messages: stage.tools, active: current)
                    }
                }
                .padding(.bottom, index < stages.count - 1 ? 18 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func toolKind(for message: AgentMessage) -> String {
    if let kind = message.toolKind, !kind.isEmpty { return kind }
    let name = (message.toolName ?? "").lowercased().filter(\.isLetter)
    if ["read", "readfile", "cat", "notebookread", "listfiles"].contains(name) { return "read" }
    if ["grep", "glob", "search", "find", "rg", "codesearch", "websearch"].contains(name) { return "search" }
    if ["edit", "write", "writefile", "applypatch", "patch", "notebookedit", "multiedit"].contains(name) { return "edit" }
    if ["bash", "shell", "command", "exec", "execute", "terminal", "runcommand"].contains(name) { return "command" }
    if name.contains("browser") || name.contains("webfetch") || name.contains("computer") { return "browser" }
    return "other"
}

private func toolLabel(for message: AgentMessage) -> String {
    switch toolKind(for: message) {
    case "read": "读取文件"
    case "search": "搜索代码"
    case "edit": "编辑文件"
    case "command": "运行命令"
    case "browser": "操作浏览器"
    default: message.toolName ?? "调用工具"
    }
}

private func toolDisplaySummary(for message: AgentMessage) -> String {
    if let summary = message.toolSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
        return summary
    }
    let value = message.content.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return value.count > 100 ? "\(value.prefix(99))…" : (value.isEmpty ? "查看详情" : value)
}

private func toolGroupSummary(_ messages: [AgentMessage]) -> String {
    guard messages.count > 1 else {
        guard let message = messages.first else { return "尚无操作" }
        return "\(toolLabel(for: message)) · \(toolDisplaySummary(for: message))"
    }
    var orderedKinds: [String] = []
    var counts: [String: Int] = [:]
    for message in messages {
        let kind = toolKind(for: message)
        if counts[kind] == nil { orderedKinds.append(kind) }
        counts[kind, default: 0] += 1
    }
    let labels = ["read": "读取", "search": "搜索", "edit": "编辑", "command": "运行", "browser": "浏览器", "other": "其他"]
    return orderedKinds.map { "\(labels[$0] ?? "其他") \(counts[$0] ?? 0) 次" }.joined(separator: " · ")
}

private struct ToolCallGroupView: View {
    let messages: [AgentMessage]
    let active: Bool
    @State private var expanded = false
    private let maximumExpandedHeight: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text(toolGroupSummary(messages))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    if active { ProgressView().controlSize(.small) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(expanded ? "轻点收起" : "轻点展开")

            if expanded {
                ViewThatFits(in: .vertical) {
                    toolItems
                        .fixedSize(horizontal: false, vertical: true)
                    ScrollView(.vertical) {
                        toolItems
                    }
                    .scrollIndicators(.visible)
                }
                .frame(maxHeight: maximumExpandedHeight, alignment: .top)
                .padding(.top, 10)
                .padding(.leading, 4)
            }
        }
        .padding(.vertical, 2)
    }

    private var toolItems: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(messages) { message in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(toolLabel(for: message))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                        if let status = message.toolStatus {
                            Text(status == "failed" ? "失败" : "已完成")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(status == "failed" ? Color.red : Color.secondary)
                        }
                    }
                    Text(toolDisplaySummary(for: message))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(message.content)
                        .font(.subheadline.monospaced())
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MessageView: View {
    let message: AgentMessage
    let active: Bool

    var body: some View {
        if message.eventType == "reasoning" {
            ThinkingText(content: message.content, active: active)
        } else {
            CompanionConversationMessage(
                role: message.role,
                content: message.content,
                pending: message.eventType == "pending"
            ) {
                EmptyView()
            }
        }
    }
}

private struct ThinkingText: View {
    let content: String
    let active: Bool
    @State private var pulsing = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            if active {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 6, height: 6)
                    .opacity(pulsing ? 1 : 0.28)
                    .animation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true), value: pulsing)
                    .onAppear { pulsing = true }
            }
            MarkdownText(content)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum MobileMarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case unorderedList([String])
    case orderedList([String])
    case quote(String)
    case code(String)
    case table(headers: [String], alignments: [MobileMarkdownTableAlignment], rows: [[String]])
    case divider
}

enum MobileMarkdownTableAlignment: Equatable {
    case leading
    case center
    case trailing
}

func parseMobileMarkdown(_ content: String) -> [MobileMarkdownBlock] {
    let lines = content
        .replacingOccurrences(of: "\r\n", with: "\n")
        .components(separatedBy: "\n")
    var blocks: [MobileMarkdownBlock] = []
    var paragraph: [String] = []
    var index = 0

    func flushParagraph() {
        guard !paragraph.isEmpty else { return }
        blocks.append(.paragraph(paragraph.joined(separator: " ")))
        paragraph.removeAll(keepingCapacity: true)
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            flushParagraph()
            index += 1
            continue
        }

        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            flushParagraph()
            let fence = String(trimmed.prefix(3))
            index += 1
            var codeLines: [String] = []
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                codeLines.append(lines[index])
                index += 1
            }
            if index < lines.count { index += 1 }
            blocks.append(.code(codeLines.joined(separator: "\n")))
            continue
        }

        if index + 1 < lines.count,
           let headers = markdownTableCells(line),
           let alignments = markdownTableAlignments(lines[index + 1], columnCount: headers.count) {
            flushParagraph()
            index += 2
            var rows: [[String]] = []
            while index < lines.count {
                let candidate = lines[index]
                guard !candidate.trimmingCharacters(in: .whitespaces).isEmpty,
                      let cells = markdownTableCells(candidate) else { break }
                rows.append(normalizeMarkdownTableRow(cells, columnCount: headers.count))
                index += 1
            }
            blocks.append(.table(headers: headers, alignments: alignments, rows: rows))
            continue
        }

        let headingMarks = trimmed.prefix { $0 == "#" }
        if !headingMarks.isEmpty,
           headingMarks.count <= 6,
           trimmed.dropFirst(headingMarks.count).first == " " {
            flushParagraph()
            blocks.append(.heading(
                level: headingMarks.count,
                text: String(trimmed.dropFirst(headingMarks.count + 1))
            ))
            index += 1
            continue
        }

        if unorderedListItem(trimmed) != nil {
            flushParagraph()
            var items: [String] = []
            while index < lines.count, let item = unorderedListItem(lines[index].trimmingCharacters(in: .whitespaces)) {
                items.append(item)
                index += 1
            }
            blocks.append(.unorderedList(items))
            continue
        }

        if orderedListItem(trimmed) != nil {
            flushParagraph()
            var items: [String] = []
            while index < lines.count, let item = orderedListItem(lines[index].trimmingCharacters(in: .whitespaces)) {
                items.append(item)
                index += 1
            }
            blocks.append(.orderedList(items))
            continue
        }

        if trimmed.hasPrefix(">") {
            flushParagraph()
            var quoted: [String] = []
            while index < lines.count {
                let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                guard candidate.hasPrefix(">") else { break }
                quoted.append(String(candidate.dropFirst()).trimmingCharacters(in: .whitespaces))
                index += 1
            }
            blocks.append(.quote(quoted.joined(separator: " ")))
            continue
        }

        if isMarkdownDivider(trimmed) {
            flushParagraph()
            blocks.append(.divider)
            index += 1
            continue
        }

        paragraph.append(trimmed)
        index += 1
    }
    flushParagraph()
    return blocks
}

private func unorderedListItem(_ line: String) -> String? {
    for prefix in ["- ", "* ", "+ "] where line.hasPrefix(prefix) {
        return String(line.dropFirst(prefix.count))
    }
    return nil
}

private func orderedListItem(_ line: String) -> String? {
    guard let dot = line.firstIndex(of: "."), dot != line.startIndex else { return nil }
    let number = line[..<dot]
    guard number.allSatisfy(\.isNumber) else { return nil }
    let contentStart = line.index(after: dot)
    guard contentStart < line.endIndex, line[contentStart] == " " else { return nil }
    return String(line[line.index(after: contentStart)...])
}

private func isMarkdownDivider(_ line: String) -> Bool {
    let compact = line.filter { !$0.isWhitespace }
    guard compact.count >= 3, let marker = compact.first, ["-", "*", "_"].contains(marker) else { return false }
    return compact.allSatisfy { $0 == marker }
}

private func markdownTableCells(_ line: String) -> [String]? {
    var source = line.trimmingCharacters(in: .whitespaces)
    guard source.contains("|") else { return nil }
    if source.first == "|" { source.removeFirst() }
    if source.last == "|" { source.removeLast() }

    var cells: [String] = []
    var cell = ""
    var escaping = false
    for character in source {
        if escaping {
            if character == "|" {
                cell.append("|")
            } else {
                cell.append("\\")
                cell.append(character)
            }
            escaping = false
        } else if character == "\\" {
            escaping = true
        } else if character == "|" {
            cells.append(cell.trimmingCharacters(in: .whitespaces))
            cell = ""
        } else {
            cell.append(character)
        }
    }
    if escaping { cell.append("\\") }
    cells.append(cell.trimmingCharacters(in: .whitespaces))
    return cells.count >= 2 ? cells : nil
}

private func markdownTableAlignments(_ line: String, columnCount: Int) -> [MobileMarkdownTableAlignment]? {
    guard let cells = markdownTableCells(line), cells.count == columnCount else { return nil }
    var alignments: [MobileMarkdownTableAlignment] = []
    for cell in cells {
        let marker = cell.trimmingCharacters(in: .whitespaces)
        let leadingColon = marker.hasPrefix(":")
        let trailingColon = marker.hasSuffix(":")
        let hyphens = marker.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
        guard hyphens.count >= 3, hyphens.allSatisfy({ $0 == "-" }) else { return nil }
        if leadingColon && trailingColon {
            alignments.append(.center)
        } else if trailingColon {
            alignments.append(.trailing)
        } else {
            alignments.append(.leading)
        }
    }
    return alignments
}

private func normalizeMarkdownTableRow(_ cells: [String], columnCount: Int) -> [String] {
    if cells.count == columnCount { return cells }
    if cells.count > columnCount { return Array(cells.prefix(columnCount)) }
    return cells + Array(repeating: "", count: columnCount - cells.count)
}

struct MarkdownText: View {
    let content: String
    init(_ content: String) { self.content = content }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parseMobileMarkdown(content).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MobileMarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            inlineText(text)
                .font(headingFont(level))
                .textSelection(.enabled)
        case .paragraph(let text):
            inlineText(text)
                .lineSpacing(3)
                .textSelection(.enabled)
        case .unorderedList(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•")
                        inlineText(item).textSelection(.enabled)
                    }
                }
            }
        case .orderedList(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1).")
                            .foregroundStyle(.secondary)
                        inlineText(item).textSelection(.enabled)
                    }
                }
            }
        case .quote(let text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(.secondary.opacity(0.45))
                    .frame(width: 3)
                inlineText(text)
                    .italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        case .code(let code):
            ScrollView(.horizontal) {
                Text(code)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(10)
            }
            .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .table(let headers, let alignments, let rows):
            markdownTable(headers: headers, alignments: alignments, rows: rows)
        case .divider:
            Divider()
        }
    }

    private func markdownTable(
        headers: [String],
        alignments: [MobileMarkdownTableAlignment],
        rows: [[String]]
    ) -> some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(spacing: 0) {
                markdownTableRow(headers, alignments: alignments, header: true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider()
                    markdownTableRow(row, alignments: alignments, header: false)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(.secondary.opacity(0.22), lineWidth: 0.8)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func markdownTableRow(
        _ cells: [String],
        alignments: [MobileMarkdownTableAlignment],
        header: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                inlineText(cell)
                    .font(header ? .subheadline.weight(.semibold) : .subheadline)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: tableAlignment(alignments[index]))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .containerRelativeFrame(
                        .horizontal,
                        count: min(3, max(1, cells.count)),
                        span: 1,
                        spacing: 0
                    )
                if index < cells.count - 1 {
                    Divider()
                }
            }
        }
        .background(header ? Color.secondary.opacity(0.1) : Color.clear)
    }

    private func tableAlignment(_ alignment: MobileMarkdownTableAlignment) -> Alignment {
        switch alignment {
        case .leading: return .topLeading
        case .center: return .top
        case .trailing: return .topTrailing
        }
    }

    private func inlineText(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return Text(attributed)
        }
        return Text(text)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3.bold()
        case 2: return .headline
        default: return .subheadline.bold()
        }
    }
}

struct DecisionListView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var status = "inbox"
    private let statuses = [
        ("inbox", "待处理"),
        ("in_progress", "进行中"),
        ("waiting", "等待中"),
        ("resolved", "已完成"),
        ("ignored", "已忽略")
    ]
    private var decisions: [Decision] { store.decisions.filter { $0.status == status } }

    var body: some View {
        VStack(spacing: 0) {
            CompanionCompactTabBar(
                selection: $status,
                items: statuses.map(\.0),
                title: statusTitle
            )
            .padding(.vertical, 10)

            List(decisions) { decision in
                NavigationLink(value: CompanionRoute.decision(id: decision.id)) { DecisionRow(decision: decision) }
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            }
            .listStyle(.plain)
            .refreshable { await store.sync() }
            .overlay {
                if decisions.isEmpty {
                    ContentUnavailableView("没有\(statuses.first(where: { $0.0 == status })?.1 ?? "")事项", systemImage: "tray")
                }
            }
        }
    }

    private func statusTitle(_ value: String) -> String {
        statuses.first(where: { $0.0 == value })?.1 ?? value
    }
}

struct DecisionRow: View {
    let decision: Decision
    var body: some View {
        if decision.status == "resolved" {
            DecisionCompletionCard(decision: decision, compact: true)
        } else {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Text(decision.title).font(.headline)
                    if decision.status == "in_progress" {
                        Text("进行中")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.blue)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.blue.opacity(0.09), in: Capsule())
                    }
                    if decision.status == "waiting" {
                        Text(decisionWaitingLabel(decision.waitingReason))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.orange.opacity(0.09), in: Capsule())
                    }
                }
                Text(decision.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                if decision.status == "waiting", let statusSummary = decision.statusSummary {
                    Text(statusSummary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Text("\(decision.source) · \(relativeDate(decision.createdAt))").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 5)
        }
    }
}

private struct DecisionCompletionCard: View {
    let decision: Decision
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 7 : 10) {
            HStack(spacing: 7) {
                Image(systemName: "checkmark.circle.fill")
                Text("已完成").font(.subheadline.weight(.semibold))
                Spacer()
                if let resolvedAt = decision.resolvedAt {
                    Text(relativeDate(resolvedAt)).font(.caption).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(.green)

            Text(decision.title).font(.headline).foregroundStyle(.primary)
            Text(decision.resolutionSummary ?? "事项已经完成。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(compact ? 2 : nil)

            if !compact && !decision.evidenceRefs.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(decision.evidenceRefs, id: \.uri) { evidence in
                            Label(evidence.label, systemImage: "checkmark")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.green)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(.green.opacity(0.09), in: Capsule())
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(compact ? 14 : 16)
        .background(.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.green.opacity(0.13), lineWidth: 1)
        }
    }
}

struct DecisionDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    @EnvironmentObject private var router: CompanionRouter
    let decisionID: String
    @State private var busy = false
    @State private var error: String?
    private var decision: Decision? { store.state.decisions.first { $0.id == decisionID } }

    var body: some View {
        Form {
            if let decision {
                Section("发现") {
                    Text(decision.summary)
                    LabeledContent("影响", value: decision.impact)
                    LabeledContent("来源", value: decision.source)
                }
                if decision.status == "resolved" {
                    Section {
                        DecisionCompletionCard(decision: decision, compact: false)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                        ForEach(decision.evidenceRefs, id: \.uri) { evidence in
                            if let url = URL(string: evidence.uri) {
                                Link(evidence.label, destination: url)
                            }
                        }
                        Button("取消完成", systemImage: "arrow.uturn.backward") { Task { await cancelCompletion() } }.disabled(busy)
                    }
                } else if decision.status == "ignored" {
                    Section("处理") {
                        Button("恢复待处理", systemImage: "arrow.uturn.backward") { Task { await restore() } }.disabled(busy)
                    }
                } else {
                    Section("处理") {
                        if decision.status == "waiting", let statusSummary = decision.statusSummary {
                            LabeledContent(decisionWaitingLabel(decision.waitingReason), value: statusSummary)
                        }
                        Button(decision.status == "in_progress" || decision.status == "waiting" ? "继续处理" : "去处理", systemImage: "arrow.up.right") { Task { await handle(decision) } }.disabled(busy)
                        Button("忽略", systemImage: "archivebox", role: .destructive) { Task { await ignore() } }.disabled(busy)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
        }
        .navigationTitle(decision?.title ?? "收件箱")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func handle(_ decision: Decision) async {
        busy = true; defer { busy = false }
        do {
            let runID = try await store.handleDecision(decision)
            router.openRun(id: runID, prefill: decision.summary)
        } catch { self.error = error.localizedDescription }
    }

    private func ignore() async {
        busy = true; defer { busy = false }
        do {
            try await store.updateDecision(id: decisionID, status: "ignored")
            await store.sync()
            router.select(.inbox)
        } catch { self.error = error.localizedDescription }
    }

    private func cancelCompletion() async {
        busy = true; defer { busy = false }
        do {
            try await store.updateDecision(id: decisionID, status: "in_progress")
            await store.sync()
        } catch { self.error = error.localizedDescription }
    }

    private func restore() async {
        busy = true; defer { busy = false }
        do {
            try await store.updateDecision(id: decisionID, status: "inbox")
            await store.sync()
        } catch { self.error = error.localizedDescription }
    }
}

private func decisionWaitingLabel(_ reason: String?) -> String {
    switch reason {
    case "deployment": return "等待部署"
    case "verification": return "等待验证"
    case "external": return "等待外部处理"
    case "measurement": return "等待指标"
    case "user": return "等待用户"
    case "scheduled": return "等待复查"
    default: return "等待中"
    }
}

struct ProjectListView: View {
    @EnvironmentObject private var store: CompanionStore
    var body: some View {
        List(store.state.projects) { project in
            NavigationLink(value: CompanionRoute.project(id: project.id)) {
                HStack(alignment: .top, spacing: 10) {
                    ProjectIconView(project: project)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(project.name).font(.headline)
                        Text(project.summary).foregroundStyle(.secondary)
                        Text(project.focus).font(.caption).foregroundStyle(.tertiary)
                    }
                }.padding(.vertical, 4)
            }
        }
        .listStyle(.plain)
        .refreshable { await store.sync() }
    }
}

private struct ProjectIconView: View {
    let project: Project

    private var image: UIImage? {
        guard let data = projectIconImageData(project.icon) else { return nil }
        return UIImage(data: data)
    }

    private var text: String {
        let custom = project.icon?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return custom.isEmpty ? String(project.name.trimmingCharacters(in: .whitespacesAndNewlines).first ?? "?") : custom
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Text(text)
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
            }
        }
            .frame(width: 30, height: 30)
            .background(image == nil ? Color.accentColor : Color.white, in: RoundedRectangle(cornerRadius: 8))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.primary.opacity(image == nil ? 0 : 0.08)))
            .accessibilityLabel("\(project.name) 图标")
    }
}

func projectIconImageData(_ icon: String?) -> Data? {
    guard let icon = icon?.trimmingCharacters(in: .whitespacesAndNewlines),
          icon.range(of: #"^data:image/(png|jpeg|webp);base64,"#, options: [.regularExpression, .caseInsensitive]) != nil,
          let comma = icon.firstIndex(of: ",") else { return nil }
    return Data(base64Encoded: String(icon[icon.index(after: comma)...]))
}

struct ProjectDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    @EnvironmentObject private var router: CompanionRouter
    let project: Project
    @State private var section = ProjectDetailSection.overview
    private var goals: [ProjectGoal] { store.state.goals.filter { $0.projectId == project.id } }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                CompanionCompactTabBar(
                    selection: $section,
                    items: ProjectDetailSection.allCases,
                    title: { $0.title }
                )

                HStack {
                    Button {
                        guard !router.path.isEmpty else { return }
                        router.path.removeLast()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.headline.weight(.semibold))
                            .frame(width: 42, height: 42)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .companionLiquidGlass(in: Circle())
                    .accessibilityLabel("返回项目列表")
                    Spacer()
                }
            }
            .frame(height: 58)
            .padding(.horizontal, 16)

            CompanionTwoPageContainer(
                selection: $section,
                leadingSelection: .overview,
                trailingSelection: .settings
            ) {
                List {
                    Section("当前重点") { Text(project.focus); Text(project.summary).foregroundStyle(.secondary) }
                    Section("目标") {
                        if goals.isEmpty { Text("尚未设置目标").foregroundStyle(.secondary) }
                        ForEach(goals) { goal in
                            VStack(alignment: .leading, spacing: 7) {
                                HStack { Text(goal.title).font(.headline); Spacer(); Text(goal.priority).font(.caption.bold()).foregroundStyle(.secondary) }
                                ProgressView(value: goal.progress)
                                Text(goal.agentSummary).font(.subheadline).foregroundStyle(.secondary)
                                ForEach(goal.milestones) { milestone in
                                    Label(milestone.title, systemImage: milestone.status == "completed" ? "checkmark.circle.fill" : "circle")
                                        .font(.caption).foregroundStyle(milestone.status == "completed" ? Color.green : Color.secondary)
                                }
                            }.padding(.vertical, 5)
                        }
                    }
                }
            } trailing: {
                ProjectSettingsView(project: project)
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
    }
}

private enum ProjectDetailSection: String, CaseIterable, Identifiable {
    case overview, settings
    var id: String { rawValue }
    var title: String { self == .overview ? "概览" : "设置" }
}

private struct ProjectSettingsListDraft: Equatable {
    var surfaces: String
    var focusAreas: String
    var dataSources: String
    var nextMoves: String

    init(project: Project) {
        surfaces = project.profile.surfaces.joined(separator: "\n")
        focusAreas = project.profile.focusAreas.joined(separator: "\n")
        dataSources = project.profile.dataSources.joined(separator: "\n")
        nextMoves = project.profile.nextMoves.joined(separator: "\n")
    }
}

private struct ProjectSettingsView: View {
    @EnvironmentObject private var store: CompanionStore
    let project: Project
    @State private var draft: Project
    @State private var lists: ProjectSettingsListDraft
    @State private var saving = false
    @State private var feedback: String?
    @State private var feedbackIsError = false

    init(project: Project) {
        self.project = project
        _draft = State(initialValue: project)
        _lists = State(initialValue: ProjectSettingsListDraft(project: project))
    }

    var body: some View {
        Form {
            Section {
                TextField("项目名称", text: $draft.name)
                if projectIconImageData(draft.icon) != nil {
                    HStack {
                        ProjectIconView(project: draft)
                        Text("当前使用项目 Logo").foregroundStyle(.secondary)
                        Spacer()
                        Button("移除", role: .destructive) { draft.icon = nil }
                    }
                } else {
                    TextField("项目图标", text: Binding(
                        get: { draft.icon ?? "" },
                        set: { draft.icon = $0.isEmpty ? nil : String($0.prefix(16)) }
                    ), prompt: Text("Emoji 或文字；留空使用项目名首字"))
                }
                Picker("状态", selection: $draft.status) {
                    Text("Active").tag("active")
                    Text("Watching").tag("watching")
                    Text("Paused").tag("paused")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("一句话介绍").font(.caption).foregroundStyle(.secondary)
                    TextField("项目的一句话介绍", text: $draft.summary, axis: .vertical).lineLimit(2...4)
                }
                TextField("Agent 分析视角", text: $draft.focus, prompt: Text("Growth / Data / Operations"))
            } header: {
                Text("基本信息")
            } footer: {
                Text("项目在侧边栏、简报和 Agent 上下文中的身份。")
            }

            Section {
                TextField("产品类型", text: $draft.profile.productType)
                TextField("当前阶段", text: $draft.profile.stage)
                multilineField("产品形态（每行一项）", text: $lists.surfaces, minHeight: 76)
                multilineField("重点领域（每行一项）", text: $lists.focusAreas, minHeight: 92)
            } header: {
                Text("产品上下文")
            } footer: {
                Text("帮助 Agent 理解项目形态、阶段和当前工作范围。")
            }

            Section {
                if draft.profile.workspaceRoots.isEmpty {
                    Text("尚未配置 Workspace").foregroundStyle(.secondary)
                }
                ForEach($draft.profile.workspaceRoots) { $root in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("Workspace 名称", text: $root.label)
                            Button(role: .destructive) { removeWorkspace(id: root.id) } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("移除 \(root.label)")
                        }
                        TextField("/Users/name/Code/project", text: $root.path)
                            .font(.system(.subheadline, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .padding(.vertical, 3)
                }
                Button { addWorkspace() } label: { Label("添加 Workspace", systemImage: "plus") }

                if !draft.profile.workspaceRoots.isEmpty {
                    Picker("主 Workspace", selection: primaryWorkspaceBinding) {
                        ForEach(draft.profile.workspaceRoots) { root in
                            Text(root.label.isEmpty ? (root.path.isEmpty ? root.id : root.path) : root.label).tag(root.id)
                        }
                    }
                }
                Picker("默认 Agent", selection: $draft.profile.defaultAgent) {
                    Text("Pi Agent").tag("pi")
                    Text("Codex").tag("codex")
                    Text("Claude Code").tag("claude")
                    Text("OpenCode").tag("opencode")
                }
                TextField("官网", text: websiteBinding, prompt: Text("https://example.com"))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("代码与入口")
            } footer: {
                Text("所有 Agent Run 都从主 Workspace 启动，并可访问这里列出的项目目录。")
            }

            Section {
                multilineField("数据源（每行一项）", text: $lists.dataSources, minHeight: 112)
                multilineField("建议下一步（每行一项）", text: $lists.nextMoves, minHeight: 112)
            } header: {
                Text("数据与下一步")
            } footer: {
                Text("定义项目自己的证据来源和当前优先事项。")
            }

            if let feedback {
                Section {
                    Label(feedback, systemImage: feedbackIsError ? "exclamationmark.circle" : "checkmark.circle")
                        .foregroundStyle(feedbackIsError ? Color.red : Color.green)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button { Task { await save() } } label: {
                HStack {
                    if saving { ProgressView().tint(.white) }
                    else { Image(systemName: "checkmark.shield") }
                    Text(saving ? "正在保存…" : "保存项目设置")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .disabled(saving || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
        .onChange(of: project) { _, updated in
            guard !saving else { return }
            draft = updated
            lists = ProjectSettingsListDraft(project: updated)
        }
        .task(id: feedback) {
            guard feedback != nil else { return }
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { feedback = nil }
        }
    }

    @ViewBuilder private func multilineField(_ title: String, text: Binding<String>, minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextEditor(text: text)
                .frame(minHeight: minHeight)
                .scrollContentBackground(.hidden)
        }
    }

    private var websiteBinding: Binding<String> {
        Binding(
            get: { draft.profile.websiteUrl ?? "" },
            set: { draft.profile.websiteUrl = $0.isEmpty ? nil : $0 }
        )
    }

    private var primaryWorkspaceBinding: Binding<String> {
        Binding(
            get: { draft.profile.primaryWorkspaceRootId ?? draft.profile.workspaceRoots.first?.id ?? "" },
            set: { draft.profile.primaryWorkspaceRootId = $0 }
        )
    }

    private func addWorkspace() {
        let root = ProjectWorkspaceRoot(id: "workspace-\(UUID().uuidString.lowercased())", label: "New workspace", path: "")
        draft.profile.workspaceRoots.append(root)
        if draft.profile.primaryWorkspaceRootId == nil { draft.profile.primaryWorkspaceRootId = root.id }
    }

    private func removeWorkspace(id: String) {
        draft.profile.workspaceRoots.removeAll { $0.id == id }
        if draft.profile.primaryWorkspaceRootId == id {
            draft.profile.primaryWorkspaceRootId = draft.profile.workspaceRoots.first?.id
        }
    }

    private func lines(_ value: String) -> [String] {
        value.split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func normalizedProject() -> Project {
        var value = draft
        value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines)
        value.summary = value.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        value.focus = value.focus.trimmingCharacters(in: .whitespacesAndNewlines)
        value.profile.productType = value.profile.productType.trimmingCharacters(in: .whitespacesAndNewlines)
        value.profile.stage = value.profile.stage.trimmingCharacters(in: .whitespacesAndNewlines)
        value.profile.websiteUrl = value.profile.websiteUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.profile.websiteUrl?.isEmpty == true { value.profile.websiteUrl = nil }
        value.profile.surfaces = lines(lists.surfaces)
        value.profile.focusAreas = lines(lists.focusAreas)
        value.profile.dataSources = lines(lists.dataSources)
        value.profile.nextMoves = lines(lists.nextMoves)
        value.profile.workspaceRoots = value.profile.workspaceRoots.compactMap { root in
            let path = root.path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { return nil }
            let label = root.label.trimmingCharacters(in: .whitespacesAndNewlines)
            return ProjectWorkspaceRoot(id: root.id, label: label.isEmpty ? URL(fileURLWithPath: path).lastPathComponent : label, path: path)
        }
        if !value.profile.workspaceRoots.contains(where: { $0.id == value.profile.primaryWorkspaceRootId }) {
            value.profile.primaryWorkspaceRootId = value.profile.workspaceRoots.first?.id
        }
        value.profile.repoPath = value.profile.workspaceRoots.first(where: { $0.id == value.profile.primaryWorkspaceRootId })?.path ?? ""
        return value
    }

    @MainActor private func save() async {
        saving = true
        feedback = nil
        do {
            let value = normalizedProject()
            try await store.updateProject(value)
            draft = value
            lists = ProjectSettingsListDraft(project: value)
            feedbackIsError = false
            feedback = "项目设置已保存"
        } catch {
            feedbackIsError = true
            feedback = error.localizedDescription
        }
        saving = false
    }
}

struct CompanionSettingsView: View {
    @EnvironmentObject private var store: CompanionStore
    var body: some View {
        Form {
            Section("连接") {
                LabeledContent("状态", value: connectionLabel)
                if let credentials = store.credentials {
                    LabeledContent("Relay", value: URL(string: credentials.relayURL)?.host ?? credentials.relayURL)
                    LabeledContent("设备", value: String(credentials.deviceID.prefix(8)))
                }
                Button("立即同步") { Task { await store.sync() } }
            }
            Section { Button("断开 Mac", role: .destructive) { store.unpair() } }
        }
    }
    private var connectionLabel: String {
        switch store.connection {
        case .unpaired: "未配对"
        case .connecting: "正在连接"
        case .connected: store.macOnline ? "Mac 在线" : "Relay 已连接，Mac 离线"
        case .offline: "离线，显示本地缓存"
        case .error(let message): message
        }
    }
}

private func relativeDate(_ value: String) -> String {
    guard let date = parseCompanionDate(value) else { return value }
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: "zh-Hans-CN")
    return formatter.localizedString(for: date, relativeTo: Date())
}
