// The Nebula orb: a WKWebView on the bundled orb.html and three.min.js (no
// network). Swift pushes OrbState about 20 times a second, only when it
// changed, and pauses the page's animation while the window isn't visible.

import SwiftUI
import WebKit

struct OrbView: NSViewRepresentable {
    let store: DashboardStore

    static var pageURL: URL? { Bundle.main.url(forResource: "orb", withExtension: "html") }

    func makeCoordinator() -> Coordinator { Coordinator(store: store) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.setAccessibilityElement(false)
        if let url = Self.pageURL { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        context.coordinator.web = web
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.setVisible(store.onScreen)
    }

    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.setVisible(false)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var web: WKWebView?
        let store: DashboardStore
        private var timer: Timer?
        private var loaded = false
        private var visible = false
        private var sent = ""

        init(store: DashboardStore) { self.store = store }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            sent = ""
            apply()
        }

        /// Only the bundled page; nothing navigates anywhere else.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.isFileURL == true ? .allow : .cancel
        }

        func setVisible(_ v: Bool) {
            guard v != visible else { return }
            visible = v
            apply()
        }

        private func apply() {
            guard loaded else { return }
            web?.evaluateJavaScript("jarvis.pause(\(!visible))")
            if visible, timer == nil {
                push()
                timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.push() }
                }
            } else if !visible {
                timer?.invalidate()
                timer = nil
            }
        }

        private func push() {
            let json = store.orbState().json
            guard json != sent else { return }
            sent = json
            web?.evaluateJavaScript("jarvis.set(\(json))")
        }
    }
}
