// The phone's link to the owner's computer, as host functions for the app (as the Android shell's Link.java):
//   link.state   → { paired: false } or { paired: true, origin, token } (origin = this phone's bridge to /dsh)
//   link.scan    → the text of a scanned QR (VisionKit's scanner, Scanner.swift)
//   link.pair    { text } → as link.state; the one-time QR (or a dshm1: link) to a paired device
//   link.reset   → a new tunnel and bridge, as link.state (the app found the link dead)
//   link.forget  → unpairs this phone on the computer (best effort) and forgets the link
//   link.path    → { route: direct | relay | lan | unknown, relay? } how the tunnel reaches the computer now
//   link.tailcatOnly { on? } → { on }: reach the computer over Tailcat only (no relay, no local network), kept on the phone
//   event link.emoji { emoji } → an emoji pairing (bootstrap v2) waits for the computer's user to compare and confirm
// Pairing follows docs/TAILCAT.md: the QR opens a short-lived pairing node; TailPocket's connectmobile pairs this phone's
// durable Tailcat key there and returns its Link, whose payload is invitation v4; then the normal node, pinned TLS (Bridge)
// and POST /v1/pairings. The tunnel is connectmobile's (Connect, Path, Sync); Diagnose is DSH's own (dshtailcat). Both are
// in Dshtailcat.xcframework (tools/build-tailcat.sh).
import CryptoKit
import DSHKit
import Dshtailcat
import NativeShell
import UIKit

final class Link {
    private weak var host: UIViewController?
    private let vault = Vault()
    private let work = DispatchQueue(label: "dsh-link")
    private let deviceName = UIDevice.current.model
    private var scanner: Scanner?
    // One tunnel per process: a second Tailcat node with the same key leaves the new bridge's connections reset.
    private static var tunnel: Int64 = -1
    private static var bridge: Bridge?
    private static let pairOp: Int64 = 1 // connectmobile's cancellable-operation number; one pairing at a time
    private weak var view: NshAppView?

    // "Tailcat only" is an empty file in the app's Application Support: Release builds use no NSUserDefaults
    // (PrivacyInfo.xcprivacy declares no reason for it; check-testflight.sh fails an IPA that links it).
    private static var tailcatOnlyFile: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("dsh-tailcat-only")
    }
    private static var tailcatOnly: Bool {
        get { FileManager.default.fileExists(atPath: tailcatOnlyFile.path) }
        set {
            if newValue {
                try? FileManager.default.createDirectory(at: tailcatOnlyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
                _ = FileManager.default.createFile(atPath: tailcatOnlyFile.path, contents: Data())
            } else {
                try? FileManager.default.removeItem(at: tailcatOnlyFile)
            }
        }
    }

    init(host: UIViewController) {
        self.host = host
        ConnectmobileSetTailcatOnly(Link.tailcatOnly)
    }

    @MainActor
    func attach(_ view: NshAppView) {
        self.view = view
        // A new tunnel takes the setting (connectmobile reads it at Connect), so the app asks link.state again after.
        view.handle("link.tailcatOnly") { [self] data, reply in
            let on = (data as? [String: Any])?["on"] as? Bool
            work.async {
                if let on, on != Link.tailcatOnly {
                    Link.tailcatOnly = on
                    ConnectmobileSetTailcatOnly(Link.tailcatOnly)
                    Link.disconnect()
                }
                reply.resolve(["on": Link.tailcatOnly])
            }
        }
        view.handle("link.state") { [self] _, reply in work.async { self.answer(reply) { try self.state() } } }
        view.handle("link.pair") { [self] data, reply in
            let text = (data as? [String: Any])?["text"] as? String ?? ""
            work.async { self.answer(reply) { try self.pair(text) } }
        }
        view.handle("link.reset") { [self] _, reply in work.async { self.answer(reply) { Link.disconnect(); return try self.state() } } }
        view.handle("link.forget") { [self] _, reply in work.async { self.forget(); reply.resolve(nil) } }
        // Which part answers, for saying why the computer can't be reached: DshtailcatDiagnose's answer (up to eight
        // seconds, so off the link's own queue) or {error}.
        view.handle("link.diagnose") { _, reply in
            DispatchQueue.global(qos: .utility).async {
                let handle = Link.tunnel
                guard handle >= 0, let data = DshtailcatDiagnose(handle).data(using: .utf8),
                      let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { reply.resolve(["error": "no-tunnel"]); return }
                reply.resolve(o)
            }
        }
        // How the tunnel reaches the computer now: {route: "direct"}, {route: "relay", relay: code} or {route: "unknown"}.
        // Off the link's own queue: the answer may take up to three seconds (ConnectmobilePath).
        view.handle("link.path") { _, reply in
            DispatchQueue.global(qos: .utility).async {
                let handle = Link.tunnel
                var out: [String: Any] = ["route": "unknown"]
                if handle >= 0, let data = ConnectmobilePath(handle, 3000).data(using: .utf8),
                   let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let route = o["route"] as? String {
                    out["route"] = route
                    if let relay = o["relay"] as? String { out["relay"] = relay }
                }
                reply.resolve(out)
            }
        }
        view.handle("link.scan") { [self] _, reply in
            guard let host else { return reply.reject("cancelled") }
            scanner = Scanner.present(from: host) { [weak self] result in
                self?.scanner = nil
                switch result {
                case .success(let text): reply.resolve(text)
                case .failure(let e): reply.reject((e as? LinkFailure)?.code ?? e.localizedDescription)
                }
            }
        }
    }

    /// Where the app's requests go: the bridge's /dsh origin and this phone's device token.
    struct Endpoint { let origin: String, token: String }

    /// Called off the main thread.
    func endpoint() throws -> Endpoint {
        let s = try work.sync { try state() }
        guard s["paired"] as? Bool == true, let origin = s["origin"] as? String, let token = s["token"] as? String else {
            throw LinkFailure("link/not-linked")
        }
        return Endpoint(origin: origin, token: token)
    }

    private func answer(_ reply: NshHostReply, _ body: () throws -> [String: Any]) {
        do { reply.resolve(try body()) } catch { reply.reject((error as? LinkFailure)?.code ?? error.localizedDescription) }
    }

    private func saved() -> [String: Any]? {
        vault.read().flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }

    private func save(_ link: [String: Any]) throws {
        try vault.write(String(decoding: try JSONSerialization.data(withJSONObject: link), as: UTF8.self))
    }

    /// The paired computer's origin through the bridge, starting the tunnel if needed.
    private func state() throws -> [String: Any] {
        guard let link = saved(), let token = link["token"] as? String, let invitation = link["invitation"] as? String,
            let clientKey = link["clientKey"] as? String
        else { return ["paired": false] }
        let port = try Link.connect(try Invite.invitation(invitation), clientKey: clientKey, saved: link["tailpocket"] as? String,
                                    onSynced: { [weak self] in self?.saveSynced($0) })
        let cacheId = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        return ["paired": true, "origin": "http://127.0.0.1:\(port)/dsh", "token": token, "cacheId": cacheId]
    }

    private func pair(_ text: String) throws -> [String: Any] {
        let boot = try Invite.bootstrap(text.trimmingCharacters(in: .whitespacesAndNewlines), nowMs: Int64(Date().timeIntervalSince1970 * 1000))
        var link = saved() ?? [:]
        if link["clientKey"] == nil { link["clientKey"] = ConnectmobileNewKey(); try save(link) }
        let clientKey = link["clientKey"] as! String
        // 1. The pairing node: trade the QR's proof and this phone's public key for the computer's Link; its payload is the
        // invitation. The reply's address is the normal node's, so it replaces the payload's.
        // Bootstrap v2 (an emoji pairing): both screens show four emoji and the computer's user confirms there; the Link
        // then already carries the computer's routes (PairV2 syncs), so the tunnel starts from it.
        let paired: [String: Any]
        var pairedText: String?
        if let invite2 = boot.invite2 {
            var answer = ConnectmobilePair2(Link.pairOp, invite2, clientKey, deviceName, "", 90_000)
            if let shown = (try? JSONSerialization.jsonObject(with: Data(answer.utf8))) as? [String: Any], let emoji = shown["emoji"] as? [String] {
                show(emoji)
                answer = ConnectmobilePair2Finish(Link.pairOp, 180_000)
                show([])
            }
            paired = try Link.linked(answer)
            pairedText = answer
        } else {
            let invite = try JSONSerialization.data(withJSONObject: ["v": 1, "address": boot.address, "port": Invite.pairingPort,
                                                                     "key": boot.key, "proof": boot.proof, "expiresAt": boot.expiresAtMs / 1000])
            paired = try Link.linked(ConnectmobilePair(Link.pairOp, String(decoding: invite, as: UTF8.self), clientKey, deviceName, "", 90_000))
        }
        guard var payload = (paired["payload"] as? String).flatMap({ try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }),
              var tailcat = payload["tailcat"] as? [String: Any], let address = paired["address"] as? String
        else { throw LinkFailure("link/invalid") }
        tailcat["address"] = address
        payload["tailcat"] = tailcat
        let inv = try Invite.invitation(String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self))
        // 2. The computer itself, over pinned TLS: the one-time pairing token becomes this phone's device token.
        let port = try Link.connect(inv, clientKey: clientKey, saved: pairedText, onSynced: { [weak self] in self?.saveSynced($0) })
        let body = try JSONSerialization.data(withJSONObject: ["pairingToken": inv.pairingToken, "deviceName": deviceName])
        let answer = try Link.http("POST", "http://127.0.0.1:\(port)/v1/pairings", auth: nil, body: body)
        guard let device = try? JSONSerialization.jsonObject(with: answer) as? [String: Any], let token = device["deviceToken"] as? String else {
            throw LinkFailure("link/invalid")
        }
        link["invitation"] = inv.json
        link["token"] = token
        if let pairedText { link["tailpocket"] = pairedText }
        try save(link)
        return try state()
    }

    /// The four emoji to show while the computer's user compares them (none: the comparison is over).
    private func show(_ emoji: [String]) {
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.view?.send("link.emoji", ["emoji": emoji]) } }
    }

    private func forget() {
        if let token = saved()?["token"] as? String, let b = Link.bridge {
            // Offline: the computer keeps the device until its owner revokes it.
            _ = try? Link.http("DELETE", "http://127.0.0.1:\(b.port)/v1/device", auth: "Bearer \(token)", body: nil)
        }
        Link.disconnect()
        vault.clear()
    }

    /// Keeps the Link Sync returned, with the routes the computer added, for when Tailcat cannot be reached.
    private func saveSynced(_ synced: String) {
        work.async { [self] in
            guard var link = saved(), link["token"] != nil else { return }
            link["tailpocket"] = synced
            try? save(link) // the next start syncs again
        }
    }

    private static func connect(_ inv: Invitation, clientKey: String, saved: String?, onSynced: @escaping (String) -> Void) throws -> Int {
        if let bridge, bridge.serves(inv) { return bridge.port }
        // Pairing with another computer: the old tunnel and bridge reach the old one.
        disconnect()
        // connectmobile's Link: the invitation's node and this phone's key (all a phone paired before TailPocket has), or the
        // one the last Sync stored for that same node and key, which also names the computer's opaque relay.
        var linkJSON = String(decoding: try JSONSerialization.data(withJSONObject: ["address": inv.address, "port": inv.port, "name": "", "key": clientKey]), as: UTF8.self)
        if let saved, let s = (try? JSONSerialization.jsonObject(with: Data(saved.utf8))) as? [String: Any],
           s["address"] as? String == inv.address, s["key"] as? String == clientKey {
            linkJSON = saved
        }
        let normal = try started(ConnectmobileConnect(linkJSON, ""))
        tunnel = normal.handle
        do {
            bridge = try Bridge(invitation: inv, tailcatPort: normal.port, forwardToken: normal.token)
        } catch {
            disconnect()
            throw error
        }
        let handle = normal.handle
        DispatchQueue.global(qos: .utility).async {
            // Over Tailcat only, best effort: registers this phone's end-to-end key and fetches the computer's routes.
            let synced = ConnectmobileSync(handle, 30_000)
            if let o = (try? JSONSerialization.jsonObject(with: Data(synced.utf8))) as? [String: Any], o["error"] == nil { onSynced(synced) }
        }
        return bridge!.port
    }

    private static func disconnect() {
        bridge?.close()
        bridge = nil
        if tunnel >= 0 { ConnectmobileStop(tunnel); tunnel = -1 }
    }

    /// ConnectmobileConnect's answer: {"handle":n,"port":p,"token":t,"base":b} or {"error":code}.
    private static func started(_ answer: String) throws -> (handle: Int64, port: Int, token: String) {
        let o = (try? JSONSerialization.jsonObject(with: Data(answer.utf8))) as? [String: Any] ?? [:]
        if let e = o["error"] { throw LinkFailure("link/tunnel:\(e)") }
        guard let h = (o["handle"] as? NSNumber)?.int64Value, let p = (o["port"] as? NSNumber)?.intValue, let t = o["token"] as? String
        else { throw LinkFailure("link/tunnel:answer") }
        return (h, p, t)
    }

    /// ConnectmobilePair's answer: the Link, or {"error":code} worded as the app's link/ codes.
    private static func linked(_ answer: String) throws -> [String: Any] {
        let o = (try? JSONSerialization.jsonObject(with: Data(answer.utf8))) as? [String: Any] ?? [:]
        switch o["error"] as? String {
        case nil where !o.isEmpty: return o
        case "expired": throw LinkFailure("link/expired")
        case "invalid-invite": throw LinkFailure("link/invalid")
        case "unauthorized": throw LinkFailure("link/refused:401")
        case "taken": throw LinkFailure("link/refused:409")
        case "denied": throw LinkFailure("link/refused:403")
        case let e: throw LinkFailure("link/tunnel:\(e ?? "answer")")
        }
    }

    /// One request, waited for on the calling (work) queue; 410 is link/expired, other refusals link/refused:<status>.
    static func http(_ method: String, _ url: String, auth: String?, body: Data?) throws -> Data {
        var request = URLRequest(url: URL(string: url)!, timeoutInterval: 30)
        request.httpMethod = method
        if let auth { request.setValue(auth, forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = DispatchSemaphore(value: 0)
        var result: Result<(Data, Int), Error> = .failure(LinkFailure("link/tunnel:timeout"))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) } else { result = .success((data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0)) }
            done.signal()
        }.resume()
        done.wait()
        let (data, status) = try result.get()
        if status == 410 { throw LinkFailure("link/expired") }
        if status >= 400 { throw LinkFailure("link/refused:\(status)") }
        return data
    }
}
