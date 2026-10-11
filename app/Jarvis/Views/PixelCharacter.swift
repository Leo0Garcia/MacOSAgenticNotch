// The Jarvis character (NOTCH-DESIGN section 6): an original 14 × 10 pixel
// sprite drawn in a Canvas at 8 fps. Same frames as docs/design/notch-mockup.html.

import AppKit
import SwiftUI

enum Mood: Equatable, Sendable {
    case listen, work, happy, wave, look, read

    init(_ kind: StateKind) {
        switch kind {
        case .listening: self = .listen
        case .working: self = .work
        case .done: self = .happy
        case .needs: self = .wave
        case .reminder: self = .look
        case .idle, .notice: self = .read
        }
    }
}

enum Sprite {
    enum Eyes { case open, blink, up, down, left, right, happy }
    enum Arm { case side, up }

    struct Pose: Equatable {
        var eyes: Eyes = .open
        var armL: Arm = .side
        var armR: Arm = .side
        var legs = 0 // 0 all down, 1 and 2 alternate pairs (walk)
        var dy = 0
    }

    static func eyePixels(_ e: Eyes) -> [(Int, Int)] {
        switch e {
        case .open: [(4, 4), (4, 5), (9, 4), (9, 5)]
        case .blink: [(4, 5), (9, 5)]
        case .up: [(4, 3), (4, 4), (9, 3), (9, 4)]
        case .down: [(4, 5), (4, 6), (9, 5), (9, 6)]
        case .left: [(3, 4), (3, 5), (8, 4), (8, 5)]
        case .right: [(5, 4), (5, 5), (10, 4), (10, 5)]
        case .happy: [(3, 5), (4, 4), (5, 5), (8, 5), (9, 4), (10, 5)]
        }
    }

    /// 10 rows × 14 columns: 0 empty (shows the black notch), 1 body, 2 shade.
    static func grid(_ p: Pose) -> [[UInt8]] {
        var g = Array(repeating: Array(repeating: UInt8(0), count: 14), count: 10)
        for y in 2...7 { for x in 2...11 { g[y][x] = y == 7 ? 2 : 1 } }
        func arm(_ left: Bool, _ pos: Arm) {
            if pos == .up {
                let x = left ? 1 : 12
                g[3][x] = 1; g[4][x] = 1
            } else {
                let x0 = left ? 0 : 12
                g[5][x0] = 1; g[5][x0 + 1] = 1
            }
        }
        arm(true, p.armL)
        arm(false, p.armR)
        for (i, x) in [3, 5, 8, 10].enumerated() {
            if p.legs == 1, i == 1 || i == 3 { continue }
            if p.legs == 2, i == 0 || i == 2 { continue }
            g[8][x] = 2
        }
        for (x, y) in eyePixels(p.eyes) { g[y][x] = 0 }
        return g
    }

    /// The pose for a mood at `t` seconds into it (`tt` is wall time for blinks).
    static func pose(_ mood: Mood, t: Double, tt: Double, level: Float, speaking: Bool, reduceMotion: Bool) -> Pose {
        var o = Pose()
        let blink = tt.truncatingRemainder(dividingBy: 3.4) > 3.27
        o.eyes = blink ? .blink : .open
        switch mood {
        case .listen:
            o.eyes = blink ? .blink : .up
            o.dy = level > 0.6 ? -1 : 0
        case .work:
            let f = Int(t * 8)
            o.legs = [0, 1, 0, 2][f % 4]
            o.eyes = [.left, .open, .right, .open][Int(t * 1.4) % 4]
        case .happy:
            if t < 0.5 {
                o.dy = (t < 0.12 || t > 0.38) ? -1 : -2
                o.armL = .up; o.armR = .up
                o.eyes = .happy
            } else {
                o.eyes = t < 1.6 ? .happy : (blink ? .blink : .open)
                o.dy = speaking && sin(tt * 5.3) * sin(tt * 2.1 + 0.4) > 0.35 ? -1 : 0
            }
        case .wave:
            let up = Int(t * 3) % 2 == 1
            o.armR = up ? .up : .side
            o.dy = up ? -1 : 0
        case .look:
            o.eyes = blink ? .blink : .up
            o.dy = Int(t * 2) % 4 == 0 ? -1 : 0
            let flap = t < 1.2 && Int(t * 6) % 2 == 1
            o.armL = flap ? .up : .side; o.armR = o.armL
        case .read:
            o.eyes = blink ? .blink : [.down, .left, .down, .right][Int(t * 0.8) % 4]
        }
        if reduceMotion {
            o = Pose(eyes: mood == .happy ? .happy : .open)
        }
        return o
    }
}

struct PixelCharacter: View {
    var mood: Mood
    /// Points per sprite pixel: 4 in the Large body (56 × 40), 2 in pills (28 × 20).
    var scale: CGFloat
    var since: Date
    var level: AudioLevel?
    var speaking = false
    var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if mood == .listen {
            // Listening hops on loud syllables, so it follows the live mic level.
            liveCanvas
        } else {
            SpriteLayer(mood: mood, scale: scale, speaking: speaking, animating: visible && !reduceMotion)
                .id(since) // restart the intro (hop, flap) on each new mood
                .frame(width: 14 * scale, height: 10 * scale)
                .accessibilityHidden(true)
        }
    }

    private var liveCanvas: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 8, paused: !visible || reduceMotion)) { ctx in
            let t = ctx.date.timeIntervalSince(since)
            let tt = ctx.date.timeIntervalSinceReferenceDate
            let pose = Sprite.pose(mood, t: max(0, t), tt: tt, level: level?.current ?? 0, speaking: speaking, reduceMotion: reduceMotion)
            Canvas(rendersAsynchronously: false) { gc, _ in
                let g = Sprite.grid(pose)
                for y in 0..<10 {
                    for x in 0..<14 {
                        let v = g[y][x]
                        guard v != 0 else { continue }
                        let yy = y + pose.dy
                        guard yy >= 0, yy < 10 else { continue }
                        let r = CGRect(x: CGFloat(x) * scale, y: CGFloat(yy) * scale, width: scale, height: scale)
                        gc.fill(Path(r), with: .color(v == 2 ? Theme.shadeColor : Theme.bodyColor))
                    }
                }
            }
        }
        .frame(width: 14 * scale, height: 10 * scale)
        .accessibilityHidden(true)
    }
}

// MARK: - Core Animation sprite

/// Pre-rendered frames for a mood: an intro (played once) then a loop.
enum SpriteFrames {
    static let fps = 8.0

    static func image(_ pose: Sprite.Pose) -> CGImage? {
        let g = Sprite.grid(pose)
        let w = 14, h = 10
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let body: (UInt8, UInt8, UInt8) = (0xD9, 0x77, 0x57)
        let shade: (UInt8, UInt8, UInt8) = (0xB8, 0x61, 0x3F)
        for y in 0..<h {
            for x in 0..<w {
                let v = g[y][x]
                let yy = y + pose.dy
                guard v != 0, yy >= 0, yy < h else { continue }
                let c = v == 2 ? shade : body
                let i = (yy * w + x) * 4
                px[i] = c.0; px[i + 1] = c.1; px[i + 2] = c.2; px[i + 3] = 255
            }
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData) else { return nil }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// (intro, loop) frame lists at 8 fps. Loops are long enough to hold whole
    /// blink and eye cycles so the seam doesn't show.
    static func frames(_ mood: Mood, speaking: Bool) -> (intro: [CGImage], loop: [CGImage]) {
        var cache: [Sprite.Pose: CGImage] = [:]
        func img(_ p: Sprite.Pose) -> CGImage? {
            if let c = cache[p] { return c }
            let i = image(p)
            cache[p] = i
            return i
        }
        func run(_ from: Double, _ to: Double) -> [CGImage] {
            stride(from: from, to: to, by: 1 / fps).compactMap { t in
                img(Sprite.pose(mood, t: t, tt: t, level: 0, speaking: speaking, reduceMotion: false))
            }
        }
        switch mood {
        case .happy: return (run(0, 1.625), run(1.625, 1.625 + 6.8))
        case .look: return (run(0, 1.25), run(2, 2 + 6.8))
        default: return ([], run(0, 6.8 * (mood == .work ? 5 : 1)))
        }
    }
}

extension Sprite.Pose: Hashable {}
extension Sprite.Eyes: Hashable {}
extension Sprite.Arm: Hashable {}

/// The character as a layer whose `contents` steps through pre-rendered
/// frames under Core Animation: no per-frame work in the app.
struct SpriteLayer: NSViewRepresentable {
    var mood: Mood
    var scale: CGFloat
    var speaking: Bool
    var animating: Bool

    func makeNSView(context: Context) -> SpriteNSView { SpriteNSView() }
    func updateNSView(_ v: SpriteNSView, context: Context) {
        v.configure(mood: mood, speaking: speaking, animating: animating)
    }
}

final class SpriteNSView: NSView {
    private let sprite = CALayer()
    private var key: (Mood, Bool, Bool)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        sprite.magnificationFilter = .nearest
        sprite.contentsGravity = .resize
        layer?.addSublayer(sprite)
    }

    required init?(coder: NSCoder) { fatalError("not used") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sprite.frame = bounds
        CATransaction.commit()
    }

    func configure(mood: Mood, speaking: Bool, animating: Bool) {
        if let k = key, k.0 == mood, k.1 == speaking, k.2 == animating { return }
        key = (mood, speaking, animating)
        sprite.removeAllAnimations()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard animating else {
            sprite.contents = SpriteFrames.image(Sprite.Pose(eyes: mood == .happy ? .happy : .open))
            return
        }
        let (intro, loop) = SpriteFrames.frames(mood, speaking: speaking)
        sprite.contents = loop.first
        let now = CACurrentMediaTime()
        if !intro.isEmpty {
            let a = CAKeyframeAnimation(keyPath: "contents")
            a.values = intro
            a.calculationMode = .discrete
            a.duration = Double(intro.count) / SpriteFrames.fps
            a.beginTime = now
            a.fillMode = .backwards
            a.isRemovedOnCompletion = true
            sprite.add(a, forKey: "intro")
        }
        let l = CAKeyframeAnimation(keyPath: "contents")
        l.values = loop
        l.calculationMode = .discrete
        l.duration = Double(loop.count) / SpriteFrames.fps
        l.repeatCount = .infinity
        l.beginTime = now + Double(intro.count) / SpriteFrames.fps
        sprite.add(l, forKey: "loop")
    }
}
