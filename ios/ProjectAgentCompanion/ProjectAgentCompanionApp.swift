import SwiftUI
import UIKit
#if canImport(GoogleSignIn)
import GoogleSignIn
#endif
@preconcurrency import UserNotifications

extension Notification.Name {
    static let companionPushToken = Notification.Name("companion.push-token")
    static let companionPushRegistrationFailed = Notification.Name("companion.push-registration-failed")
    static let companionOpenRun = Notification.Name("companion.open-run")
}

func companionNotificationRunID(_ userInfo: [AnyHashable: Any]) -> String? {
    guard let runID = userInfo["runId"] as? String else { return nil }
    let normalized = runID.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.isEmpty ? nil : normalized
}

@MainActor
final class CompanionAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .companionPushToken, object: token)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationCenter.default.post(name: .companionPushRegistrationFailed, object: error)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        await CompanionBackgroundSyncBridge.shared.handleRemoteUpdate()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let runID = companionNotificationRunID(response.notification.request.content.userInfo)
        if let runID { await CompanionNotificationNavigationBridge.shared.openRun(id: runID) }
        _ = await CompanionBackgroundSyncBridge.shared.handleRemoteUpdate()
    }
}

@MainActor
final class CompanionNotificationNavigationBridge {
    static let shared = CompanionNotificationNavigationBridge()
    private(set) var pendingRunID: String?

    func openRun(id: String) {
        pendingRunID = id
        NotificationCenter.default.post(name: .companionOpenRun, object: id)
    }

    func consumePendingRunID() -> String? {
        defer { pendingRunID = nil }
        return pendingRunID
    }
}

@MainActor
final class CompanionBackgroundSyncBridge {
    static let shared = CompanionBackgroundSyncBridge()
    weak var store: CompanionStore?

    func handleRemoteUpdate() async -> UIBackgroundFetchResult {
        guard let store else { return .noData }
        let previousSequence = store.state.lastSequence
        await store.sync()
        if case .offline = store.connection { return .failed }
        return store.state.lastSequence > previousSequence ? .newData : .noData
    }
}

func companionShouldRunForegroundTransport(for phase: ScenePhase) -> Bool {
    if case .active = phase { return true }
    return false
}

@main
@MainActor
struct ProjectAgentCompanionApp: App {
    @UIApplicationDelegateAdaptor(CompanionAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store: CompanionStore

    init() {
        let store = CompanionStore()
        _store = StateObject(wrappedValue: store)
        CompanionBackgroundSyncBridge.shared.store = store
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if store.restoringAccountSession {
                    ProgressView("正在打开 Fuddy…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(uiColor: .systemGroupedBackground))
                } else if !store.isSignedIn { AccountLoginView() }
                else if store.isPaired { CompanionRootView() }
                else { AccountSyncSetupView() }
            }
            .environmentObject(store)
            .onOpenURL { url in
#if canImport(GoogleSignIn)
                GIDSignIn.sharedInstance.handle(url)
#endif
            }
            .task {
                if companionShouldRunForegroundTransport(for: scenePhase) {
                    store.start(validateAccountSession: true)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if companionShouldRunForegroundTransport(for: phase) {
                    store.start(validateAccountSession: true)
                } else if phase == .background {
                    store.suspendForegroundTransport()
                }
            }
        }
    }
}
