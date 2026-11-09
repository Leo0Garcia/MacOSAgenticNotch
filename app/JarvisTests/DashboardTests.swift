import Foundation
import Testing
import WebKit
@testable import Jarvis

private func tempDir() throws -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-dash-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

private func write(_ text: String, _ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
}

@Suite struct ActiveRunsTests {
    @Test func readsLiveRunsOldestFirstAndSkipsDeadOnes() throws {
        let d = try tempDir()
        try write(#"{"sessionId":"b","pid":20,"request":"Second","startedAt":2000,"doing":"Reading Moodle"}"#, d.appendingPathComponent("b.json"))
        try write(#"{"sessionId":"a","pid":10,"request":"First","startedAt":1000}"#, d.appendingPathComponent("a.json"))
        try write(#"{"sessionId":"dead","pid":30,"request":"Gone","startedAt":500}"#, d.appendingPathComponent("dead.json"))
        try write("not json", d.appendingPathComponent("bad.json"))
        try write(#"{"sessionId":"x","pid":10,"request":"x","startedAt":1}"#, d.appendingPathComponent("x.tmp"))
        let runs = ActiveRuns.read(dir: d) { $0 != 30 }
        #expect(runs.map(\.sessionId) == ["a", "b"])
        #expect(runs[1].doing == "Reading Moodle")
        #expect(runs[0].doing == nil)
        #expect(FileManager.default.fileExists(atPath: d.appendingPathComponent("dead.json").path)) // read only
    }

    @Test func missingFolderIsNoRuns() {
        #expect(ActiveRuns.read(dir: URL(fileURLWithPath: "/nonexistent/jarvis/active")).isEmpty)
    }

    @Test func aliveChecksTheProcess() {
        #expect(ActiveRuns.alive(getpid()))
        #expect(!ActiveRuns.alive(0))
        #expect(!ActiveRuns.alive(-1))
    }
}

@Suite struct AgentCardsTests {
    let now = Date(timeIntervalSince1970: 10_000)
    let active = [
        ActiveRun(sessionId: "a", pid: 1, request: "Notes for COMP2311", startedAt: 9_000_000, doing: "Reading lecture 12"),
        ActiveRun(sessionId: "b", pid: 2, request: "Fix the Amra footer", startedAt: 9_500_000, doing: nil),
    ]

    @Test func launcherRunsNewestFirst() {
        let cards = Agents.cards(active: active, current: nil, currentRunning: false, needsYou: false, now: now)
        #expect(cards.map(\.id) == ["b", "a"])
        #expect(cards[1].stage == "Reading lecture 12")
        #expect(cards[0].stage == "Working on it")
        #expect(cards[1].startedAt == Date(timeIntervalSince1970: 9000))
        #expect(cards.allSatisfy { $0.status == .working && !$0.isCurrent })
    }

    @Test func theAppsOwnRunIsACardUntilItsFileAppears() {
        var run = RunState(request: "What's the weather", startedAt: ProcessInfo.processInfo.systemUptime - 5)
        run.status = "Checking the forecast"
        // No session yet (or an instant reply like "thanks"): no tile.
        #expect(Agents.cards(active: active, current: run, currentRunning: true, needsYou: false, now: now).count == 2)
        run.sessionId = "z"
        var cards = Agents.cards(active: active, current: run, currentRunning: true, needsYou: false, now: now)
        #expect(cards.count == 3)
        #expect(cards[0].isCurrent && cards[0].id == "z" && cards[0].stage == "Checking the forecast")
        #expect(abs(cards[0].startedAt.timeIntervalSince(now) + 5) < 1)

        run.sessionId = "a"
        cards = Agents.cards(active: active, current: run, currentRunning: true, needsYou: false, now: now)
        #expect(cards.count == 2)
        #expect(cards.first { $0.id == "a" }?.isCurrent == true)

        // Finished, or speech from a run the app didn't start: no card.
        #expect(Agents.cards(active: [], current: run, currentRunning: false, needsYou: false, now: now).isEmpty)
        #expect(Agents.cards(active: [], current: RunState(request: "", startedAt: 0), currentRunning: true, needsYou: false, now: now).isEmpty)
    }

    @Test func aQuestionMarksTheCurrentRunElseTheNewest() {
        var run = RunState(request: "Apply to Oracle", startedAt: 0)
        run.sessionId = "z"
        var cards = Agents.cards(active: active, current: run, currentRunning: true, needsYou: true, now: now)
        #expect(cards.filter { $0.status == .waiting }.map(\.id) == ["z"])
        cards = Agents.cards(active: active, current: nil, currentRunning: false, needsYou: true, now: now)
        #expect(cards.filter { $0.status == .waiting }.map(\.id) == ["b"])
        #expect(Agents.cards(active: [], current: nil, currentRunning: false, needsYou: true, now: now).isEmpty)
    }

    @Test func filters() {
        let w = AgentCard(id: "1", request: "", stage: "", startedAt: now, status: .working)
        let q = AgentCard(id: "2", request: "", stage: "", startedAt: now, status: .waiting)
        #expect(AgentFilter.all.matches(w) && AgentFilter.all.matches(q))
        #expect(AgentFilter.working.matches(w) && !AgentFilter.working.matches(q))
        #expect(AgentFilter.waiting.matches(q) && !AgentFilter.waiting.matches(w))
        #expect(!AgentFilter.paused.matches(w) && !AgentFilter.paused.matches(q))
        #expect(AgentFilter.allCases.map(\.label) == ["All", "Working", "Waiting", "Paused"])
    }

    @Test func openTasksKeepATileUntilDoneUnlessOneOfTheirRunsIsGoing() throws {
        let home = try tempDir()
        let file = home.appendingPathComponent("tasks.json")
        try write(#"[{"id":"t1","title":"Apply to Oracle","latest":"Needs your visa answer","status":"waiting","sessions":["t1"],"startedAt":"2026-11-09T14:00:00.000Z","updatedAt":"2026-11-09T14:05:00.000Z"},{"id":"t2","title":"Draft the essay","latest":"Outline done","status":"paused","sessions":["t2","b"],"startedAt":"2026-11-09T13:00:00.000Z","updatedAt":"2026-11-09T13:30:00.000Z"}]"#, file)
        let open = OpenTask.read(file: file)
        // "b" (a run of t2) is going: its own tile shows instead of t2's.
        let cards = Agents.cards(active: active, current: nil, currentRunning: false, needsYou: false, now: now, open: open)
        #expect(cards.compactMap(\.taskId) == ["t1"])
        #expect(cards.last?.status == .waiting && cards.last?.stage == "Needs your visa answer")
        OpenTask.remove("t1", file: file)
        #expect(OpenTask.read(file: file).map(\.id) == ["t2"])
    }

    @Test func stagesKeepChangesOnly() {
        var s: [Stage] = []
        s = Agents.record("Reading Moodle", into: s, at: now)
        s = Agents.record("Reading Moodle", into: s, at: now.addingTimeInterval(1))
        s = Agents.record("  ", into: s, at: now)
        s = Agents.record("Writing notes", into: s, at: now.addingTimeInterval(2))
        #expect(s.map(\.text) == ["Reading Moodle", "Writing notes"])
        #expect(s[0].at == now)
        for i in 0..<30 { s = Agents.record("step \(i)", into: s, at: now) }
        #expect(s.count == 20 && s.last?.text == "step 29")
    }

    @Test func elapsedAndSummary() {
        #expect(Agents.elapsed(42) == "42s")
        #expect(Agents.elapsed(185) == "3m 05s")
        #expect(Agents.elapsed(3720) == "1h 02m")
        #expect(Agents.elapsed(-3) == "0s")
        let w = AgentCard(id: "1", request: "", stage: "", startedAt: now, status: .working)
        var q = w
        q.status = .waiting
        #expect(Agents.summary([]) == "Nothing running")
        #expect(Agents.summary([w]) == "1 agent")
        #expect(Agents.summary([w, q, w]) == "3 agents · 1 waiting on you")
    }
}

@MainActor
@Suite struct OrbStateTests {
    let palette = Appearance.presets[0]
    func card(_ s: AgentStatus) -> AgentCard { AgentCard(id: UUID().uuidString, request: "", stage: "", startedAt: Date(), status: s) }

    @Test func stateFollowsJarvis() {
        func state(_ k: StateKind, speaking: Bool = false, run: Bool = false, cards: [AgentCard] = []) -> String {
            OrbState.make(kind: k, speaking: speaking, runActive: run, mic: 0, voice: 0, cards: cards, palette: palette).state
        }
        #expect(state(.idle) == "idle")
        #expect(state(.log) == "idle")
        #expect(state(.done) == "idle")
        #expect(state(.listening) == "listening")
        #expect(state(.working) == "working")
        #expect(state(.idle, run: true) == "working")
        #expect(state(.idle, cards: [card(.working)]) == "working")
        #expect(state(.done, speaking: true) == "speaking")
        #expect(state(.needs) == "needs")
        // Needs you wins over everything; listening over speaking.
        #expect(state(.listening, speaking: true) == "listening")
        #expect(state(.idle, speaking: true, cards: [card(.waiting)]) == "needs")
    }

    @Test func levelIsTheMicWhileListeningAndTheVoiceWhileSpeaking() {
        let listening = OrbState.make(kind: .listening, speaking: false, runActive: false, mic: 0.734, voice: 0.2, cards: [], palette: palette)
        #expect(listening.level == 0.73)
        let speaking = OrbState.make(kind: .done, speaking: true, runActive: false, mic: 0.9, voice: 0.5, cards: [], palette: palette)
        #expect(speaking.level == 0.5)
        let working = OrbState.make(kind: .working, speaking: false, runActive: true, mic: 0.9, voice: 0.9, cards: [], palette: palette)
        #expect(working.level == 0)
        #expect(OrbState.make(kind: .listening, speaking: false, runActive: false, mic: 3, voice: 0, cards: [], palette: palette).level == 1)
    }

    @Test func agentsMakeItBusierAndWaitingOnesAreFlagged() {
        let s = OrbState.make(kind: .working, speaking: false, runActive: true, mic: 0, voice: 0,
                              cards: [card(.working), card(.waiting), card(.working)], palette: palette)
        #expect(s.agents == [false, true, false])
        #expect(abs(s.busy - 0.6) < 0.001)
        let many = OrbState.make(kind: .working, speaking: false, runActive: true, mic: 0, voice: 0, cards: (0..<9).map { _ in card(.working) }, palette: palette)
        #expect(many.busy == 1)
        #expect(OrbState.make(kind: .idle, speaking: false, runActive: false, mic: 0, voice: 0, cards: [], palette: palette).busy == 0)
    }

    @Test func coloursFollowThePaletteButNeedsYouStaysAmber() {
        let sunset = Appearance.presets.first { $0.id == "sunset" }!
        let working = OrbState.make(kind: .working, speaking: false, runActive: true, mic: 0, voice: 0, cards: [], palette: sunset)
        #expect(working.colors == ["#FF375F", "#BF5AF2"])
        let listening = OrbState.make(kind: .listening, speaking: false, runActive: false, mic: 0, voice: 0, cards: [], palette: sunset)
        #expect(listening.colors == ["#FF7A59", "#FF375F"])
        let needs = OrbState.make(kind: .needs, speaking: false, runActive: false, mic: 0, voice: 0, cards: [], palette: sunset)
        #expect(needs.colors == ["#F5B547", "#FF7A45"])
    }

    @Test func encodesForTheOrbPage() throws {
        let s = OrbState(state: "working", level: 0.5, busy: 0.2, agents: [true], colors: ["#000000", "#FFFFFF"])
        let o = try JSONSerialization.jsonObject(with: Data(s.json.utf8)) as? [String: Any]
        #expect(o?["state"] as? String == "working")
        #expect(o?["agents"] as? [Bool] == [true])
        #expect(o?["colors"] as? [String] == ["#000000", "#FFFFFF"])
    }

    @Test func storeReadsTheModelAndTheLauncherRuns() throws {
        let home = try tempDir()
        try write("{\"sessionId\":\"s1\",\"pid\":\(getpid()),\"request\":\"Make flashcards\",\"startedAt\":1000,\"doing\":\"Reading the slides\"}",
                  home.appendingPathComponent("state/active/s1.json"))
        let (m, _, l, _) = makeModel()
        let store = DashboardStore(model: m, paths: Paths(home: home, repo: home), micLevel: AudioLevel(), voiceLevel: AudioLevel())
        store.refresh()
        #expect(store.cards.map(\.id) == ["s1"])
        #expect(store.orbState().state == "working")
        #expect(store.stages(for: store.cards[0]).map(\.text) == ["Reading the slides"])

        m.submit("What's the weather")
        l.emit(.state("working", sessionId: "s2"))
        store.refresh()
        #expect(store.cards.count == 2 && store.cards[0].isCurrent)
        m.received(.ask(id: "q", question: "Which day?", options: ["Today", "Tomorrow"], timeoutMs: 60000, sessionId: nil), from: 1)
        store.refresh()
        #expect(store.cards[0].status == .waiting)
        #expect(store.orbState().state == "needs")
        #expect(store.orbState().agents == [true, false])
    }
}

@Suite struct TodayTests {
    @Test func readsTheTimetableScriptsJSON() {
        let json = #"{"stale":false,"events":[{"title":"COMP2311 lecture","location":"B32","start":"2026-11-09T09:00:00.000Z","end":"2026-11-09T10:00:00.000Z","allDay":false,"source":"uni"},{"title":"Lab","location":"","start":"2026-11-09T14:00:00Z","end":"2026-11-09T16:00:00Z","allDay":false,"source":"uni"},{"title":"bad","start":"x","end":"y"}]}"#
        let events = Today.timetable(Data(json.utf8))
        #expect(events.map(\.title) == ["COMP2311 lecture", "Lab"])
        #expect(events[0].location == "B32")
        #expect(events[1].location == nil)
        #expect(events[0].start == ISO8601DateFormatter().date(from: "2026-11-09T09:00:00Z"))
        #expect(Today.timetable(Data("oops".utf8)).isEmpty)
    }

    @Test func deadlinesInTheNextSevenDays() throws {
        let d = try tempDir().appendingPathComponent("deadlines.json")
        try write(#"{"updatedAt":"","reminded":[],"deadlines":[{"title":"Sheet 6","course":"COMP2311","due":"2026-11-16T12:00:00Z"},{"title":"CW2","course":null,"due":"2026-11-13T16:00:00Z"},{"title":"Past","course":null,"due":"2026-11-01T12:00:00Z"},{"title":"Far","course":null,"due":"2026-12-20T12:00:00Z"}]}"#, d)
        let now = ISO8601DateFormatter().date(from: "2026-11-09T12:00:00Z")!
        #expect(Today.deadlines(file: d, now: now).map(\.title) == ["CW2", "Sheet 6"])
        #expect(Today.deadlines(file: d.appendingPathExtension("missing"), now: now).isEmpty)
    }

    @Test func remindersStillToFire() throws {
        let dir = try tempDir()
        try write(#"{"id":"r1","text":"Call Sue","at":"2026-11-09T18:00:00.000Z","sessionId":null,"createdAt":""}"#, dir.appendingPathComponent("r1.json"))
        try write(#"{"id":"r2","text":"Old","at":"2026-11-08T18:00:00Z","sessionId":null,"createdAt":""}"#, dir.appendingPathComponent("r2.json"))
        try write(#"{"id":"r3","text":"Bins","at":"2026-11-09T13:00:00Z","sessionId":null,"createdAt":""}"#, dir.appendingPathComponent("r3.json"))
        try write("<plist/>", dir.appendingPathComponent("r3.plist"))
        let now = ISO8601DateFormatter().date(from: "2026-11-09T12:00:00Z")!
        #expect(Today.reminders(dir: dir, now: now).map(\.text) == ["Bins", "Call Sue"])
    }
}

@Suite struct RoutingTests {
    @Test func jarvisURLs() {
        #expect(AppURL.parse(URL(string: "jarvis://dashboard")!) == .dashboard)
        #expect(AppURL.parse(URL(string: "jarvis://listen")!) == .listen)
        #expect(AppURL.parse(URL(string: "jarvis://ask?q=what%27s%20on")!) == .ask("what's on"))
        #expect(AppURL.parse(URL(string: "jarvis://ask?q=%20")!) == nil)
        #expect(AppURL.parse(URL(string: "jarvis://nope")!) == nil)
        #expect(AppURL.parse(URL(string: "https://dashboard")!) == nil)
    }

    @MainActor @Test func dashboardHotkeyIsOptionShiftJ() {
        #expect(HotKeyCenter.Combo.optionShiftJ.label == "⌥⇧J")
        #expect(HotKeyCenter.Combo.optionShiftJ != HotKeyCenter.Combo.optionShiftSpace)
    }
}

/// Loads the bundled orb page in an offscreen web view (no window): three.js
/// must load under the page's no-network policy, and `jarvis` must take state.
@MainActor
@Suite struct OrbPageTests {
    final class Waiter: NSObject, WKNavigationDelegate {
        var done: CheckedContinuation<Void, Never>?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.resume(); done = nil }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done?.resume(); done = nil }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done?.resume(); done = nil }
    }

    @Test func pageLoadsThreeLocallyAndTakesState() async throws {
        let url = try #require(OrbView.pageURL)
        #expect(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().appendingPathComponent("three.min.js").path))
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 200, height: 200))
        let waiter = Waiter()
        web.navigationDelegate = waiter
        await withCheckedContinuation { c in
            waiter.done = c
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        let three = try await web.evaluateJavaScript("typeof THREE") as? String
        #expect(three == "object")
        let json = OrbState(state: "needs", level: 0, busy: 0.4, agents: [true, false], colors: ["#F5B547", "#FF7A45"]).json
        let set = try await web.evaluateJavaScript("jarvis.set(\(json)); jarvis.pause(true); typeof jarvis.set") as? String
        #expect(set == "function")
        let html = try String(contentsOf: url, encoding: .utf8)
        #expect(!html.contains("http://") && !html.contains("https://"))
    }
}

@Suite struct QueueTests {
    private let json = #"""
    {"closed":[{"title":"x","request":"x","how":"declined","at":"2026-11-09T08:00:00Z"}],"items":[
     {"id":"d1","source":"kanban","title":"Done one","request":"r","why":"","status":"done","sessionId":"s1","summary":"Did it","createdAt":"2026-11-09T08:00:00.000Z","updatedAt":"2026-11-09T09:00:00.000Z"},
     {"id":"p1","source":"university","title":"Write notes","request":"r","why":"Empty note","status":"proposed","createdAt":"2026-11-09T08:00:00.000Z","updatedAt":"2026-11-09T08:00:00.000Z"},
     {"id":"n1","source":"email","title":"Draft reply","request":"r","why":"","status":"done","sessionId":"s2","summary":"Needs the date","needsYou":true,"createdAt":"2026-11-09T08:00:00.000Z","updatedAt":"2026-11-09T08:00:00.000Z"},
     {"id":"r1","source":"kanban","title":"Running one","request":"r","why":"","status":"running","sessionId":"s3","createdAt":"2026-11-09T08:00:00.000Z","updatedAt":"2026-11-09T08:00:00.000Z"},
     {"id":"f1","source":"other","title":"Failed one","request":"r","why":"","status":"failed","summary":"claude exited 1","createdAt":"2026-11-09T08:00:00.000Z","updatedAt":"2026-11-09T08:00:00.000Z"},
     {"id":"p2","source":"freelance","title":"Second proposal","request":"r","why":"","status":"proposed","createdAt":"2026-11-09T08:00:00.000Z","updatedAt":"2026-11-09T08:00:00.000Z"}]}
    """#

    @Test func decodesTheLaunchersQueueInPanelOrder() throws {
        let f = try tempDir().appendingPathComponent("queue.json")
        try write(json, f)
        let q = QueueItem.read(file: f)
        #expect(q.map(\.id) == ["p1", "p2", "r1", "n1", "f1", "d1"])
        #expect(q.map(\.phase) == [.proposed, .proposed, .running, .needsYou, .failed, .done])
        #expect(q[0].actions == [.approve, .decline])
        #expect(q[2].actions.isEmpty)
        #expect(q[3].actions == [.dismiss])
        #expect(q[4].actions == [.retry, .dismiss])
        #expect(q[5].actions == [.dismiss])
        #expect(QueueItem.read(file: f.appendingPathExtension("missing")).isEmpty)
        try write("{\"items\": 3}", f)
        #expect(QueueItem.read(file: f).isEmpty)
    }

    @MainActor @Test func thePanelsActionsGoToTheLauncherAndShowAtOnce() throws {
        let home = try tempDir()
        try write(json, home.appendingPathComponent("state/queue.json"))
        try write("{\"sessionId\":\"s3\",\"pid\":\(getpid()),\"request\":\"Running one\",\"startedAt\":1000,\"doing\":\"Reading the slides\"}",
                  home.appendingPathComponent("state/active/s3.json"))
        let (m, _, _, _) = makeModel()
        let store = DashboardStore(model: m, paths: Paths(home: home, repo: home), micLevel: AudioLevel(), voiceLevel: AudioLevel())
        var sent: [String] = []
        store.queueAction = { sent.append("\($0.rawValue) \($1)") }
        store.refresh()
        let byId = { (id: String) in store.queue.first { $0.id == id }! }
        // Running: the live stage from its active-run file, and its live card for the log.
        #expect(store.stage(for: byId("r1")) == "Reading the slides")
        #expect(store.card(for: byId("r1"))?.id == "s3")
        // Finished: a card with its session, so the log opens; a proposal has no run yet.
        #expect(store.card(for: byId("d1"))?.sessionId == "s1")
        #expect(store.card(for: byId("n1"))?.status == .waiting)
        #expect(store.card(for: byId("p1")) == nil)

        store.act(.approve, byId("p1"))
        store.act(.decline, byId("p2"))
        store.act(.retry, byId("f1"))
        store.act(.dismiss, byId("d1"))
        #expect(sent == ["approve p1", "decline p2", "retry f1", "dismiss d1"])
        #expect(store.queue.map(\.id) == ["p1", "r1", "n1", "f1"])
        #expect(byId("p1").phase == .approved && byId("f1").phase == .approved && byId("f1").summary == nil)
    }
}
