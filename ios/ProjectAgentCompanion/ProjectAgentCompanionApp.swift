import SwiftUI
import UIKit

extension Notification.Name {
    static let companionPushToken = Notification.Name("companion.push-token")
    static let companionRemoteUpdate = Notification.Name("companion.remote-update")
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
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        NotificationCenter.default.post(name: .companionRemoteUpdate, object: nil)
        completionHandler(.newData)
    }
}

@main
struct ProjectAgentCompanionApp: App {
    @UIApplicationDelegateAdaptor(CompanionAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = CompanionStore()

    var body: some Scene {
        WindowGroup {
            Group {
                if store.isPaired { CompanionRootView() }
                else { PairingView() }
            }
            .environmentObject(store)
            .task { store.start() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    store.start()
                    Task { await store.sync() }
                }
            }
        }
    }
}
