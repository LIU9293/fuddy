import SwiftUI

struct AccountSyncSetupView: View {
    @EnvironmentObject private var store: CompanionStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Image(systemName: "arrow.triangle.2.circlepath.icloud")
                        .font(.system(size: 42, weight: .medium))
                        .foregroundStyle(.tint)

                    VStack(spacing: 8) {
                        Text("正在连接你的 Mac")
                            .font(.title2.bold())
                        Text(store.accountEnrollmentMessage ?? "正在查找你的 Mac…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    if store.accountEnrollmentInProgress {
                        ProgressView()
                            .controlSize(.large)
                            .accessibilityLabel("正在自动连接 Mac")
                    }

                    Button(store.accountEnrollmentInProgress ? "重新查找" : "重试") {
                        store.retryAccountEnrollment()
                    }
                    .buttonStyle(.bordered)

                    VStack(alignment: .leading, spacing: 10) {
                        Label("保持 Mac 上的 Fuddy 开启", systemImage: "laptopcomputer")
                            .font(.subheadline.weight(.semibold))
                        Text("iPhone 会自动连接到同一账户下的 Mac，项目和 Agent Run 随后会出现。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))

                    if let error = store.operationError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("连接 Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("退出") { Task { await store.signOutAccount() } }
                        .accessibilityLabel("退出 Fuddy 账户")
                }
            }
        }
    }
}
