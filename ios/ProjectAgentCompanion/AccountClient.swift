import CryptoKit
import Foundation
import UIKit

enum AccountClientError: LocalizedError {
    case notConfigured
    case invalidResponse
    case authenticationRequired
    case networkUnavailable
    case service(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "账户服务尚未配置。"
        case .invalidResponse: "账户服务返回了无法识别的内容。"
        case .authenticationRequired: "登录已过期，请重新登录。"
        case .networkUnavailable: "暂时无法连接 Fuddy，请检查网络后重试。"
        case .service(let message): message
        }
    }
}

private struct AccountAPIError: Decodable {
    struct Detail: Decodable {
        let code: String?
        let message: String
    }
    let error: Detail
}

private struct CurrentAccountResponse: Decodable {
    let deviceId: String
}

private struct VerifyEmailBody: Encodable {
    struct Device: Encodable {
        let id: String
        let platform: String
        let name: String
        let publicKey: String
        let appVersion: String
        let protocolVersion: Int
    }
    let challengeId: String
    let code: String
    let device: Device
}

private struct RefreshSessionResponse: Decodable {
    let session: AccountSessionTokens
}

private struct EnrollmentRequestBody: Encodable {
    let deviceId: String
}

@MainActor
final class AccountRefreshCoordinator {
    private struct ActiveRefresh {
        let id: UUID
        let identity: String
        let inputRefreshToken: String
        let task: Task<MobileAccountSession, Error>
    }

    private var active: ActiveRefresh?
    private var lastIdentity: String?
    private var lastInputRefreshToken: String?
    private var lastResult: MobileAccountSession?

    func refreshedSession(
        accountSession: MobileAccountSession,
        operation: @escaping @MainActor (MobileAccountSession) async throws -> MobileAccountSession
    ) async throws -> MobileAccountSession {
        let identity = "\(accountSession.user.id)\0\(accountSession.device.id)"
        let inputRefreshToken = accountSession.session.refreshToken
        if lastIdentity == identity,
            lastInputRefreshToken == inputRefreshToken,
            let lastResult
        {
            return lastResult
        }
        if let active {
            if active.identity == identity, active.inputRefreshToken == inputRefreshToken {
                return try await active.task.value
            }
            _ = try? await active.task.value
            return try await refreshedSession(accountSession: accountSession, operation: operation)
        }

        let refreshID = UUID()
        let task = Task { try await operation(accountSession) }
        active = ActiveRefresh(
            id: refreshID,
            identity: identity,
            inputRefreshToken: inputRefreshToken,
            task: task
        )
        do {
            let result = try await task.value
            lastIdentity = identity
            lastInputRefreshToken = inputRefreshToken
            lastResult = result
            if active?.id == refreshID { active = nil }
            return result
        } catch {
            if active?.id == refreshID { active = nil }
            throw error
        }
    }
}

@MainActor
struct AccountClient {
    private static let refreshCoordinator = AccountRefreshCoordinator()
    let baseURL: URL
    var urlSession: URLSession = .shared

    static func configured() -> AccountClient? {
        if let value = Bundle.main.object(forInfoDictionaryKey: "FuddyAccountAPIURL") as? String {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if let url = URL(string: normalized), !normalized.isEmpty,
               url.host != nil, url.user == nil, url.password == nil,
               url.query == nil, url.fragment == nil {
#if DEBUG
                if url.scheme == "https" || (
                    url.scheme == "http" && url.host.map(["127.0.0.1", "localhost"].contains) == true
                ) {
                    return AccountClient(baseURL: url)
                }
#else
                if url.scheme == "https" { return AccountClient(baseURL: url) }
#endif
            }
        }
#if DEBUG
        return AccountClient(baseURL: URL(string: "http://127.0.0.1:8788")!)
#else
        return nil
#endif
    }

    func startEmailSignIn(email: String) async throws -> EmailSignInChallenge {
        try await request(
            path: "/v1/auth/email/start",
            body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()]
        )
    }

    func verifyEmailSignIn(challengeID: String, code: String) async throws -> MobileAccountSession {
        let device = try deviceInput()
        return try await request(
            path: "/v1/auth/email/verify",
            body: VerifyEmailBody(challengeId: challengeID, code: code, device: device)
        )
    }

    func acceptGoogleIDToken(_ idToken: String) async throws -> MobileAccountSession {
        struct Body: Encodable {
            let idToken: String
            let device: VerifyEmailBody.Device
        }
        return try await request(path: "/v1/auth/google", body: Body(idToken: idToken, device: try deviceInput()))
    }

    func listSyncSpaces(
        accountSession: MobileAccountSession
    ) async throws -> (AccountSyncSpacesResponse, MobileAccountSession) {
        try await authorizedRequest(
            path: "/v1/sync-spaces",
            method: "GET",
            body: nil,
            accountSession: accountSession
        )
    }

    func createEnrollment(
        spaceID: String,
        accountSession: MobileAccountSession
    ) async throws -> (AccountEnrollmentResponse, MobileAccountSession) {
        try await authorizedRequest(
            path: "/v1/sync-spaces/\(spaceID)/enrollments",
            method: "POST",
            body: try JSONEncoder().encode(EnrollmentRequestBody(deviceId: accountSession.device.id)),
            accountSession: accountSession
        )
    }

    func enrollment(
        spaceID: String,
        enrollmentID: String,
        accountSession: MobileAccountSession
    ) async throws -> (AccountEnrollmentResponse, MobileAccountSession) {
        try await authorizedRequest(
            path: "/v1/sync-spaces/\(spaceID)/enrollments/\(enrollmentID)",
            method: "GET",
            body: nil,
            accountSession: accountSession
        )
    }

    func validateSession(
        accountSession: MobileAccountSession
    ) async throws -> MobileAccountSession {
        let (response, refreshed): (CurrentAccountResponse, MobileAccountSession) = try await authorizedRequest(
            path: "/v1/me",
            method: "GET",
            body: nil,
            accountSession: accountSession
        )
        guard response.deviceId == refreshed.device.id else { throw AccountClientError.authenticationRequired }
        return refreshed
    }

    func logout(accountSession: MobileAccountSession) async throws -> MobileAccountSession {
        var current = accountSession
        var result = try await performAuthorized(
            path: "/v1/auth/logout",
            method: "POST",
            body: nil,
            accessToken: current.session.accessToken
        )
        if result.response.statusCode == 401 {
            current = try await Self.refreshCoordinator.refreshedSession(accountSession: current) {
                try await self.performRefresh(accountSession: $0)
            }
            result = try await performAuthorized(
                path: "/v1/auth/logout",
                method: "POST",
                body: nil,
                accessToken: current.session.accessToken
            )
        }
        if result.response.statusCode == 401 { throw AccountClientError.authenticationRequired }
        guard (200..<300).contains(result.response.statusCode) else {
            let message = (try? JSONDecoder().decode(AccountAPIError.self, from: result.data))?.error.message
            throw AccountClientError.service(message ?? "账户服务请求失败（\(result.response.statusCode)）。")
        }
        return current
    }

    private func request<Response: Decodable, Body: Encodable>(path: String, body: Body) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw AccountClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode(AccountAPIError.self, from: data))?.error
            if http.statusCode == 401 { throw AccountClientError.authenticationRequired }
            let message = detail?.message
            throw AccountClientError.service(message ?? "账户服务请求失败（\(http.statusCode)）。")
        }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else {
            throw AccountClientError.invalidResponse
        }
        return decoded
    }

    private func authorizedRequest<Response: Decodable>(
        path: String,
        method: String,
        body: Data?,
        accountSession: MobileAccountSession
    ) async throws -> (Response, MobileAccountSession) {
        var current = accountSession
        var result = try await performAuthorized(
            path: path,
            method: method,
            body: body,
            accessToken: current.session.accessToken
        )
        if result.response.statusCode == 401 {
            current = try await Self.refreshCoordinator.refreshedSession(accountSession: current) {
                try await self.performRefresh(accountSession: $0)
            }
            result = try await performAuthorized(
                path: path,
                method: method,
                body: body,
                accessToken: current.session.accessToken
            )
        }
        if result.response.statusCode == 401 { throw AccountClientError.authenticationRequired }
        guard (200..<300).contains(result.response.statusCode) else {
            let message = (try? JSONDecoder().decode(AccountAPIError.self, from: result.data))?.error.message
            throw AccountClientError.service(message ?? "账户服务请求失败（\(result.response.statusCode)）。")
        }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: result.data) else {
            throw AccountClientError.invalidResponse
        }
        return (decoded, current)
    }

    private func performAuthorized(
        path: String,
        method: String,
        body: Data?,
        accessToken: String
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw AccountClientError.invalidResponse }
        return (data, http)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await urlSession.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .timedOut, .cannotFindHost, .cannotConnectToHost,
                 .dnsLookupFailed, .networkConnectionLost:
                throw AccountClientError.networkUnavailable
            default:
                throw AccountClientError.service("请求没有完成，请重试。")
            }
        }
    }

    private func performRefresh(accountSession: MobileAccountSession) async throws -> MobileAccountSession {
        let refreshed: RefreshSessionResponse = try await request(
            path: "/v1/auth/refresh",
            body: ["refreshToken": accountSession.session.refreshToken]
        )
        return MobileAccountSession(
            user: accountSession.user,
            device: accountSession.device,
            session: refreshed.session
        )
    }

    private func deviceInput() throws -> VerifyEmailBody.Device {
        let defaults = UserDefaults.standard
        let deviceIDKey = "account.device-id"
        let deviceID: String
        if let stored = defaults.string(forKey: deviceIDKey) {
            deviceID = stored
        } else {
            deviceID = UUID().uuidString.lowercased()
            defaults.set(deviceID, forKey: deviceIDKey)
        }
        let privateKey: P256.KeyAgreement.PrivateKey
        if let stored = try AccountKeychainStore.loadDevicePrivateKey() {
            privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: stored)
        } else {
            privateKey = P256.KeyAgreement.PrivateKey()
            try AccountKeychainStore.saveDevicePrivateKey(privateKey.rawRepresentation)
        }
        return VerifyEmailBody.Device(
            id: deviceID,
            platform: "ios",
            name: UIDevice.current.name,
            publicKey: AccountDeviceGrant.subjectPublicKeyInfo(privateKey.publicKey).base64EncodedString(),
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            protocolVersion: companionProtocolVersion
        )
    }
}
