import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private struct CompanionBottomSafeAreaInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var companionBottomSafeAreaInset: CGFloat {
        get { self[CompanionBottomSafeAreaInsetKey.self] }
        set { self[CompanionBottomSafeAreaInsetKey.self] = newValue }
    }
}

private struct CompanionLiquidGlassModifier<EffectShape: Shape>: ViewModifier {
    let shape: EffectShape
    let interactive: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            if interactive {
                content.glassEffect(.regular.interactive(), in: shape)
            } else {
                content.glassEffect(.regular, in: shape)
            }
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay {
                    shape.stroke(.white.opacity(0.3), lineWidth: 0.8)
                }
        }
        #else
        content
            .background(.ultraThinMaterial, in: shape)
            .overlay {
                shape.stroke(.white.opacity(0.3), lineWidth: 0.8)
            }
        #endif
    }
}

extension View {
    func companionLiquidGlass<EffectShape: Shape>(
        in shape: EffectShape,
        interactive: Bool = true
    ) -> some View {
        modifier(CompanionLiquidGlassModifier(shape: shape, interactive: interactive))
    }
}

struct PendingAttachment: Identifiable, Hashable {
    let id: String
    let name: String
    let mimeType: String
    let data: Data
}

private struct CompanionComposerHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 72

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct CompanionChatSurface<Content: View, Composer: View>: View {
    @Environment(\.companionBottomSafeAreaInset) private var screenBottomSafeAreaInset

    var topChromeHeight: CGFloat = 62
    let isAtLatestMessage: Bool
    let onScrollToLatest: () -> Void
    @ViewBuilder let content: (_ viewport: CGSize, _ topInset: CGFloat, _ bottomInset: CGFloat) -> Content
    @ViewBuilder let composer: () -> Composer

    @State private var composerHeight: CGFloat = CompanionComposerHeightKey.defaultValue
    @State private var keyboardPresented = false

    var body: some View {
        GeometryReader { geometry in
            let topInset = geometry.safeAreaInsets.top + topChromeHeight
            let bottomInset = composerHeight + 24
            let composerBottomInset = keyboardPresented ? 2 : screenBottomSafeAreaInset + 2

            ZStack(alignment: .bottom) {
                chatContent(
                    viewport: geometry.size,
                    topInset: topInset,
                    bottomInset: bottomInset
                )

                CompanionBottomScrollEdgeEffect(height: composerHeight + 82)

                measuredComposer(bottomInset: composerBottomInset)

                scrollToLatestButton
            }
            .animation(.easeOut(duration: 0.2), value: isAtLatestMessage)
            .onPreferenceChange(CompanionComposerHeightKey.self) { height in
                guard height.isFinite, height > 0 else { return }
                composerHeight = height
            }
            .animation(.easeOut(duration: 0.25), value: keyboardPresented)
        }
        .ignoresSafeArea(.container, edges: [.top, .bottom])
        .background {
            // Paint the shared chat surface through the home-indicator area without
            // moving the composer or opting the layout out of keyboard safe areas.
            Color(uiColor: .systemBackground)
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardPresented = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardPresented = false
        }
    }

    private func chatContent(
        viewport: CGSize,
        topInset: CGFloat,
        bottomInset: CGFloat
    ) -> some View {
        content(viewport, topInset, bottomInset)
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .onTapGesture {
                dismissCompanionKeyboard()
            }
    }

    private func measuredComposer(bottomInset: CGFloat) -> some View {
        composer()
            .padding(.bottom, bottomInset)
            .background {
                GeometryReader { composerGeometry in
                    Color.clear.preference(
                        key: CompanionComposerHeightKey.self,
                        value: composerGeometry.size.height
                    )
                }
            }
    }

    @ViewBuilder
    private var scrollToLatestButton: some View {
        if !isAtLatestMessage {
            CompanionScrollToLatestButton(action: onScrollToLatest)
                .padding(.bottom, composerHeight + 14)
                .transition(.scale.combined(with: .opacity))
        }
    }
}

private struct CompanionBottomScrollEdgeEffect: View {
    let height: CGFloat

    var body: some View {
        Rectangle()
            .fill(.thinMaterial)
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black.opacity(0.18), location: 0.24),
                        .init(color: .black.opacity(0.7), location: 0.62),
                        .init(color: .black, location: 1)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .frame(height: max(140, height))
            .ignoresSafeArea(.container, edges: .bottom)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct CompanionScrollToLatestButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.subheadline.weight(.semibold))
                .frame(width: 38, height: 38)
                .background(.regularMaterial, in: Circle())
                .overlay { Circle().stroke(.primary.opacity(0.08), lineWidth: 0.8) }
                .shadow(color: .black.opacity(0.12), radius: 12, y: 5)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("回到最新消息")
    }
}

@MainActor
private func dismissCompanionKeyboard() {
    UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder),
        to: nil,
        from: nil,
        for: nil
    )
}

struct CompanionChatComposer: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var text: String
    @Binding var attachments: [PendingAttachment]
    let placeholder: String
    let sending: Bool
    var imageOnly = false
    var disabled = false
    var active = false
    let onSend: () -> Void
    var onStop: (() -> Void)? = nil

    @State private var photoItems: [PhotosPickerItem] = []
    @State private var importingFiles = false
    @State private var attachmentError: String?
    @StateObject private var voiceInput = CompanionVoiceInput()

    private var canSend: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) && !sending && !disabled
    }

    private var canStop: Bool {
        active && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && !sending && onStop != nil
    }

    private var enabledSendColor: Color {
        colorScheme == .dark ? .white : .black
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments) { attachment in
                            HStack(spacing: 6) {
                                Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc")
                                Text(attachment.name).lineLimit(1)
                                Button {
                                    attachments.removeAll { $0.id == attachment.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(.secondary.opacity(0.1), in: Capsule())
                        }
                    }
                }
            }

            if let error = attachmentError ?? voiceInput.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            HStack(alignment: .bottom, spacing: 10) {
                Menu {
                    PhotosPicker(selection: $photoItems, maxSelectionCount: max(1, 4 - attachments.count), matching: .images) {
                        Label("照片", systemImage: "photo.on.rectangle")
                    }
                    if !imageOnly {
                        Button {
                            importingFiles = true
                        } label: {
                            Label("文件", systemImage: "doc")
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .frame(width: 38, height: 38)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(attachments.count >= 4 || sending)

                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.subheadline)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.vertical, 9)

                Button {
                    Task {
                        if voiceInput.state == .recording {
                            if let transcript = await voiceInput.stopAndTranscribe(
                                prompt: "Fuddy，项目，目标，决策收件箱，工作助理，Agent Run"
                            ), !transcript.isEmpty {
                                text = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? transcript
                                    : "\(text.trimmingCharacters(in: .whitespacesAndNewlines)) \(transcript)"
                            }
                        } else {
                            await voiceInput.start()
                        }
                    }
                } label: {
                    Group {
                        switch voiceInput.state {
                        case .idle: Image(systemName: "mic")
                        case .recording: Image(systemName: "stop.fill").foregroundStyle(.red)
                        case .transcribing: ProgressView().controlSize(.small)
                        }
                    }
                    .font(.body.weight(.medium))
                    .frame(width: 34, height: 38)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(disabled || sending || voiceInput.state == .transcribing)
                .accessibilityLabel(voiceInput.state == .recording ? "停止录音并转写" : "语音输入")

                Button(action: { canStop ? onStop?() : onSend() }) {
                    ZStack {
                        Circle().fill((canSend || canStop) ? enabledSendColor : Color.secondary.opacity(0.18))
                        if sending {
                            ProgressView().tint(.white).controlSize(.small)
                        } else if canStop {
                            Image(systemName: "stop.fill")
                                .font(.caption.bold())
                                .foregroundStyle(Color(uiColor: .systemBackground))
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.body.bold())
                                .foregroundStyle(canSend ? Color(uiColor: .systemBackground) : Color.secondary)
                        }
                    }
                    .frame(width: 38, height: 38)
                }
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .buttonStyle(.plain)
                .disabled(!canSend && !canStop)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .companionLiquidGlass(
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .shadow(color: .black.opacity(0.1), radius: 18, y: 7)
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .onChange(of: photoItems) { _, items in
            Task { await addPhotos(items) }
        }
        .fileImporter(
            isPresented: $importingFiles,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            addFiles(result)
        }
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        defer { photoItems = [] }
        attachmentError = nil
        for item in items.prefix(max(0, 4 - attachments.count)) {
            do {
                guard let source = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: source),
                      let data = image.jpegData(compressionQuality: 0.9) else { continue }
                try append(data: data, name: "照片-\(attachments.count + 1).jpg", mimeType: "image/jpeg")
            } catch {
                attachmentError = error.localizedDescription
            }
        }
    }

    private func addFiles(_ result: Result<[URL], Error>) {
        attachmentError = nil
        do {
            for url in try result.get().prefix(max(0, 4 - attachments.count)) {
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                let contentType = UTType(filenameExtension: url.pathExtension)
                try append(data: data, name: url.lastPathComponent, mimeType: contentType?.preferredMIMEType ?? "application/octet-stream")
            }
        } catch {
            attachmentError = error.localizedDescription
        }
    }

    private func append(data: Data, name: String, mimeType: String) throws {
        // Leave 32 bytes for the PAE2 + AES-GCM envelope so the stored R2
        // object itself never exceeds the hosted 20 MiB limit.
        guard data.count <= 20 * 1024 * 1024 - 32 else {
            throw ComposerAttachmentError.tooLarge
        }
        attachments.append(PendingAttachment(id: UUID().uuidString, name: name, mimeType: mimeType, data: data))
    }
}

private enum ComposerAttachmentError: LocalizedError {
    case tooLarge
    var errorDescription: String? { "单个附件不能超过 20 MiB。" }
}
