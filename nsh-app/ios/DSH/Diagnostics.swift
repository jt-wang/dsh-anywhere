// Opt-in system metadata and a private bounded journal. No content, network probe or periodic sampler.
import NativeShell
import UIKit

@MainActor
final class Diagnostics {
    private weak var host: UIViewController?
    private weak var view: NshAppView?
    private let work = DispatchQueue(label: "dsh-diagnostics")
    private var observers: [NSObjectProtocol] = []
    private var wanted = false
    private var active = false
    init(host: UIViewController) { self.host = host }

    // Reject unknown keys/values before either native file sink. Never accept a free-text log payload.
    private nonisolated static func allowed(_ text: String, export: Bool) -> Bool {
        func keys(_ v: [String: Any], _ names: [String]) -> Bool { Set(v.keys) == Set(names) }
        func number(_ v: Any?, _ max: Double = 1e15) -> Bool {
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
            return n.doubleValue.isFinite && n.doubleValue >= 0 && n.doubleValue <= max
        }
        func choice(_ v: Any?, _ options: [String]) -> Bool { (v as? String).map(options.contains) ?? false }
        func event(_ raw: Any) -> Bool {
            guard let e = raw as? [String: Any], keys(e, ["at", "category", "event", "fields"]), number(e["at"]), let f = e["fields"] as? [String: Any] else { return false }
            switch (e["category"] as? String, e["event"] as? String) {
            case ("interaction", "ui.action"): return keys(f, ["action"]) && choice(f["action"], ["menu", "new_chat", "settings", "back", "refresh"])
            case ("interaction", "app.lifecycle"): return keys(f, ["state"]) && choice(f["state"], ["foreground", "background"])
            case ("performance", "ui.callback_gap"): return keys(f, ["durationMs", "method"]) && number(f["durationMs"], 3600000) && choice(f["method"], ["next_task_not_fps"])
            case ("network", "rpc.complete"):
                guard Set(f.keys).isSubset(of: ["operation", "outcome", "durationMs", "status", "bytesReceived", "bytesSource"]), choice(f["operation"], ["list", "history", "projects", "capabilities", "progress", "command", "other"]), choice(f["outcome"], ["ok", "timeout", "unauthorized", "http_error", "rpc_error", "network_error"]), number(f["durationMs"], 3600000) else { return false }
                return (f["status"] == nil || number(f["status"], 599)) && (f["bytesReceived"] == nil ? f["bytesSource"] == nil : number(f["bytesReceived"], 1e12) && choice(f["bytesSource"], ["content_length"]))
            case ("resources", "os.snapshot"):
                return !f.isEmpty && Set(f.keys).isSubset(of: ["batteryPercent", "charging", "thermal", "lowPower"]) && (f["batteryPercent"] == nil || number(f["batteryPercent"], 100)) && (f["charging"] == nil || choice(f["charging"], ["charging", "full", "unplugged", "unknown"])) && (f["thermal"] == nil || choice(f["thermal"], ["nominal", "fair", "serious", "critical", "unknown"])) && (f["lowPower"] == nil || (f["lowPower"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true)
            default: return false
            }
        }
        guard let raw = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) else { return false }
        if !export { return (raw as? [Any]).map { $0.count <= 800 && $0.allSatisfy(event) } ?? false }
        guard let root = raw as? [String: Any], keys(root, ["schemaVersion", "exportId", "app", "range", "actualRange", "categories", "events"]), root["schemaVersion"] as? Int == 1,
              let id = root["exportId"] as? String, UUID(uuidString: id) != nil,
              let app = root["app"] as? [String: Any], keys(app, ["version", "build", "platform", "os", "deviceClass", "runtime"]), app["runtime"] is NSNull,
              choice(app["platform"], ["ios", "android", "unknown"]), choice(app["deviceClass"], ["phone", "tablet", "unknown"]),
              ["version", "build", "os"].allSatisfy({ key in app[key] is NSNull || ((app[key] as? String).map { $0.count <= 32 && $0.range(of: "^\\d+(?:\\.\\d+){0,3}$", options: .regularExpression) != nil } ?? false) }),
              let categories = root["categories"] as? [String], categories.count <= 4, categories.allSatisfy({ ["interaction", "performance", "network", "resources"].contains($0) }),
              let events = root["events"] as? [Any], events.count <= 800, events.allSatisfy(event) else { return false }
        return ["range", "actualRange"].allSatisfy { key in
            if key == "actualRange" && root[key] is NSNull { return true }
            guard let range = root[key] as? [String: Any], keys(range, ["from", "to"]) else { return false }
            return ["from", "to"].allSatisfy { number(range[$0]) }
        }
    }

    private nonisolated static func preferences(_ text: String) -> Bool {
        guard let v = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], Set(v.keys) == ["enabled", "categories"],
              let enabled = v["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
              let categories = v["categories"] as? [String: Any], Set(categories.keys) == ["interaction", "performance", "network", "resources"] else { return false }
        return categories.values.allSatisfy { ($0 as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true }
    }

    private nonisolated static func file(_ name: String = "journal.json", export: Bool = false) throws -> URL {
        let root = FileManager.default.urls(for: export ? .cachesDirectory : .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = root.appendingPathComponent("Diagnostics", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        return dir.appendingPathComponent(name)
    }

    func attach(_ view: NshAppView) {
        self.view = view
        view.handle("diagnostics.preferences.read") { [self] _, reply in
            work.async {
                do {
                    let url = try Self.file("preferences.json")
                    let text = FileManager.default.fileExists(atPath: url.path) ? try String(contentsOf: url, encoding: .utf8) : nil
                    if let text, !Self.preferences(text) { throw NSError(domain: "diagnostics/format", code: 1) }
                    Task { @MainActor in reply.resolve(text) }
                } catch { Task { @MainActor in reply.reject("diagnostics/preferences") } }
            }
        }
        view.handle("diagnostics.preferences.write") { [self] args, reply in
            guard let text = (args as? [String: Any])?["text"] as? String, text.utf8.count <= 1024, Self.preferences(text) else { return reply.reject("diagnostics/format") }
            work.async {
                do { try Data(text.utf8).write(to: Self.file("preferences.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); Task { @MainActor in reply.resolve(nil) } }
                catch { Task { @MainActor in reply.reject("diagnostics/preferences") } }
            }
        }
        view.handle("diagnostics.read") { [self] _, reply in
            work.async {
                do {
                    let url = try Self.file()
                    let text = FileManager.default.fileExists(atPath: url.path) ? try String(contentsOf: url, encoding: .utf8) : nil
                    Task { @MainActor in reply.resolve(text) }
                } catch { Task { @MainActor in reply.reject("diagnostics/read") } }
            }
        }
        view.handle("diagnostics.write") { [self] args, reply in
            guard let text = (args as? [String: Any])?["text"] as? String, text.utf8.count <= 131072, Self.allowed(text, export: false) else { return reply.reject("diagnostics/format") }
            work.async {
                do { try Data(text.utf8).write(to: Self.file(), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); Task { @MainActor in reply.resolve(nil) } }
                catch { Task { @MainActor in reply.reject("diagnostics/write") } }
            }
        }
        view.handle("diagnostics.clear") { [self] _, reply in
            work.async {
                do {
                    for url in [try Self.file(), try Self.file("DSH Anywhere Diagnostics.json", export: true)] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                    Task { @MainActor in reply.resolve(nil) }
                } catch { Task { @MainActor in reply.reject("diagnostics/clear") } }
            }
        }
        view.handle("diagnostics.resources") { [self] args, reply in
            wanted = (args as? [String: Any])?["enabled"] as? Bool == true
            resources(wanted && active)
            reply.resolve(nil)
        }
        view.handle("diagnostics.share") { [self] args, reply in
            guard let text = (args as? [String: Any])?["text"] as? String, text.utf8.count <= 262144, Self.allowed(text, export: true) else { return reply.reject("diagnostics/format") }
            work.async {
                do {
                    let url = try Self.file("DSH Anywhere Diagnostics.json", export: true)
                    try Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    Task { @MainActor [weak self] in
                        guard let host = self?.host, host.presentedViewController == nil else { return reply.reject("diagnostics/share") }
                        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                        sheet.popoverPresentationController?.sourceView = host.view
                        sheet.popoverPresentationController?.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
                        host.present(sheet, animated: true)
                        reply.resolve(nil)
                    }
                } catch { Task { @MainActor in reply.reject("diagnostics/share") } }
            }
        }
    }

    func setActive(_ value: Bool) { active = value; resources(wanted && active) }

    private func resources(_ enabled: Bool) {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers = []
        UIDevice.current.isBatteryMonitoringEnabled = enabled
        guard enabled else { return }
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification, ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.snapshot() }
            })
        }
        snapshot()
    }

    private func snapshot() {
        guard UIApplication.shared.applicationState != .background else { return }
        let device = UIDevice.current
        let charging: String
        switch device.batteryState { case .charging: charging = "charging"; case .full: charging = "full"; case .unplugged: charging = "unplugged"; default: charging = "unknown" }
        let thermal: String
        switch ProcessInfo.processInfo.thermalState { case .nominal: thermal = "nominal"; case .fair: thermal = "fair"; case .serious: thermal = "serious"; case .critical: thermal = "critical"; @unknown default: thermal = "unknown" }
        var data: [String: Any] = ["charging": charging, "thermal": thermal, "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]
        if device.batteryLevel >= 0 { data["batteryPercent"] = Int((device.batteryLevel * 100).rounded()) }
        view?.send("diagnostics.resource", data)
    }
}
