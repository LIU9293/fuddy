import SwiftUI
import UIKit

struct PairingView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var payload = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Image(systemName: "iphone.and.arrow.forward")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(.tint)
                VStack(spacing: 8) {
                    Text("连接到 Project Agent").font(.title2.bold())
                    Text("在 Mac 的“设置 → 通用 → iPhone Companion”创建配对信息，然后粘贴到这里。所有 Agent 操作仍在 Mac 上执行。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                TextEditor(text: $payload)
                    .font(.caption.monospaced())
                    .frame(minHeight: 120, maxHeight: 180)
                    .padding(8)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(alignment: .topTrailing) {
                        Button("粘贴") { payload = UIPasteboard.general.string ?? "" }
                            .buttonStyle(.bordered)
                            .padding(8)
                    }
                Button {
                    Task { await store.pair(payloadText: payload.trimmingCharacters(in: .whitespacesAndNewlines)) }
                } label: {
                    if store.connection == .connecting { ProgressView().frame(maxWidth: .infinity) }
                    else { Text("连接 Mac").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(payload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.connection == .connecting)
                if let error = store.operationError {
                    Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }
                Spacer()
            }
            .padding(24)
            .navigationTitle("配对")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
