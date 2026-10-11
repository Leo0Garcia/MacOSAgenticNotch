// Where the app reads and writes. Everything stays in the repo and ~/Jarvis
// (DESIGN section 2). JARVIS_HOME and JARVIS_REPO override, as for the launcher.

import Foundation

struct Paths: Sendable {
    var home: URL
    var repo: URL

    static func current(env: [String: String] = ProcessInfo.processInfo.environment, bundle: Bundle = .main) -> Paths {
        let userHome = URL(fileURLWithPath: env["HOME"] ?? NSHomeDirectory(), isDirectory: true)
        let home = env["JARVIS_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? userHome.appendingPathComponent("Jarvis", isDirectory: true)
        let repoPath = env["JARVIS_REPO"] ?? (bundle.object(forInfoDictionaryKey: "JarvisRepo") as? String) ?? ""
        let repo = URL(fileURLWithPath: repoPath, isDirectory: true).standardizedFileURL
        return Paths(home: home, repo: repo)
    }

    var notchFile: URL { home.appendingPathComponent("notch.json") }
    var models: URL { home.appendingPathComponent("models", isDirectory: true) }
    var logs: URL { home.appendingPathComponent("logs", isDirectory: true) }
    var appLog: URL { logs.appendingPathComponent("app.log") }
    var launcherScript: URL { repo.appendingPathComponent("launcher/run.sh") }
}

/// Small append-only log at ~/Jarvis/logs/app.log. Never logs secrets or tokens.
enum AppLog {
    nonisolated(unsafe) private static var url: URL?
    private static let queue = DispatchQueue(label: "jarvis.applog")

    static func configure(_ paths: Paths) {
        try? FileManager.default.createDirectory(at: paths.logs, withIntermediateDirectories: true)
        queue.sync { url = paths.appLog }
    }

    static func write(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        queue.async {
            guard let url else { return }
            if let h = try? FileHandle(forWritingTo: url) {
                h.seekToEndOfFile()
                h.write(Data(line.utf8))
                try? h.close()
            } else {
                try? Data(line.utf8).write(to: url)
            }
        }
    }
}
