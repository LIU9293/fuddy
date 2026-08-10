import QuickLook
import SwiftUI

struct ArtifactRow: View {
    @EnvironmentObject private var store: CompanionStore
    let artifact: AgentArtifact
    @State private var previewItem: PreviewItem?
    @State private var downloading = false
    @State private var error: String?

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: iconName)
                    .frame(width: 30, height: 30)
                    .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.label).font(.subheadline.weight(.medium)).lineLimit(1)
                    if let attachment = store.attachment(for: artifact.id) {
                        Text("\(attachment.mimeType) · \(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))")
                            .font(.caption).foregroundStyle(.secondary)
                    } else { Text(artifact.relativePath).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
                if downloading { ProgressView() } else { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(downloading)
        .sheet(item: $previewItem) { QuickLookPreview(url: $0.url) }
        .alert("无法打开附件", isPresented: Binding(
            get: { error != nil },
            set: { presented in if !presented { error = nil } }
        )) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var iconName: String {
        guard let mimeType = store.attachment(for: artifact.id)?.mimeType ?? artifact.mimeType else { return "doc" }
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType == "application/pdf" { return "doc.richtext" }
        if mimeType.hasPrefix("video/") { return "video" }
        return "doc"
    }

    private func open() async {
        downloading = true; defer { downloading = false }
        do { previewItem = PreviewItem(url: try await store.openArtifact(artifact)) }
        catch { self.error = error.localizedDescription }
    }
}

struct RunInfoSheet: View {
    private enum Tab: String, CaseIterable, Identifiable {
        case overview = "基本信息"
        case files = "文件"
        var id: String { rawValue }
    }

    @EnvironmentObject private var store: CompanionStore
    @Environment(\.dismiss) private var dismiss
    let runID: String
    @State private var tab: Tab = .overview

    private var detail: RunDetail? { store.state.runs.first { $0.run.id == runID } }
    private var project: Project? {
        guard let projectID = detail?.run.projectId else { return nil }
        return store.state.projects.first { $0.id == projectID }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Session 信息", selection: $tab) {
                    ForEach(Tab.allCases) { tab in Text(tab.rawValue).tag(tab) }
                }
                .pickerStyle(.segmented)
                .padding()

                if let detail {
                    switch tab {
                    case .overview: overview(detail)
                    case .files: files(detail)
                    }
                } else {
                    ProgressView("正在同步 Session…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Session 信息")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func overview(_ detail: RunDetail) -> some View {
        List {
            Section("Session") {
                LabeledContent("标题", value: detail.run.title)
                LabeledContent("Agent", value: detail.run.provider)
                LabeledContent("状态", value: statusLabel(detail.run.status))
                if !detail.run.summary.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("概览").font(.caption).foregroundStyle(.secondary)
                        Text(detail.run.summary)
                    }
                }
            }
            if let project {
                Section("当前项目") {
                    LabeledContent("名称", value: project.name)
                    if !project.summary.isEmpty { Text(project.summary).foregroundStyle(.secondary) }
                    if !project.focus.isEmpty { LabeledContent("当前重点", value: project.focus) }
                }
            }
            Section("Workspace") {
                Text(detail.run.workingDirectory ?? "未配置")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .listStyle(.insetGrouped)
    }

    private func files(_ detail: RunDetail) -> some View {
        List {
            if detail.artifacts.isEmpty {
                ContentUnavailableView("暂无文件", systemImage: "doc", description: Text("这个 Session 还没有产物。"))
            } else {
                Section("产物 \(detail.artifacts.count)") {
                    ForEach(detail.artifacts) { artifact in ArtifactRow(artifact: artifact) }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "draft": "草稿"
        case "queued": "等待中"
        case "running": "运行中"
        case "completed": "已完成"
        case "failed": "失败"
        case "cancelled": "已取消"
        default: status
        }
    }
}

struct RemoteAttachmentRow: View {
    @EnvironmentObject private var store: CompanionStore
    let attachment: AttachmentDescriptor
    @State private var previewItem: PreviewItem?
    @State private var downloading = false
    @State private var error: String?

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "paperclip")
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.filename).lineLimit(1)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if downloading { ProgressView().controlSize(.small) }
            }
            .font(.caption)
            .padding(8)
            .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .sheet(item: $previewItem) { QuickLookPreview(url: $0.url) }
        .alert("无法打开附件", isPresented: Binding(
            get: { error != nil },
            set: { presented in if !presented { error = nil } }
        )) {
            Button("好") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func open() async {
        downloading = true; defer { downloading = false }
        do { previewItem = PreviewItem(url: try await store.download(attachment)) }
        catch { self.error = error.localizedDescription }
    }
}

struct PreviewItem: Identifiable { let url: URL; var id: String { url.absoluteString } }

struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
