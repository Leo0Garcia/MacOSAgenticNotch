// The notch's colours (Leo, 2026-10-22: "the green and blue is nice but I'd
// love to be able to change it in the settings"). A palette sets the rim and
// accents for listening, working and done; needs-you and reminders stay amber
// and yellow so they always read as "look at me".

import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class Appearance {
    static let shared = Appearance()
    static let paletteKey = "AppearancePalette"
    static let customKey = "AppearanceCustom"

    struct Palette: Identifiable, Equatable {
        var id: String
        var name: String
        var listening: [UInt32]
        var working: [UInt32]
        var done: [UInt32]

        /// Three picked colours spread across the three states.
        static func from(_ c: [UInt32]) -> Palette {
            Palette(id: "custom", name: "Custom", listening: [c[0], c[1], c[0]], working: [c[1], c[2], c[0]], done: [c[2], c[0], c[1]])
        }
    }

    static let presets: [Palette] = [
        Palette(id: "aurora", name: "Aurora", listening: [0x5AC8FA, 0x7D7AFF, 0x64D2FF], working: [0x7D7AFF, 0xBF5AF2, 0x5AC8FA], done: [0x30D158, 0x63E6BE, 0x5AC8FA]),
        Palette(id: "ocean", name: "Ocean", listening: [0x64D2FF, 0x0A84FF, 0x5AC8FA], working: [0x0A84FF, 0x5E5CE6, 0x64D2FF], done: [0x40C8E0, 0x64D2FF, 0x0A84FF]),
        Palette(id: "sunset", name: "Sunset", listening: [0xFF7A59, 0xFF375F, 0xFFB86B], working: [0xFF375F, 0xBF5AF2, 0xFF7A59], done: [0xFFB86B, 0xFF7A59, 0xFF375F]),
        Palette(id: "forest", name: "Forest", listening: [0x63E6BE, 0x30D158, 0xA3E635], working: [0x30D158, 0x2DD4BF, 0x63E6BE], done: [0xA3E635, 0x30D158, 0x63E6BE]),
        Palette(id: "mono", name: "Mono", listening: [0xE5E7EB, 0x9AA4B2, 0xFFFFFF], working: [0x9AA4B2, 0x6B7280, 0xE5E7EB], done: [0xFFFFFF, 0xC7CCD4, 0x9AA4B2]),
    ]

    var paletteID: String { didSet { UserDefaults.standard.set(paletteID, forKey: Self.paletteKey) } }
    /// The three custom colours, as 0xRRGGBB.
    var custom: [UInt32] { didSet { UserDefaults.standard.set(custom.map { String(format: "%06X", $0) }, forKey: Self.customKey) } }

    init(defaults: UserDefaults = .standard) {
        paletteID = defaults.string(forKey: Self.paletteKey) ?? "aurora"
        let saved = (defaults.stringArray(forKey: Self.customKey) ?? []).compactMap { UInt32($0, radix: 16) }
        custom = saved.count == 3 ? saved : [0x5AC8FA, 0x7D7AFF, 0x30D158]
    }

    var palette: Palette {
        paletteID == "custom" ? .from(custom) : Self.presets.first { $0.id == paletteID } ?? Self.presets[0]
    }

    static func hex(_ c: Color) -> UInt32 {
        let n = NSColor(c).usingColorSpace(.sRGB) ?? .white
        func b(_ x: CGFloat) -> UInt32 { UInt32((max(0, min(1, x)) * 255).rounded()) }
        return b(n.redComponent) << 16 | b(n.greenComponent) << 8 | b(n.blueComponent)
    }
}

/// Settings › Appearance: preset palettes and three custom colours.
struct AppearanceTab: View {
    @Bindable var appearance = Appearance.shared

    var body: some View {
        Form {
            Section("Colours") {
                Picker("Palette", selection: $appearance.paletteID) {
                    ForEach(Appearance.presets) { Text($0.name).tag($0.id) }
                    Text("Custom").tag("custom")
                }
                ForEach(["Listening", "Working", "Done"], id: \.self) { state in
                    LabeledContent(state) { swatch(state) }
                }
            }
            if appearance.paletteID == "custom" {
                Section("Custom colours") {
                    ForEach(0..<3, id: \.self) { i in
                        ColorPicker(["First", "Second", "Third"][i], selection: Binding(
                            get: { Color(hex: appearance.custom[i]) },
                            set: { appearance.custom[i] = Appearance.hex($0) }), supportsOpacity: false)
                    }
                    Text("The three colours turn round the rim; each state leads with a different one.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("Needs-you stays amber and reminders stay yellow, so they always stand out.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }

    private func swatch(_ state: String) -> some View {
        let p = appearance.palette
        let cs = (state == "Listening" ? p.listening : state == "Working" ? p.working : p.done).map { Color(hex: $0) }
        return Capsule()
            .fill(LinearGradient(colors: cs, startPoint: .leading, endPoint: .trailing))
            .frame(width: 120, height: 10)
            .accessibilityLabel("\(state) colours")
    }
}
