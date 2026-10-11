// macOS notifications for needs-you, reminders and notify, and VoiceOver
// announcements for every state change (NOTCH-DESIGN section 7).

import AppKit
@preconcurrency import UserNotifications

@MainActor
final class SystemNotifier {
    private var authorized = false

    /// Shows the macOS notification permission prompt the first time.
    func requestAuthorization() {
        // UNUserNotificationCenter needs a bundled app; skip in unit tests.
        guard Bundle.main.bundleIdentifier != nil else { return }
        Task {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            self.authorized = granted
            AppLog.write("notifications \(granted ? "allowed" : "not allowed, using osascript")")
        }
    }

    /// Fallback when Jarvis may not post its own notifications (e.g. the
    /// ad-hoc signed build): the same osascript route the bridge uses, with
    /// the text passed as argv, never inside the script.
    private func osascriptNotify(title: String, body: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    func post(title: String, body: String) {
        guard authorized else { return osascriptNotify(title: title, body: body) }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { err in
            if let err { AppLog.write("notification failed: \(err.localizedDescription)") }
        }
    }

    func announce(_ text: String) {
        guard !text.isEmpty else { return }
        NSAccessibility.post(
            element: NSApp as Any,
            notification: .announcementRequested,
            userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }
}
