// Jarvis: a normal Mac app while its dashboard window is open (Dock icon,
// menus), and a background app with the notch and a menu bar item when it's
// closed. The notch itself is driven by AppDelegate.

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
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Dashboard") { delegate.showDashboard() }
                    .keyboardShortcut("j", modifiers: [.option, .shift])
            }
            CommandGroup(after: .sidebar) {
                Button("Ambient Mode") { delegate.toggleAmbient() }
                    .keyboardShortcut("f", modifiers: [.control, .command])
            }
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
        Button("Open Jarvis", action: openDashboard)
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
