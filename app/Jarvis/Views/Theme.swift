// Design tokens from NOTCH-DESIGN.md sections 1, 3, 4 and 6 (Large layout).

import SwiftUI

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}

enum Theme {
    // Section 1, Large layout.
    static let expandedWidth: CGFloat = 520
    static let maxHeight: CGFloat = 360
    static let topRadius: CGFloat = 12
    static let bottomRadius: CGFloat = 28
    static let wing: CGFloat = 52
    /// DynamicNotchKit insets the expanded content 15 pt on the sides and bottom.
    static let dnkInset: CGFloat = 15
    static let bodyPadding = EdgeInsets(top: 12, leading: 22 - dnkInset, bottom: 22 - dnkInset, trailing: 22 - dnkInset)
    /// Width our expanded view lays out at, so the visible shape is 520 wide.
    static var contentWidth: CGFloat { expandedWidth - 2 * dnkInset }
    static let characterColumn: CGFloat = 56
    static let columnGap: CGFloat = 18

    // Section 4.
    static let body = Font.system(size: 19, weight: .medium)
    static let bodyLine: CGFloat = 25 - 19
    static let request = Font.system(size: 13, weight: .regular)
    static let label = Font.system(size: 11.5, weight: .semibold)
    static let wingFont = Font.system(size: 12.5, weight: .medium).monospacedDigit()
    static let sub = Font.system(size: 14, weight: .regular)
    static let step = Font.system(size: 13, weight: .regular)
    static let button = Font.system(size: 13, weight: .medium)

    static let bodyColor = Color(hex: 0xD97757)
    static let shadeColor = Color(hex: 0xB8613F)
    static let success = Color(hex: 0x30D158)
    static let attention = Color(hex: 0xFF9F0A)
    static let attentionText = Color(hex: 0xFFB340)
    static let reminder = Color(hex: 0xFFD60A)
    static let recording = Color(hex: 0xFF453A)
    static let primaryButtonText = Color(hex: 0xFFC266)
    static let savedText = Color(hex: 0x7FD1FF)

    /// Section 6: rim colours and the time for one turn, per state.
    static func rim(_ kind: StateKind) -> (colors: [Color], period: Double, opacity: Double, glow: Double) {
        switch kind {
        case .idle: ([.white, .gray, .white], 4, 0, 0)
        case .listening: ([Color(hex: 0x5AC8FA), Color(hex: 0x7D7AFF), Color(hex: 0x64D2FF)], 3, 0.95, 0.35)
        case .working: ([Color(hex: 0x7D7AFF), Color(hex: 0xBF5AF2), Color(hex: 0x5AC8FA)], 1.5, 0.95, 0.4)
        case .done: ([Color(hex: 0x30D158), Color(hex: 0x63E6BE), Color(hex: 0x5AC8FA)], 5, 0.8, 0.3)
        case .needs: ([Color(hex: 0xFF9F0A), Color(hex: 0xFF6B3D), Color(hex: 0xFFD60A)], 2.4, 0.95, 0.45)
        case .reminder: ([Color(hex: 0xFFD60A), Color(hex: 0xFF9F0A), Color(hex: 0xFFF3B0)], 3, 0.9, 0.3)
        case .notice: ([Color(hex: 0x9AA4B2), Color(hex: 0x4B5563), Color(hex: 0xE5E7EB)], 8, 0.4, 0)
        }
    }

    static func stateName(_ kind: StateKind, saved: Bool = false) -> String {
        switch kind {
        case .idle: ""
        case .listening: "Listening"
        case .working: "Working"
        case .done: saved ? "Saved" : "Done"
        case .needs: "Needs you"
        case .reminder: "Reminder"
        case .notice: "Jarvis"
        }
    }
}

/// Section 3 motion tokens.
enum MotionToken {
    static let expand = Animation.spring(response: 0.42, dampingFraction: 0.8)
    static let collapse = Animation.spring(response: 0.34, dampingFraction: 1)
    static let contentIn = Animation.easeOut(duration: 0.24).delay(0.04)
    static let contentOut = Animation.easeIn(duration: 0.11)
    static let wordIn = Animation.easeOut(duration: 0.18)
    static let reduced = Animation.easeInOut(duration: 0.16)

    static func spring(_ m: Motion, reduceMotion: Bool) -> Animation {
        if reduceMotion { return reduced }
        return m == .expand ? expand : collapse
    }
}

/// Blur + fade + small drop, for content arriving and leaving (contentIn/contentOut).
struct BlurFade: ViewModifier {
    var progress: Double // 1 = hidden, 0 = shown
    var blur: CGFloat = 6
    var dy: CGFloat = -4

    func body(content: Content) -> some View {
        content
            .opacity(1 - progress)
            .blur(radius: blur * progress)
            .offset(y: dy * progress)
            .scaleEffect(1 - 0.02 * progress, anchor: .top)
    }
}

extension AnyTransition {
    /// contentIn on insertion, contentOut on removal.
    static func content(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity.animation(MotionToken.reduced) }
        return .asymmetric(
            insertion: .modifier(active: BlurFade(progress: 1), identity: BlurFade(progress: 0)).animation(MotionToken.contentIn),
            removal: .modifier(active: BlurFade(progress: 1, blur: 4, dy: 0), identity: BlurFade(progress: 0, blur: 4, dy: 0)).animation(MotionToken.contentOut))
    }
}

/// 30 pt capsules (Large layout); the primary one is amber.
struct NotchButtonStyle: ButtonStyle {
    var primary = false
    @State private var hover = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.button)
            .foregroundStyle(primary ? Theme.primaryButtonText : .white)
            .padding(.horizontal, 15)
            .frame(height: 30)
            .background(
                Capsule().fill(primary
                    ? Theme.attention.opacity(hover || configuration.isPressed ? 0.34 : 0.24)
                    : Color.white.opacity(hover || configuration.isPressed ? 0.2 : 0.12)))
            .contentShape(Capsule())
            .onHover { hover = $0 }
    }
}
