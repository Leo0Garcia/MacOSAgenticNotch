// Jarvis notch app: an agent app (no Dock icon) with a small menu bar item
// for status and Quit. The notch itself is driven by AppDelegate.

import SwiftUI

@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra("Jarvis", systemImage: "waveform") {
            MenuContent(model: delegate.model, openDashboard: { delegate.showDashboard() })
        }
        Settings {
            SettingsView(voice: delegate.voiceSettings, model: delegate.model, socket: delegate.speechSocket)
        }
    }
}

private struct MenuContent: View {
    let model: AppModel
    var openDashboard: () -> Void

    var body: some View {
        Text("Hold ⌥ Space and talk")
        Text(speechStatus)
        Divider()
        Button("Dashboard", action: openDashboard)
        SettingsLink { Text("Settings…") }
            .keyboardShortcut(",")
        Button("Quit Jarvis") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var speechStatus: String {
        switch model.speechModel {
        case .notLoaded: "Speech model not loaded"
        case let .loading(text): "\(text)…"
        case .ready: "Speech model ready"
        case let .failed(message): "Speech model failed: \(message)"
        }
    }
}
