// Voice settings for Jarvis's Kokoro voice, saved to ~/Jarvis/state/voice.json.
// tts/voice.py reads the same file (load_settings) and re-reads it whenever it
// changes, so a change applies from the next sentence. The presets mirror
// PRESETS in tts/voice.py; keep the two in step.

import Foundation
import Observation

@MainActor
@Observable
final class VoiceSettings {
    enum Style: String, CaseIterable, Identifiable {
        case jarvis, natural, deeper, custom
        var id: String { rawValue }
        var label: String {
            switch self {
            case .jarvis: "Jarvis"
            case .natural: "Natural"
            case .deeper: "Deeper"
            case .custom: "Custom"
            }
        }
    }

    struct Values: Equatable {
        var george: Double
        var fable: Double
        var daniel: Double
        var lewis: Double
        var speed: Double
        var semitones: Double
        var effect: Double
    }

    static let presets: [Style: Values] = [
        .jarvis: Values(george: 0.55, fable: 0.25, daniel: 0.1, lewis: 0.1, speed: 1.04, semitones: -0.75, effect: 1),
        .natural: Values(george: 0.55, fable: 0.3, daniel: 0.15, lewis: 0, speed: 1, semitones: 0, effect: 0),
        .deeper: Values(george: 0.6, fable: 0, daniel: 0, lewis: 0.4, speed: 1, semitones: -1, effect: 1),
    ]

    var style: Style = .jarvis {
        didSet { if style != .custom, let v = Self.presets[style] { applying(v) } }
    }
    var values: Values = VoiceSettings.presets[.jarvis]! {
        didSet {
            guard !applyingPreset else { return }
            if style != .custom, Self.presets[style] != values { style = .custom }
            scheduleSave()
        }
    }
    private(set) var status = ""

    @ObservationIgnored private let file: URL
    @ObservationIgnored private var applyingPreset = false
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    init(file: URL) {
        self.file = file
        load()
    }

    private func applying(_ v: Values) {
        applyingPreset = true
        values = v
        applyingPreset = false
        scheduleSave()
    }

    func resetToJarvis() { style = .jarvis }

    // MARK: - File

    var json: [String: Any] {
        [
            "preset": style.rawValue,
            "custom": style == .custom,
            "blend": ["bm_george": values.george, "bm_fable": values.fable, "bm_daniel": values.daniel, "bm_lewis": values.lewis],
            "speed": values.speed,
            "semitones": values.semitones,
            "effect": values.effect,
        ]
    }

    func load() {
        guard let data = try? Data(contentsOf: file),
              let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        applyingPreset = true
        defer { applyingPreset = false }
        let blend = d["blend"] as? [String: Double] ?? [:]
        let base = Self.presets[.jarvis]!
        values = Values(
            george: blend["bm_george"] ?? 0, fable: blend["bm_fable"] ?? 0, daniel: blend["bm_daniel"] ?? 0,
            lewis: blend["bm_lewis"] ?? 0, speed: d["speed"] as? Double ?? base.speed,
            semitones: d["semitones"] as? Double ?? base.semitones, effect: d["effect"] as? Double ?? base.effect)
        if (d["custom"] as? Bool) == true {
            style = .custom
        } else if let s = (d["preset"] as? String).flatMap(Style.init(rawValue:)) {
            style = s
            if let v = Self.presets[s] { values = v }
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    func save() {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) else { return }
        do {
            try writeAtomically(data, to: file, mode: 0o644)
        } catch {
            status = "Couldn't save: \(error.localizedDescription)"
        }
    }

    // MARK: - Sample

    static let sampleLine = "Good evening, sir. It's twelve degrees in Southampton, with light rain expected later."

    /// Renders the current (possibly unsaved) values through the speech server and plays them.
    func playSample(socket: URL) {
        status = "Rendering…"
        var settings = json
        settings["custom"] = true
        let body: [String: Any] = ["text": Self.sampleLine, "settings": settings]
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("jarvis-sample-\(UUID().uuidString).wav")
        Task.detached {
            let ok = Self.run("/usr/bin/curl", ["-sf", "--max-time", "20", "--unix-socket", socket.path, "-H", "content-type: application/json",
                                                "--data-binary", "@-", "-o", out.path, "http://localhost/render"], stdin: payload)
            await MainActor.run { self.status = ok ? "" : "The voice server isn't running. Restart Jarvis, then try again." }
            guard ok else { return }
            _ = Self.run("/usr/bin/afplay", [out.path], stdin: nil)
            try? FileManager.default.removeItem(at: out)
        }
    }

    nonisolated private static func run(_ exe: String, _ args: [String], stdin: Data?) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let input = Pipe()
        if stdin != nil { p.standardInput = input }
        do { try p.run() } catch { return false }
        if let stdin {
            input.fileHandleForWriting.write(stdin)
            try? input.fileHandleForWriting.close()
        }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
