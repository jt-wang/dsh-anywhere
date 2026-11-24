// Measures the header of the app `nsh test --target ios` drives (src/header.test.tsx, run by tools/header-check.sh):
// for each marker `<name>.png` the test leaves in DSH_PROBE_DIR (passed as TEST_RUNNER_DSH_PROBE_DIR to xcodebuild),
// the on-screen frames of the navigation bar, its texts and the views the test names go to `<name>.json` beside it,
// in points. tools/header-check.py judges them. It runs only when DSH_PROBE_DIR is set; `xcodebuild test` without it
// skips. A `stop` file in the folder ends it.
import XCTest

final class HeaderProbe: XCTestCase {
    private static let ids = ["new-chat", "more", "connection", "chat-more", "connection-dot", "activity", "terminal-more", "header-menu", "quick-chat"]

    func testProbe() throws {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["DSH_PROBE_DIR"].map(URL.init(fileURLWithPath:)) else { throw XCTSkip("DSH_PROBE_DIR is not set") }
        // The nsh development host that `nsh test --target ios` installs and drives; it is not launched from here.
        let app = XCUIApplication(bundleIdentifier: env["DSH_PROBE_BUNDLE"] ?? "com.longbridge.nsh.host")
        executionTimeAllowance = 3 * 3600
        let files = FileManager.default
        let deadline = Date().addingTimeInterval(3 * 3600)
        try Data("{\"ready\":true}".utf8).write(to: dir.appendingPathComponent("ready.json"))
        while Date() < deadline, !files.fileExists(atPath: dir.appendingPathComponent("stop").path) {
            let markers = (try? files.contentsOfDirectory(atPath: dir.path)) ?? []
            for png in markers.filter({ $0.hasSuffix(".png") }).sorted() {
                let out = dir.appendingPathComponent(String(png.dropLast(4)) + ".json")
                if files.fileExists(atPath: out.path) { continue }
                let data = try JSONSerialization.data(withJSONObject: measure(app), options: [.sortedKeys])
                try data.write(to: out, options: .atomic)
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    private func rect(_ f: CGRect) -> [String: Double] {
        ["x": Double(f.minX), "y": Double(f.minY), "w": Double(f.width), "h": Double(f.height)]
    }

    private func measure(_ app: XCUIApplication) -> [String: Any] {
        var views: [String: Any] = [:]
        for id in Self.ids {
            let e = app.descendants(matching: .any).matching(identifier: id).firstMatch
            if e.exists { views[id] = rect(e.frame) }
        }
        let bar = app.navigationBars.firstMatch
        var texts: [[String: Any]] = []
        if bar.exists {
            for t in bar.staticTexts.allElementsBoundByIndex where !t.label.isEmpty {
                texts.append(["label": t.label, "frame": rect(t.frame)])
            }
        }
        return ["platform": "ios", "screen": rect(app.frame), "bar": bar.exists ? rect(bar.frame) : NSNull(), "texts": texts, "views": views]
    }
}
