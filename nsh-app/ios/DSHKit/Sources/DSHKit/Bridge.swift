// The app speaks plain HTTP and WebSocket to 127.0.0.1:<port>; each connection continues as TLS that trusts only the
// computer's invited certificate (SNI h-<hostId>.dsh.invalid), carried by Tailcat (WireGuard) to the companion. NSH's
// WebSocket cannot be given a private certificate, so TLS ends here, inside the app's own process (as android
// Bridge.java, with Network.framework). connectmobile's forward carries raw connections only after the line
// "TP-FWD <token>\n" with the token Connect gave (connectphone.Forward): ForwardLine, a framer below TLS, sends it first
// on every connection. The token stays in memory.
import Foundation
import Network
import Security

public final class Bridge: @unchecked Sendable {
    private let invitation: Invitation
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dsh-bridge")
    /// The loopback port the app connects to.
    public let port: Int

    private let tailcatPort: UInt16

    public init(invitation: Invitation, tailcatPort: Int, forwardToken: String) throws {
        self.invitation = invitation
        self.tailcatPort = UInt16(clamping: tailcatPort)
        ForwardLine.set(Data("TP-FWD \(forwardToken)\n".utf8), for: self.tailcatPort)
        let p = NWParameters.tcp
        p.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: p)
        let ready = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let e): failure = e; ready.signal()
            default: break
            }
        }
        let remote = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(clamping: tailcatPort)) ?? 9)
        let tls = Bridge.parameters(invitation)
        let queue = self.queue
        listener.newConnectionHandler = { local in Bridge.carry(local, to: NWConnection(to: remote, using: tls), queue: queue) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 10) == .success, failure == nil, let bound = listener.port else {
            listener.cancel()
            ForwardLine.set(nil, for: self.tailcatPort)
            throw LinkFailure("link/bridge")
        }
        port = Int(bound.rawValue)
    }

    /// Whether this bridge reaches the computer `other` invites to: the same node, port, name and certificate.
    public func serves(_ other: Invitation) -> Bool { invitation.sameComputer(as: other) }

    public func close() { listener.cancel(); ForwardLine.set(nil, for: tailcatPort) }

    deinit { close() }

    /// TLS 1.2+ with the invited name as SNI, accepting exactly the invited leaf certificate.
    private static func parameters(_ invitation: Invitation) -> NWParameters {
        let tls = NWProtocolTLS.Options()
        let o = tls.securityProtocolOptions
        sec_protocol_options_set_tls_server_name(o, invitation.serverName)
        sec_protocol_options_set_min_tls_protocol_version(o, .TLSv12)
        sec_protocol_options_set_verify_block(o, { _, trust, complete in
            let t = sec_trust_copy_ref(trust).takeRetainedValue()
            let leaf = (SecTrustCopyCertificateChain(t) as? [SecCertificate])?.first.map { SecCertificateCopyData($0) as Data }
            complete(leaf.map(invitation.trusts(leaf:)) ?? false)
        }, DispatchQueue(label: "dsh-bridge-verify"))
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 20
        let p = NWParameters(tls: tls, tcp: tcp)
        // Below TLS (the stack lists the top first): the forward's line goes out before the ClientHello.
        p.defaultProtocolStack.applicationProtocols.append(NWProtocolFramer.Options(definition: ForwardLine.definition))
        return p
    }

    /// One app connection: the remote handshake first (15 s at most, so a dead tunnel cannot hold it), then bytes
    /// both ways until either side ends, which ends both.
    private static func carry(_ local: NWConnection, to remote: NWConnection, queue: DispatchQueue) {
        let end = { local.cancel(); remote.cancel() }
        let handshake = DispatchWorkItem(block: end)
        queue.asyncAfter(deadline: .now() + 15, execute: handshake)
        remote.stateUpdateHandler = { state in
            switch state {
            case .ready:
                handshake.cancel()
                pump(local, remote, end)
                pump(remote, local, end)
            case .failed, .cancelled, .waiting:
                handshake.cancel()
                end()
            default: break
            }
        }
        local.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled: end()
            default: break
            }
        }
        local.start(queue: queue)
        remote.start(queue: queue)
    }

    private static func pump(_ from: NWConnection, _ to: NWConnection, _ end: @escaping () -> Void) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 32 * 1024) { data, _, done, error in
            guard error == nil else { return end() }
            if let data, !data.isEmpty {
                to.send(content: data, completion: .contentProcessed { e in
                    if e != nil || done { end() } else { pump(from, to, end) }
                })
            } else if done {
                end()
            } else {
                pump(from, to, end)
            }
        }
    }
}

/// Sends the forward's "TP-FWD <token>\n" when a connection to the forward starts, then gets out of the way. The line
/// is found by the forward's loopback port, the connection's remote end (one forward, so one token, per tunnel).
final class ForwardLine: NWProtocolFramerImplementation {
    static let label = "TP-FWD"
    static let definition = NWProtocolFramer.Definition(implementation: ForwardLine.self)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var lines: [UInt16: Data] = [:]

    static func set(_ line: Data?, for port: UInt16) { lock.lock(); lines[port] = line; lock.unlock() }
    private static func line(for port: UInt16) -> Data? { lock.lock(); defer { lock.unlock() }; return lines[port] }

    required init(framer: NWProtocolFramer.Instance) {}

    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult {
        guard case .hostPort(_, let port)? = framer.remote, let line = ForwardLine.line(for: port.rawValue) else {
            framer.markFailed(error: .posix(.ECONNREFUSED))
            return .willMarkReady
        }
        framer.writeOutput(data: line)
        framer.passThroughOutput()
        framer.passThroughInput()
        return .ready
    }

    func handleInput(framer: NWProtocolFramer.Instance) -> Int { 0 }
    func handleOutput(framer: NWProtocolFramer.Instance, message: NWProtocolFramer.Message, messageLength: Int, isComplete: Bool) {
        try? framer.writeOutputNoCopy(length: messageLength)
    }
    func wakeup(framer: NWProtocolFramer.Instance) {}
    func stop(framer: NWProtocolFramer.Instance) -> Bool { true }
    func cleanup(framer: NWProtocolFramer.Instance) {}
}
