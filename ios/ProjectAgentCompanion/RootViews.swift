import SwiftUI

struct CompanionRootView: View {
    var body: some View {
        TabView {
            WorkAssistantView().tabItem { Label("工作助理", systemImage: "sparkles") }
            RunsListView().tabItem { Label("Agent Runs", systemImage: "bubble.left.and.bubble.right") }
            DecisionListView().tabItem { Label("收件箱", systemImage: "tray") }
            ProjectListView().tabItem { Label("项目", systemImage: "square.grid.2x2") }
            CompanionSettingsView().tabItem { Label("设置", systemImage: "gearshape") }
        }
    }
}

struct WorkAssistantView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var prompt = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        ForEach(store.workAssistantMessages) { message in
                            HStack {
                                if message.role == "user" { Spacer(minLength: 42) }
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(message.role == "user" ? "你" : "工作助理")
                                        .font(.caption.bold()).foregroundStyle(.secondary)
                                    MarkdownText(message.content)
                                    ForEach(message.attachments) { attachment in
                                        RemoteAttachmentRow(attachment: attachment)
                                    }
                                }
                                .padding(12)
                                .background(message.role == "user" ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                                if message.role != "user" { Spacer(minLength: 24) }
                            }
                            .id(message.id)
                        }
                    }.padding()
                }
                .onChange(of: store.workAssistantMessages.count) { _, _ in
                    if let id = store.workAssistantMessages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 6) {
                    if let error { Text(error).font(.caption).foregroundStyle(.red) }
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("讨论任务、目标或项目问题", text: $prompt, axis: .vertical)
                            .lineLimit(1...5).textFieldStyle(.roundedBorder)
                        Button { Task { await send() } } label: {
                            if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        }
                        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                    }
                }.padding(.horizontal).padding(.vertical, 10).background(.bar)
            }
            .navigationTitle("工作助理")
            .refreshable { await store.sync() }
            .overlay { if store.workAssistantMessages.isEmpty { ContentUnavailableView("开始和工作助理对话", systemImage: "sparkles") } }
        }
    }

    private func send() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true; error = nil
        do { try await store.sendWorkAssistantMessage(text); prompt = ""; await store.sync() }
        catch { self.error = error.localizedDescription }
        sending = false
    }
}

struct RunsListView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            List(store.runs) { detail in
                NavigationLink(value: detail.run.id) {
                    HStack(alignment: .top, spacing: 12) {
                        if detail.run.status == "running" || detail.run.status == "queued" { ProgressView().controlSize(.small) }
                        VStack(alignment: .leading, spacing: 5) {
                            Text(detail.run.title).font(.headline).lineLimit(2)
                            Text(runMetadata(detail.run)).font(.caption).foregroundStyle(.secondary)
                            if !detail.run.summary.isEmpty { Text(detail.run.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
            .navigationDestination(for: String.self) { RunDetailView(runID: $0) }
            .navigationTitle("Agent Runs")
            .refreshable { await store.sync() }
            .overlay { if store.runs.isEmpty { ContentUnavailableView("暂无 Agent Run", systemImage: "bubble.left.and.bubble.right") } }
        }
    }

    private func runMetadata(_ run: AgentRun) -> String {
        let project = store.state.projects.first { $0.id == run.projectId }?.name ?? "无项目"
        return "\(project) · \(run.provider) · \(relativeDate(run.updatedAt))"
    }
}

struct RunDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    let runID: String
    @State private var prompt = ""
    @State private var sending = false
    @State private var showRename = false
    @State private var renamedTitle = ""
    @State private var error: String?

    private var detail: RunDetail? { store.state.runs.first { $0.run.id == runID } }

    var body: some View {
        Group {
            if let detail {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(detail.messages) { message in MessageView(message: message, detail: detail).id(message.id) }
                            if !detail.artifacts.isEmpty {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("附件").font(.caption.bold()).foregroundStyle(.secondary)
                                    ForEach(detail.artifacts) { artifact in ArtifactRow(artifact: artifact) }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding()
                    }
                    .onChange(of: detail.messages.count) { _, _ in if let id = detail.messages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } } }
                }
                .safeAreaInset(edge: .bottom) { composer(detail.run) }
                .navigationTitle(detail.run.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar(detail.run) }
                .alert("重命名 Session", isPresented: $showRename) {
                    TextField("Session 标题", text: $renamedTitle)
                    Button("取消", role: .cancel) {}
                    Button("保存") { Task { await rename() } }
                }
            } else { ContentUnavailableView("Session 不存在", systemImage: "questionmark.folder") }
        }
    }

    @ViewBuilder private func composer(_ run: AgentRun) -> some View {
        VStack(spacing: 6) {
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("给 \(run.provider) 发送消息", text: $prompt, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder)
                Button { Task { await send() } } label: {
                    if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                }
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || run.status == "running")
            }
        }
        .padding(.horizontal).padding(.vertical, 10).background(.bar)
    }

    @ToolbarContentBuilder private func toolbar(_ run: AgentRun) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("重命名", systemImage: "pencil") { renamedTitle = run.title; showRename = true }
                Button("归档", systemImage: "archivebox", role: .destructive) { Task { await archive() } }
                    .disabled(run.status == "running" || run.status == "queued")
            } label: { Image(systemName: "ellipsis.circle") }
        }
    }

    private func send() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true; error = nil
        do { try await store.sendMessage(runID: runID, prompt: text); prompt = ""; await store.sync() }
        catch { self.error = error.localizedDescription }
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

struct MessageView: View {
    let message: AgentMessage
    let detail: RunDetail

    var body: some View {
        if message.role == "tool" {
            DisclosureGroup {
                Text(message.content).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            } label: { Label(message.toolName ?? "工具调用", systemImage: "wrench.and.screwdriver") }
            .font(.subheadline).padding(12).background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        } else {
            HStack {
                if message.role == "user" { Spacer(minLength: 42) }
                VStack(alignment: .leading, spacing: 7) {
                    Text(message.role == "user" ? "你" : message.role == "assistant" ? detail.run.provider : "系统")
                        .font(.caption.bold()).foregroundStyle(.secondary)
                    MarkdownText(message.content)
                }
                .padding(12)
                .background(message.role == "user" ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                if message.role != "user" { Spacer(minLength: 24) }
            }
        }
    }
}

struct MarkdownText: View {
    let content: String
    init(_ content: String) { self.content = content }
    var body: some View {
        if let attributed = try? AttributedString(markdown: content) { Text(attributed).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        else { Text(content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
    }
}

struct DecisionListView: View {
    @EnvironmentObject private var store: CompanionStore
    var body: some View {
        NavigationStack {
            List(store.decisions) { decision in NavigationLink(value: decision) { DecisionRow(decision: decision) } }
                .navigationDestination(for: Decision.self) { DecisionDetailView(decisionID: $0.id) }
                .navigationTitle("决策收件箱")
                .refreshable { await store.sync() }
                .overlay { if store.decisions.isEmpty { ContentUnavailableView("收件箱为空", systemImage: "tray") } }
        }
    }
}

struct DecisionRow: View {
    let decision: Decision
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(decision.title).font(.headline)
            Text(decision.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            Text("\(decision.source) · \(relativeDate(decision.createdAt))").font(.caption).foregroundStyle(.tertiary)
        }.padding(.vertical, 3)
    }
}

struct DecisionDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    let decisionID: String
    @State private var busy = false
    @State private var error: String?
    private var decision: Decision? { store.state.decisions.first { $0.id == decisionID } }
    var body: some View {
        Form {
            if let decision {
                Section("发现") { Text(decision.summary); LabeledContent("影响", value: decision.impact); LabeledContent("来源", value: decision.source) }
                Section("处理") {
                    Button("稍后处理") { Task { await update("later") } }.disabled(busy)
                    Button("标记完成") { Task { await update("resolved") } }.disabled(busy)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
        }.navigationTitle(decision?.title ?? "决策").navigationBarTitleDisplayMode(.inline)
    }
    private func update(_ status: String) async {
        busy = true; defer { busy = false }
        do { try await store.updateDecision(id: decisionID, status: status); await store.sync() }
        catch { self.error = error.localizedDescription }
    }
}

struct ProjectListView: View {
    @EnvironmentObject private var store: CompanionStore
    var body: some View {
        NavigationStack {
            List(store.state.projects) { project in
                NavigationLink(value: project) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(project.name).font(.headline)
                        Text(project.summary).foregroundStyle(.secondary)
                        Text(project.focus).font(.caption).foregroundStyle(.tertiary)
                    }.padding(.vertical, 4)
                }
            }
            .navigationDestination(for: Project.self) { ProjectDetailView(project: $0) }
            .navigationTitle("项目").refreshable { await store.sync() }
        }
    }
}

struct ProjectDetailView: View {
    @EnvironmentObject private var store: CompanionStore
    let project: Project
    private var goals: [ProjectGoal] { store.state.goals.filter { $0.projectId == project.id } }
    var body: some View {
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
        }.navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
    }
}

struct CompanionSettingsView: View {
    @EnvironmentObject private var store: CompanionStore
    var body: some View {
        NavigationStack {
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
                Section("架构") { Text("手机保存只读缓存并发送操作命令；代码、数据库、Agent 凭证和工具执行始终留在 Mac。") }
            }.navigationTitle("设置")
        }
    }
    private var connectionLabel: String {
        switch store.connection {
        case .unpaired: "未配对"
        case .connecting: "正在连接"
        case .connected: "已连接"
        case .offline: "离线，显示本地缓存"
        case .error(let message): message
        }
    }
}

private func relativeDate(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    guard let date = formatter.date(from: value) else { return value }
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}
