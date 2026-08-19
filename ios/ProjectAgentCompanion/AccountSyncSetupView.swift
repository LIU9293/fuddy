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
                        Text("正在同步你的项目")
                            .font(.title2.bold())
                        Text(store.accountEnrollmentMessage ?? "正在查找已登录同一账户的 Mac…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    if store.accountEnrollmentInProgress {
                        ProgressView()
                            .controlSize(.large)
                            .accessibilityLabel("正在自动连接 Mac")
                    } else {
                        Button("重新查找") { store.retryAccountEnrollment() }
                            .buttonStyle(.bordered)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Label("在 Mac 上打开 Fuddy", systemImage: "laptopcomputer")
                            .font(.subheadline.weight(.semibold))
                        Text("确认 Mac 和这台 iPhone 登录的是同一账户。Mac 在线后，项目和 Agent Run 会自动出现。")
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
            .navigationTitle("同步项目")
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
