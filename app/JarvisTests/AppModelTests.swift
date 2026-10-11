import Foundation
import Testing
@testable import Jarvis

@MainActor
@Suite struct AppModelTests {
    @Test func hotkeyOpensListeningExpanded() {
        let (m, _, _, v) = makeModel()
        m.hotkeyDown()
        #expect(m.panel == .listening)
        #expect(m.size == .expanded)
        #expect(v.started == 1)
    }

    @Test func micProblemShowsInListeningAndReleaseHides() {
        let (m, _, l, v) = makeModel()
        v.failWith = AudioCaptureError.micDenied
        m.hotkeyDown()
        #expect(m.listenProblem?.contains("microphone") == true)
        m.hotkeyUp()
        #expect(m.panel == .idle)
        #expect(m.size == .hidden)
        #expect(l.requests.isEmpty)
    }

    @Test func spokenRequestGoesToLauncherAndWorkingCollapsesAfter3s() {
        let (m, s, l, _) = makeModel()
        m.hotkeyDown()
        m.listeningFinished("what's the weather in Southampton")
        #expect(l.requests == ["what's the weather in Southampton"])
        #expect(m.panel == .working)
        #expect(m.size == .expanded)
        s.advance(2.9)
        #expect(m.size == .expanded)
        s.advance(0.2)
        #expect(m.size == .compact)
        #expect(m.panel == .working)
    }

    @Test func emptyTranscriptSaysDidntCatchThat() {
        let (m, s, l, _) = makeModel()
        m.hotkeyDown()
        m.listeningFinished("  ")
        #expect(l.requests.isEmpty)
        #expect(m.panel == .notice(title: "I didn't catch that.", body: ""))
        s.advance(4.1)
        #expect(m.size == .hidden)
    }

    @Test func doneHoldsWhileSpeakingThenPillThenHides() {
        let (m, s, l, _) = makeModel()
        m.submit("weather")
        l.emit(.state("working", sessionId: "s1"))
        s.advance(1)
        m.speechStarted(id: "a", text: "It's 14 degrees and cloudy.")
        #expect(m.panel == .done)
        #expect(m.size == .expanded)
        #expect(m.run?.firstWordAt == s.now)
        l.emit(.done(sessionId: "s1", keep: false, summary: "Weather", reply: "It's 14 degrees and cloudy.", name: nil))
        l.exit(0)
        // Still speaking: nothing collapses, even past the 6 s watchdog.
        s.advance(8)
        #expect(m.size == .expanded)
        m.speechEnded(id: "a")
        s.advance(1.7)
        #expect(m.size == .expanded)
        s.advance(0.2)
        #expect(m.size == .compact)
        s.advance(1.5)
        #expect(m.size == .hidden)
        #expect(m.panel == .idle)
        #expect(m.run == nil)
    }

    @Test func savedRunHolds4sAndOpensInDesktop() {
        let (m, s, l, _) = makeModel()
        m.submit("start a research session on rents")
        m.speechStarted(id: "a", text: "Started.")
        l.emit(.done(sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", keep: true, summary: "Research: rents", reply: "Started.", name: "Jarvis: Research: rents"))
        l.exit(0)
        m.speechEnded(id: "a")
        #expect(m.run?.savedLabel == "Research: rents")
        s.advance(3.9)
        #expect(m.size == .expanded)
        m.openSavedRun()
        #expect(l.opened == ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])
        s.advance(0.2)
        #expect(m.size == .compact)
    }

    @Test func replyWithoutSocketSpeechStillShowsCaption() {
        let (m, s, l, _) = makeModel()
        m.submit("hi")
        l.emit(.speak("Hello Leo."))
        s.advance(0.31)
        #expect(m.panel == .done)
        #expect(m.run?.captions.map(\.text) == ["Hello Leo."])
    }

    @Test func socketSpeechWinsOverStdoutSpeech() {
        let (m, s, l, _) = makeModel()
        m.submit("hi")
        l.emit(.speak("Hello Leo."))
        m.speechStarted(id: "123-1", text: "Hello Leo.")
        s.advance(0.5)
        #expect(m.run?.captions.count == 1)
    }

    @Test func statusLinesCoalesceTo350ms() {
        let (m, s, l, _) = makeModel()
        m.submit("weather")
        l.emit(.status(text: "Searching the web", detail: "weather"))
        l.emit(.status(text: "Reading BBC Weather", detail: "bbc.co.uk/weather"))
        l.emit(.status(text: "Reading Met Office", detail: "www.metoffice.gov.uk/x"))
        #expect(m.run?.status == "Searching the web")
        s.advance(0.36)
        #expect(m.run?.status == "Reading Met Office")
        #expect(m.run?.steps.map(\.text) == ["Searching the web", "Reading Met Office"])
        #expect(m.run?.steps.first?.duration != nil)
        #expect(m.run?.hosts == ["bbc.co.uk", "metoffice.gov.uk"])
    }

    @Test func guardDenialEndsInBlockedWithSafeVersion() {
        let (m, s, l, _) = makeModel()
        var notified: [String] = []
        m.postNotification = { t, _ in notified.append(t) }
        m.submit("pay my tuition")
        l.emit(.denied(tool: "WebFetch", rule: "no-real-consequences",
                       reason: "guard:no-real-consequences: tuition fee payment is for Leo to do himself. Safe alternative: a reminder to pay it at 6pm"))
        l.emit(.state("needs-you", sessionId: "s"))
        l.exit(0)
        guard case let .blocked(b) = m.panel else { Issue.record("expected blocked, got \(m.panel)"); return }
        #expect(b.rule == "no-real-consequences")
        #expect(b.sentence == "I can't do that: tuition fee payment is for Leo to do himself.")
        #expect(b.safeVersion == "a reminder to pay it at 6pm")
        #expect(notified == ["Jarvis is blocked"])
        // Needs you stays until resolved; after 20 s idle it drops to the pill.
        s.advance(19)
        #expect(m.size == .expanded)
        s.advance(1.1)
        #expect(m.size == .compact)
        #expect(m.panel.isNeedsYou)
        m.hoverChanged(true)
        s.advance(0.31)
        #expect(m.size == .expanded)
        m.doSafeVersion()
        #expect(l.requests.last == "And also, do the safe version instead: a reminder to pay it at 6pm")
    }

    @Test func needsAccessReplyShowsAccessPanel() {
        let (m, _, l, _) = makeModel()
        m.submit("check my Notion")
        l.emit(.done(sessionId: "s", keep: false, summary: "", reply: "I need the Notion connector for that, connect it at claude.ai/customize/connectors and ask again.", name: nil))
        l.exit(0)
        guard case let .access(a) = m.panel else { Issue.record("expected access, got \(m.panel)"); return }
        #expect(a.what == "I need the Notion connector for that.")
        #expect(a.fix == "Connect it at claude.ai/customize/connectors and ask again.")
        m.dismiss()
        #expect(m.size == .hidden)
    }

    @Test func ordinaryReplyIsNotAccess() {
        #expect(AppModel.accessInfo(in: "It's 14 degrees and cloudy in Southampton.") == nil)
        #expect(AppModel.accessInfo(in: "I need to check one thing first.") == nil)
    }

    @Test func askAnsweredByButtonSendsAnswerToItsClient() {
        let (m, _, _, _) = makeModel()
        var sent: [(Int, NotchProtocol.AppMessage)] = []
        m.sendToClient = { sent.append(($0, $1)) }
        m.received(.ask(id: "q1", question: "Which lane?", options: ["In-progress", "Not Started"], timeoutMs: 60000, sessionId: nil), from: 7)
        #expect(m.panel.isNeedsYou)
        m.answerButton("Not Started")
        #expect(sent.count == 1)
        #expect(sent.first?.0 == 7)
        #expect(sent.first?.1 == .answer(id: "q1", text: "Not Started", via: .button))
        #expect(m.size == .hidden)
    }

    @Test func askAnsweredByVoice() {
        let (m, _, l, _) = makeModel()
        var sent: [NotchProtocol.AppMessage] = []
        m.sendToClient = { sent.append($1) }
        m.received(.ask(id: "q1", question: "Which lane?", options: [], timeoutMs: 60000, sessionId: nil), from: 1)
        m.hotkeyDown()
        m.listeningFinished("in progress please")
        #expect(sent == [.answer(id: "q1", text: "in progress please", via: .voice)])
        #expect(l.requests.isEmpty)
    }

    @Test func askCancelAndDisconnectDropTheQuestion() {
        let (m, _, _, _) = makeModel()
        m.received(.ask(id: "q1", question: "?", options: [], timeoutMs: 60000, sessionId: nil), from: 1)
        m.received(.askCancel(id: "q1", reason: "timeout"), from: 1)
        #expect(m.panel == .idle)
        m.received(.ask(id: "q2", question: "?", options: [], timeoutMs: 60000, sessionId: nil), from: 2)
        m.clientDisconnected(2)
        #expect(m.panel == .idle)
    }

    @Test func askDuringRunReturnsToWorkingPill() {
        let (m, _, _, _) = makeModel()
        m.sendToClient = { _, _ in }
        m.submit("add buy chalk to my Kanban")
        m.received(.ask(id: "q", question: "Which lane?", options: ["A", "B"], timeoutMs: 60000, sessionId: nil), from: 1)
        m.answerButton("A")
        #expect(m.panel == .working)
        #expect(m.size == .compact)
    }

    @Test func reminderExpands5sThenPillThenHides() {
        let (m, s, _, _) = makeModel()
        m.received(.reminder(id: "r", text: "Call Sue"), from: 1)
        guard case .reminder = m.panel else { Issue.record("expected reminder"); return }
        #expect(m.size == .expanded)
        s.advance(5.1)
        #expect(m.size == .compact)
        s.advance(60)
        #expect(m.size == .hidden)
    }

    @Test func reminderWaitsForNeedsYou() {
        let (m, _, _, _) = makeModel()
        m.sendToClient = { _, _ in }
        m.received(.ask(id: "q", question: "?", options: ["Yes"], timeoutMs: 60000, sessionId: nil), from: 1)
        m.received(.reminder(id: "r", text: "Call Sue"), from: 2)
        #expect(m.panel.isNeedsYou)
        m.answerButton("Yes")
        guard case .reminder = m.panel else { Issue.record("expected reminder next, got \(m.panel)"); return }
    }

    @Test func secondRequestDropsFirstRunsEvents() {
        let (m, _, l, _) = makeModel()
        m.submit("first")
        m.submit("second")
        l.emit(.status(text: "From the first run", detail: nil), run: 0)
        #expect(m.run?.request == "second")
        #expect(m.run?.steps.isEmpty == true)
        l.exit(0, run: 0)
        #expect(m.runActive)
    }

    @Test func failedRunShowsNotice() {
        let (m, s, l, _) = makeModel()
        m.submit("x")
        l.emit(.error("guard isn't installed"))
        l.exit(1)
        #expect(m.panel == .notice(title: "Something went wrong", body: "guard isn't installed"))
        s.advance(4.1)
        #expect(m.size == .hidden)
    }

    @Test func escapeCollapsesWorkingToPill() {
        let (m, _, _, _) = makeModel()
        m.submit("x")
        m.collapseOrHide()
        #expect(m.size == .compact)
    }

    @Test func expandMotionWhenGrowingCollapseWhenShrinking() {
        let (m, s, _, _) = makeModel()
        m.hotkeyDown()
        #expect(m.motion == .expand)
        m.listeningFinished("x")
        s.advance(3.1)
        #expect(m.motion == .collapse)
    }

    @Test func runFromTerminalShowsViaRunEvents() {
        let (m, _, _, _) = makeModel()
        m.received(.runEvent(sessionId: "s", event: "started", text: "hello", keep: nil, summary: nil, rule: nil), from: 1)
        #expect(m.panel == .working)
        #expect(m.size == .compact)
        m.received(.runEvent(sessionId: "s", event: "done", text: nil, keep: false, summary: "", rule: nil), from: 1)
        #expect(m.size == .hidden)
    }
}
