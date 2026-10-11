// Runs `launcher/run.sh run "<request>"` (DESIGN 4.6) and turns its NDJSON
// stdout into events for the model. `run.sh open <id>` opens a saved run.

import Foundation

/// One line of the launcher's stdout.
enum LauncherEvent: Equatable, Sendable {
    case state(String, sessionId: String?)
    case speak(String)
    case status(text: String, detail: String?)
    case denied(tool: String, rule: String?, reason: String?)
    case warning(String)
    case done(sessionId: String, keep: Bool, summary: String, reply: String, name: String?)
    case error(String)

    static func parse(_ line: String) -> LauncherEvent? {
        guard let data = line.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = o["event"] as? String
        else { return nil }
        let s = { (k: String) in o[k] as? String }
        switch event {
        case "state": return s("state").map { .state($0, sessionId: s("sessionId")) }
        case "speak": return s("text").map { .speak($0) }
        case "status": return s("text").map { .status(text: $0, detail: s("detail")) }
        case "denied": return .denied(tool: s("tool") ?? "unknown", rule: s("rule"), reason: s("reason"))
        case "warning": return s("message").map { .warning($0) }
        case "done":
            return .done(
                sessionId: s("sessionId") ?? "", keep: o["keep"] as? Bool ?? false,
                summary: s("summary") ?? "", reply: s("reply") ?? "", name: s("name"))
        case "error": return .error(s("message") ?? "unknown error")
        default: return nil
        }
    }
}

@MainActor
protocol LauncherRunning: AnyObject {
    /// Starts a run. Events arrive on the main actor; `exited` fires once with the exit code.
    func run(_ request: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws
    func open(sessionId: String)
    func cancelAll()
}

enum LauncherError: LocalizedError {
    case missing(URL)
    var errorDescription: String? {
        switch self {
        case let .missing(url): "The launcher isn't at \(url.path). Set JARVIS_REPO or rebuild the app from the repo."
        }
    }
}

@MainActor
final class Launcher: LauncherRunning {
    private let paths: Paths
    private var running: [Process] = []

    init(paths: Paths) { self.paths = paths }

    private func process(_ args: [String]) throws -> Process {
        let script = paths.launcherScript
        guard FileManager.default.fileExists(atPath: script.path) else { throw LauncherError.missing(script) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [script.path] + args
        var env = ProcessInfo.processInfo.environment
        env["JARVIS_REPO"] = paths.repo.path
        env["JARVIS_HOME"] = paths.home.path
        p.environment = env
        p.currentDirectoryURL = paths.repo
        p.standardInput = FileHandle.nullDevice
        return p
    }

    func run(_ request: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws {
        let p = try process(["run", request])
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        let lines = LineSplitter()
        out.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            let parsed = lines.push(chunk).compactMap(LauncherEvent.parse)
            guard !parsed.isEmpty else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { parsed.forEach(onEvent) } }
        }
        err.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            let text = String(decoding: chunk, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { AppLog.write("launcher stderr: \(text.prefix(500))") }
        }
        p.terminationHandler = { proc in
            let code = proc.terminationStatus
            // Let the last stdout chunk drain before reporting the exit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                MainActor.assumeIsolated {
                    if let tail = lines.flush().flatMap(LauncherEvent.parse) { onEvent(tail) }
                    self.running.removeAll { $0 === proc }
                    exited(code)
                }
            }
        }
        try p.run()
        running.append(p)
        AppLog.write("launcher run started (pid \(p.processIdentifier))")
    }

    func open(sessionId: String) {
        guard sessionId.range(of: "^[0-9a-fA-F-]{36}$", options: .regularExpression) != nil,
              let p = try? process(["open", sessionId]) else { return }
        try? p.run()
    }

    /// Reminder "In 10 minutes": straight to the launcher's scheduler (DESIGN 8.3), no model run.
    func snooze(text: String, minutes: Int) {
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(minutes) * 60))
        guard let payload = try? JSONSerialization.data(withJSONObject: ["at": at, "text": text, "session_id": NSNull()]) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["bun", paths.repo.appendingPathComponent("launcher/src/reminders.ts").path, "schedule"]
        var env = ProcessInfo.processInfo.environment
        env["JARVIS_REPO"] = paths.repo.path
        env["JARVIS_HOME"] = paths.home.path
        let home = NSHomeDirectory()
        env["PATH"] = ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
        p.environment = env
        let input = Pipe()
        p.standardInput = input
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { proc in
            AppLog.write("snooze reminder exited \(proc.terminationStatus)")
        }
        do {
            try p.run()
            input.fileHandleForWriting.write(payload)
            try? input.fileHandleForWriting.close()
        } catch {
            AppLog.write("snooze failed: \(error.localizedDescription)")
        }
    }

    func cancelAll() {
        for p in running where p.isRunning { p.terminate() }
    }
}

/// Splits a byte stream into lines; safe to call from the pipe's queue.
final class LineSplitter: @unchecked Sendable {
    private var buffer = Data()
    private let lock = NSLock()

    func push(_ data: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        buffer.append(data)
        var out: [String] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            out.append(String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        return out
    }

    func flush() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !buffer.isEmpty else { return nil }
        let s = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll()
        return s
    }
}
