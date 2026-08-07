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
        .sheet(item: $previewItem) { QuickLookPreview(url: $0.url) }
        .alert("无法打开附件", isPresented: .constant(error != nil)) {
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
        guard let attachment = store.attachment(for: artifact.id) else {
            error = "这个附件尚未从 Mac 上传。"
            return
        }
        downloading = true; defer { downloading = false }
        do { previewItem = PreviewItem(url: try await store.download(attachment)) }
        catch { self.error = error.localizedDescription }
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
        .alert("无法打开附件", isPresented: .constant(error != nil)) {
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
