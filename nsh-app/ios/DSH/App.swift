// One full-screen NshAppView running the bundled `nsh` folder (built from ../nsh-app by ios/build.sh), with the host
// functions the Android shell gives the same app (android/app/src/main/java/dev/dshmobile/nsh). The app draws under
// the status bar and home indicator itself (its safe areas).
import NativeShell
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Notify.shared.start() // before launch ends, so a tapped notification that started the app reaches it
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var shell: ShellController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        var pair = options.urlContexts.lazy.compactMap { self.pairText($0.url) }.first
        #if DEBUG
        // Simulator checks without a camera or a tap: `simctl launch … -dshPair dshm1:…` starts as a scanned code would.
        pair = pair ?? UserDefaults.standard.string(forKey: "dshPair").flatMap { $0.hasPrefix("dshm1:") ? $0 : nil }
        #endif
        let shell = ShellController(pair: pair)
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = .dshBackground
        window.rootViewController = shell
        window.makeKeyAndVisible()
        self.window = window
        self.shell = shell
    }

    /// A pairing QR opened while the app runs (the system camera, a link): the app's `pair` event.
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        for c in contexts { if let text = pairText(c.url) { shell?.pair(text) } }
    }

    private func pairText(_ url: URL) -> String? {
        let s = url.absoluteString
        return s.hasPrefix("dshm1:") ? s : nil
    }

    func sceneDidEnterBackground(_ scene: UIScene) { shell?.diagnosticActive(false) }
    func sceneDidBecomeActive(_ scene: UIScene) { shell?.diagnosticActive(true) }
}

final class ShellController: UIViewController {
    private let app = NshAppView()
    private let pairAtStart: String?
    private var link: Link!
    private var files: Files!
    private var modules: Modules!
    private var network: NetworkWatch!
    private var diagnostics: Diagnostics!
    private var voice: Voice!

    init(pair: String?) {
        pairAtStart = pair
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func loadView() {
        app.backgroundColor = .dshBackground
        view = app
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        app.onError = { message in NSLog("nsh: %@", message) }
        // As the Android shell's setLimits(2047, 0, MAX, MAX, MAX): a chat's history and markdown need the room.
        app.limits = NshLimits(memoryMB: 2047, loadBudget: 10_000_000, callBudget: 10_000_000, maxNodes: .max)
        // The installed phone app, not the NSH runtime or the linked computer.
        app.handle("app.info") { _, reply in
            guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                  let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String else {
                return reply.reject("app.info/unavailable")
            }
            reply.resolve(["version": version, "build": build, "os": UIDevice.current.systemVersion,
                           "deviceClass": UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"])
        }
        // The phone's 12- or 24-hour clock from its settings: the times of day the app shows follow it (src/clock.ts).
        app.handle("app.clock") { _, reply in
            let format = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .autoupdatingCurrent) ?? ""
            reply.resolve(["hourCycle": format.contains("a") ? "h12" : "h23"])
        }
        diagnostics = Diagnostics(host: self)
        diagnostics.attach(app)
        modules = Modules(host: self)
        modules.attach(app) // generated interfaces (`ui.open`)
        link = Link(host: self)
        link.attach(app) // the link to the owner's computer (`link.*`)
        files = Files(host: self, link: link)
        files.attach(app) // a file for a message (`files.pick`)
        voice = Voice()
        voice.attach(app) // foreground microphone capture (`voice.*`)
        Haptics.attach(app) // the phone's feedback (`haptic`)
        network = NetworkWatch()
        network.attach(app) // whether the phone has a network (`network.state`, `network`)
        Notify.shared.attach(app) // news while the app is away, and the way back to its chat (`notify.*`, `app.state`)
        var params: [String: Any] = [:]
        if let pairAtStart { params["pair"] = pairAtStart }
        if let open = Notify.shared.takePendingOpen() { params["open"] = open }
        #if DEBUG
        // UI tests only: `-dshMenuTrace YES` shows the ⋯ menu's presses and states to them (App.tsx).
        if UserDefaults.standard.bool(forKey: "dshMenuTrace") { params["menuTrace"] = true }
        #endif
        if !params.isEmpty { app.params = params }
        guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
            return NSLog("nsh: the app bundle is missing (ios/build.sh copies it)")
        }
        do { try app.loadBundle(at: bundle) } catch { NSLog("nsh: %@", "\(error)") }
    }

    func pair(_ text: String) { app.send("pair", ["text": text]) }
    func diagnosticActive(_ active: Bool) { diagnostics?.setActive(active) }

    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
}

extension UIColor {
    /// The app's `background` token (nsh.json), light and dark: what shows before the app's first frame.
    static let dshBackground = UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: 0x14120B) : UIColor(rgb: 0xF7F7F4) }
    static let dshForeground = UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: 0xEDECEC) : UIColor(rgb: 0x26251E) }

    convenience init(rgb: Int) {
        self.init(red: CGFloat(rgb >> 16 & 0xFF) / 255, green: CGFloat(rgb >> 8 & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

/// The shell's own few words (<language>.lproj/Localizable.strings, as Android's res/values-*). iOS picks the language
/// from the ones Info.plist lists, the same choice that sets the locale NSH gives the app (`NSLocale.currentLocale`):
/// before Chinese was listed, a phone set to Chinese gave en_CN (simulator, 2026-10-30).
enum Words {
    static var done: String { NSLocalizedString("done", comment: "") }
    static var scanTitle: String { NSLocalizedString("scan_title", comment: "") }
    static var notifyAnswer: String { NSLocalizedString("notify_answer", comment: "") }
    static var notifyFailed: String { NSLocalizedString("notify_failed", comment: "") }
    static var notifyDecision: String { NSLocalizedString("notify_decision", comment: "") }
}
