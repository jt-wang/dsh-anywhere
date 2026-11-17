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

    private func sample() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        // Stop before interacting or taking screenshots if the app is already paired.
        let start = try require("try-it")
        start.tap()
        _ = try require("try-banner")
        _ = try require("session-try-fix")
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
        let message = (1...25).map { "Reading line \($0): preserve this position." }.joined(separator: "\n")
        let composer = try require("composer")
        composer.tap()
        composer.typeText(message)
        try require("send").tap()
        XCTAssertTrue(app.staticTexts["This is a sample answer. In the real app, your message goes to the agent on your computer and its answer comes back here."].waitForExistence(timeout: 10))
        let thread = try require("thread")
        // Read a little earlier without flinging to the beginning or collapsing UIKit's navigation bar.
        let point = thread.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        point.press(forDuration: 0.05, thenDragTo: point.withOffset(CGVector(dx: 0, dy: 60)), withVelocity: .slow, thenHoldForDuration: 0.1)
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
