// `--snapshots <dir>`: renders each state's expanded panel and pill to PNG,
// inside a stand-in for DynamicNotchKit's shape, so the look can be checked
// without a screen recording permission.

import AppKit
import SwiftUI

/// The filled notch outline (same curve as DynamicNotchKit's NotchShape).
struct NotchFillShape: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let t = topRadius, b = bottomRadius
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t, y: rect.minY + t), control: CGPoint(x: rect.minX + t, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX + t, y: rect.maxY - b))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t + b, y: rect.maxY), control: CGPoint(x: rect.minX + t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t - b, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - t, y: rect.maxY - b), control: CGPoint(x: rect.maxX - t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t, y: rect.minY + t))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control: CGPoint(x: rect.maxX - t, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

@MainActor
enum Snapshots {
    final class ManualScheduler: Scheduling {
        var now: Double = 100
        func after(_ seconds: Double, _ action: @escaping @MainActor () -> Void) -> Scheduled { Scheduled {} }
    }

    final class NoLauncher: LauncherRunning {
        func run(_ request: String, onEvent: @escaping @MainActor (LauncherEvent) -> Void, exited: @escaping @MainActor (Int32) -> Void) throws {}
        func open(sessionId: String) {}
        func cancelAll() {}
    }

    /// Renders every panel once offscreen at launch, so fonts, glyphs and
    /// view types are warm before the first real transition (no first-show hitch).
    static func warmUp(env: NotchEnvironment) {
        for (_, m) in cases(env: env) {
            _ = ImageRenderer(content: expanded(m, env)).cgImage
            _ = ImageRenderer(content: pill(m, env)).cgImage
        }
    }

    static func render(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let level = AudioLevel()
        level.set(0.55)
        let env = NotchEnvironment(level: level)
        env.notchSize = CGSize(width: 185, height: 32)
        for (name, m) in cases(env: env) {
            write(expanded(m, env), to: dir.appendingPathComponent("\(name).png"))
            write(pill(m, env), to: dir.appendingPathComponent("\(name)-pill.png"))
        }
    }

    private static func cases(env: NotchEnvironment) -> [(String, AppModel)] {
        func model(_ setup: (AppModel) -> Void) -> AppModel {
            let m = AppModel(scheduler: ManualScheduler())
            m.launcher = NoLauncher()
            m.speechModel = .ready
            setup(m)
            return m
        }

        return [
            ("listening", model { m in
                m.hotkeyDown()
                m.updateTranscript(Transcript(confirmed: "What's the weather in", hypothesis: "Southampton"))
            }),
            ("working", model { m in
                m.submit("What's the weather in Southampton")
                m.launcherEvent(.status(text: "Searching the web", detail: "southampton weather today"))
                m.launcherEvent(.status(text: "Reading BBC Weather", detail: "bbc.co.uk/weather/2637487"))
            }),
            ("done-saved", model { m in
                m.submit("Start a research session on Southampton rents")
                m.launcherEvent(.status(text: "Reading Zoopla", detail: "zoopla.co.uk/market/southampton"))
                m.speechStarted(id: "1", text: "I've started that. The first pass is in your vault under Southampton rents.")
                m.launcherEvent(.done(sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", keep: true, summary: "Research: Southampton rents", reply: "", name: "Jarvis: Research: Southampton rents"))
            }),
            ("question", model { m in
                m.received(.ask(id: "q", question: "Put “COMP2211 lab 4” in In-progress or Not Started?", options: ["In-progress", "Not Started"], timeoutMs: 60000, sessionId: nil), from: 1)
            }),
            ("blocked", model { m in
                m.submit("Pay my tuition fee")
                m.launcherEvent(.denied(tool: "mcp__claude-in-chrome__navigate", rule: "no-real-consequences", reason: "guard:no-real-consequences: tuition fee payment is for Leo to do himself. Safe alternative: a reminder to pay it at 6pm"))
                m.launcherExited(0)
            }),
            ("access", model { m in
                m.submit("Check my Notion")
                m.launcherEvent(.done(sessionId: "x", keep: false, summary: "", reply: "I need the Notion connector for that, connect it at claude.ai/customize/connectors and ask again.", name: nil))
                m.launcherExited(0)
            }),
            ("reminder", model { m in
                m.received(.reminder(id: "r", text: "Call Sue about the Amra brief"), from: 1)
            }),
        ]
    }

    private static func expanded(_ m: AppModel, _ env: NotchEnvironment) -> some View {
        let notchH = env.notchSize.height
        return ExpandedView(model: m, env: env)
            .padding(EdgeInsets(top: notchH, leading: Theme.dnkInset, bottom: Theme.dnkInset, trailing: Theme.dnkInset))
            .padding(.horizontal, Theme.topRadius)
            .background(Color.black)
            .mask(NotchFillShape(topRadius: Theme.topRadius, bottomRadius: Theme.bottomRadius))
            .overlay(alignment: .top) {
                // Where the hardware notch sits, for reference.
                RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.15), style: StrokeStyle(lineWidth: 1, dash: [3]))
                    .frame(width: env.notchSize.width, height: notchH)
            }
            .padding(30)
            .background(Color(white: 0.35))
            .environment(\.colorScheme, .dark)
    }

    private static func pill(_ m: AppModel, _ env: NotchEnvironment) -> some View {
        HStack(spacing: 0) {
            PillLeading(model: m, env: env).padding(.leading, 8).padding(.top, 4).padding(.bottom, 8)
            Spacer().frame(width: env.notchSize.width)
            PillTrailing(model: m, env: env).padding(.trailing, 8).padding(.top, 4).padding(.bottom, 8)
        }
        .padding(.horizontal, 6)
        .background(Color.black)
        .mask(NotchFillShape(topRadius: 6, bottomRadius: 14))
        .padding(30)
        .background(Color(white: 0.35))
    }

    private static func write(_ view: some View, to url: URL) {
        let r = ImageRenderer(content: view)
        r.scale = 2
        guard let img = r.nsImage, let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
            print("render failed: \(url.lastPathComponent)")
            return
        }
        try? png.write(to: url)
        print("wrote \(url.path)")
    }
}
