// network.state → {online}; the `network` event {online} when the phone gains or loses its network. The link to the
// computer runs inside a Tailcat tunnel whose connections outlive a network change, so the app's socket alone never
// notices that the phone went offline (as the Android shell's NetworkWatch.java).
import Dshtailcat
import Network
import NativeShell

final class NetworkWatch {
    private let monitor = NWPathMonitor()
    private var online = true
    private var interfaces: [String] = []

    @MainActor
    func attach(_ view: NshAppView) {
        online = monitor.currentPath.status == .satisfied
        view.handle("network.state") { [self] _, reply in reply.resolve(["online": online]) }
        monitor.pathUpdateHandler = { [weak self, weak view] path in
            let now = path.status == .satisfied
            let names = path.availableInterfaces.map(\.name)
            DispatchQueue.main.async {
                guard let self else { return }
                // Another network (not every detail iOS reports of the same one) can change the route to the computer:
                // the path watch asks at once. It only asks; the connection is left as it is.
                if names != self.interfaces { self.interfaces = names; DshtailcatNudgePath() }
                guard now != self.online else { return }
                self.online = now
                view?.send("network", ["online": now])
            }
        }
        monitor.start(queue: DispatchQueue(label: "dsh-network"))
    }

    deinit { monitor.cancel() }
}
