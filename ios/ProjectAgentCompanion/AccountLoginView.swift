import SwiftUI
#if canImport(GoogleSignIn) && canImport(GoogleSignInSwift)
import GoogleSignIn
import GoogleSignInSwift
#endif

struct AccountLoginView: View {
    @EnvironmentObject private var store: CompanionStore
    @State private var email = ""
    @State private var code = ""
    @State private var googleError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()
                Image(systemName: "bubble.left.and.text.bubble.right.fill")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 54, height: 54)
                    .background(.black, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .padding(.bottom, 24)

                if let challenge = store.emailChallenge {
                    codeView(challenge: challenge)
                } else {
                    emailView
                }
                Spacer()
                if store.emailChallenge == nil {
                    Text("我们会向你的邮箱发送一次性验证码。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 22)
                }
            }
            .padding(.horizontal, 28)
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Fuddy").font(.subheadline.weight(.semibold))
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var emailView: some View {
        VStack(spacing: 18) {
            VStack(spacing: 9) {
                Text("登录或注册 Fuddy").font(.title.bold())
                Text("让项目在 Mac 和 iPhone 之间无缝继续。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            googleSignInSection
            if googleConfigured {
                HStack(spacing: 12) {
                    Rectangle()
                        .fill(.secondary.opacity(0.22))
                        .frame(height: 1)
                    Text("或")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    Rectangle()
                        .fill(.secondary.opacity(0.22))
                        .frame(height: 1)
                }
                .frame(height: 18)
            }
            TextField(
                "",
                text: $email,
                prompt: Text("you@example.com").foregroundStyle(.secondary)
            )
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(.primary)
                .tint(.accentColor)
                .padding(14)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(.secondary.opacity(0.2), lineWidth: 1)
                }
            Button {
                Task { await store.startEmailSignIn(email: email) }
            } label: {
                if store.accountBusy { ProgressView().frame(maxWidth: .infinity) }
                else { Text("用邮箱继续").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.accountBusy)
            if let googleError {
                Text(googleError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            errorView
        }
    }

    @ViewBuilder private var googleSignInSection: some View {
#if canImport(GoogleSignIn) && canImport(GoogleSignInSwift)
        if googleConfigured {
                GoogleSignInButton(
                    scheme: .light,
                    style: .wide,
                    state: store.accountBusy ? .disabled : .normal,
                    action: startGoogleSignIn
                )
                .frame(height: 50)
                .disabled(store.accountBusy)
        }
#endif
    }

    private func codeView(challenge: EmailSignInChallenge) -> some View {
        VStack(spacing: 18) {
            VStack(spacing: 9) {
                Text("输入验证码").font(.title.bold())
                Text("验证码已发送至 \(challenge.email ?? email)，10 分钟内有效。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            TextField(
                "",
                text: $code,
                prompt: Text("6 位数字").foregroundStyle(.secondary)
            )
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .font(.title2.monospacedDigit().weight(.semibold))
                .foregroundStyle(.primary)
                .tint(.accentColor)
                .padding(14)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(.secondary.opacity(0.2), lineWidth: 1)
                }
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                }
            if let debugCode = challenge.debugCode {
                Text("开发环境验证码：\(debugCode)").font(.caption).foregroundStyle(.secondary)
            }
            Button {
                Task { await store.verifyEmailSignIn(code: code) }
            } label: {
                if store.accountBusy { ProgressView().frame(maxWidth: .infinity) }
                else { Text("登录").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(code.count != 6 || store.accountBusy)
            Button("更换邮箱") { store.cancelEmailSignIn() }
                .font(.footnote)
            errorView
        }
    }

    @ViewBuilder private var errorView: some View {
        if let error = store.operationError {
            Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
        }
    }

    private var googleConfigured: Bool {
        configuredString("GIDClientID") != nil && configuredString("GIDServerClientID") != nil
    }

    private func configuredString(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, !normalized.contains("$(") else { return nil }
        return normalized
    }

    private func startGoogleSignIn() {
#if canImport(GoogleSignIn)
        googleError = nil
        guard let presenter = presentingViewController() else {
            googleError = "暂时无法打开 Google 登录。"
            return
        }
        GIDSignIn.sharedInstance.signIn(withPresenting: presenter) { result, error in
            let idToken = result?.user.idToken?.tokenString
            let nsError = error as NSError?
            let wasCancelled = nsError?.domain == kGIDSignInErrorDomain
                && nsError?.code == GIDSignInError.canceled.rawValue
            let errorMessage = error?.localizedDescription

            Task { @MainActor in
                if let errorMessage {
                    if !wasCancelled { googleError = errorMessage }
                    return
                }
                guard let idToken else {
                    googleError = "Google 没有返回可验证的登录凭证。"
                    return
                }
                await store.signInWithGoogle(idToken: idToken)
            }
        }
#endif
    }

    private func presentingViewController() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
        var presented = root
        while let next = presented?.presentedViewController { presented = next }
        return presented
    }
}
