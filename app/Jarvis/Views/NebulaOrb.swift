// The notch's Nebula orb (NOTCH-DESIGN section 6): a small native cousin of
// the dashboard's orb (Dashboard/Orb/orb.html). A soft core glow and a few
// hundred particles in three shells, pre-rendered once per state and turned,
// breathed and pulsed by Core Animation, so the app does no per-frame work.
// Only Listening polls the mic level, at 15 Hz.

import AppKit
import SwiftUI

enum Nebula {
    /// What the orb shows: the dashboard orb's state and colours, plus its motion.
    struct Look: Equatable {
        var state: String
        var colors: [UInt32]
        var energy: Double
        var speed: Double
    }

    /// orb.html's STATES table.
    static let motion: [String: (energy: Double, speed: Double)] = [
        "idle": (0.2, 0.35), "listening": (0.45, 0.6), "working": (0.7, 1.15),
        "speaking": (0.55, 0.8), "needs": (0.5, 0.6),
    ]

    @MainActor
    static func look(_ kind: StateKind, speaking: Bool, palette: Appearance.Palette = Appearance.shared.palette) -> Look {
        let s = OrbState.make(kind: kind, speaking: speaking, runActive: kind == .working, mic: 0, voice: 0, cards: [], palette: palette)
        let m = motion[s.state] ?? motion["idle"]!
        return Look(state: s.state, colors: s.colors.compactMap { UInt32($0.dropFirst(), radix: 16) }, energy: m.energy, speed: m.speed)
    }

    struct Particle { var x, y, z, size, mix: Double }

    static let radii = [0.72, 0.95, 1.18]
    /// Unit-sphere particles per shell, the same every launch (seeded).
    static let shells: [[Particle]] = {
        var rng = SplitMix(seed: 0x4E42_554C)
        return radii.enumerated().map { i, R in
            (0..<[130, 110, 90][i]).map { _ in
                let u = rng.next() * 2 - 1, th = rng.next() * 2 * .pi, r = (1 - u * u).squareRoot()
                let rr = R * (0.96 + rng.next() * 0.08)
                return Particle(x: cos(th) * r * rr, y: u * rr, z: sin(th) * r * rr, size: rng.next(), mix: rng.next())
            }
        }
    }()

    struct SplitMix {
        var seed: UInt64
        mutating func next() -> Double {
            seed &+= 0x9E37_79B9_7F4A_7C15
            var z = seed
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
        }
    }

    static func cg(_ c: UInt32, _ a: Double = 1) -> CGColor {
        CGColor(srgbRed: CGFloat((c >> 16) & 0xFF) / 255, green: CGFloat((c >> 8) & 0xFF) / 255, blue: CGFloat(c & 0xFF) / 255, alpha: a)
    }

    static func mixWhite(_ c: UInt32, _ t: Double) -> UInt32 {
        func ch(_ s: UInt32) -> UInt32 { let v = Double((c >> s) & 0xFF); return UInt32(v + (255 - v) * t) << s }
        return ch(16) | ch(8) | ch(0)
    }

    private static func context(_ px: Int) -> CGContext? {
        CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    }

    /// One shell's particles, front ones brighter; about 22% take the second colour.
    static func shellImage(_ shell: Int, look: Look, diameter: CGFloat, scale: CGFloat) -> CGImage? {
        let px = Int((diameter * scale).rounded())
        guard let gc = context(px) else { return nil }
        let unit = CGFloat(px) / 2 / 1.32, c = CGFloat(px) / 2
        let a = look.colors.first ?? 0xFFFFFF, b = look.colors.dropFirst().first ?? a
        let dot = max(0.3, diameter * 0.011) * scale
        for p in shells[shell] {
            let alpha = (0.25 + 0.75 * (p.z / radii[shell] + 1) / 2) * (0.55 + 0.45 * p.size)
            gc.setFillColor(cg(mixWhite(p.mix > 0.78 ? b : a, 0.25), alpha))
            let r = dot * (0.6 + 0.9 * p.size)
            gc.fillEllipse(in: CGRect(x: c + CGFloat(p.x) * unit - r, y: c + CGFloat(p.y) * unit - r, width: 2 * r, height: 2 * r))
        }
        return gc.makeImage()
    }

    /// The core: white at the centre, the state colour around it, fading out.
    static func coreImage(look: Look, diameter: CGFloat, scale: CGFloat) -> CGImage? {
        let px = Int((diameter * scale).rounded())
        guard let gc = context(px) else { return nil }
        let a = look.colors.first ?? 0xFFFFFF
        let colors = [cg(0xFFFFFF, 0.95), cg(mixWhite(a, 0.5), 0.75), cg(a, 0.28), cg(a, 0)] as CFArray
        guard let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 0.16, 0.42, 1]) else { return nil }
        let c = CGPoint(x: CGFloat(px) / 2, y: CGFloat(px) / 2)
        gc.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: CGFloat(px) / 2, options: [])
        return gc.makeImage()
    }

    /// Core and shells flattened into one still frame (offscreen renders, which can't draw layers).
    static func still(_ look: Look, diameter: CGFloat, scale: CGFloat = 2) -> CGImage? {
        let px = Int((diameter * scale).rounded())
        guard let gc = context(px) else { return nil }
        let r = CGRect(x: 0, y: 0, width: px, height: px)
        for img in [coreImage(look: look, diameter: diameter, scale: scale)] + (0..<3).map({ shellImage($0, look: look, diameter: diameter, scale: scale) }) {
            if let img { gc.draw(img, in: r) }
        }
        return gc.makeImage()
    }
}

struct NebulaOrb: View {
    var kind: StateKind
    var speaking = false
    var level: AudioLevel?
    var visible = true
    var diameter: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let look = Nebula.look(kind, speaking: speaking)
        Group {
            if OffscreenRender.active {
                // ImageRenderer can't draw AppKit layers: the same orb, still.
                if let img = Nebula.still(look, diameter: diameter) { Image(decorative: img, scale: 2) }
            } else {
                NebulaLayer(look: look, diameter: diameter, level: level, animating: visible && !reduceMotion)
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }
}

struct NebulaLayer: NSViewRepresentable {
    var look: Nebula.Look
    var diameter: CGFloat
    var level: AudioLevel?
    var animating: Bool

    func makeNSView(context: Context) -> NebulaNSView { NebulaNSView() }
    func updateNSView(_ v: NebulaNSView, context: Context) {
        v.configure(look: look, diameter: diameter, level: level, animating: animating)
    }
    static func dismantleNSView(_ v: NebulaNSView, coordinator: ()) { v.stopLevel() }
}

final class NebulaNSView: NSView {
    private let container = CALayer()
    private let core = CALayer()
    private let shells = (0..<3).map { _ in CALayer() }
    private var key: (Nebula.Look, CGFloat, CGFloat, Bool)?
    private var timer: Timer?
    private var level: AudioLevel?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(container)
        for l in [core] + shells { l.contentsGravity = .resizeAspect; container.addSublayer(l) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.frame = bounds
        for l in [core] + shells { l.frame = container.bounds }
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopLevel() } else if let k = key { key = nil; configure(look: k.0, diameter: k.1, level: level, animating: k.3) }
    }

    func stopLevel() {
        timer?.invalidate()
        timer = nil
    }

    func configure(look: Nebula.Look, diameter: CGFloat, level: AudioLevel?, animating: Bool) {
        self.level = level
        let scale = window?.backingScaleFactor ?? 2
        if let k = key, k.0 == look, k.1 == diameter, k.2 == scale, k.3 == animating { return }
        let redraw = key.map { $0.0.colors != look.colors || $0.1 != diameter || $0.2 != scale } ?? true
        key = (look, diameter, scale, animating)
        stopLevel()
        if redraw {
            // Implicit 0.25 s crossfade of `contents` between states.
            core.contents = Nebula.coreImage(look: look, diameter: diameter, scale: scale)
            for (i, s) in shells.enumerated() { s.contents = Nebula.shellImage(i, look: look, diameter: diameter, scale: scale) }
        }
        for l in [container, core] + shells { l.removeAllAnimations() }
        core.opacity = Float(0.7 + 0.3 * look.energy)
        guard animating else { return }

        let now = CACurrentMediaTime()
        for (i, s) in shells.enumerated() {
            // Shells turn at different speeds, alternating direction, and breathe out of step.
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = (i % 2 == 0 ? 2 : -2) * Double.pi
            spin.duration = [16, 22, 28][i] / look.speed
            spin.repeatCount = .infinity
            s.add(spin, forKey: "spin")
            s.add(breathe(1 + (0.03 + 0.05 * look.energy) * [1, -0.8, 1.2][i], period: [2.6, 3.4, 4.2][i] / look.speed, begin: now - Double(i) * 0.7), forKey: "breathe")
        }
        core.add(breathe(1 + 0.08 + 0.1 * look.energy, period: 2.8 / look.speed, begin: now), forKey: "breathe")

        switch look.state {
        case "speaking":
            // Pulses while Jarvis speaks: an uneven beat, like the voice bars.
            let p = CAKeyframeAnimation(keyPath: "transform.scale")
            p.values = [1, 1.08, 1.02, 1.1, 1, 1.06, 1.01, 1.09, 1]
            p.duration = 2
            p.repeatCount = .infinity
            p.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            container.add(p, forKey: "pulse")
        case "needs":
            // Needs you: the core pulses on `attention` (1.2 s), like the rim.
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 1
            a.toValue = 0.45
            a.duration = 0.6
            a.autoreverses = true
            a.repeatCount = .infinity
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            core.add(a, forKey: "pulse")
        case "listening":
            // Follows the mic: the only state that does any work in the app, one transform at 15 Hz.
            guard let level else { break }
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.follow(level.current) }
            }
        default: break
        }
    }

    private func follow(_ l: Float) {
        CATransaction.begin()
        CATransaction.setAnimationDuration(1.0 / 15)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .linear))
        let s = 1 + 0.22 * CGFloat(max(0, min(1, l)))
        container.setAffineTransform(CGAffineTransform(scaleX: s, y: s))
        CATransaction.commit()
    }

    private func breathe(_ to: Double, period: Double, begin: CFTimeInterval) -> CABasicAnimation {
        let b = CABasicAnimation(keyPath: "transform.scale")
        b.fromValue = 1
        b.toValue = to
        b.duration = period / 2
        b.autoreverses = true
        b.repeatCount = .infinity
        b.beginTime = begin
        b.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        return b
    }
}
