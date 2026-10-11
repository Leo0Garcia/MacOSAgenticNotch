// Push-to-talk: capture while the hotkey is held, re-transcribe the growing
// buffer about twice a second for the live transcript, and transcribe once
// more on release for the request. Words both passes agree on are confirmed;
// the rest show at 45% white (section 2).

import AVFoundation
import Foundation

@MainActor
final class VoicePipeline: VoiceInput {
    private let capture: AudioCapture
    private let transcriber: SpeechTranscribing
    private weak var model: AppModel?
    private var loop: Task<Void, Never>?
    private var previous: [String] = []
    private var ready = false
    private var simulating = false

    /// Live updates while held; at least this many seconds apart.
    static let liveInterval: Double = 0.45
    /// Below this much audio there is nothing to transcribe.
    static let minSamples = Int(AudioCapture.sampleRate * 0.3)

    var level: AudioLevel { capture.level }

    init(capture: AudioCapture, transcriber: SpeechTranscribing, model: AppModel) {
        self.capture = capture
        self.transcriber = transcriber
        self.model = model
    }

    /// Loads the model at launch so the first press is fast.
    func prepare() {
        model?.speechModel = .loading("Loading the speech model")
        let model = self.model
        Task {
            do {
                try await transcriber.prepare { text in
                    Task { @MainActor in
                        if case .loading = model?.speechModel { model?.speechModel = .loading(text) }
                    }
                }
                ready = true
                model?.speechModel = .ready
                AppLog.write("speech model ready")
            } catch {
                model?.speechModel = .failed(error.localizedDescription)
                AppLog.write("speech model failed: \(error.localizedDescription)")
            }
        }
    }

    func start() throws {
        if case let .failed(message) = model?.speechModel {
            throw NSError(domain: "Jarvis", code: 1, userInfo: [NSLocalizedDescriptionKey: "The speech model didn't load: \(message)"])
        }
        if AudioCapture.permission == .notDetermined, !simulating {
            throw NSError(domain: "Jarvis", code: 2, userInfo: [NSLocalizedDescriptionKey: "Allow microphone access in the macOS dialog, then hold the hotkey again."])
        }
        if !simulating { try capture.start() }
        previous = []
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.liveInterval))
                guard let self, !Task.isCancelled, self.ready else { continue }
                let samples = self.capture.buffer.snapshot()
                guard samples.count >= Self.minSamples else { continue }
                guard let text = try? await self.transcriber.transcribe(samples), !Task.isCancelled else { continue }
                self.publish(text)
            }
        }
    }

    func finish() async -> String {
        loop?.cancel()
        loop = nil
        let samples = simulating ? capture.buffer.snapshot() : capture.stop()
        simulating = false
        guard samples.count >= Self.minSamples else { return "" }
        if !ready {
            // First press before the model finished loading: wait for it.
            while case .loading = model?.speechModel { try? await Task.sleep(for: .milliseconds(100)) }
        }
        let t0 = Date()
        guard let text = try? await transcriber.transcribe(samples) else { return "" }
        AppLog.write(String(format: "final transcription of %.1fs audio took %.0f ms", Double(samples.count) / AudioCapture.sampleRate, Date().timeIntervalSince(t0) * 1000))
        publish(text)
        return text
    }

    /// Plays an audio file through the same path as the mic, in real time:
    /// Listening with live words, then the request. For testing without a mic.
    func simulate(file: URL) async {
        guard let samples = try? Self.loadSamples(file) else {
            AppLog.write("couldn't read audio file \(file.path)")
            return
        }
        simulating = true
        capture.buffer.reset()
        model?.hotkeyDown()
        let chunk = Int(AudioCapture.sampleRate / 20)
        var i = 0
        while i < samples.count {
            let slice = Array(samples[i..<min(i + chunk, samples.count)])
            capture.buffer.append(slice)
            let rms = (slice.reduce(0) { $0 + $1 * $1 } / Float(max(1, slice.count))).squareRoot()
            capture.level.set(min(1, max(0, (20 * log10(max(rms, 1e-5)) + 55) / 40)))
            i += chunk
            try? await Task.sleep(for: .milliseconds(50))
        }
        capture.level.set(0)
        model?.hotkeyUp()
    }

    static func loadSamples(_ url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        guard let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioCapture.sampleRate, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: file.processingFormat, to: out),
              let inBuf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
        else { return [] }
        try file.read(into: inBuf)
        let cap = AVAudioFrameCount(Double(inBuf.frameLength) * AudioCapture.sampleRate / file.processingFormat.sampleRate + 1024)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return [] }
        let source = UncheckedBox(inBuf)
        let fed = UncheckedBox(FlagBox())
        var err: NSError?
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed.value.set { status.pointee = .endOfStream; return nil }
            fed.value.set = true
            status.pointee = .haveData
            return source.value
        }
        if let err { throw err }
        guard let ch = outBuf.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: ch, count: Int(outBuf.frameLength)))
    }

    func cancel() {
        loop?.cancel()
        loop = nil
        _ = capture.stop()
    }

    private func publish(_ text: String) {
        let words = text.split(separator: " ").map(String.init)
        let agreed = Self.commonPrefix(previous, words)
        previous = words
        model?.updateTranscript(Transcript(
            confirmed: words.prefix(agreed).joined(separator: " "),
            hypothesis: words.dropFirst(agreed).joined(separator: " ")))
    }

    /// How many leading words two passes agree on (ignoring case and punctuation).
    nonisolated static func commonPrefix(_ a: [String], _ b: [String]) -> Int {
        func norm(_ s: String) -> String { s.lowercased().trimmingCharacters(in: .punctuationCharacters) }
        var n = 0
        while n < a.count, n < b.count, norm(a[n]) == norm(b[n]) { n += 1 }
        return n
    }
}

final class FlagBox: @unchecked Sendable {
    var set = false
}
