// Drives one DynamicNotch for the app's lifetime from the model's `size`
// (NOTCH-DESIGN section 5). Never chains expand/compact with sleeps: each
// size change sets the target and lets one animation run; DynamicNotchKit's
// springs retarget from the current state when a new change lands mid-way.

import AppKit
import Combine
import DynamicNotchKit
import SwiftUI

@MainActor
final class NotchController {
    private let model: AppModel
    private let env: NotchEnvironment
    private let notch: DynamicNotch<ExpandedView, PillLeading, PillTrailing>
    private var hoverSub: AnyCancellable?
    private var screenSub: AnyCancellable?
    private var applied: NotchSize = .hidden
    private var clickMonitor: Any?
    private var moveMonitor: Any?
    private var pointerInNotch = false

    private func pointerMoved() {
        guard applied == .hidden else {
            pointerInNotch = false
            return
        }
        let s = screen
        let n = s.jarvisNotchSize
        // The notch, a few points wider so the menu bar's edge counts too.
        let rect = NSRect(x: s.frame.midX - n.width / 2 - 6, y: s.frame.maxY - n.height, width: n.width + 12, height: n.height + 1)
        let inside = rect.contains(NSEvent.mouseLocation)
        guard inside != pointerInNotch else { return }
        pointerInNotch = inside
        model.notchHover(inside)
    }

    init(model: AppModel, env: NotchEnvironment) {
        self.model = model
        self.env = env
        if let screen = NSScreen.builtIn ?? NSScreen.screens.first {
            env.notchSize = screen.jarvisNotchSize
        }
        notch = DynamicNotch(
            hoverBehavior: [.keepVisible],
            style: .notch(topCornerRadius: Theme.topRadius, bottomCornerRadius: Theme.bottomRadius),
            expanded: { ExpandedView(model: model, env: env) },
            compactLeading: { PillLeading(model: model, env: env) },
            compactTrailing: { PillTrailing(model: model, env: env) })
        notch.transitionConfiguration = DynamicNotchTransitionConfiguration(
            openingAnimation: MotionToken.expand,
            closingAnimation: MotionToken.collapse,
            conversionAnimation: MotionToken.expand,
            skipIntermediateHides: true)
        hoverSub = notch.$isHovering.removeDuplicates().sink { [weak model] h in
            MainActor.assumeIsolated { model?.hoverChanged(h) }
        }
        observe()
        prepareWindow()
        // DynamicNotchKit rebuilds its window when displays change; keep it hidden if we are.
        screenSub = NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .delay(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.applied == .hidden, let w = self.notch.windowController?.window else { return }
                    w.alphaValue = 0
                    w.ignoresMouseEvents = true
                }
            }
        // A click anywhere else collapses the panel (section 2.1). Mouse-only
        // global monitors need no Accessibility permission.
        // Hover on the hardware notch while hidden opens the Recent panel. The
        // hidden window is click-through, so watch the pointer globally (mouse
        // monitors need no Accessibility permission).
        moveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            MainActor.assumeIsolated { self?.pointerMoved() }
        }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak model] _ in
            MainActor.assumeIsolated { model?.collapseOrHide() }
        }
    }

    private func observe() {
        withObservationTracking {
            _ = model.size
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.apply(self.model.size)
                self.observe()
            }
        }
    }

    private var screen: NSScreen { NSScreen.builtIn ?? NSScreen.screens[0] }

    /// "Hidden" keeps DynamicNotchKit's window alive: the notch sits in its
    /// compact state with empty wings (exactly the hardware outline), faded to
    /// alpha 0 and click-through. DynamicNotchKit's own hide() tears the window
    /// down, and rebuilding it on the next show cost a 25–40 ms hitch.
    private func apply(_ size: NotchSize) {
        guard size != applied else { return }
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let grow = Self.rank(size) > Self.rank(applied)
        let from = applied
        applied = size
        env.notchSize = screen.jarvisNotchSize
        // Bigger → expand spring; smaller → collapse spring, no overshoot.
        notch.transitionConfiguration.conversionAnimation = reduce ? MotionToken.reduced : (grow ? MotionToken.expand : MotionToken.collapse)
        notch.transitionConfiguration.openingAnimation = reduce ? MotionToken.reduced : MotionToken.expand
        notch.transitionConfiguration.closingAnimation = reduce ? MotionToken.reduced : MotionToken.collapse
        let target = screen
        fadeTask?.cancel()
        switch size {
        case .expanded, .compact:
            if from == .hidden { reveal() }
            Task {
                if size == .expanded { await notch.expand(on: target) } else { await notch.compact(on: target) }
            }
        case .hidden:
            Task { await notch.compact(on: target) }
            // Fade once the shape has shrunk back to the hardware outline.
            fadeTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(reduce ? 0.16 : 0.36))
                guard !Task.isCancelled, self.applied == .hidden, let w = self.notch.windowController?.window else { return }
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = 0.12
                    w.animator().alphaValue = 0
                }, completionHandler: nil)
                w.ignoresMouseEvents = true
            }
        }
    }

    private var fadeTask: Task<Void, Never>?

    private func reveal() {
        guard let w = notch.windowController?.window else { return }
        w.alphaValue = 1 // the shape is still the black hardware outline, so this is seamless
        w.ignoresMouseEvents = false
    }

    /// Creates the window at launch, hidden, so the first hotkey press animates
    /// in the same frame (NOTCH-DESIGN section 3, Startup).
    func prepareWindow() {
        let target = screen
        Task {
            await notch.compact(on: target)
            guard applied == .hidden, let w = notch.windowController?.window else { return }
            w.alphaValue = 0
            w.ignoresMouseEvents = true
        }
    }

    private static func rank(_ s: NotchSize) -> Int {
        switch s { case .hidden: 0; case .compact: 1; case .expanded: 2 }
    }
}

extension NSScreen {
    /// The built-in display (the one with the notch), if attached.
    static var builtIn: NSScreen? {
        screens.first { $0.auxiliaryTopLeftArea != nil && $0.auxiliaryTopRightArea != nil }
    }

    /// Hardware notch size, read the way DynamicNotchKit does; menu-bar fallback.
    var jarvisNotchSize: CGSize {
        if let l = auxiliaryTopLeftArea?.width, let r = auxiliaryTopRightArea?.width {
            return CGSize(width: frame.width - l - r, height: safeAreaInsets.top)
        }
        return CGSize(width: 300, height: max(24, frame.maxY - visibleFrame.maxY))
    }
}
