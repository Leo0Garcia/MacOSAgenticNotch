import Foundation
import Testing
@testable import Jarvis

@Suite struct ProtocolTests {
    @Test func decodesEveryClientMessage() throws {
        #expect(try NotchProtocol.decode(#"{"type":"hello","protocol":1,"token":"t","client":"bridge","pid":42,"session_id":null}"#)
            == .hello(protocol: 1, token: "t", client: .bridge, pid: 42, sessionId: nil))
        #expect(try NotchProtocol.decode(#"{"type":"speak_start","id":"1","text":"Hi","session_id":"s"}"#) == .speakStart(id: "1", text: "Hi", sessionId: "s"))
        #expect(try NotchProtocol.decode(#"{"type":"speak_end","id":"1"}"#) == .speakEnd(id: "1"))
        #expect(try NotchProtocol.decode(#"{"type":"notify","id":"n","title":"T","body":"B","session_id":null}"#) == .notify(id: "n", title: "T", body: "B", sessionId: nil))
        #expect(try NotchProtocol.decode(#"{"type":"ask","id":"q","question":"?","options":["a","b","c"],"timeout_ms":5000,"session_id":null}"#)
            == .ask(id: "q", question: "?", options: ["a", "b"], timeoutMs: 5000, sessionId: nil))
        #expect(try NotchProtocol.decode(#"{"type":"ask_cancel","id":"q","reason":"timeout"}"#) == .askCancel(id: "q", reason: "timeout"))
        #expect(try NotchProtocol.decode(#"{"type":"reminder","id":"r","text":"Call Sue"}"#) == .reminder(id: "r", text: "Call Sue"))
        #expect(try NotchProtocol.decode(#"{"type":"log","row":{"id":3,"ts":"2026-10-11T10:00:00Z","session_id":null,"kind":"run","summary":"x","detail":null,"saved":true}}"#)
            == .log(.init(id: 3, ts: "2026-10-11T10:00:00Z", session_id: nil, kind: "run", summary: "x", detail: nil, saved: true)))
        #expect(try NotchProtocol.decode(#"{"type":"run_event","session_id":"s","event":"denied","text":"no","rule":"no-money"}"#)
            == .runEvent(sessionId: "s", event: "denied", text: "no", keep: nil, summary: nil, rule: "no-money"))
        #expect(try NotchProtocol.decode(#"{"type":"something_new","x":1}"#) == .unknown(type: "something_new"))
    }

    @Test func rejectsBadFrames() {
        #expect(throws: NotchProtocol.DecodeError.notJSON) { try NotchProtocol.decode("nope") }
        #expect(throws: NotchProtocol.DecodeError.missingType) { try NotchProtocol.decode("{}") }
        #expect(throws: NotchProtocol.DecodeError.missingField("text")) { try NotchProtocol.decode(#"{"type":"reminder","id":"r"}"#) }
    }

    @Test func encodesAppMessages() {
        #expect(NotchProtocol.encode(.welcome) == #"{"protocol":1,"type":"welcome"}"#)
        #expect(NotchProtocol.encode(.answer(id: "q", text: "yes", via: .voice)) == #"{"id":"q","text":"yes","type":"answer","via":"voice"}"#)
        #expect(NotchProtocol.encode(.error(id: nil, message: "bad token")) == #"{"message":"bad token","type":"error"}"#)
    }

    @Test func parsesLauncherEvents() {
        #expect(LauncherEvent.parse(#"{"event":"state","state":"working","sessionId":"s"}"#) == .state("working", sessionId: "s"))
        #expect(LauncherEvent.parse(#"{"event":"speak","text":"Hi."}"#) == .speak("Hi."))
        #expect(LauncherEvent.parse(#"{"event":"status","text":"Reading BBC","detail":"bbc.co.uk"}"#) == .status(text: "Reading BBC", detail: "bbc.co.uk"))
        #expect(LauncherEvent.parse(#"{"event":"denied","tool":"WebFetch","rule":"no-money","reason":"guard:no-money: x"}"#) == .denied(tool: "WebFetch", rule: "no-money", reason: "guard:no-money: x"))
        #expect(LauncherEvent.parse(#"{"event":"done","sessionId":"s","keep":true,"summary":"S","reply":"R","name":"Jarvis: N"}"#)
            == .done(sessionId: "s", keep: true, summary: "S", reply: "R", name: "Jarvis: N"))
        #expect(LauncherEvent.parse(#"{"event":"error","message":"boom"}"#) == .error("boom"))
        #expect(LauncherEvent.parse(#"{"event":"ready","sessionId":"s"}"#) == .ready(sessionId: "s"))
        #expect(LauncherEvent.parse("not json") == nil)
        #expect(LauncherEvent.parse(#"{"event":"future"}"#) == nil)
    }

    @Test func lineSplitterHandlesPartialLines() {
        let l = LineSplitter()
        #expect(l.push(Data("{\"a\":1}\n{\"b\"".utf8)) == ["{\"a\":1}"])
        #expect(l.push(Data(":2}\n".utf8)) == ["{\"b\":2}"])
        #expect(l.push(Data("tail".utf8)).isEmpty)
        #expect(l.flush() == "tail")
    }

    @Test func transcriptAgreementAndCleanup() {
        #expect(VoicePipeline.commonPrefix(["What's", "the", "weather"], ["what's", "the", "whether", "in"]) == 2)
        #expect(VoicePipeline.commonPrefix([], ["a"]) == 0)
        #expect(WhisperTranscriber.clean(" [BLANK_AUDIO] ") == "")
        #expect(WhisperTranscriber.clean("Thank you.") == "")
        #expect(WhisperTranscriber.clean(" What's the weather in  Southampton? ") == "What's the weather in Southampton?")
    }

    @Test func elapsedFormats() {
        #expect(ElapsedText.format(3.2, .clock) == "0:03")
        #expect(ElapsedText.format(1.64, .tenths) == "1.6s")
        #expect(ElapsedText.format(1.64, .seconds) == "1s")
        #expect(ElapsedText.format(65, .seconds) == "1:05")
        #expect(ElapsedText.format(12.7, .seconds) == "12s")
    }

    @Test func spriteHasEyeHolesAndWalkFrames() {
        let g = Sprite.grid(.init())
        #expect(g[4][4] == 0 && g[4][9] == 0)
        #expect(g[2][2] == 1 && g[7][2] == 2)
        let walk1 = Sprite.grid(.init(legs: 1)), walk2 = Sprite.grid(.init(legs: 2))
        #expect(walk1[8] != walk2[8])
    }
}

@MainActor
@Suite(.serialized) struct NotchServerTests {
    private func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    final class Recorder: NotchServerDelegate {
        var messages: [(NotchProtocol.ClientMessage, Int)] = []
        var disconnects: [Int] = []
        func notchServer(_ server: NotchServer, received message: NotchProtocol.ClientMessage, from client: NotchServer.ClientID) {
            messages.append((message, client))
        }
        func notchServer(_ server: NotchServer, disconnected client: NotchServer.ClientID) { disconnects.append(client) }
    }

    private func connect(_ port: UInt16) -> URLSessionWebSocketTask {
        let t = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/")!)
        t.resume()
        return t
    }

    private func receiveText(_ t: URLSessionWebSocketTask) async throws -> String {
        switch try await t.receive() {
        case let .string(s): return s
        case let .data(d): return String(decoding: d, as: UTF8.self)
        @unknown default: return ""
        }
    }

    @Test func writesNotchFileAndAuthenticates() async throws {
        let dir = tempDir()
        let file = dir.appendingPathComponent("notch.json")
        let server = NotchServer(notchFile: file)
        let rec = Recorder()
        server.delegate = rec
        let port = try await server.start()

        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let nf = try JSONDecoder().decode(NotchProtocol.File.self, from: Data(contentsOf: file))
        #expect(nf.port == Int(port))
        #expect(nf.protocol == 1)
        #expect(nf.token.count == 64)
        #expect(nf.pid == ProcessInfo.processInfo.processIdentifier)

        // Wrong token: error, then closed.
        let bad = connect(port)
        try await bad.send(.string(#"{"type":"hello","protocol":1,"token":"nope","client":"cli","pid":1,"session_id":null}"#))
        #expect(try await receiveText(bad).contains("bad token"))

        // A frame before hello is refused too.
        let early = connect(port)
        try await early.send(.string(#"{"type":"reminder","id":"r","text":"x"}"#))
        #expect(try await receiveText(early).contains("hello"))

        // Right token: welcome, then messages reach the delegate; answers come back.
        let good = connect(port)
        try await good.send(.string(#"{"type":"hello","protocol":1,"token":"\#(nf.token)","client":"bridge","pid":1,"session_id":"s"}"#))
        #expect(try await receiveText(good) == #"{"protocol":1,"type":"welcome"}"#)
        try await good.send(.string(#"{"type":"ask","id":"q1","question":"Which?","options":["A"],"timeout_ms":5000,"session_id":"s"}"#))
        for _ in 0..<50 where rec.messages.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        let (msg, client) = try #require(rec.messages.first)
        #expect(msg == .ask(id: "q1", question: "Which?", options: ["A"], timeoutMs: 5000, sessionId: "s"))
        #expect(server.kind(of: client) == .bridge)
        server.send(.answer(id: "q1", text: "A", via: .button), to: client)
        #expect(try await receiveText(good) == #"{"id":"q1","text":"A","type":"answer","via":"button"}"#)

        good.cancel(with: .normalClosure, reason: nil)
        for _ in 0..<50 where rec.disconnects.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        #expect(rec.disconnects == [client])

        server.stop()
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func launcherRunsScriptAndStreamsEvents() async throws {
        let repo = tempDir()
        let launcherDir = repo.appendingPathComponent("launcher")
        try FileManager.default.createDirectory(at: launcherDir, withIntermediateDirectories: true)
        // A stand-in run.sh that prints launcher NDJSON (no model call).
        let script = """
        #!/bin/sh
        [ "$1" = run ] || exit 64
        printf '%s\\n' '{"event":"state","state":"working","sessionId":"s1"}'
        printf '%s\\n' "{\\"event\\":\\"speak\\",\\"text\\":\\"You said $2.\\"}"
        printf '%s' '{"event":"done","sessionId":"s1","keep":false,"summary":"S","reply":"R"}'
        exit 0
        """
        try script.write(to: launcherDir.appendingPathComponent("run.sh"), atomically: true, encoding: .utf8)
        let launcher = Launcher(paths: Paths(home: repo.appendingPathComponent("home"), repo: repo))
        launcher.keepWarm = false
        var events: [LauncherEvent] = []
        var code: Int32?
        try launcher.run("hello", onEvent: { events.append($0) }, exited: { code = $0 })
        for _ in 0..<100 where code == nil { try await Task.sleep(for: .milliseconds(20)) }
        #expect(code == 0)
        #expect(events == [
            .state("working", sessionId: "s1"),
            .speak("You said hello."),
            .done(sessionId: "s1", keep: false, summary: "S", reply: "R", name: nil),
        ])
    }

    @Test func missingLauncherThrows() {
        let launcher = Launcher(paths: Paths(home: tempDir(), repo: tempDir()))
        #expect(throws: LauncherError.self) { try launcher.run("x", onEvent: { _ in }, exited: { _ in }) }
    }
}

@Suite struct CalendarProtocolTests {
    @Test func decodesTheRequestAndEncodesTheResult() throws {
        #expect(try NotchProtocol.decode(#"{"type":"calendar_events","id":"c1","from":"2026-10-12T00:00:00Z","to":"2026-10-13T00:00:00Z"}"#)
            == .calendarEvents(id: "c1", from: "2026-10-12T00:00:00Z", to: "2026-10-13T00:00:00Z"))
        let out = NotchProtocol.encode(.calendarEventsResult(id: "c1", events: [
            .init(calendar: "Personal", title: "Dentist", start: "2026-10-12T14:30:00.000Z", end: "2026-10-12T15:00:00.000Z", allDay: false, location: nil),
        ]))
        let obj = try #require(try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])
        #expect(obj["type"] as? String == "calendar_events_result")
        let ev = try #require((obj["events"] as? [[String: Any]])?.first)
        #expect(ev["title"] as? String == "Dentist")
        #expect(ev["allDay"] as? Bool == false)
        #expect(ev["location"] is NSNull)
        let err = NotchProtocol.encode(.calendarEventsError(id: "c1", code: "denied", message: "off"))
        #expect(err.contains(#""code":"denied""#))
    }

    @Test func parsesBothISOForms() {
        #expect(CalendarService.date("2026-10-12T00:00:00Z") != nil)
        #expect(CalendarService.date("2026-10-12T00:00:00.000Z") != nil)
        #expect(CalendarService.date("tomorrow") == nil)
    }
}

@MainActor
@Suite struct VoiceSettingsTests {
    private func file() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).json")
    }

    @Test func presetsFillTheSlidersAndMovingOneMakesItCustom() async throws {
        let f = file()
        let v = VoiceSettings(file: f)
        #expect(v.style == .jarvis)
        v.style = .deeper
        #expect(v.values.semitones == -1)
        v.values.semitones = -1.5
        #expect(v.style == .custom)
        v.save()
        let d = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: f)) as? [String: Any])
        #expect(d["custom"] as? Bool == true)
        #expect(d["semitones"] as? Double == -1.5)
        #expect((d["blend"] as? [String: Double])?["bm_lewis"] == 0.4)
        // A fresh window reads it back.
        let again = VoiceSettings(file: f)
        #expect(again.style == .custom)
        #expect(again.values.semitones == -1.5)
        again.resetToJarvis()
        #expect(again.values == VoiceSettings.presets[.jarvis])
    }
}


@MainActor
@Suite(.serialized) struct WarmRunTests {
    @Test func aWarmRunTakesTheNextRequestOnStdin() async throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-warm-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("launcher"), withIntermediateDirectories: true)
        // Stand-in run.sh: "warm" says ready, reads one line, echoes it back as speech.
        let script = """
        #!/bin/sh
        if [ "$1" = warm ]; then
          printf '%s\\n' '{"event":"ready","sessionId":"w1"}'
          read -r req || exit 0
          printf '{"event":"speak","text":"warm: %s"}\\n' "$req"
          exit 0
        fi
        printf '{"event":"speak","text":"cold: %s"}\\n' "$2"
        """
        try script.write(to: repo.appendingPathComponent("launcher/run.sh"), atomically: true, encoding: .utf8)
        let launcher = Launcher(paths: Paths(home: repo.appendingPathComponent("home"), repo: repo))
        launcher.prepareWarm()
        try await Task.sleep(for: .milliseconds(400))
        var events: [LauncherEvent] = []
        var code: Int32?
        try launcher.run("what's the time", onEvent: { events.append($0) }, exited: { code = $0 })
        for _ in 0..<100 where code == nil { try await Task.sleep(for: .milliseconds(20)) }
        launcher.keepWarm = false
        launcher.cancelAll()
        #expect(events == [.speak("warm: what's the time")])
        #expect(code == 0)
    }
}

@Suite struct ComputerContextTests {
    @Test func screenshotOnlyForRequestsAboutTheScreen() {
        #expect(ComputerContext.isAboutScreen("summarise this page"))
        #expect(ComputerContext.isAboutScreen("what's on my screen"))
        #expect(ComputerContext.isAboutScreen("reply to the email I'm looking at"))
        #expect(!ComputerContext.isAboutScreen("what's the weather in Southampton"))
        #expect(!ComputerContext.isAboutScreen("add buy chalk to my Kanban"))
    }
}
