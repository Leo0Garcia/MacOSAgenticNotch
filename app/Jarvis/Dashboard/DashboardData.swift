// The dashboard's data, kept apart from its views so it can be tested: the
// runs the launcher is working on (~/Jarvis/state/active), the agent cards
// built from them, what the orb is told, and today's timetable, deadlines and
// reminders. Everything here is read only.

import Foundation

/// launcher/src/store.ts ActiveRun: one file per run in progress.
struct ActiveRun: Decodable, Equatable, Sendable {
    var sessionId: String
    var pid: Int32
    var request: String
    /// Milliseconds since 1970.
    var startedAt: Double
    /// The run's opening line, then its latest step.
    var doing: String?
}

enum ActiveRuns {
    nonisolated static func alive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    /// Runs still working, oldest first. Files left by a launcher that died are
    /// skipped (the launcher removes them; the app only reads).
    nonisolated static func read(dir: URL, alive: (Int32) -> Bool = alive) -> [ActiveRun] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(ActiveRun.self, from: Data(contentsOf: $0)) }
            .filter { alive($0.pid) }
            .sorted { $0.startedAt < $1.startedAt }
    }
}

enum AgentStatus: String, Sendable {
    case working, waiting, paused
}

/// A task Jarvis hasn't finished (~/Jarvis/state/tasks.json, launcher/src/tasks.ts):
/// it keeps its tile until a run says it's done, or Leo dismisses it.
struct OpenTask: Decodable, Equatable, Sendable {
    var id: String
    var title: String
    var latest: String
    var status: String
    var sessions: [String]
    var startedAt: String
    var updatedAt: String

    nonisolated static func read(file: URL) -> [OpenTask] {
        guard let d = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([OpenTask].self, from: d)) ?? []
    }

    /// Leo dismissed its tile.
    nonisolated static func remove(_ id: String, file: URL) {
        let rest = read(file: file).filter { $0.id != id }
        guard let data = try? JSONEncoder().encode(rest.map(Encoded.init)) else { return }
        try? data.write(to: file, options: .atomic)
    }

    private struct Encoded: Encodable {
        var id, title, latest, status: String
        var sessions: [String]
        var startedAt, updatedAt: String
        init(_ t: OpenTask) { (id, title, latest, status, sessions, startedAt, updatedAt) = (t.id, t.title, t.latest, t.status, t.sessions, t.startedAt, t.updatedAt) }
    }
}

/// One item in Jarvis's approval queue (~/Jarvis/state/queue.json, launcher/src/queue.ts).
/// The app only reads it; changes go through `run.sh queue <action> <id>`.
struct QueueItem: Decodable, Identifiable, Equatable, Sendable {
    var id: String
    var source: String
    var title: String
    var request: String
    var why: String
    var status: String
    var sessionId: String?
    var summary: String?
    var needsYou: Bool?
    var createdAt: String
    var updatedAt: String

    enum Action: String, Sendable { case approve, decline, dismiss, retry }

    /// What the panel shows, in the order it shows them: what to approve first, finished last.
    enum Phase: Int, Comparable, Sendable {
        case proposed, running, approved, needsYou, failed, done
        static func < (a: Phase, b: Phase) -> Bool { a.rawValue < b.rawValue }
    }

    var phase: Phase {
        switch status {
        case "proposed": .proposed
        case "running": .running
        case "approved": .approved
        case "failed": .failed
        default: needsYou == true ? .needsYou : .done
        }
    }

    var actions: [Action] {
        switch phase {
        case .proposed: [.approve, .decline]
        case .running, .approved: []
        case .failed: [.retry, .dismiss]
        case .needsYou, .done: [.dismiss]
        }
    }

    nonisolated static func read(file: URL) -> [QueueItem] {
        struct Q: Decodable { var items: [QueueItem] }
        guard let d = try? Data(contentsOf: file), let q = try? JSONDecoder().decode(Q.self, from: d) else { return [] }
        // Stable within a phase: oldest first, as the worker takes them.
        return q.items.enumerated().sorted { ($0.element.phase, $0.offset) < ($1.element.phase, $1.offset) }.map(\.element)
    }
}

struct Stage: Equatable, Sendable {
    var text: String
    var at: Date
}

/// One running request on the dashboard.
struct AgentCard: Identifiable, Equatable, Sendable {
    var id: String
    var request: String
    var stage: String
    var startedAt: Date
    var status: AgentStatus
    /// The app's own run (the notch's current request).
    var isCurrent = false
    var sessionId: String?
    /// Set for an open task's tile, which Leo can dismiss.
    var taskId: String?
}

enum AgentFilter: String, CaseIterable, Identifiable, Sendable {
    case all, working, waiting, paused
    var id: String { rawValue }
    var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }

    func matches(_ c: AgentCard) -> Bool {
        switch self {
        case .all: true
        case .working: c.status == .working
        case .waiting: c.status == .waiting
        case .paused: c.status == .paused
        }
    }
}

enum Agents {
    /// The launcher's runs plus the app's own current one, newest first. The
    /// app's run also writes an active file once it has a session id; the two
    /// are one card.
    static func cards(active: [ActiveRun], current: RunState?, currentRunning: Bool, needsYou: Bool, now: Date, open: [OpenTask] = []) -> [AgentCard] {
        var cards = active.map {
            AgentCard(id: $0.sessionId, request: $0.request, stage: $0.doing ?? "Working on it",
                      startedAt: Date(timeIntervalSince1970: $0.startedAt / 1000), status: .working, sessionId: $0.sessionId)
        }
        // Only a request that started an agent (a Claude run, so it has a session) gets a
        // tile; "thanks", the lights and other instant replies don't (Leo, 2026-11-09).
        if let run = current, currentRunning, !run.request.isEmpty, run.sessionId != nil {
            if let sid = run.sessionId, let i = cards.firstIndex(where: { $0.id == sid }) {
                cards[i].isCurrent = true
            } else {
                // RunState's clock is uptime, not wall time.
                let started = now.addingTimeInterval(run.startedAt - ProcessInfo.processInfo.systemUptime)
                cards.append(AgentCard(id: run.sessionId ?? "current", request: run.request, stage: run.status,
                                       startedAt: started, status: .working, isCurrent: true, sessionId: run.sessionId))
            }
        }
        // shortcut: a question doesn't say which run asked it, so it goes on the app's
        // own run, else the newest; upgrade when ask frames carry the session id.
        if needsYou, let i = cards.firstIndex(where: \.isCurrent) ?? cards.indices.last {
            cards[i].status = .waiting
        }
        // Open tasks stay as tiles between runs; while one of their runs is going, that run's tile shows instead.
        let running = Set(cards.compactMap(\.sessionId))
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        for t in open where running.isDisjoint(with: t.sessions) && !running.contains(t.id) {
            cards.insert(AgentCard(id: "task-\(t.id)", request: t.title, stage: t.latest,
                                   startedAt: iso.date(from: t.startedAt) ?? now, status: t.status == "waiting" ? .waiting : .paused,
                                   sessionId: t.sessions.last, taskId: t.id), at: 0)
        }
        return cards.reversed()
    }

    /// Keeps the stages a card has shown, so a click can lay them out in order.
    static func record(_ stage: String, into list: [Stage], at: Date) -> [Stage] {
        let s = stage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, list.last?.text != s else { return list }
        return Array((list + [Stage(text: s, at: at)]).suffix(20))
    }

    /// "42s", "3m 05s", "1h 02m".
    static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return String(format: "%dm %02ds", s / 60, s % 60) }
        return String(format: "%dh %02dm", s / 3600, (s % 3600) / 60)
    }

    /// "3 agents · 1 waiting on you".
    static func summary(_ cards: [AgentCard]) -> String {
        guard !cards.isEmpty else { return "Nothing running" }
        var s = cards.count == 1 ? "1 agent" : "\(cards.count) agents"
        let waiting = cards.filter { $0.status == .waiting }.count
        if waiting > 0 { s += " · \(waiting) waiting on you" }
        return s
    }
}

/// What Swift pushes to the orb (Resources/orb.html, `jarvis.set`).
struct OrbState: Encodable, Equatable, Sendable {
    var state: String
    /// 0…1: the mic while Leo talks, Jarvis's voice while it speaks.
    var level: Double
    /// 0…1: how many agents are running (more is busier and brighter).
    var busy: Double
    /// One per running agent: true if it's waiting on Leo (amber).
    var agents: [Bool]
    /// The state's two colours as "#RRGGBB" (needs-you stays amber).
    var colors: [String]

    @MainActor
    static func make(kind: StateKind, speaking: Bool, runActive: Bool, mic: Float, voice: Float, cards: [AgentCard], palette: Appearance.Palette) -> OrbState {
        let state: String
        if kind == .needs || cards.contains(where: { $0.status == .waiting }) { state = "needs" }
        else if kind == .listening { state = "listening" }
        else if speaking { state = "speaking" }
        else if runActive || kind == .working || !cards.isEmpty { state = "working" }
        else { state = "idle" }
        let level: Float = state == "listening" ? mic : state == "speaking" ? voice : 0
        let hex = { (c: UInt32) in String(format: "#%06X", c) }
        let colors: [UInt32] = switch state {
        case "needs": [0xF5B547, 0xFF7A45]
        case "listening": [palette.listening[0], palette.listening[1]]
        case "working": [palette.working[0], palette.working[1]]
        case "speaking": [palette.done[2], palette.done[0]]
        default: [palette.done[1], palette.listening[0]]
        }
        return OrbState(state: state, level: (Double(max(0, min(1, level))) * 100).rounded() / 100,
                        busy: min(1, Double(cards.count) / 5), agents: cards.map { $0.status == .waiting },
                        colors: colors.map(hex))
    }

    var json: String {
        (try? String(decoding: JSONEncoder().encode(self), as: UTF8.self)) ?? "{}"
    }
}

// MARK: - Today

struct TodayEvent: Identifiable, Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var location: String?
    var id: String { "\(title)|\(start.timeIntervalSince1970)" }
}

struct Deadline: Decodable, Identifiable, Equatable, Sendable {
    var title: String
    var course: String?
    var due: String
    var id: String { "\(course ?? "")|\(title)|\(due)" }
    var dueDate: Date? { CalendarService.date(due) }
}

struct ReminderEntry: Decodable, Identifiable, Equatable, Sendable {
    var id: String
    var text: String
    var at: String
    var date: Date? { CalendarService.date(at) }
}

enum Today {
    /// `bun skills/calendar/ics.ts --day today --json` → {stale, events: [{title, location, start, end, allDay}]}.
    nonisolated static func timetable(_ data: Data) -> [TodayEvent] {
        struct Out: Decodable {
            struct E: Decodable { var title: String; var location: String?; var start: String; var end: String; var allDay: Bool? }
            var events: [E]
        }
        guard let out = try? JSONDecoder().decode(Out.self, from: data) else { return [] }
        return out.events.compactMap { e in
            guard let s = CalendarService.date(e.start), let end = CalendarService.date(e.end) else { return nil }
            return TodayEvent(title: e.title, start: s, end: end, allDay: e.allDay ?? false, location: (e.location?.isEmpty ?? true) ? nil : e.location)
        }
    }

    nonisolated static func calendar(_ events: [NotchProtocol.CalendarEvent]) -> [TodayEvent] {
        events.compactMap { e in
            guard let s = CalendarService.date(e.start), let end = CalendarService.date(e.end) else { return nil }
            return TodayEvent(title: e.title, start: s, end: end, allDay: e.allDay, location: e.location)
        }
    }

    /// ~/Jarvis/state/deadlines.json, due from now to `days` ahead, soonest first.
    nonisolated static func deadlines(file: URL, now: Date, days: Double = 7) -> [Deadline] {
        struct State: Decodable { var deadlines: [Deadline] }
        guard let data = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(State.self, from: data) else { return [] }
        let end = now.addingTimeInterval(days * 86400)
        return s.deadlines.filter { d in d.dueDate.map { $0 >= now && $0 <= end } ?? false }
            .sorted { ($0.dueDate ?? now) < ($1.dueDate ?? now) }
    }

    /// ~/Jarvis/reminders/*.json still to fire, soonest first.
    nonisolated static func reminders(dir: URL, now: Date) -> [ReminderEntry] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(ReminderEntry.self, from: Data(contentsOf: $0)) }
            .filter { ($0.date ?? .distantPast) >= now }
            .sorted { ($0.date ?? now) < ($1.date ?? now) }
    }

    /// Runs the timetable script off the main thread; nil if bun or the script fails.
    nonisolated static func runTimetable(repo: URL, home: URL) async -> Data? {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                p.arguments = ["bun", repo.appendingPathComponent("skills/calendar/ics.ts").path, "--day", "today", "--json"]
                var env = ProcessInfo.processInfo.environment
                env["JARVIS_REPO"] = repo.path
                env["JARVIS_HOME"] = home.path
                env["PATH"] = ["\(NSHomeDirectory())/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
                p.environment = env
                let out = Pipe()
                p.standardOutput = out
                p.standardError = FileHandle.nullDevice
                p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch { return cont.resume(returning: nil) }
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                cont.resume(returning: p.terminationStatus == 0 ? data : nil)
            }
        }
    }
}

// MARK: - URLs

/// jarvis:// links (Shortcuts, Siri, and later "Jarvis, open the dashboard").
enum AppURL: Equatable {
    case listen
    case ask(String)
    case dashboard

    static func parse(_ url: URL) -> AppURL? {
        guard url.scheme == "jarvis" else { return nil }
        switch url.host {
        case "listen": return .listen
        case "dashboard": return .dashboard
        case "ask":
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value ?? ""
            return q.trimmingCharacters(in: .whitespaces).isEmpty ? nil : .ask(q)
        default: return nil
        }
    }
}
