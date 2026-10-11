// The Settings window (menu-bar icon → Settings…): Jarvis's voice and a few
// read-only facts about the app.

import AppKit
import SwiftUI

struct SettingsView: View {
    @Bindable var voice: VoiceSettings
    let model: AppModel
    let socket: URL

    var body: some View {
        TabView {
            voiceTab.tabItem { Label("Voice", systemImage: "waveform") }
            generalTab.tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 460)
        .onAppear { NSApp.activate() } // agent app: bring the window to the front
    }

    private var voiceTab: some View {
        Form {
            Section {
                Picker("Style", selection: $voice.style) {
                    ForEach(VoiceSettings.Style.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                slider("Depth", value: $voice.values.semitones, in: -3...2, step: 0.25,
                       text: String(format: "%+.2f semitones", voice.values.semitones), help: "Lower is deeper.")
                slider("Pace", value: $voice.values.speed, in: 0.8...1.3, step: 0.02,
                       text: String(format: "%.2f×", voice.values.speed), help: "How quickly Jarvis speaks.")
                slider("AI effect", value: $voice.values.effect, in: 0...1, step: 0.05,
                       text: "\(Int(voice.values.effect * 100))%", help: "Presence, a small room and a faint sheen.")
            }
            Section("Voice blend") {
                slider("George", value: $voice.values.george, in: 0...1, step: 0.05, text: pct(voice.values.george), help: "Older, warm, RP")
                slider("Fable", value: $voice.values.fable, in: 0...1, step: 0.05, text: pct(voice.values.fable), help: "Smooth, younger")
                slider("Daniel", value: $voice.values.daniel, in: 0...1, step: 0.05, text: pct(voice.values.daniel), help: "Light, crisp")
                slider("Lewis", value: $voice.values.lewis, in: 0...1, step: 0.05, text: pct(voice.values.lewis), help: "Deep, rounded")
            }
            Section {
                HStack {
                    Button("Play sample") { voice.playSample(socket: socket) }
                        .keyboardShortcut(.defaultAction)
                    Button("Reset to Jarvis") { voice.resetToJarvis() }
                    Spacer()
                    Text(voice.status).foregroundStyle(.secondary).font(.callout)
                }
                Text("Changes apply from Jarvis's next sentence.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(.bottom, 8)
    }

    private var generalTab: some View {
        Form {
            LabeledContent("Push-to-talk", value: "Hold ⌥ Space")
            LabeledContent("Hover", value: "Rest the pointer on the notch for recent actions")
            LabeledContent("Speech recognition", value: speechStatus)
            LabeledContent("Voice engine", value: "Kokoro, on this Mac")
        }
        .formStyle(.grouped)
    }

    private var speechStatus: String {
        switch model.speechModel {
        case .notLoaded: "Not loaded"
        case let .loading(t): "\(t)…"
        case .ready: "WhisperKit small.en, on this Mac"
        case let .failed(m): "Failed: \(m)"
        }
    }

    private func pct(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

    private func slider(_ title: String, value: Binding<Double>, in range: ClosedRange<Double>, step: Double, text: String, help: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                Spacer()
                Text(text).monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: value, in: range, step: step)
            Text(help).font(.caption).foregroundStyle(.secondary)
        }
    }
}
