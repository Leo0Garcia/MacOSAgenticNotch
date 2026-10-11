// Aurora (NOTCH-DESIGN section 6): a 1.5 pt band of turning light round the
// sides and bottom of the shape, a soft glow inside the bottom edge, mic and
// speaking bars, and the shimmer on the Working status line. Everything here
// draws in a Canvas under a TimelineView that pauses when not visible.

import SwiftUI

/// The notch outline without its top edge, matching DynamicNotchKit's NotchShape.
struct NotchRimPath: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { .init(topRadius, bottomRadius) }
        set { topRadius = newValue.first; bottomRadius = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let t = topRadius, b = bottomRadius
        p.move(to: CGPoint(x: rect.minX + t, y: rect.minY + t))
        p.addLine(to: CGPoint(x: rect.minX + t, y: rect.maxY - b))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t + b, y: rect.maxY), control: CGPoint(x: rect.minX + t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t - b, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - t, y: rect.maxY - b), control: CGPoint(x: rect.maxX - t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t, y: rect.minY + t))
        return p
    }
}

struct AuroraRim: View {
    var kind: StateKind
    var topRadius: CGFloat
    var bottomRadius: CGFloat
    var visible: Bool
    var showGlow = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let rim = Theme.rim(kind)
        ZStack {
            if showGlow, rim.glow > 0 {
                // Static: the glow never redraws per frame.
                GeometryReader { geo in
                    Ellipse()
                        .fill(RadialGradient(colors: [rim.colors[1], .clear], center: .center, startRadius: 0, endRadius: geo.size.width * 0.42))
                        .frame(width: geo.size.width * 0.84, height: 60)
                        .position(x: geo.size.width / 2, y: geo.size.height + 4)
                        .blur(radius: 12)
                        .opacity(rim.glow)
                }
                .drawingGroup()
            }
            RimLayer(colors: rim.colors, period: rim.period, opacity: rim.opacity, pulse: kind == .needs,
                     topRadius: topRadius, bottomRadius: bottomRadius, animating: visible && !reduceMotion)
        }
        .allowsHitTesting(false)
        .animation(.easeInOut(duration: 0.4), value: kind)
    }
}

/// The turning band of light, run entirely by Core Animation: a conic
/// gradient rotating under a stroked mask. The app does no per-frame work.
struct RimLayer: NSViewRepresentable {
    var colors: [Color]
    var period: Double
    var opacity: Double
    var pulse: Bool
    var topRadius: CGFloat
    var bottomRadius: CGFloat
    var animating: Bool

    func makeNSView(context: Context) -> RimNSView { RimNSView() }

    func updateNSView(_ v: RimNSView, context: Context) {
        v.topRadius = topRadius
        v.bottomRadius = bottomRadius
        v.configure(colors: colors.map { NSColor($0).cgColor }, period: period, opacity: Float(opacity), pulse: pulse, animating: animating)
    }
}

final class RimNSView: NSView {
    var topRadius: CGFloat = 12 { didSet { if topRadius != oldValue { needsLayout = true } } }
    var bottomRadius: CGFloat = 28 { didSet { if bottomRadius != oldValue { needsLayout = true } } }
    private let container = CALayer()
    private let gradient = CAGradientLayer()
    private let mask = CAShapeLayer()
    private var period: Double = 0
    private var animating = false
    private var pulse = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(container)
        gradient.type = .conic
        gradient.startPoint = CGPoint(x: 0.5, y: 0.5)
        gradient.endPoint = CGPoint(x: 0.5, y: 0)
        container.addSublayer(gradient)
        mask.fillColor = nil
        mask.strokeColor = NSColor.black.cgColor
        mask.lineWidth = 3 // centred on the shape's edge, so 1.5 pt shows inside
        mask.lineCap = .round
        mask.lineJoin = .round
        container.mask = mask
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.frame = bounds
        mask.frame = bounds
        mask.path = NotchRimPath(topRadius: topRadius, bottomRadius: bottomRadius).path(in: bounds).cgPath
        let side = hypot(bounds.width, bounds.height)
        gradient.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        gradient.position = CGPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
    }

    func configure(colors: [CGColor], period: Double, opacity: Float, pulse: Bool, animating: Bool) {
        let cs = colors + [colors[0]]
        if (gradient.colors as? [CGColor]) != cs {
            gradient.colors = cs // implicit 0.25 s crossfade between states
        }
        container.opacity = opacity
        if period != self.period || animating != self.animating {
            self.period = period
            self.animating = animating
            gradient.removeAnimation(forKey: "spin")
            if animating {
                let spin = CABasicAnimation(keyPath: "transform.rotation.z")
                spin.fromValue = 0
                spin.toValue = 2 * Double.pi
                spin.duration = period
                spin.repeatCount = .infinity
                gradient.add(spin, forKey: "spin")
            }
        }
        if pulse != self.pulse || (pulse && container.animation(forKey: "pulse") == nil && animating) {
            self.pulse = pulse
            container.removeAnimation(forKey: "pulse")
            if pulse, animating {
                // Needs you: opacity pulses on `attention` (1.2 s).
                let a = CABasicAnimation(keyPath: "opacity")
                a.fromValue = opacity
                a.toValue = opacity * 0.45
                a.duration = 0.6
                a.autoreverses = true
                a.repeatCount = .infinity
                a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                container.add(a, forKey: "pulse")
            }
        }
        if !animating { container.removeAnimation(forKey: "pulse") }
    }
}

/// Mic level meter (Listening) and speaking bars (Done).
struct LevelBars: View {
    enum Style { case mic, speaking }

    var style: Style
    var count: Int
    var barWidth: CGFloat
    var gap: CGFloat
    var height: CGFloat
    var colors: [Color]
    var level: AudioLevel?
    var active: Bool
    var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var smoothed = BarState()

    final class BarState {
        var values: [Double] = []
    }

    var body: some View {
        let width = CGFloat(count) * barWidth + CGFloat(count - 1) * gap
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !visible || reduceMotion)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Canvas(rendersAsynchronously: false) { gc, size in
                if smoothed.values.count != count { smoothed.values = Array(repeating: 0, count: count) }
                let base: Double = {
                    if reduceMotion { return 0.3 }
                    switch style {
                    case .mic: return active ? Double(level?.current ?? 0) : 0.06
                    case .speaking: return active ? 0.3 + 0.6 * abs(sin(t * 5.3) * sin(t * 2.1 + 0.4)) : 0.05
                    }
                }()
                let gradient = Gradient(colors: colors.count > 1 ? Array(colors.prefix(2)) : [.white, .white])
                let shading = GraphicsContext.Shading.linearGradient(gradient, startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0))
                for i in 0..<count {
                    let wobble = 0.55 + 0.45 * sin(t * (7 + Double(i)) + Double(i) * 1.3)
                    let target = max(0, base * wobble)
                    smoothed.values[i] += (target - smoothed.values[i]) * 0.25
                    let h = max(barWidth, 3 + (size.height - 3) * min(1, smoothed.values[i]))
                    let x = CGFloat(i) * (barWidth + gap)
                    let r = CGRect(x: x, y: (size.height - h) / 2, width: barWidth, height: h)
                    gc.fill(Path(roundedRect: r, cornerRadius: barWidth / 2), with: shading)
                }
            }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}

/// The Working status line: a highlight band sweeping left to right every 1.6 s.
struct ShimmerText: View {
    var text: String
    var font: Font
    var visible: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(.white.opacity(reduceMotion ? 1 : 0.5))
            .overlay {
                if !reduceMotion {
                    TimelineView(.animation(paused: !visible)) { ctx in
                        let p = (ctx.date.timeIntervalSinceReferenceDate / 1.6).truncatingRemainder(dividingBy: 1)
                        GeometryReader { geo in
                            LinearGradient(
                                stops: [
                                    .init(color: .clear, location: 0),
                                    .init(color: Color(hex: 0xE4DBFF), location: 0.42),
                                    .init(color: .white, location: 0.5),
                                    .init(color: .clear, location: 1),
                                ],
                                startPoint: .leading, endPoint: .trailing)
                            .frame(width: geo.size.width * 0.6)
                            .offset(x: -geo.size.width * 0.6 + (geo.size.width * 1.6) * p)
                        }
                        .mask(Text(text).font(font))
                    }
                }
            }
            .lineLimit(1)
    }
}
