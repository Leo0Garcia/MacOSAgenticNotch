// The notch's state machine (NOTCH-DESIGN sections 2 and 2.1). Views only
// read it; the hotkey, voice pipeline, launcher and notch socket feed it.
// `size` is what the notch controller drives DynamicNotchKit to; `panel` is
// what the expanded body and the pill show.

import Foundation
import Observation

/// Rim colours, character mood and labels hang off this.
enum StateKind: Equatable, Sendable {
    case idle, listening, working, done, needs, reminder, notice, log
}

enum NotchSize: Equatable, Sendable {
    case hidden, compact, expanded
}

/// Which spring a change uses (section 3: bigger → expand, smaller → collapse).
enum Motion: Sendable {
    case expand, collapse
}

struct AskInfo: Equatable, Sendable {
    var id: String
    var question: String
    var options: [String]
    var client: NotchServer.ClientID?
}

struct AccessInfo: Equatable, Sendable {
    var what: String
    var fix: String?
}

struct BlockedInfo: Equatable, Sendable {
    var rule: String
    var sentence: String
    var detail: String?
    var safeVersion: String?
}

struct ReminderInfo: Equatable, Sendable {
    var text: String
    var firedAt: Date
}

enum Panel: Equatable, Sendable {
    case idle
    case listening
    case working
    case done
    case question(AskInfo)
    case access(AccessInfo)
    case blocked(BlockedInfo)
    case reminder(ReminderInfo)
    case notice(title: String, body: String)
    /// Hover log: the pointer rests on the notch while nothing else is shown.
    case recent([ActionItem])

    var kind: StateKind {
        switch self {
        case .idle: .idle
        case .listening: .listening
        case .working: .working
        case .done: .done
        case .question, .access, .blocked: .needs
        case .reminder: .reminder
        case .notice: .notice
        case .recent: .log
        }
    }

    var isNeedsYou: Bool { kind == .needs }
}

struct RunStep: Equatable, Identifiable, Sendable {
    let id: Int
    var text: String
    var detail: String?
    var startedAt: Double
    var duration: Double?
}

struct RunState: Equatable, Sendable {
    var token = 0
    /// Started outside the app (reported over the socket's run_event).
    var external = false
    var request: String
    var startedAt: Double
    var sessionId: String?
    var status: String = "Thinking"
    var steps: [RunStep] = []
    var hosts: [String] = []
    var captions: [Caption] = []
    var firstWordAt: Double?
    var socketSpeech = false
    var keep = false
    var name: String?
    var summary = ""
    var reply = ""
    var finalState: String?
    var errorMessage: String?
    var denials: [BlockedInfo] = []
    var exited = false
    var exitCode: Int32 = 0

    var savedLabel: String? {
        guard keep, let sessionId, !sessionId.isEmpty else { return nil }
        let label = name ?? (summary.isEmpty ? "this run" : summary)
        return label.hasPrefix("Jarvis: ") ? String(label.dropFirst(8)) : label
    }
}

struct Caption: Equatable, Identifiable, Sendable {
    let id: String
    var text: String
    var startedAt: Double
    /// Estimated speaking time; `say` reports no word timing (section 2 rules).
    var estimatedDuration: Double { max(0.6, Double(text.count) * 0.048) }
}

struct Transcript: Equatable, Sendable {
    var confirmed = ""
    var hypothesis = ""
    var full: String { [confirmed, hypothesis].filter { !$0.isEmpty }.joined(separator: " ") }
}

enum SpeechModelStatus: Equatable, Sendable {
    case notLoaded
    case loading(String)
    case ready
    case failed(String)
}

@MainActor
protocol VoiceInput: AnyObject {
    /// Starts capture. Throws when the mic or model isn't available.
    func start() throws
    /// Stops capture and returns the final transcription ("" if nothing was said).
    func finish() async -> String
    func cancel()
}

@MainActor
@Observable
final class AppModel {
    // What the notch shows.
    private(set) var size: NotchSize = .hidden
    private(set) var panel: Panel = .idle
    /// The last non-idle panel, so content stays put while the shape collapses.
    private(set) var lastPanel: Panel = .working
    /// When the character's mood last changed (hop, wave and flap timings start here).
    private(set) var moodSince = Date()
    private(set) var motion: Motion = .expand
    /// Bumps whenever the expanded body's layout changes, so views animate once.
    private(set) var layoutRevision = 0

    // Listening.
    private(set) var transcript = Transcript()
    private(set) var listeningStartedAt: Double = 0
    private(set) var isTranscribing = false
    var speechModel: SpeechModelStatus = .notLoaded

    // The current run, if any.
    private(set) var run: RunState?
    private(set) var doneEnteredAt: Double = 0
    private(set) var speaking = false

    /// Shown in the Listening body when the mic or model can't start.
    private(set) var listenProblem: String?

    @ObservationIgnored let scheduler: Scheduling
    @ObservationIgnored var launcher: LauncherRunning?
    @ObservationIgnored var voice: VoiceInput?
    @ObservationIgnored var sendToClient: ((NotchServer.ClientID, NotchProtocol.AppMessage) -> Void)?
    @ObservationIgnored var postNotification: ((_ title: String, _ body: String) -> Void)?
    @ObservationIgnored var announce: ((String) -> Void)?
    @ObservationIgnored var loadRecent: (() -> [ActionItem])?

    @ObservationIgnored private var timers: [String: Scheduled] = [:]
    @ObservationIgnored private var speakingIDs: Set<String> = []
    @ObservationIgnored private var stdoutSpeechCount = 0
    @ObservationIgnored private var hovering = false
    @ObservationIgnored private var listenTarget: ListenTarget = .request
    @ObservationIgnored private var pendingStatus: (text: String, detail: String?)?
    @ObservationIgnored private var lastStatusAt: Double = -10
    @ObservationIgnored private var deferred: [Panel] = []
    @ObservationIgnored private var stepCounter = 0
    @ObservationIgnored private var lastCollapseAt: Double = 0
    @ObservationIgnored private var expandedContentAt: Double = 0
    @ObservationIgnored private var runTokens = 0

    private enum ListenTarget: Equatable {
        case request
        case answer(AskInfo)
    }

    // Section 2.1 timings, in seconds.
    enum Timing {
        static let workingExpanded = 3.0
        static let doneHold = 1.8
        static let doneHoldSaved = 4.0
        static let donePill = 1.4
        static let needsIdle = 20.0
        static let reminderExpanded = 5.0
        static let reminderPill = 60.0
        static let noticeHold = 4.0
        static let hoverIn = 0.3
        static let hoverOut = 0.4
        static let statusMinInterval = 0.35
        static let maxExpandedWithoutContent = 6.0
    }

    init(scheduler: Scheduling) {
        self.scheduler = scheduler
    }

    // MARK: - Derived

    var kind: StateKind { panel.kind }

    var runActive: Bool { run.map { !$0.exited } ?? false }

    /// Seconds since this state's clock started (Listening: hotkey down; Working: request sent).
    func elapsed(at now: Double) -> Double {
        switch panel {
        case .listening: return now - listeningStartedAt
        default: return run.map { now - $0.startedAt } ?? 0
        }
    }

    // MARK: - Hotkey and voice

    func hotkeyDown() {
        if panel == .listening { return }
        if case let .question(ask) = panel { listenTarget = .answer(ask) } else { listenTarget = .request }
        transcript = Transcript()
        listenProblem = nil
        isTranscribing = false
        listeningStartedAt = scheduler.now
        cancelTimer("collapse"); cancelTimer("hide"); cancelTimer("needsIdle"); cancelTimer("hover")
        do {
            try voice?.start()
        } catch {
            listenProblem = error.localizedDescription
        }
        show(.listening, size: .expanded)
    }

    func hotkeyUp() {
        guard panel == .listening else { return }
        if listenProblem != nil {
            voice?.cancel()
            restoreAfterListening()
            return
        }
        isTranscribing = true
        Task { @MainActor in
            let text = await voice?.finish() ?? ""
            self.listeningFinished(text)
        }
    }

    func updateTranscript(_ t: Transcript) {
        guard panel == .listening, t != transcript else { return }
        let grew = t.full.count > transcript.full.count + 20
        transcript = t
        if grew { bumpLayout(.expand) }
    }

    func listeningFinished(_ text: String) {
        isTranscribing = false
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch listenTarget {
        case let .answer(ask):
            listenTarget = .request
            if clean.isEmpty {
                show(.question(ask), size: .expanded)
                return
            }
            answer(ask, text: clean, via: .voice)
        case .request:
            if clean.isEmpty {
                restoreAfterListening(notice: "I didn't catch that.")
                return
            }
            submit(clean)
        }
    }

    // MARK: - Runs

    /// Sends a request to the launcher (spoken, typed with --request, or a button).
    func submit(_ request: String) {
        let now = scheduler.now
        runTokens += 1
        let token = runTokens
        run = RunState(token: token, request: request, startedAt: now)
        stdoutSpeechCount = 0
        speakingIDs.removeAll()
        speaking = false
        pendingStatus = nil
        stepCounter = 0
        show(.working, size: .expanded)
        announce?("Working on: \(request)")
        schedule("collapse", Timing.workingExpanded) { [weak self] in
            guard let self, self.panel == .working else { return }
            self.setSize(.compact)
        }
        guard let launcher else {
            launcherFailed("The launcher isn't connected.")
            return
        }
        do {
            // A second request replaces the run on screen; the first one's events are dropped.
            try launcher.run(
                request,
                onEvent: { [weak self] e in if self?.run?.token == token { self?.launcherEvent(e) } },
                exited: { [weak self] code in if self?.run?.token == token { self?.launcherExited(code) } })
        } catch {
            launcherFailed(error.localizedDescription)
        }
    }

    private func launcherFailed(_ message: String) {
        AppLog.write("launcher failed: \(message)")
        run?.errorMessage = message
        run?.exited = true
        run?.exitCode = 1
        evaluateEnd()
    }

    func launcherEvent(_ e: LauncherEvent) {
        guard run != nil else { return }
        switch e {
        case let .state(state, sessionId):
            if let sessionId { run?.sessionId = sessionId }
            if state != "working" { run?.finalState = state }
        case let .status(text, detail):
            queueStatus(text, detail)
        case let .speak(text):
            // Captions come from the socket (speak_start/speak_end, timed to the
            // audio). Without the socket, fall back to the launcher's stdout.
            stdoutSpeechCount += 1
            let n = stdoutSpeechCount
            scheduler.after(0.3) { [weak self] in
                guard let self, let run = self.run, !run.socketSpeech else { return }
                let id = "stdout-\(n)"
                self.speechStarted(id: id, text: text)
                let dur = Caption(id: id, text: text, startedAt: 0).estimatedDuration
                self.scheduler.after(dur) { [weak self] in self?.speechEnded(id: id) }
            }
        case let .denied(tool, rule, reason):
            guard let rule, let reason else { return }
            run?.denials.append(Self.blockedInfo(rule: rule, reason: reason, tool: tool))
        case .warning:
            break
        case let .done(sessionId, keep, summary, reply, name):
            if !sessionId.isEmpty { run?.sessionId = sessionId }
            run?.keep = keep
            run?.summary = summary
            run?.reply = reply
            run?.name = name
        case let .error(message):
            run?.errorMessage = message
        }
    }

    func launcherExited(_ code: Int32) {
        guard run != nil else { return }
        flushStatus()
        run?.exited = true
        run?.exitCode = code
        evaluateEnd()
    }

    private func queueStatus(_ text: String, _ detail: String?) {
        let now = scheduler.now
        if let host = Self.host(in: detail ?? ""), run?.hosts.contains(host) == false, text.hasPrefix("Reading") || text.hasPrefix("Opening") {
            run?.hosts.append(host)
        }
        pendingStatus = (text, detail)
        let wait = Timing.statusMinInterval - (now - lastStatusAt)
        if wait <= 0 {
            flushStatus()
        } else if timers["status"] == nil {
            schedule("status", wait) { [weak self] in self?.flushStatus() }
        }
    }

    private func flushStatus() {
        cancelTimer("status")
        guard let s = pendingStatus, run != nil else { return }
        pendingStatus = nil
        let now = scheduler.now
        lastStatusAt = now
        if let n = run?.steps.count, n > 0, run?.steps[n - 1].duration == nil {
            let started = run?.steps[n - 1].startedAt ?? now
            run?.steps[n - 1].duration = now - started
        }
        stepCounter += 1
        run?.steps.append(RunStep(id: stepCounter, text: s.text, detail: s.detail, startedAt: now))
        run?.status = s.text
        if panel == .working, size == .expanded { bumpLayout(.expand) }
    }

    // MARK: - Speech (socket speak_start / speak_end)

    func speechStarted(id: String, text: String) {
        let now = scheduler.now
        if run != nil, !id.hasPrefix("stdout-") { run?.socketSpeech = true }
        speakingIDs.insert(id)
        speaking = true
        if run == nil {
            // Speech from a run the app didn't start (terminal, reminder job).
            run = RunState(request: "", startedAt: now)
            run?.exited = true
            run?.socketSpeech = true
        }
        if run?.firstWordAt == nil { run?.firstWordAt = now }
        run?.captions.append(Caption(id: id, text: text, startedAt: now))
        trimCaptions()
        cancelTimer("collapse"); cancelTimer("hide")
        if panel.isNeedsYou || panel == .listening {
            return // the caption waits; needs-you and listening win
        }
        if panel != .done {
            doneEnteredAt = now
            show(.done, size: .expanded)
            announce?(text)
        } else {
            if size != .expanded { setSize(.expanded) }
            bumpLayout(.expand)
        }
    }

    func speechEnded(id: String) {
        guard speakingIDs.remove(id) != nil else { return }
        if speakingIDs.isEmpty {
            speaking = false
            evaluateEnd()
        }
    }

    private func trimCaptions() {
        // Keep the tail that fits the Large body (about 7 lines of 19 pt).
        guard var caps = run?.captions else { return }
        while caps.count > 1, caps.map(\.text.count).reduce(0, +) > 320 { caps.removeFirst() }
        run?.captions = caps
    }

    /// After the run exits and speech stops: Done hold, or Needs you.
    private func evaluateEnd() {
        guard let run, run.exited, speakingIDs.isEmpty else { return }
        if panel.isNeedsYou || panel == .listening { return }
        if let blocked = run.denials.first {
            show(.blocked(blocked), size: .expanded)
            postNotification?("Jarvis is blocked", blocked.sentence)
            announce?(blocked.sentence)
            startNeedsIdleTimer()
            return
        }
        if let access = Self.accessInfo(in: run.reply) {
            show(.access(access), size: .expanded)
            postNotification?("Jarvis needs access", access.what)
            announce?(access.what)
            startNeedsIdleTimer()
            return
        }
        if run.captions.isEmpty {
            if !run.reply.isEmpty {
                // Nothing reached the caption (no socket, no stdout speech).
                self.run?.captions = [Caption(id: "reply", text: run.reply, startedAt: scheduler.now)]
                trimCaptions()
                doneEnteredAt = scheduler.now
                show(.done, size: .expanded)
            } else if let message = run.errorMessage ?? (run.exitCode != 0 ? "The run failed (exit \(run.exitCode))." : nil) {
                show(.notice(title: "Something went wrong", body: message), size: .expanded)
                schedule("hide", Timing.noticeHold) { [weak self] in self?.finishAndHide() }
                return
            } else {
                finishAndHide()
                return
            }
        }
        if panel != .done {
            doneEnteredAt = scheduler.now
            show(.done, size: .expanded)
        }
        let hold = run.savedLabel != nil ? Timing.doneHoldSaved : Timing.doneHold
        schedule("collapse", hold) { [weak self] in
            guard let self, self.panel == .done else { return }
            if self.hovering { return }
            self.setSize(.compact)
            self.schedule("hide", Timing.donePill) { [weak self] in
                guard let self, self.panel == .done, !self.hovering else { return }
                self.finishAndHide()
            }
        }
    }

    private func finishAndHide() {
        if runActive {
            show(.working, size: .compact)
            return
        }
        run = nil
        speaking = false
        speakingIDs.removeAll()
        if let next = deferred.first {
            deferred.removeFirst()
            present(next)
            return
        }
        show(.idle, size: .hidden)
    }

    // MARK: - Socket messages

    func received(_ msg: NotchProtocol.ClientMessage, from client: NotchServer.ClientID) {
        switch msg {
        case let .speakStart(id, text, _):
            speechStarted(id: id, text: text)
        case let .speakEnd(id):
            speechEnded(id: id)
        case let .notify(_, title, body, _):
            postNotification?(title, body)
            if panel == .idle { present(.notice(title: title, body: body)) }
        case let .ask(id, question, options, timeoutMs, _):
            postNotification?("Jarvis needs you", question)
            let ask = AskInfo(id: id, question: question, options: options, client: client)
            if panel == .listening {
                deferred.insert(.question(ask), at: 0)
            } else {
                present(.question(ask))
            }
            // The bridge times out on its own; this only tidies the notch if its ask_cancel is lost.
            schedule("askTimeout-\(id)", Double(timeoutMs) / 1000 + 2) { [weak self] in self?.askCancelled(id) }
        case let .askCancel(id, _):
            askCancelled(id)
        case let .reminder(_, text):
            postNotification?("Reminder", text)
            let r = Panel.reminder(ReminderInfo(text: text, firedAt: Date()))
            if panel.isNeedsYou || panel == .listening { deferred.append(r) } else { present(r) }
        case let .runEvent(sessionId, event, text, keep, summary, rule):
            runEventFromSocket(sessionId: sessionId, event: event, text: text, keep: keep, summary: summary, rule: rule)
        case .hello, .log, .unknown:
            break
        }
    }

    func clientDisconnected(_ client: NotchServer.ClientID) {
        // An open question from that client can no longer be answered.
        if case let .question(ask) = panel, ask.client == client { askCancelled(ask.id) }
        deferred.removeAll { if case let .question(a) = $0 { return a.client == client }; return false }
    }

    /// run_event frames matter only for runs the app didn't start (e.g. from a terminal).
    private func runEventFromSocket(sessionId: String?, event: String, text: String?, keep: Bool?, summary: String?, rule: String?) {
        if let run, !run.exited, !run.external { return } // our own run reports over stdout
        switch event {
        case "started":
            guard panel == .idle else { return }
            run = RunState(external: true, request: text ?? "", startedAt: scheduler.now, sessionId: sessionId)
            show(.working, size: .compact)
        case "tool":
            if let text, run != nil { queueStatus(text, nil) }
        case "denied":
            if let rule, let text { run?.denials.append(Self.blockedInfo(rule: rule, reason: text, tool: "")) }
        case "done", "failed":
            guard run != nil else { return }
            run?.keep = keep ?? false
            run?.summary = summary ?? ""
            run?.exited = true
            evaluateEnd()
        default: break
        }
    }

    // MARK: - Needs you

    func answer(_ ask: AskInfo, text: String, via: NotchProtocol.AnswerVia) {
        cancelTimer("askTimeout-\(ask.id)")
        if let client = ask.client { sendToClient?(client, .answer(id: ask.id, text: text, via: via)) }
        resolveNeedsYou()
    }

    func answerButton(_ option: String) {
        guard case let .question(ask) = panel else { return }
        answer(ask, text: option, via: .button)
    }

    private func askCancelled(_ id: String) {
        cancelTimer("askTimeout-\(id)")
        deferred.removeAll { if case let .question(a) = $0 { return a.id == id }; return false }
        if case let .question(ask) = panel, ask.id == id { resolveNeedsYou() }
    }

    /// Dismiss on Access, Blocked, Reminder and notices; on a question it answers "dismissed".
    func dismiss() {
        switch panel {
        case let .question(ask): answer(ask, text: "", via: .dismissed)
        case .access, .blocked, .reminder, .notice: resolveNeedsYou()
        case .done: finishAndHide()
        default: collapseOrHide()
        }
    }

    /// Blocked: the safe version is a follow-up to the same run (DESIGN 4.4).
    func doSafeVersion() {
        guard case let .blocked(b) = panel else { return }
        resolveNeedsYou()
        let ask = b.safeVersion.map { "And also, do the safe version instead: \($0)" } ?? "And also, do the safe version you offered instead."
        submit(ask)
    }

    func openSavedRun() {
        guard let id = run?.sessionId, run?.keep == true else { return }
        launcher?.open(sessionId: id)
    }

    private func resolveNeedsYou() {
        cancelTimer("needsIdle")
        cancelTimer("collapse")
        cancelTimer("hide")
        if let next = deferred.first {
            deferred.removeFirst()
            present(next)
            return
        }
        if runActive {
            if let run, !run.captions.isEmpty, speaking { show(.done, size: .expanded) } else { show(.working, size: .compact) }
            return
        }
        if let run, run.exited, !run.captions.isEmpty, speaking { show(.done, size: .expanded); return }
        run = nil
        show(.idle, size: .hidden)
    }

    private func startNeedsIdleTimer() {
        schedule("needsIdle", Timing.needsIdle) { [weak self] in
            guard let self, self.panel.isNeedsYou, self.size == .expanded else { return }
            if self.hovering { self.startNeedsIdleTimer(); return }
            self.setSize(.compact)
        }
    }

    /// Any pointer or keyboard activity on the panel restarts the idle clock.
    func userActivity() {
        if panel.isNeedsYou, size == .expanded { startNeedsIdleTimer() }
    }

    // MARK: - Presenting

    private func present(_ p: Panel) {
        switch p {
        case .question, .access, .blocked:
            show(p, size: .expanded)
            if case let .question(a) = p { announce?(a.question) }
            startNeedsIdleTimer()
        case let .reminder(r):
            show(p, size: .expanded)
            announce?("Reminder: \(r.text)")
            schedule("collapse", Timing.reminderExpanded) { [weak self] in
                guard let self, case .reminder = self.panel, !self.hovering else { return }
                self.setSize(.compact)
                self.schedule("hide", Timing.reminderPill) { [weak self] in
                    guard let self, case .reminder = self.panel else { return }
                    self.resolveNeedsYou()
                }
            }
        case let .notice(title, body):
            show(p, size: .expanded)
            announce?("\(title). \(body)")
            schedule("hide", Timing.noticeHold) { [weak self] in
                guard let self, case .notice = self.panel else { return }
                self.resolveNeedsYou()
            }
        default:
            show(p, size: .expanded)
        }
    }

    private func restoreAfterListening(notice: String? = nil) {
        if let next = deferred.first {
            deferred.removeFirst()
            present(next)
        } else if let notice {
            present(.notice(title: notice, body: ""))
        } else if runActive {
            show(.working, size: .compact)
        } else {
            show(.idle, size: .hidden)
        }
    }

    /// Esc or a click outside: the pill if something is running, else hide.
    func collapseOrHide() {
        guard size == .expanded else { return }
        switch panel {
        case .listening: return
        case .question, .access, .blocked, .reminder, .working, .done: setSize(.compact)
        default: finishAndHide()
        }
    }

    // MARK: - Hover

    /// The pointer is over the hardware notch while Jarvis is hidden (the
    /// notch window ignores the mouse then, so the controller watches globally).
    func notchHover(_ inside: Bool) {
        guard panel == .idle, size == .hidden else { return }
        if inside {
            guard timers["hoverIdle"] == nil else { return }
            schedule("hoverIdle", Timing.hoverIn) { [weak self] in
                guard let self, self.panel == .idle else { return }
                self.show(.recent(self.loadRecent?() ?? []), size: .expanded)
                // If the pointer never reaches the panel, don't leave it open.
                self.schedule("hover", 1.5) { [weak self] in
                    guard let self, case .recent = self.panel, !self.hovering else { return }
                    self.finishAndHide()
                }
            }
        } else {
            cancelTimer("hoverIdle")
        }
    }

    func openRecent(_ item: ActionItem) {
        guard item.saved, let id = item.sessionId else { return }
        launcher?.open(sessionId: id)
        finishAndHide()
    }

    func hoverChanged(_ isHovering: Bool) {
        hovering = isHovering
        cancelTimer("hover")
        if isHovering {
            userActivity()
            guard size == .compact, panel != .idle else { return }
            schedule("hover", Timing.hoverIn) { [weak self] in
                guard let self, self.hovering, self.size == .compact else { return }
                self.setSize(.expanded)
            }
        } else {
            schedule("hover", Timing.hoverOut) { [weak self] in
                guard let self, !self.hovering, self.size == .expanded else { return }
                switch self.panel {
                case .working:
                    self.setSize(.compact)
                case .done where !self.speaking:
                    self.evaluateEnd()
                case .reminder:
                    self.setSize(.compact)
                case .recent:
                    self.finishAndHide()
                default: break
                }
            }
        }
    }

    // MARK: - Plumbing

    private func show(_ p: Panel, size s: NotchSize) {
        let grows = Self.rank(s) > Self.rank(size) || (s == .expanded && p != panel && Self.weight(p) >= Self.weight(panel))
        motion = grows ? .expand : .collapse
        if p.kind != panel.kind, p != .idle { moodSince = Date() }
        if p != .idle, p != lastPanel { lastPanel = p }
        if p != panel { panel = p }
        if s != size { size = s }
        if s == .expanded { expandedContentAt = scheduler.now }
        layoutRevision &+= 1
        if p == .idle { cancelAllTimers(except: []) }
        if s == .expanded, !p.isNeedsYou, p != .listening { armWatchdog() }
    }

    private func setSize(_ s: NotchSize) {
        guard s != size else { return }
        motion = Self.rank(s) > Self.rank(size) ? .expand : .collapse
        size = s
        if s == .expanded { expandedContentAt = scheduler.now; armWatchdog() }
        layoutRevision &+= 1
    }

    private func bumpLayout(_ m: Motion) {
        motion = m
        layoutRevision &+= 1
        if size == .expanded { expandedContentAt = scheduler.now; armWatchdog() }
    }

    /// Nothing stays expanded more than 6 s without new content, except needs-you,
    /// listening, and speech in progress (section 2.1).
    private func armWatchdog() {
        schedule("watchdog", Timing.maxExpandedWithoutContent + 0.05) { [weak self] in
            guard let self, self.size == .expanded else { return }
            if self.panel.isNeedsYou || self.panel == .listening || self.speaking || self.hovering { return }
            if self.scheduler.now - self.expandedContentAt < Timing.maxExpandedWithoutContent { self.armWatchdog(); return }
            switch self.panel {
            case .done: self.evaluateEnd()
            case .working, .reminder: self.setSize(.compact)
            case .notice: self.resolveNeedsYou()
            case .recent: self.finishAndHide()
            default: break
            }
        }
    }

    private static func rank(_ s: NotchSize) -> Int {
        switch s { case .hidden: 0; case .compact: 1; case .expanded: 2 }
    }

    /// Rough body height order, to pick expand vs collapse between expanded states.
    private static func weight(_ p: Panel) -> Int {
        switch p {
        case .idle: 0
        case .notice: 1
        case .listening, .reminder: 2
        case .working, .question, .access: 3
        case .done, .blocked, .recent: 4
        }
    }

    private func schedule(_ key: String, _ seconds: Double, _ action: @escaping @MainActor () -> Void) {
        timers[key]?.cancel()
        timers[key] = scheduler.after(seconds) { [weak self] in
            self?.timers[key] = nil
            action()
        }
    }

    private func cancelTimer(_ key: String) {
        timers.removeValue(forKey: key)?.cancel()
    }

    private func cancelAllTimers(except keep: Set<String>) {
        for (k, t) in timers where !keep.contains(k) && !k.hasPrefix("askTimeout-") {
            t.cancel()
            timers[k] = nil
        }
    }

    // MARK: - Parsing helpers

    /// "guard:<rule>: <reason>. Safe alternative: <offer>" → the Blocked panel.
    static func blockedInfo(rule: String, reason: String, tool: String) -> BlockedInfo {
        var text = reason.replacingOccurrences(of: #"^guard:[a-z-]+:\s*"#, with: "", options: .regularExpression)
        var safe: String?
        if let r = text.range(of: "Safe alternative:", options: .caseInsensitive) {
            safe = String(text[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines.union(.init(charactersIn: ".")))
            text = String(text[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        let sentence = text.isEmpty ? "That breaks one of my rules." : "I can't do that: \(text.prefix(1).lowercased())\(text.dropFirst())"
        let detail = tool.isEmpty ? nil : "Guard blocked \(friendlyTool(tool)). Nothing was sent or submitted."
        return BlockedInfo(rule: rule, sentence: sentence, detail: detail, safeVersion: (safe?.isEmpty ?? true) ? nil : safe)
    }

    static func friendlyTool(_ tool: String) -> String {
        if tool.hasPrefix("mcp__") {
            let parts = tool.components(separatedBy: "__")
            let action = parts.last ?? ""
            if action.contains("navigate") || action.contains("open") { return "the page" }
            if parts.count >= 2 { return "the \(parts[1].replacingOccurrences(of: "-", with: " ")) step" }
            return "that step"
        }
        switch tool {
        case "WebFetch": return "the page fetch"
        case "Bash": return "the command"
        case "Write", "Edit": return "the file change"
        default: return "the \(tool) step"
        }
    }

    /// The needs-access skill's one sentence: "I need the Notion connector for that, connect it at …".
    static func accessInfo(in reply: String) -> AccessInfo? {
        let t = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = t.range(of: #"^I need (the |a |an |you to )?[^.]{1,80}?(connector|login|permission|key|access|MCP server|extension|to log in)\b"#,
                              options: [.regularExpression, .caseInsensitive]) else { return nil }
        // First sentence: ends at ". " or a newline, not at the dot in "claude.ai".
        let end = t.range(of: #"[.!?](\s|$)"#, options: .regularExpression)?.lowerBound ?? t.endIndex
        let first = String(t[..<end]).isEmpty ? String(t[m]) : String(t[..<end])
        var what = first
        var fix: String?
        if let comma = first.range(of: ", ") {
            what = String(first[..<comma.lowerBound]) + "."
            let rest = String(first[comma.upperBound...])
            fix = rest.prefix(1).uppercased() + rest.dropFirst() + "."
        } else {
            what += "."
            let tail = t.dropFirst(first.count).trimmingCharacters(in: CharacterSet(charactersIn: ". \n"))
            if !tail.isEmpty { fix = tail.hasSuffix(".") ? tail : tail + "." }
        }
        return AccessInfo(what: what, fix: fix)
    }

    static func host(in detail: String) -> String? {
        let candidate = detail.contains("://") ? detail : "https://\(detail)"
        guard let h = URL(string: candidate)?.host, h.contains(".") else { return nil }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }
}
