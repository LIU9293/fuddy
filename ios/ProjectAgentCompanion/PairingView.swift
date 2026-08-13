import SwiftUI
import UIKit
import VisionKit

struct PairingView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var payload = ""
    @State private var showingScanner = false
    @State private var scannerError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Image(systemName: "iphone.and.arrow.forward")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(.tint)
                VStack(spacing: 8) {
                    Text("连接到 Fuddy").font(.title2.bold())
                    Text("在 Mac 的“设置 → 通用 → iPhone Companion”创建配对二维码，然后使用相机扫描。所有 Agent 操作仍在 Mac 上执行。")
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
                    if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                        showingScanner = true
                    } else {
                        scannerError = "此设备暂不支持相机扫码，请使用下方的粘贴方式。"
                    }
                } label: {
                    Label("扫描 Mac 配对二维码", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Button {
                    Task { await store.pair(payloadText: payload.trimmingCharacters(in: .whitespacesAndNewlines)) }
                } label: {
                    if store.connection == .connecting { ProgressView().frame(maxWidth: .infinity) }
                    else { Text("连接 Mac").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.bordered)
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
            .sheet(isPresented: $showingScanner) {
                NavigationStack {
                    PairingCodeScanner { code in
                        payload = code
                        showingScanner = false
                        Task { await store.pair(payloadText: code.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    } onError: { message in
                        showingScanner = false
                        scannerError = message
                    }
                    .ignoresSafeArea()
                    .navigationTitle("扫描配对二维码")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("取消") { showingScanner = false }
                        }
                    }
                }
            }
            .alert("无法扫描", isPresented: Binding(
                get: { scannerError != nil },
                set: { presented in if !presented { scannerError = nil } }
            )) {
                Button("好") { scannerError = nil }
            } message: {
                Text(scannerError ?? "")
            }
        }
    }
}
