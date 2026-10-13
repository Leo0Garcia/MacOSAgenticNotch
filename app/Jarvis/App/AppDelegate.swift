// Wires the pieces together at launch: notch socket, launcher, hotkey, voice
// pipeline, notch controller.
//
// Launch arguments (for testing without the mic):
//   --request "<text>"     send a typed request as if spoken
//   --audio-file <path>    play an audio file through transcription as if spoken
//   --demo                 cycle through every state with canned content
//   --snapshots <dir>      render each state to PNG and quit

import AppKit
import AVFoundation
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let paths = Paths.current()
    lazy var model = AppModel(scheduler: LiveScheduler())
    lazy var voiceSettings = VoiceSettings(file: paths.home.appendingPathComponent("state/voice.json"))
    var speechSocket: URL { paths.home.appendingPathComponent("run/tts.sock") }
    private(set) var env: NotchEnvironment!
    private var controller: NotchController?
    private var server: NotchServer?
    private var launcher: Launcher?
    private var hotkeys: HotKeyCenter?
    private var escapeID: UInt32?
    private var voice: VoicePipeline?
    private var wake: WakeListener?
    private var defaultsObserver: NSObjectProtocol?

    /// Settings > General. Defaults: off (Leo prefers ⌥ Space), "Jarvis".
    static let wakeEnabledKey = "WakeWordEnabled"
    static let wakeWordKey = "WakeWord"
    private let notifier = SystemNotifier()
    private let calendar = CalendarService()
    private var notificationsRequested = false
    private var demo: DemoDriver?
    private var signalSources: [DispatchSourceSignal] = []

    static var isUnitTesting: Bool { ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !Self.isUnitTesting else { return }
        if let i = CommandLine.arguments.firstIndex(of: "--snapshots"), i + 1 < CommandLine.arguments.count {
            Snapshots.render(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
            exit(0)
        }
        AppLog.configure(paths)
        AppLog.write("Jarvis app starting (repo \(paths.repo.path))")

        let capture = AudioCapture()
        env = NotchEnvironment(level: capture.level)

        let launcher = Launcher(paths: paths)
        self.launcher = launcher
        model.launcher = launcher
        env.snooze = { text, minutes in launcher.snooze(text: text, minutes: minutes) }
        model.postNotification = { [weak self] title, body in self?.notify(title: title, body: body) }
        model.announce = { [weak self] text in self?.notifier.announce(text) }
        let context = ComputerContext(paths: paths)
        model.captureContext = { context.capture() }
        model.willSubmit = { context.write(for: $0) }
        let actions = paths.home.appendingPathComponent("actions.sqlite")
        model.loadRecent = { ActionsStore.newest(8, file: actions) }

        let transcriber = WhisperTranscriber(downloadBase: paths.models)
        let voice = VoicePipeline(capture: capture, transcriber: transcriber, model: model)
        self.voice = voice
        model.voice = voice
        UserDefaults.standard.register(defaults: [Self.wakeEnabledKey: false, Self.wakeWordKey: "Jarvis"])
        let phrase = UserDefaults.standard.string(forKey: Self.wakeWordKey) ?? "Jarvis"
        model.wakePhrase = phrase
        wake = WakeListener(capture: capture, transcriber: transcriber, model: model, phrase: phrase)

        // SIGTERM/SIGINT (launchd, kill) still go through terminate, so notch.json is removed.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { NSApp.terminate(nil) }
            src.resume()
            signalSources.append(src)
        }
        controller = NotchController(model: model, env: env)
        Snapshots.warmUp(env: env)
        startServer()
        registerHotkeys()

        let args = CommandLine.arguments
        if args.contains("--demo") || args.contains("--demo-working") {
            demo = DemoDriver(model: model)
            if args.contains("--demo-working") { demo?.startWorking() } else { demo?.start() }
            return
        }
        voice.prepare()
        startSpeechServer()
        // A warm run, so the first request doesn't pay Claude Code's start-up.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { launcher.prepareWarm() }
        observeWakeSettings()
        if let i = args.firstIndex(of: "--request"), i + 1 < args.count {
            let request = args[i + 1]
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                self.model.submit(request)
            }
        }
        if let i = args.firstIndex(of: "--audio-file"), i + 1 < args.count {
            let url = URL(fileURLWithPath: args[i + 1])
            Task { @MainActor in
                // Wait for the model so the simulated press behaves like a real one.
                while case .loading = self.model.speechModel { try? await Task.sleep(for: .milliseconds(200)) }
                try? await Task.sleep(for: .seconds(0.5))
                await voice.simulate(file: url)
            }
        }
        observeEscape()
    }

    /// jarvis://listen — for a Shortcut Siri can run ("Hey Siri, Jarvis"):
    /// Jarvis listens for one request, mic on only for that request.
    /// jarvis://ask?q=<text> sends text straight in.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "jarvis" {
            switch url.host {
            case "listen":
                AppLog.write("listening (from \(url.absoluteString))")
                wake?.listenNow()
            case "ask":
                let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value ?? ""
                if !q.trimmingCharacters(in: .whitespaces).isEmpty { model.submit(q) }
            default:
                break
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.stop()
        launcher?.cancelAll()
    }

    /// Starts wake-word listening once the speech model is loaded and the mic
    /// is allowed, and follows changes made in Settings.
    private func observeWakeSettings() {
        Task { @MainActor in
            // Hands-free needs the mic; ask now rather than waiting for a key press.
            if UserDefaults.standard.bool(forKey: Self.wakeEnabledKey), AudioCapture.permission == .notDetermined {
                let granted = await AudioCapture.requestPermission()
                AppLog.write("microphone \(granted ? "allowed" : "denied") (for the wake word)")
            }
            while true {
                if case .ready = model.speechModel, AudioCapture.permission == .authorized { break }
                if case .failed = model.speechModel { return }
                try? await Task.sleep(for: .seconds(1))
            }
            applyWakeSettings()
        }
        defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.applyWakeSettings() }
        }
    }

    private func applyWakeSettings() {
        guard let wake, case .ready = model.speechModel else { return }
        let d = UserDefaults.standard
        let phrase = (d.string(forKey: Self.wakeWordKey) ?? "Jarvis").trimmingCharacters(in: .whitespaces)
        if phrase != model.wakePhrase { wake.setPhrase(phrase) }
        wake.setEnabled(d.bool(forKey: Self.wakeEnabledKey) && !WakePhrase(phrase).isEmpty)
    }

    /// Jarvis's voice (tts/server.py, Kokoro) kept warm so the first reply isn't slow.
    /// Skipped when Kokoro isn't installed; speech then falls back to `say`.
    private func startSpeechServer() {
        let python = paths.home.appendingPathComponent("tts/.venv/bin/python")
        let script = paths.repo.appendingPathComponent("tts/server.py")
        guard FileManager.default.isExecutableFile(atPath: python.path), FileManager.default.fileExists(atPath: script.path),
              ProcessInfo.processInfo.environment["JARVIS_TTS"] != "say" else { return }
        let p = Process()
        p.executableURL = python
        p.arguments = [script.path]
        var env = ProcessInfo.processInfo.environment
        env["JARVIS_HOME"] = paths.home.path
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":") // ffmpeg
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { AppLog.write("speech server didn't start: \(error.localizedDescription)") }
    }

    private func startServer() {
        let server = NotchServer(notchFile: paths.notchFile)
        server.delegate = self
        self.server = server
        model.sendToClient = { [weak server] id, msg in server?.send(msg, to: id) }
        Task {
            do {
                _ = try await server.start()
            } catch {
                AppLog.write("notch socket failed: \(error.localizedDescription)")
            }
        }
    }

    private func registerHotkeys() {
        let hk = HotKeyCenter()
        hotkeys = hk
        let ok = hk.register(.optionSpace, onPress: { [weak self] in self?.pushToTalkDown() }, onRelease: { [weak self] in self?.model.hotkeyUp() })
        env.hotkeyLabel = HotKeyCenter.Combo.optionSpace.label
        if ok == nil {
            AppLog.write("⌥ Space is taken by another app")
            model.postNotification?("Jarvis", "⌥ Space is already used by another app, so push-to-talk is off.")
        }
    }

    private func pushToTalkDown() {
        // First press: macOS asks for the mic. Leo triggers this himself.
        if AudioCapture.permission == .notDetermined {
            Task {
                let granted = await AudioCapture.requestPermission()
                AppLog.write("microphone \(granted ? "allowed" : "denied")")
            }
            model.hotkeyDown() // shows the listening panel with the problem text
            return
        }
        model.hotkeyDown()
    }

    /// Esc is registered only while a dismissable panel is expanded.
    private func observeEscape() {
        withObservationTracking {
            _ = model.size
            _ = model.panel
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateEscape()
                self.observeEscape()
            }
        }
    }

    private func updateEscape() {
        let want = model.size == .expanded && model.panel != .listening && model.panel != .idle
        if want, escapeID == nil {
            escapeID = hotkeys?.register(.escape, onPress: { [weak self] in
                guard let self else { return }
                switch self.model.panel {
                case .access, .blocked, .reminder, .notice: self.model.dismiss()
                default: self.model.collapseOrHide()
                }
            })
        } else if !want, let id = escapeID {
            hotkeys?.unregister(id)
            escapeID = nil
        }
    }

    private func notify(title: String, body: String) {
        if !notificationsRequested {
            notificationsRequested = true
            notifier.requestAuthorization()
        }
        notifier.post(title: title, body: body)
    }
}

extension AppDelegate: NotchServerDelegate {
    func notchServer(_ server: NotchServer, received message: NotchProtocol.ClientMessage, from client: NotchServer.ClientID) {
        if case let .calendarEvents(id, from, to) = message {
            Task {
                switch await calendar.events(fromISO: from, toISO: to) {
                case let .success(events): server.send(.calendarEventsResult(id: id, events: events), to: client)
                case .failure(.badRange): server.send(.calendarEventsError(id: id, code: "bad_range", message: "from and to must be ISO 8601, from before to."), to: client)
                case let .failure(f): server.send(.calendarEventsError(id: id, code: f.code, message: f.message), to: client)
                }
            }
            return
        }
        if case let .calendarAdd(id, event) = message {
            Task {
                switch await calendar.add(event) {
                case let .success(name): server.send(.calendarAddResult(id: id, calendar: name), to: client)
                case let .failure(f): server.send(.calendarAddError(id: id, code: f.code, message: f.message), to: client)
                }
            }
            return
        }
        model.received(message, from: client)
    }

    func notchServer(_ server: NotchServer, disconnected client: NotchServer.ClientID) {
        model.clientDisconnected(client)
    }
}
