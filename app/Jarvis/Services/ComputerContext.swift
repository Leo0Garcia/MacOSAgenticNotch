// What Leo was doing when he asked, for ~/Jarvis/state/context.json (read by
// the launcher, launcher/src/context.ts). The frontmost app needs no
// permission. The browser tab (Automation permission per browser) and a
// screenshot for "this" requests (Screen Recording) are off until Leo turns
// them on in Settings.

import AppKit
import Foundation

@MainActor
final class ComputerContext {
    static let shareBrowserKey = "ShareBrowserTab"
    static let shareScreenKey = "ShareScreen"

    private let paths: Paths
    private var captured: [String: Any]?
    private var capturedAt = Date.distantPast

    /// The last app other than Jarvis to be frontmost (opening jarvis:// brings Jarvis forward).
    private var lastExternal: NSRunningApplication?
    private var observer: NSObjectProtocol?

    init(paths: Paths) {
        self.paths = paths
        lastExternal = NSWorkspace.shared.frontmostApplication
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
            MainActor.assumeIsolated { self?.lastExternal = app }
        }
    }

    /// Called when listening starts: the app Leo is in right now (Jarvis never takes focus).
    func capture() {
        var ctx: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date())]
        let front = NSWorkspace.shared.frontmostApplication
        if let app = front?.bundleIdentifier == Bundle.main.bundleIdentifier ? lastExternal : front {
            ctx["frontmostApp"] = app.localizedName ?? app.bundleIdentifier ?? ""
            ctx["bundleId"] = app.bundleIdentifier ?? ""
            if UserDefaults.standard.bool(forKey: Self.shareBrowserKey), let tab = Self.browserTab(bundleId: app.bundleIdentifier ?? "") {
                ctx["browserTab"] = tab
            }
        }
        captured = ctx
        capturedAt = Date()
    }

    /// Called just before the request goes to the launcher.
    func write(for request: String) {
        if captured == nil || Date().timeIntervalSince(capturedAt) > 60 { capture() }
        var ctx = captured ?? [:]
        captured = nil
        if UserDefaults.standard.bool(forKey: Self.shareScreenKey), Self.isAboutScreen(request), let shot = screenshot() {
            ctx["screenshot"] = shot
        }
        guard let data = try? JSONSerialization.data(withJSONObject: ctx) else { return }
        try? writeAtomically(data, to: paths.home.appendingPathComponent("state/context.json"), mode: 0o600)
    }

    /// "Summarise this", "what's on my screen", "reply to what I'm looking at"…
    nonisolated static func isAboutScreen(_ request: String) -> Bool {
        request.range(of: #"\b(this|these|that|here|screen|looking at|on my display|open window|this page|this tab|this email)\b"#,
                      options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Front tab of Chrome, Arc, Safari or Brave via AppleScript (macOS asks once per browser).
    nonisolated static func browserTab(bundleId: String) -> [String: String]? {
        let script: String
        switch bundleId {
        case "com.google.Chrome", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac":
            script = "tell application id \"\(bundleId)\" to get {title, URL} of active tab of front window"
        case "com.apple.Safari":
            script = "tell application id \"com.apple.Safari\" to get {name, URL} of current tab of front window"
        default:
            return nil
        }
        var err: NSDictionary?
        guard let out = NSAppleScript(source: script)?.executeAndReturnError(&err), out.numberOfItems == 2 else { return nil }
        return ["title": out.atIndex(1)?.stringValue ?? "", "url": out.atIndex(2)?.stringValue ?? ""]
    }

    /// The main display as PNG in ~/Jarvis/cache (the previous one is replaced).
    private func screenshot() -> String? {
        let url = paths.home.appendingPathComponent("cache/screen.png")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-m", "-t", "png", url.path]
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        return p.terminationStatus == 0 && FileManager.default.fileExists(atPath: url.path) ? url.path : nil
    }
}
