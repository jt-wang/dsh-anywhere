package dshtailcat

import (
	"encoding/json"
	"sync"
	"time"
)

// PathListener hears how the tunnel reaches the computer, each time that changes: connectmobile.Path's
// answer ({"route","relay","kind","derpRegion","derpCode","derpHost","relayHost"}), or {"route":"unknown"}
// while it does not answer. The app shows it as the one source of "direct" or "through a relay".
type PathListener interface {
	Changed(path string)
}

// How often the watcher asks. TailPocket and Tailcat report no path change (connectphone Session.Route
// and tailcat Client.DiscoPing are questions), so the watcher asks: soon and then less often while the
// path is a relay, since Tailcat moves to a direct path a few seconds after it connects and the ping
// itself nudges it there; once a minute on a direct or local path, which can fall back to a relay
// without telling. A network change or the app coming back asks at once (NudgePath).
var (
	pathAskLimit = 3 * time.Second
	pathRelayed  = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 15 * time.Second, 30 * time.Second}
	pathSettled  = time.Minute
)

type pathWatch struct {
	handle   int64
	listener PathListener
	nudge    chan struct{}
	stop     chan struct{}
	done     chan struct{} // closed as run returns
}

var path struct {
	sync.Mutex
	watch  *pathWatch
	active bool
	last   string
}

func init() { path.active = true }

// WatchPath follows the route of tunnel handle and tells listener when it changes, the first answer
// included; it replaces the watch of an earlier tunnel. It asks only while the app is on screen
// (SetPathActive).
func WatchPath(handle int64, listener PathListener) {
	if listener == nil {
		return
	}
	w := &pathWatch{handle, listener, make(chan struct{}, 1), make(chan struct{}), make(chan struct{})}
	path.Lock()
	if path.watch != nil {
		close(path.watch.stop)
	}
	path.watch, path.last = w, ""
	path.Unlock()
	go w.run()
}

// StopPath ends the watch (the tunnel stopped); the last path is forgotten.
func StopPath() {
	path.Lock()
	defer path.Unlock()
	if path.watch != nil {
		close(path.watch.stop)
		path.watch = nil
	}
	path.last = ""
}

// SetPathActive pauses the watch while the app is away and asks at once when it is back.
func SetPathActive(on bool) {
	path.Lock()
	was := path.active
	path.active = on
	path.Unlock()
	if on && !was {
		NudgePath()
	}
}

// NudgePath asks now: the phone's network changed or the connection was made again.
func NudgePath() {
	path.Lock()
	w := path.watch
	path.Unlock()
	if w != nil {
		select {
		case w.nudge <- struct{}{}:
		default:
		}
	}
}

// LastPath is the path the listener heard last, {"route":"unknown"} before the first answer.
func LastPath() string {
	path.Lock()
	defer path.Unlock()
	if path.last == "" {
		return `{"route":"unknown"}`
	}
	return path.last
}

func (w *pathWatch) run() {
	defer close(w.done)
	step := 0
	for {
		path.Lock()
		active := path.active
		path.Unlock()
		wait := pathSettled
		if active {
			now, settled := w.ask()
			path.Lock()
			if path.watch != w {
				path.Unlock()
				return
			}
			changed := now != path.last
			path.last = now
			path.Unlock()
			if changed {
				w.listener.Changed(now)
				step = 0
			}
			if !settled {
				wait = pathRelayed[min(step, len(pathRelayed)-1)]
				step++
			}
		}
		select {
		case <-w.stop:
			return
		case <-w.nudge:
			step = 0
		case <-time.After(wait):
		}
	}
}

// ask returns the route as the listener hears it, and whether it is direct or local (the best there is).
func (w *pathWatch) ask() (string, bool) {
	var p struct {
		Route      string `json:"route"`
		Relay      string `json:"relay,omitempty"`
		Kind       string `json:"kind,omitempty"`
		DERPRegion int    `json:"derpRegion,omitempty"`
		DERPCode   string `json:"derpCode,omitempty"`
		DERPHost   string `json:"derpHost,omitempty"`
		RelayHost  string `json:"relayHost,omitempty"`
		Error      string `json:"error,omitempty"`
	}
	if json.Unmarshal([]byte(pathOf(w.handle, int(pathAskLimit/time.Millisecond))), &p) != nil || p.Error != "" || p.Route == "" {
		return `{"route":"unknown"}`, false
	}
	p.Error = ""
	body, err := json.Marshal(p)
	if err != nil {
		return `{"route":"unknown"}`, false
	}
	return string(body), p.Kind == "direct" || p.Kind == "lan"
}
