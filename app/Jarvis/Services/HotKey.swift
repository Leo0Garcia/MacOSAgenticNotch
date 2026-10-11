// Global hotkeys through Carbon's RegisterEventHotKey: press and release
// events, no Accessibility or Input Monitoring permission needed.
// Push-to-talk is ⌥ Space. Esc is registered only while a dismissable panel
// is open, so it never steals Esc from other apps otherwise.

import Carbon.HIToolbox
import Foundation

@MainActor
final class HotKeyCenter {
    struct Combo: Equatable {
        var keyCode: UInt32
        var modifiers: UInt32

        static let optionSpace = Combo(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey))
        static let escape = Combo(keyCode: UInt32(kVK_Escape), modifiers: 0)

        var label: String {
            var s = ""
            if modifiers & UInt32(controlKey) != 0 { s += "⌃" }
            if modifiers & UInt32(optionKey) != 0 { s += "⌥" }
            if modifiers & UInt32(shiftKey) != 0 { s += "⇧" }
            if modifiers & UInt32(cmdKey) != 0 { s += "⌘" }
            switch Int(keyCode) {
            case kVK_Space: s += " Space"
            case kVK_Escape: s += "Esc"
            default: s += "key \(keyCode)"
            }
            return s
        }
    }

    private struct Entry {
        var ref: EventHotKeyRef?
        var onPress: () -> Void
        var onRelease: () -> Void
    }

    private var entries: [UInt32: Entry] = [:]
    private var nextID: UInt32 = 1
    private var handler: EventHandlerRef?
    private static let signature: OSType = 0x4A_52_56_53 // 'JRVS'

    init() {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var hk = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            guard err == noErr else { return err }
            let kind = GetEventKind(event)
            let center = Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue()
            // Carbon delivers these on the main thread.
            MainActor.assumeIsolated { center.fire(id: hk.id, pressed: kind == UInt32(kEventHotKeyPressed)) }
            return noErr
        }, types.count, &types, me, &handler)
    }

    /// Registers a combo. Returns an id for `unregister`, or nil if another app holds it.
    @discardableResult
    func register(_ combo: Combo, onPress: @escaping () -> Void, onRelease: @escaping () -> Void = {}) -> UInt32? {
        let id = nextID
        nextID += 1
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, EventHotKeyID(signature: Self.signature, id: id),
                                         GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            AppLog.write("hotkey \(combo.label) unavailable (status \(status))")
            return nil
        }
        entries[id] = Entry(ref: ref, onPress: onPress, onRelease: onRelease)
        return id
    }

    func unregister(_ id: UInt32) {
        if let ref = entries.removeValue(forKey: id)?.ref { UnregisterEventHotKey(ref) }
    }

    private func fire(id: UInt32, pressed: Bool) {
        guard let e = entries[id] else { return }
        pressed ? e.onPress() : e.onRelease()
    }
}
