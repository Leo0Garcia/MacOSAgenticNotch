// ⌥⇧ Space: a text box just under the notch for when Leo can't talk
// (Leo, 2026-10-16). It takes the keyboard without activating Jarvis, so the
// app he was in stays frontmost; Return sends, Esc or clicking away closes.

import AppKit
import SwiftUI

@MainActor
final class TypeBox {
    private final class KeyPanel: NSPanel {
        override var canBecomeKey: Bool { true }
        var onClose: (() -> Void)?
        override func resignKey() {
            super.resignKey()
            onClose?()
        }
        override func cancelOperation(_ sender: Any?) { onClose?() }
    }

    private var panel: KeyPanel?
    private let submit: (String) -> Void

    init(submit: @escaping (String) -> Void) {
        self.submit = submit
    }

    var isOpen: Bool { panel != nil }

    func toggle() {
        if isOpen { close() } else { open() }
    }

    func open() {
        guard panel == nil, let screen = NSScreen.main else { return }
        let size = CGSize(width: 440, height: 46)
        let top = screen.frame.maxY - max(screen.safeAreaInsets.top, 24) - 8
        let frame = CGRect(x: screen.frame.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height)
        let p = KeyPanel(contentRect: frame, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.onClose = { [weak self] in self?.close() }
        p.contentView = NSHostingView(rootView: Field { [weak self] text in
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            self?.close()
            if !t.isEmpty { self?.submit(t) }
        })
        panel = p
        p.makeKeyAndOrderFront(nil)
    }

    func close() {
        guard let p = panel else { return }
        panel = nil
        p.onClose = nil
        p.orderOut(nil)
    }

    private struct Field: View {
        let send: (String) -> Void
        @State private var text = ""
        @FocusState private var focused: Bool

        var body: some View {
            TextField("Type to Jarvis", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .foregroundStyle(.white)
                .focused($focused)
                .onSubmit { send(text) }
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.black))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.15)))
                .environment(\.colorScheme, .dark)
                .accessibilityLabel("Type a request to Jarvis")
                .onAppear { focused = true }
        }
    }
}
