// Hands-free: "Jarvis, what's the weather" in one breath. While enabled, the
// mic stays on and a simple speech detector watches the level; only when
// someone speaks does WhisperKit (already loaded for push-to-talk) check
// the start of what was said for the wake word. Audio never leaves the Mac
// and nothing is kept: the stream is dropped as it is read.
//
// The wake word is any word or short phrase (Settings → General); matching
// tolerates Whisper's small spelling slips ("Jarvis," "Jarviss").

import Foundation

/// The wake word and how to find and strip it in a transcript.
struct WakePhrase: Equatable, Sendable {
    let words: [String]

    init(_ phrase: String) {
        words = WakePhrase.normalize(phrase)
    }

    var isEmpty: Bool { words.isEmpty }

    static func normalize(_ s: String) -> [String] {
        s.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    /// Where the wake phrase ends in `text` (index of the first word after it),
    /// if it appears within the first few words (an optional "hey"/"ok" first).
    func match(in text: String) -> Int? {
        let t = WakePhrase.normalize(text)
        guard !words.isEmpty, t.count >= words.count else { return nil }
        for start in 0...min(2, t.count - words.count) {
            if zip(words, t[start..<(start + words.count)]).allSatisfy({ WakePhrase.close($0, $1) }) {
                return start + words.count
            }
        }
        return nil
    }

    /// The request after the wake phrase: "Jarvis, what's the weather?" → "what's the weather?"
    func strip(_ text: String) -> String {
        guard let n = match(in: text), n > 0 else { return text }
        // Word ranges in the original text, split the same way as normalize().
        var ranges: [Range<String.Index>] = []
        var start: String.Index?
        for i in text.indices {
            let isWord = text[i].unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) }
            if isWord, start == nil { start = i }
            if !isWord, let s = start { ranges.append(s..<i); start = nil }
        }
        if let s = start { ranges.append(s..<text.endIndex) }
        guard ranges.count >= n else { return "" }
        // Drop the punctuation right after the wake word ("Jarvis, …"), keep the rest as said.
        let rest = text[ranges[n - 1].upperBound...].drop { " ,.!?:;-\n\t".contains($0) }
        return String(rest).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Same word, allowing one slip in words of five letters or more.
    static func close(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        guard a.count >= 5, abs(a.count - b.count) <= 1 else { return false }
        return distance(Array(a), Array(b)) <= 1
    }

    static func distance(_ a: [Character], _ b: [Character]) -> Int {
        var prev = Array(0...b.count)
        for i in 1...max(1, a.count) where !a.isEmpty {
            var cur = [i] + Array(repeating: 0, count: b.count)
            for j in 1...max(1, b.count) where !b.isEmpty {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            prev = cur
        }
        return prev[b.count]
    }
}

/// Speech detection on 16 kHz audio: an adaptive noise floor and a level
/// threshold, in 100 ms frames. Pure, so it can be tested with numbers.
struct SpeechGate {
    static let frame = 1600 // 100 ms at 16 kHz
    private(set) var noise: Float = 0.004
    private(set) var speaking = false
    private(set) var silentFrames = 0
    private(set) var speechFrames = 0

    enum Event: Equatable { case none, started, continuing, ended }

    /// Feeds one 100 ms frame's RMS. `endAfter` frames of quiet end the speech.
    mutating func feed(rms: Float, endAfter: Int) -> Event {
        let loud = rms > max(noise * 4, 0.01)
        if !speaking {
            // Track the room's level only while nobody is talking.
            noise = noise * 0.95 + min(rms, 0.05) * 0.05
            guard loud else { return .none }
            speaking = true
            speechFrames = 1
            silentFrames = 0
            return .started
        }
        if loud {
            silentFrames = 0
            speechFrames += 1
        } else {
            silentFrames += 1
            if silentFrames >= endAfter {
                speaking = false
                return .ended
            }
        }
        return .continuing
    }

    static func rms(_ s: ArraySlice<Float>) -> Float {
        guard !s.isEmpty else { return 0 }
        return (s.reduce(0) { $0 + $1 * $1 } / Float(s.count)).squareRoot()
    }
}

@MainActor
final class WakeListener {
    private let capture: AudioCapture
    private let transcriber: SpeechTranscribing
    private weak var model: AppModel?
    private var timer: Timer?
    private var gate = SpeechGate()
    private var pending: [Float] = []        // < 1 frame left over
    private var preroll: [Float] = []        // the last 0.5 s before speech started
    private var segment: [Float] = []        // the utterance so far
    private var checking = false
    private var rejected = false             // this utterance didn't start with the wake word
    private var triggered = false            // we're in a hands-free capture
    private var framesSinceTrigger = 0
    private var spokeAfterTrigger = false    // "Jarvis… what's the weather": a pause after the name is fine
    private var lastCheckAt = 0
    private(set) var phrase: WakePhrase
    private(set) var enabled = false

    /// Seconds of quiet that end a hands-free request.
    static let endSilence = 0.9
    /// Check for the wake word once this much speech is in, then every 0.5 s up to 2.5 s.
    static let firstCheck = 0.7, maxCheck = 2.5

    init(capture: AudioCapture, transcriber: SpeechTranscribing, model: AppModel, phrase: String) {
        self.capture = capture
        self.transcriber = transcriber
        self.model = model
        self.phrase = WakePhrase(phrase)
    }

    func setPhrase(_ p: String) {
        phrase = WakePhrase(p)
        model?.wakePhrase = p
    }

    func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        if on {
            guard AudioCapture.permission == .authorized else {
                AppLog.write("wake word needs microphone access first")
                return
            }
            do {
                try capture.startStreaming()
            } catch {
                AppLog.write("wake word couldn't start the mic: \(error.localizedDescription)")
                return
            }
            enabled = true
            reset()
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            AppLog.write("listening for the wake word")
        } else {
            enabled = false
            timer?.invalidate()
            timer = nil
            capture.stopStreaming()
            reset()
        }
    }

    private func reset() {
        gate = SpeechGate()
        pending = []
        preroll = []
        segment = []
        rejected = false
        checking = false
        triggered = false
    }

    private func tick() {
        guard enabled, let model else { return }
        pending += capture.stream.drain()
        // Push-to-talk, Jarvis speaking or the panel listening: don't listen
        // for the wake word (and never hear Jarvis say its own name).
        let busy = model.panel == .listening && !triggered || model.speaking || model.isTranscribing
        while pending.count >= SpeechGate.frame {
            let frame = Array(pending.prefix(SpeechGate.frame))
            pending.removeFirst(SpeechGate.frame)
            if busy { gate = SpeechGate(); segment = []; rejected = false; continue }
            handle(frame)
        }
    }

    /// `defaults write com.jarvis.notch WakeDebug -bool YES` logs what the detector does.
    private let debug = UserDefaults.standard.bool(forKey: "WakeDebug")
    private var frames = 0

    private func handle(_ frame: [Float]) {
        let endAfter = Int(Self.endSilence * 10)
        let rms = SpeechGate.rms(frame[...])
        let event = gate.feed(rms: rms, endAfter: triggered ? endAfter : 6)
        frames += 1
        if debug, event != .none || frames % 50 == 0 {
            AppLog.write(String(format: "wake: %@ rms %.4f noise %.4f", "\(event)", rms, gate.noise))
        }
        switch event {
        case .none:
            preroll = Array((preroll + frame).suffix(Int(AudioCapture.sampleRate / 2)))
        case .started:
            if triggered { spokeAfterTrigger = true; return }
            segment = preroll + frame
            rejected = false
            lastCheckAt = 0
        case .continuing:
            if triggered {
                framesSinceTrigger += 1
                if framesSinceTrigger > 6 { spokeAfterTrigger = true } // kept talking past the name
                return // the capture buffer has it
            }
            segment += frame
            maybeCheck()
        case .ended:
            if triggered, !spokeAfterTrigger { return } // waiting for the request after "Jarvis,"
            finishTrigger()
            segment = []
            rejected = false
            preroll = []
        }
        // Said only the name and then nothing for 4 s: give up quietly.
        if triggered, !gate.speaking {
            framesSinceTrigger += 1
            if framesSinceTrigger > 40 { finishTrigger() }
        }
    }

    private func finishTrigger() {
        guard triggered else { return }
        triggered = false
        model?.wakeEnded()
    }

    private func maybeCheck() {
        let secs = Double(segment.count) / AudioCapture.sampleRate
        guard !rejected, !checking, secs >= Self.firstCheck else { return }
        if secs > Self.maxCheck { rejected = true; return }
        guard segment.count - lastCheckAt >= Int(AudioCapture.sampleRate / 2) || lastCheckAt == 0 else { return }
        lastCheckAt = segment.count
        checking = true
        // A little silence in front helps Whisper keep the first word.
        let audio = [Float](repeating: 0, count: Int(AudioCapture.sampleRate * 0.3)) + segment
        let prompt = phrase.words.joined(separator: " ").capitalized + ","
        Task { [weak self] in
            let text = (try? await self?.transcriber.transcribe(audio, prompt: prompt)) ?? ""
            guard let self else { return }
            if self.debug { AppLog.write("wake: heard \"\(text)\"") }
            self.checking = false
            guard self.enabled, !self.triggered, self.gate.speaking else { return }
            if let end = self.phrase.match(in: text) {
                self.triggered = true
                self.framesSinceTrigger = 0
                // Words already said after the name count as the request starting.
                self.spokeAfterTrigger = WakePhrase.normalize(text).count > end
                AppLog.write("wake word heard")
                self.model?.wakeTriggered(preroll: self.segment)
            } else if WakePhrase.normalize(text).count >= self.phrase.words.count + 2 {
                self.rejected = true // a sentence that doesn't start with the wake word
            }
        }
    }
}
