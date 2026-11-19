// The bridge carries plain app traffic as TLS that trusts only the invited certificate: a stand-in companion with
// that certificate echoes through it; one with any other certificate gets nothing and the app's connection closes
// (as android BridgeTest). The stand-in is connectmobile's forward too: it reads the line "TP-FWD <token>\n" first and
// drops a connection without the right one, as connectphone.Forward does.
import DSHKit
import Foundation
import Network
import XCTest

private let token = "synthetic-forward-token"

/// The forward's side of the line, below the stand-in's TLS: reads "TP-FWD <token>\n", then lets TLS through.
private final class ForwardReader: NWProtocolFramerImplementation {
    static let label = "TP-FWD reader"
    static let definition = NWProtocolFramer.Definition(implementation: ForwardReader.self)
    private var line = Data()
    required init(framer: NWProtocolFramer.Instance) {}
    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult { .willMarkReady }
    func handleInput(framer: NWProtocolFramer.Instance) -> Int {
        while true {
            var byte: UInt8?
            let got = framer.parseInput(minimumIncompleteLength: 1, maximumLength: 1) { buffer, _ in
                byte = buffer?.first; return byte == nil ? 0 : 1
            }
            guard got, let b = byte else { return 1 }
            if b != 10 { line.append(b); if line.count > 200 { framer.markFailed(error: .posix(.EPROTO)); return 0 }; continue }
            guard String(decoding: line, as: UTF8.self) == "TP-FWD \(token)" else { framer.markFailed(error: .posix(.EACCES)); return 0 }
            framer.passThroughInput()
            framer.passThroughOutput()
            framer.markReady()
            return 0
        }
    }
    func handleOutput(framer: NWProtocolFramer.Instance, message: NWProtocolFramer.Message, messageLength: Int, isComplete: Bool) {
        try? framer.writeOutputNoCopy(length: messageLength)
    }
    func wakeup(framer: NWProtocolFramer.Instance) {}
    func stop(framer: NWProtocolFramer.Instance) -> Bool { true }
    func cleanup(framer: NWProtocolFramer.Instance) {}
}

final class BridgeTests: XCTestCase {
    private func json(_ url: URL) throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any] }
    private var pairingURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../android/app/src/test/resources/pairing.json").standardized
    }

    private func identity(_ name: String) throws -> SecIdentity {
        let x = try json(Bundle.module.url(forResource: "extra", withExtension: "json", subdirectory: "Fixtures")!)
        var items: CFArray?
        var options: [CFString: Any] = [kSecImportExportPassphrase: "test"]
        // Never into the Mac's keychain (iOS keeps imports in memory anyway).
        if #available(iOS 18, macOS 15, *) { options[kSecImportToMemoryOnly] = true }
        let status = SecPKCS12Import(Data(base64Encoded: x[name] as! String)! as CFData, options as CFDictionary, &items)
        XCTAssertEqual(status, errSecSuccess)
        let first = (items as! [[String: Any]])[0]
        return first[kSecImportItemIdentity as String] as! SecIdentity
    }

    /// A TLS echo server on 127.0.0.1 presenting `identity`; records the SNI it was asked for.
    private final class Companion: @unchecked Sendable {
        let listener: NWListener
        private(set) var port = 0
        init(_ identity: SecIdentity) throws {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sec_identity_create(identity)!)
            let p = NWParameters(tls: tls)
            p.defaultProtocolStack.applicationProtocols.append(NWProtocolFramer.Options(definition: ForwardReader.definition))
            p.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: p)
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.newConnectionHandler = { c in
                c.start(queue: .global())
                func echo() {
                    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, error in
                        if let data, !data.isEmpty { c.send(content: data, completion: .contentProcessed { _ in }) }
                        if !done && error == nil { echo() }
                    }
                }
                echo()
            }
            listener.start(queue: .global())
            _ = ready.wait(timeout: .now() + 5)
            port = Int(listener.port!.rawValue)
        }
        deinit { listener.cancel() }
    }

    /// Sends `text` to the bridge as the app would and returns what comes back within `timeout` (nil: closed, nothing).
    private func roundTrip(_ port: Int, _ text: String, timeout: TimeInterval = 10) -> String? {
        let c = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var answer: String?
        c.stateUpdateHandler = { if case .ready = $0 {
            c.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                if let data, !data.isEmpty { answer = String(decoding: data, as: UTF8.self) }
                done.signal()
            }
        } }
        c.start(queue: .global())
        _ = done.wait(timeout: .now() + timeout)
        c.cancel()
        return answer
    }

    func testTheInvitedCompanionEchoesThroughTheBridge() throws {
        let inv = try Invite.invitation(String(decoding: try JSONSerialization.data(withJSONObject: try json(pairingURL)["invitation"]!), as: UTF8.self))
        let companion = try Companion(try identity("companionP12"))
        let bridge = try Bridge(invitation: inv, tailcatPort: companion.port, forwardToken: token)
        defer { bridge.close() }
        XCTAssertEqual(roundTrip(bridge.port, "GET / HTTP/1.1\r\n\r\n"), "GET / HTTP/1.1\r\n\r\n")
        XCTAssertEqual(roundTrip(bridge.port, "again"), "again")
    }

    func testAnyOtherCertificateGetsNothing() throws {
        let inv = try Invite.invitation(String(decoding: try JSONSerialization.data(withJSONObject: try json(pairingURL)["invitation"]!), as: UTF8.self))
        let impostor = try Companion(try identity("otherP12"))
        let bridge = try Bridge(invitation: inv, tailcatPort: impostor.port, forwardToken: token)
        defer { bridge.close() }
        XCTAssertNil(roundTrip(bridge.port, "secret"))
    }

    func testWithoutTheForwardsTokenNothingGetsThrough() throws {
        let inv = try Invite.invitation(String(decoding: try JSONSerialization.data(withJSONObject: try json(pairingURL)["invitation"]!), as: UTF8.self))
        let companion = try Companion(try identity("companionP12"))
        let bridge = try Bridge(invitation: inv, tailcatPort: companion.port, forwardToken: "another-token")
        defer { bridge.close() }
        XCTAssertNil(roundTrip(bridge.port, "secret"))
    }

    func testTheBridgeServesOnlyTheSameComputer() throws {
        let f = try json(pairingURL)
        let inv = try Invite.invitation(String(decoding: try JSONSerialization.data(withJSONObject: f["invitation"]!), as: UTF8.self))
        let bridge = try Bridge(invitation: inv, tailcatPort: 9, forwardToken: token)
        defer { bridge.close() }
        XCTAssertTrue(bridge.serves(inv))
        var other = f["invitation"] as! [String: Any]
        var t = other["tailcat"] as! [String: Any]; t["address"] = "tcANOTHERNODEaGVsbG8"; other["tailcat"] = t
        XCTAssertFalse(bridge.serves(try Invite.invitation(String(decoding: try JSONSerialization.data(withJSONObject: other), as: UTF8.self))))
    }
}
