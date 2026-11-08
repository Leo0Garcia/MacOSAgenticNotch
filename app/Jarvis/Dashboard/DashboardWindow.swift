// Owns the dashboard's NSWindow: ⌥⇧J, the menu bar's Dashboard item and
// jarvis://dashboard open it. Closing it drops the window and its web view,
// so nothing renders; covered or minimised, polling and the orb pause.
// Ambient mode is the window in full screen; Esc leaves it.

import AppKit
import SwiftUI

@MainActor
final class DashboardWindow: NSObject, NSWindowDelegate {
    let store: DashboardStore
    var hotkeyLabel = "⌥ Space"
    private var window: NSWindow?
    private var escMonitor: Any?

    init(store: DashboardStore) { self.store = store }

    /// The hotkey: open, or close it if it's already in front.
    func toggle() {
        if let w = window, w.isKeyWindow, w.occlusionState.contains(.visible) { w.close() } else { show() }
    }

    func show() {
        if window == nil { make() }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }

    func toggleAmbient() {
        window?.toggleFullScreen(nil)
    }

    private func make() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 840),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "Jarvis"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.isReleasedWhenClosed = false
        w.collectionBehavior = [.fullScreenPrimary]
        w.minSize = NSSize(width: 1040, height: 680)
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = NSColor(Dash.bg)
        w.contentViewController = NSHostingController(rootView: DashboardView(store: store, hotkeyLabel: hotkeyLabel) { [weak self] in
            self?.toggleAmbient()
        })
        w.setContentSize(NSSize(width: 1320, height: 840))
        w.center()
        w.setFrameAutosaveName("JarvisDashboard")
        w.delegate = self
        window = w
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            // Esc leaves ambient mode; otherwise it goes on as usual.
            guard e.keyCode == 53, let self, e.window === self.window, self.store.ambient else { return e }
            self.toggleAmbient()
            return nil
        }
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        let visible = window?.occlusionState.contains(.visible) == true
        store.setVisible(visible)
        // On screen, the dashboard shows the conversation; covered, minimised or closed, the notch does.
        store.model.dashboardShowing = visible && window?.isMiniaturized == false
    }

    func windowDidEnterFullScreen(_ notification: Notification) { store.ambient = true }
    func windowDidExitFullScreen(_ notification: Notification) { store.ambient = false }

    func windowWillClose(_ notification: Notification) {
        store.setVisible(false)
        store.model.dashboardShowing = false
        store.ambient = false
        if let m = escMonitor { NSEvent.removeMonitor(m) }
        escMonitor = nil
        window?.contentViewController = nil
        window?.delegate = nil
        window = nil
    }
}
