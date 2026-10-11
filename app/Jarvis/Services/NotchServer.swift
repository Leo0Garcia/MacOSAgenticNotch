// The notch socket (DESIGN 8.2): a WebSocket on 127.0.0.1, random port,
// Network.framework only. Writes ~/Jarvis/notch.json (0600) once listening,
// with a fresh token each launch, and deletes it on stop. The first frame from
// a client must be a valid `hello`, else `error` and close code 4001.

import Foundation
import Network
import Security

@MainActor
protocol NotchServerDelegate: AnyObject {
    func notchServer(_ server: NotchServer, received message: NotchProtocol.ClientMessage, from client: NotchServer.ClientID)
    func notchServer(_ server: NotchServer, disconnected client: NotchServer.ClientID)
}

@MainActor
final class NotchServer {
    typealias ClientID = Int

    weak var delegate: NotchServerDelegate?
    private(set) var port: UInt16?
    let token: String
    private let notchFile: URL
    private var listener: NWListener?
    private var clients: [ClientID: Client] = [:]
    private var nextID = 1

    private final class Client {
        let connection: NWConnection
        var authenticated = false
        var kind: NotchProtocol.ClientKind?
        init(_ c: NWConnection) { connection = c }
    }

    init(notchFile: URL, token: String = NotchServer.makeToken()) {
        self.notchFile = notchFile
        self.token = token
    }

    nonisolated static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Starts listening; resolves with the port once ready.
    func start() async throws -> UInt16 {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = 1 << 20
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        params.acceptLocalOnly = true
        let listener = try NWListener(using: params)
        self.listener = listener

        listener.newConnectionHandler = { [weak self] conn in
            MainActor.assumeIsolated { self?.accept(conn) }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { cont in
            var resumed = false
            listener.stateUpdateHandler = { state in
                MainActor.assumeIsolated {
                    guard !resumed else { return }
                    switch state {
                    case .ready:
                        resumed = true
                        cont.resume(returning: listener.port?.rawValue ?? 0)
                    case let .failed(err):
                        resumed = true
                        cont.resume(throwing: err)
                    default: break
                    }
                }
            }
            listener.start(queue: .main)
        }
        self.port = port
        try writeNotchFile(port: port)
        AppLog.write("notch socket listening on 127.0.0.1:\(port)")
        return port
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for c in clients.values { c.connection.cancel() }
        clients.removeAll()
        // Only remove the file if it is still ours.
        if let data = try? Data(contentsOf: notchFile),
           let f = try? JSONDecoder().decode(NotchProtocol.File.self, from: data),
           f.pid == ProcessInfo.processInfo.processIdentifier {
            try? FileManager.default.removeItem(at: notchFile)
        }
    }

    func send(_ msg: NotchProtocol.AppMessage, to id: ClientID) {
        guard let c = clients[id] else { return }
        send(msg, on: c.connection)
    }

    func kind(of id: ClientID) -> NotchProtocol.ClientKind? { clients[id]?.kind }

    // MARK: - Connections

    private func accept(_ conn: NWConnection) {
        let id = nextID
        nextID += 1
        clients[id] = Client(conn)
        conn.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                switch state {
                case .failed, .cancelled: self?.drop(id)
                default: break
                }
            }
        }
        conn.start(queue: .main)
        receive(id)
    }

    private func receive(_ id: ClientID) {
        guard let conn = clients[id]?.connection else { return }
        conn.receiveMessage { [weak self] data, context, _, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if error != nil { self.drop(id); return }
                if let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                    switch meta.opcode {
                    case .text:
                        if let data { self.handle(String(decoding: data, as: UTF8.self), from: id) }
                    case .close:
                        self.drop(id)
                        return
                    default: break
                    }
                }
                self.receive(id)
            }
        }
    }

    private func handle(_ text: String, from id: ClientID) {
        guard let client = clients[id] else { return }
        let msg: NotchProtocol.ClientMessage
        do {
            msg = try NotchProtocol.decode(text)
        } catch {
            if !client.authenticated { reject(id, "first frame must be hello") }
            return
        }
        if !client.authenticated {
            guard case let .hello(proto, token, kind, _, _) = msg else { return reject(id, "first frame must be hello") }
            guard proto == NotchProtocol.version else { return reject(id, "unsupported protocol \(proto)") }
            guard constantTimeEqual(token, self.token) else { return reject(id, "bad token") }
            client.authenticated = true
            client.kind = kind
            send(.welcome, on: client.connection)
            return
        }
        delegate?.notchServer(self, received: msg, from: id)
    }

    private func reject(_ id: ClientID, _ message: String) {
        guard let c = clients[id] else { return }
        send(.error(id: nil, message: message), on: c.connection)
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        meta.closeCode = .privateCode(4001)
        let ctx = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        let conn = c.connection
        conn.send(content: nil, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in
            conn.cancel()
        })
        clients[id] = nil
    }

    private func drop(_ id: ClientID) {
        guard let c = clients.removeValue(forKey: id) else { return }
        c.connection.cancel()
        if c.authenticated { delegate?.notchServer(self, disconnected: id) }
    }

    private func send(_ msg: NotchProtocol.AppMessage, on conn: NWConnection) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "frame", metadata: [meta])
        conn.send(content: Data(NotchProtocol.encode(msg).utf8), contentContext: ctx, isComplete: true, completion: .idempotent)
    }

    private func writeNotchFile(port: UInt16) throws {
        let file = NotchProtocol.File(port: Int(port), token: token, pid: ProcessInfo.processInfo.processIdentifier, protocol: NotchProtocol.version)
        let data = try JSONEncoder().encode(file)
        try writeAtomically(data, to: notchFile, mode: 0o600)
    }
}

/// Writes through a temp file in the same directory, chmods it, then renames.
func writeAtomically(_ data: Data, to url: URL, mode: Int) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(ProcessInfo.processInfo.processIdentifier).tmp")
    fm.createFile(atPath: tmp.path, contents: nil, attributes: [.posixPermissions: mode])
    let h = try FileHandle(forWritingTo: tmp)
    try h.write(contentsOf: data)
    try h.close()
    try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: tmp.path)
    if rename(tmp.path, url.path) != 0 {
        try? fm.removeItem(at: tmp)
        throw CocoaError(.fileWriteUnknown)
    }
}

func constantTimeEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in x.indices { diff |= x[i] ^ y[i] }
    return diff == 0
}
