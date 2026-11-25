import XCTest

/// Run on an isolated simulator installation with a fresh app container.
/// These tests tap UIKit coordinates and assert the resulting screen, not a JS callback.
final class HeaderButtonsTests: XCTestCase {
    private var app = XCUIApplication()
    private struct MissingFixture: Error {}

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func require(_ id: String, file: StaticString = #filePath, line: UInt = #line) throws -> XCUIElement {
        let view = element(id)
        guard view.waitForExistence(timeout: 10) else {
            XCTFail("Expected screen element: \(id)", file: file, line: line)
            throw MissingFixture()
        }
        return view
    }

    private func screenshot(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }

    /// `trace`: the app shows the ⋯ menu's presses and states (`menuTrace`), and the test keeps them with its result.
    private func sample(trace: Bool = false) throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + (trace ? ["-dshMenuTrace", "YES"] : [])
        if trace {
            addTeardownBlock { [self] in
                let log = XCTAttachment(string: element("menu-trace").exists ? element("menu-trace").label : "no trace")
                log.name = "menu-trace"
                log.lifetime = .keepAlways
                add(log)
            }
        }
        app.launch()
        // Stop before interacting or taking screenshots if the app is already paired.
        let start = try require("try-it")
        start.tap()
        _ = try require("try-banner")
        _ = try require("session-try-fix")
    }

    /// What the home ⋯ menu saw, in order: `press` (one ⋯ delivered), `outside` (a press outside the menu), `open` and
    /// `closed`, each with its time in ms (App.tsx, DEBUG builds launched with `-dshMenuTrace YES`).
    private func menuTrace() -> [(what: String, at: Int)] {
        element("menu-trace").label.split(separator: " ").compactMap { item in
            let parts = item.split(separator: "@")
            guard parts.count == 2, let at = Int(parts[1]) else { return nil }
            return (String(parts[0]), at)
        }
    }

    private func tapHeader(_ id: String) throws {
        let button = try require(id)
        XCTAssertTrue(button.isHittable, "Header control is not hittable: \(id)")
        let center = CGPoint(x: button.frame.midX, y: button.frame.midY)
        XCTAssertTrue(app.frame.contains(center), "Header control is outside the app: \(id)")
        screenshot("before-\(id)")
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        screenshot("after-\(id)")
    }

    private func openChatAction(_ action: String) throws {
        try sample()
        try require("session-try-fix").tap()
        _ = try require("composer")
        try tapHeader("chat-more")
        // A visible button or a successful tap alone is not acceptance.
        try require("menu-\(action)").tap()
    }

    func testNewChatHeaderOpensSheetAndCreatesSampleChat() throws {
        try sample()
        try tapHeader("new-chat")
        try require("start-chat").tap()
        _ = try require("composer")
        screenshot("new-chat-composer")
    }

    // A required check before every release. 0.1.21 (22) on an iPhone: 44 pt buttons in the 36 pt header row sat
    // 4 pt below the title and reached the connection banner.
    func testChatsHeaderButtonsLineUpWithTheTitle() throws {
        try sample()
        let bar = app.navigationBars.firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "No header bar")
        let title = bar.staticTexts["Chats"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "No \"Chats\" title in the header")
        let banner = try require("try-banner")
        for id in ["new-chat", "more"] {
            let f = try require(id).frame
            XCTAssertEqual(f.midY, title.frame.midY, accuracy: 1, "\(id) center is off the title's line: \(f) vs \(title.frame)")
            XCTAssertTrue(bar.frame.insetBy(dx: -0.5, dy: -0.5).contains(f), "\(id) \(f) reaches out of the header \(bar.frame)")
            XCTAssertLessThanOrEqual(f.maxY, banner.frame.minY + 0.5, "\(id) \(f) reaches the banner \(banner.frame)")
        }
        screenshot("chats-header")
    }

    // Where a tap on a header button counts, measured on iOS 26.5: the bar item takes touches in a 36 pt band, so the
    // 36 pt button is all of it, edge to edge; its 6 pt hit slop reaches only sideways. 0.1.21's 44 pt button drew 8 pt
    // below that band, where a tap did nothing.
    private func tapAt(x: CGFloat, y: CGFloat) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
    }

    func testHomeMenuOpensFromTapsAtTheButtonsEdgesAndInsideItsHitSlop() throws {
        try sample(trace: true)
        let more = try require("more")
        let f = more.frame
        for (name, x, y) in [("2 pt inside the top", f.midX, f.minY + 2), ("2 pt inside the bottom", f.midX, f.maxY - 2),
                             ("3 pt right of it, inside its hit slop", f.maxX + 3, f.midY)] {
            let menu = element("menu-settings")
            XCTAssertFalse(menu.exists)
            tapAt(x: x, y: y)
            XCTAssertTrue(menu.waitForExistence(timeout: 5), "A tap \(name) of ⋯ \(f) did not open its menu")
            screenshot("menu-from-\(name)")
            // Close it with a tap far from the header.
            tapAt(x: 30, y: app.frame.height - 120)
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: menu)
            waitForExpectations(timeout: 5)
        }
    }

    // WANG-121: a second tap right after ⋯ closes its menu opens it again. UIKit's own double tap puts the two taps far
    // closer together than the 300 ms that 0.1.22 ignored ⋯ for after its menu closed, where this test fails: the first
    // tap closes the menu and the second is swallowed. The app's trace must show both taps delivered under 300 ms apart
    // and the menu closed between them, so a tap that never arrived, or a menu that never closed, fails as well.
    func testHomeMenuTakesASecondTapRightAfterItCloses() throws {
        try sample(trace: true)
        let more = try require("more")
        let menu = element("menu-settings")
        more.tap()
        XCTAssertTrue(menu.waitForExistence(timeout: 5), "A tap on ⋯ did not open its menu")
        let before = menuTrace()
        XCTAssertEqual(before.last(where: { $0.what != "press" && $0.what != "outside" })?.what, "open", "The trace does not show the menu open: \(before)")
        more.doubleTap()
        Thread.sleep(forTimeInterval: 1.5)
        screenshot("menu-after-double-tap")
        let after = Array(menuTrace().dropFirst(before.count))
        let presses = after.filter { $0.what == "press" }.map(\.at)
        XCTAssertEqual(presses.count, 2, "A double tap on ⋯ must deliver two presses: \(after)")
        XCTAssertTrue((0..<300).contains(presses[1] - presses[0]), "The two presses must come in order, under 300 ms apart: \(after)")
        XCTAssertEqual(after.map(\.what).filter { $0 == "open" || $0 == "closed" }, ["closed", "open"],
                       "The first tap must close the menu and the second open it: \(after)")
        XCTAssertTrue(menu.exists, "Two quick taps on ⋯ with its menu open must close it and open it again; it is closed")
    }

    func testNewChatOpensFromATapAtTheButtonsBottomEdge() throws {
        try sample()
        let f = try require("new-chat").frame
        tapAt(x: f.midX, y: f.maxY - 2)
        _ = try require("start-chat")
        screenshot("new-chat-from-edge")
    }

    func testHomeMenuOpensSchedules() throws {
        try sample()
        try tapHeader("more")
        try require("menu-schedules").tap()
        _ = try require("schedules")
        screenshot("schedules")
    }

    func testHomeMenuOpensSettings() throws {
        try sample()
        try tapHeader("more")
        try require("menu-settings").tap()
        _ = try require("settings")
        screenshot("settings")
    }

    func testChatMenuOpensFiles() throws {
        try openChatAction("files")
        _ = try require("entry-README.md")
        screenshot("files")
    }

    func testChatMenuOpensTrajectory() throws {
        try openChatAction("trajectory")
        _ = try require("trajectory")
        let call = try require("call-c-test")
        XCTAssertTrue(call.label.contains("npm test"))
        XCTAssertTrue(call.label.contains("Completed"))
        screenshot("trajectory")
    }

    func testChatMenuOpensDetails() throws {
        try openChatAction("details")
        _ = try require("details")
        screenshot("details")
    }

    func testChatMenuOpensTerminals() throws {
        try openChatAction("terminal")
        _ = try require("terminals-empty")
        screenshot("terminals")
    }

    func testSampleChatSendsAndReceivesWithTheKeyboardOpen() throws {
        try sample()
        try require("session-try-fix").tap()
        let composer = try require("composer")
        composer.tap()
        composer.typeText("Release smoke check")
        try require("send").tap()
        XCTAssertTrue(app.staticTexts["This is a sample answer. In the real app, your message goes to the agent on your computer and its answer comes back here."].waitForExistence(timeout: 10))
        screenshot("sample-reply-keyboard")
    }

    func testChatHeaderMenuPreservesReadingPosition() throws {
        try sample()
        try require("session-try-fix").tap()
        let message = (1...40).map { "Reading line \($0): preserve this position." }.joined(separator: "\n")
        let composer = try require("composer")
        composer.tap()
        composer.typeText(message)
        try require("send").tap()
        XCTAssertTrue(app.staticTexts["This is a sample answer. In the real app, your message goes to the agent on your computer and its answer comes back here."].waitForExistence(timeout: 10))
        let thread = try require("thread")
        // Read earlier without flinging to the beginning or collapsing UIKit's navigation bar. The menu puts the
        // keyboard away (keyboard.test.tsx) and the list grows by about its height: a reader that close to the end stays
        // with the end (WANG-115: 60 pt back moved the message 130 pt), so read back farther than the keyboard frees.
        // Drag in steps inside the list: a drag into the keyboard would put it away interactively first.
        let keyboard = app.keyboards.firstMatch
        var back = (keyboard.exists ? keyboard.frame.height : 0) + 180
        while back > 0 {
            let step = min(back, 200)
            let point = thread.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
            point.press(forDuration: 0.05, thenDragTo: point.withOffset(CGVector(dx: 0, dy: step)), withVelocity: .slow, thenHoldForDuration: 0.1)
            back -= step
        }
        XCTAssertTrue(keyboard.exists, "The keyboard must still be up when the header is pressed")
        let reading = app.staticTexts.matching(NSPredicate(format: "label == %@", message)).firstMatch
        XCTAssertTrue(reading.exists)
        let y = reading.frame.minY
        XCTAssertFalse(app.staticTexts["The login test fails. Can you fix it?"].isHittable, "The test must read away from the beginning before touching the header")
        try tapHeader("chat-more")
        _ = try require("menu-files")
        XCTAssertTrue(reading.exists, "Opening the menu must not discard the visible message")
        XCTAssertEqual(reading.frame.minY, y, accuracy: 2, "Opening the header menu must preserve the reading position")
    }

    func testSampleApprovalAllowsTheChatToContinue() throws {
        try sample()
        try require("session-try-delete").tap()
        try require("allow").tap()
        XCTAssertTrue(app.staticTexts["Done. The old build folder is gone."].waitForExistence(timeout: 10))
        XCTAssertFalse(element("allow").exists)
    }

    func testSampleApprovalCanBeRejected() throws {
        try sample()
        try require("session-try-delete").tap()
        try require("reject").tap()
        XCTAssertTrue(app.staticTexts["OK, I left the folder alone."].waitForExistence(timeout: 10))
    }

    func testSampleQuestionAcceptsAnAnswer() throws {
        try sample()
        try require("session-try-name").tap()
        try require("option-name-Harbor").tap()
        try require("submit-answer").tap()
        XCTAssertTrue(app.staticTexts["Good choice. The release is now called Harbor."].waitForExistence(timeout: 10))
    }

    func testSampleRunningChatCanBeStopped() throws {
        try sample()
        try require("session-try-delete").tap()
        _ = try require("allow")
        try require("stop").tap()
        let stopped = NSPredicate(format: "exists == false")
        expectation(for: stopped, evaluatedWith: element("stop"))
        waitForExpectations(timeout: 10)
        XCTAssertFalse(element("allow").exists)
        XCTAssertTrue(element("composer").isHittable)
        screenshot("sample-stopped")
    }
}
