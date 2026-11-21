package dshtailcat

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type heard struct {
	sync.Mutex
	paths []string
}

func (h *heard) Changed(p string) { h.Lock(); h.paths = append(h.paths, p); h.Unlock() }
func (h *heard) list() []string   { h.Lock(); defer h.Unlock(); return append([]string(nil), h.paths...) }

// watching answers Path with what route() says now and counts the questions.
func watching(t *testing.T, relayed []time.Duration, settled time.Duration, route func() string) (*heard, func() int) {
	t.Helper()
	p, r, s := pathOf, pathRelayed, pathSettled
	var mu sync.Mutex
	asked := 0
	pathOf = func(int64, int) string { mu.Lock(); asked++; mu.Unlock(); return route() }
	pathRelayed, pathSettled = relayed, settled
	h := &heard{}
	WatchPath(7, h)
	path.Lock()
	w := path.watch
	path.Unlock()
	t.Cleanup(func() { StopPath(); <-w.done; SetPathActive(true); pathOf, pathRelayed, pathSettled = p, r, s })
	return h, func() int { mu.Lock(); defer mu.Unlock(); return asked }
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("never: %s", what)
}

const derp = `{"route":"relay","relay":"tok","kind":"derp","derpRegion":1,"derpCode":"tok"}`
const direct = `{"route":"direct","relay":"","kind":"direct"}`

// The bug on the phone: Tailcat starts on DERP and finds the direct path seconds later. The watcher keeps
// asking while relayed, so the move is heard without anyone asking, and each path is heard once.
func TestWatchHearsTheMoveFromARelayToDirectOnce(t *testing.T) {
	var mu sync.Mutex
	now := derp
	h, asked := watching(t, []time.Duration{10 * time.Millisecond}, time.Hour, func() string { mu.Lock(); defer mu.Unlock(); return now })
	waitFor(t, "the relay heard", func() bool { return len(h.list()) == 1 })
	waitFor(t, "asked again while relayed", func() bool { return asked() >= 3 })
	mu.Lock()
	now = direct
	mu.Unlock()
	waitFor(t, "direct heard", func() bool { return len(h.list()) == 2 })
	got := h.list()
	if !strings.Contains(got[0], `"kind":"derp"`) || !strings.Contains(got[1], `"kind":"direct"`) {
		t.Fatalf("heard %q", got)
	}
	if !strings.Contains(LastPath(), `"kind":"direct"`) {
		t.Fatalf("LastPath %s", LastPath())
	}
	// Settled on direct: no more questions until a nudge, and the nudge asks at once.
	n := asked()
	time.Sleep(60 * time.Millisecond)
	if asked() != n {
		t.Fatalf("asked %d more times on a direct path", asked()-n)
	}
	NudgePath()
	waitFor(t, "a nudge asks", func() bool { return asked() == n+1 })
	if len(h.list()) != 2 {
		t.Fatalf("the same path heard twice: %q", h.list())
	}
}

func TestWatchAsksNothingWhileTheAppIsAway(t *testing.T) {
	SetPathActive(false)
	h, asked := watching(t, []time.Duration{5 * time.Millisecond}, 5*time.Millisecond, func() string { return direct })
	time.Sleep(50 * time.Millisecond)
	if asked() != 0 || len(h.list()) != 0 {
		t.Fatalf("asked %d, heard %q while away", asked(), h.list())
	}
	SetPathActive(true)
	waitFor(t, "back on screen asks", func() bool { return len(h.list()) == 1 })
}

func TestWatchReportsAnUnansweredPathAsUnknownAndStops(t *testing.T) {
	h, _ := watching(t, []time.Duration{time.Hour}, time.Hour, func() string { return `{"error":"unreachable"}` })
	waitFor(t, "unknown heard", func() bool { return len(h.list()) == 1 })
	if h.list()[0] != `{"route":"unknown"}` {
		t.Fatalf("heard %q", h.list())
	}
	StopPath()
	if LastPath() != `{"route":"unknown"}` {
		t.Fatalf("LastPath after stop %s", LastPath())
	}
}
