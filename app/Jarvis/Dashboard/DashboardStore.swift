// What the dashboard shows that isn't in AppModel: running agents (polled
// every second), the stages each one has shown, Recent, and Today. It only
// polls while the window is on screen; closed or covered, it does nothing.

import EventKit
import Foundation
import Observation

@MainActor
@Observable
final class DashboardStore {
    private(set) var cards: [AgentCard] = []
    private(set) var stages: [String: [Stage]] = [:]
    private(set) var recent: [[ActionItem]] = []
    var events: [TodayEvent] = []
    private(set) var deadlines: [Deadline] = []
    private(set) var reminders: [ReminderEntry] = []
    /// Ticks with the poll, so elapsed times and the clock move without their own timers.
    private(set) var now = Date()
    /// Fullscreen, side panels faded back (Esc or the button leaves it).
    var ambient = false
    /// The window is open and not covered; the orb animates only then.
    private(set) var onScreen = false

    @ObservationIgnored let model: AppModel
    @ObservationIgnored let paths: Paths
    @ObservationIgnored let micLevel: AudioLevel
    @ObservationIgnored let voiceLevel: AudioLevel
    @ObservationIgnored var calendarToday: () async -> [NotchProtocol.CalendarEvent] = { [] }
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var ticks = 0
    @ObservationIgnored private var todayLoadedAt = Date.distantPast

    static let todayEvery: TimeInterval = 600

    init(model: AppModel, paths: Paths, micLevel: AudioLevel, voiceLevel: AudioLevel) {
        self.model = model
        self.paths = paths
        self.micLevel = micLevel
        self.voiceLevel = voiceLevel
    }

    /// The window came on screen (true) or was closed, hidden or covered (false).
    func setVisible(_ visible: Bool) {
        poll?.cancel()
        poll = nil
        onScreen = visible
        guard visible else { return }
        poll = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func refresh() {
        now = Date()
        let active = ActiveRuns.read(dir: paths.home.appendingPathComponent("state/active"))
        cards = Agents.cards(active: active, current: model.run, currentRunning: model.runActive, needsYou: model.panel.isNeedsYou, now: now)
        stages = Dictionary(cards.map { ($0.id, Agents.record($0.stage, into: stages[$0.id] ?? [], at: now)) }, uniquingKeysWith: { a, _ in a })
        if ticks % 5 == 0 {
            recent = AppModel.conversations(ActionsStore.newest(30, file: paths.home.appendingPathComponent("actions.sqlite")))
            deadlines = Today.deadlines(file: paths.home.appendingPathComponent("state/deadlines.json"), now: now)
            reminders = Today.reminders(dir: paths.home.appendingPathComponent("reminders"), now: now)
        }
        ticks += 1
        if now.timeIntervalSince(todayLoadedAt) > Self.todayEvery {
            todayLoadedAt = now
            Task { await loadToday() }
        }
    }

    /// The timetable (ics.ts) and Apple Calendar for today, merged by start time.
    private func loadToday() async {
        let repo = paths.repo, home = paths.home
        let timetable = await Today.runTimetable(repo: repo, home: home).map(Today.timetable) ?? []
        // Only if Calendars access is already granted: opening the dashboard never prompts.
        let calendar = EKEventStore.authorizationStatus(for: .event) == .fullAccess ? Today.calendar(await calendarToday()) : []
        events = (timetable + calendar).sorted { $0.start < $1.start }
    }

    /// The orb's state, read about 20 times a second while the window shows.
    func orbState() -> OrbState {
        OrbState.make(kind: model.kind, speaking: model.speaking, runActive: model.runActive,
                      mic: micLevel.current, voice: voiceLevel.current, cards: cards, palette: Appearance.shared.palette)
    }

    /// A finished request with this session, for "Show the log".
    func finished(sessionId: String?) -> [ActionItem]? {
        guard let sessionId else { return nil }
        return recent.first { $0.contains { $0.sessionId == sessionId && $0.details != nil } }
    }

    func stages(for card: AgentCard) -> [Stage] {
        if card.isCurrent, let steps = model.run?.steps, !steps.isEmpty {
            let offset = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
            return steps.map { Stage(text: $0.text, at: Date(timeIntervalSince1970: offset + $0.startedAt)) }
        }
        return stages[card.id] ?? []
    }
}
