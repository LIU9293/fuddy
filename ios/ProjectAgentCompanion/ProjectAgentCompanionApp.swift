import SwiftUI
import UIKit

extension Notification.Name {
    static let companionPushToken = Notification.Name("companion.push-token")
}

final class CompanionAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .companionPushToken, object: token)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        await CompanionBackgroundSyncBridge.shared.handleRemoteUpdate()
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
                if store.isPaired { CompanionRootView() }
                else { PairingView() }
            }
            .environmentObject(store)
            .task {
                if companionShouldRunForegroundTransport(for: scenePhase) { store.start() }
            }
            .onChange(of: scenePhase) { _, phase in
                if companionShouldRunForegroundTransport(for: phase) {
                    store.start()
                } else if phase == .background {
                    store.suspendForegroundTransport()
                }
            }
        }
    }
}
