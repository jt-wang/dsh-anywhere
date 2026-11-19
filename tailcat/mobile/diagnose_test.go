package dshtailcat

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeHandle answers linkOf, pathOf and the relay probe as a connection whose parts answer as given.
func fakeHandle(t *testing.T, relay error, path string, pathDelay time.Duration) {
	t.Helper()
	l, p, r := linkOf, pathOf, probeRegionOf
	t.Cleanup(func() { linkOf, pathOf, probeRegionOf = l, p, r })
	linkOf = func(handle int64) string {
		if handle != 7 {
			return `{"error":"unknown-handle"}`
		}
		return `{"address":"tc-test","port":48931,"name":"","key":"privkey:…"}`
	}
	pathOf = func(_ int64, timeoutMs int) string {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
		defer cancel()
		select {
		case <-time.After(pathDelay):
			return path
		case <-ctx.Done():
			return `{"error":"timeout"}`
		}
	}
	probeRegionOf = func(context.Context, string) error { return relay }
}

func diagnose(t *testing.T, handle int64) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(Diagnose(handle)), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDiagnoseSaysWhichPartAnswers(t *testing.T) {
	for _, c := range []struct {
		name              string
		relay             error
		path              string
		wantRelay, wantPC string
	}{
		{"everything answers", nil, `{"route":"direct","relay":""}`, "reachable", "reachable"},
		{"the relay answers and the computer does not", nil, `{"error":"unreachable"}`, "reachable", "unreachable"},
		{"nothing answers", io.EOF, `{"error":"timeout"}`, "unreachable", "unreachable"},
		{"a phone removed on the computer gets no answer", nil, `{"error":"revoked"}`, "reachable", "unreachable"},
		{"the computer's answer came through a relay, whatever the probe said", io.EOF, `{"route":"relay","relay":"fra"}`, "reachable", "reachable"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeHandle(t, c.relay, c.path, 20*time.Millisecond)
			out := diagnose(t, 7)
			if out["relay"] != c.wantRelay || out["computer"] != c.wantPC {
				t.Fatalf("got %v", out)
			}
			if latency, ok := out["latencyMs"].(float64); (c.wantPC == "reachable") != ok || (ok && latency < 20) {
				t.Fatalf("latency only with an answer, and as long as it took: %v", out)
			}
		})
	}
	fakeHandle(t, nil, `{"route":"direct"}`, 0)
	if Diagnose(987654) != `{"error":"unknown-handle"}` {
		t.Fatal("unknown handle")
	}
}

// A computer that stays silent uses up the whole limit. The relay's answer, in long before, still counts: seen on the
// emulator on 2026-11-03, a revoked phone was told its network blocked the relay about half the time.
func TestDiagnoseKeepsTheRelaysAnswerWhenTheComputerStaysSilent(t *testing.T) {
	defer func(d time.Duration) { diagnoseLimit = d }(diagnoseLimit)
	diagnoseLimit = 5 * time.Millisecond
	fakeHandle(t, nil, `{"route":"direct"}`, time.Hour)
	for i := 0; i < 60; i++ {
		if out := diagnose(t, 7); out["relay"] != "reachable" || out["computer"] != "unreachable" {
			t.Fatalf("run %d: %v", i, out)
		}
	}
}

func TestRelayProbeNeedsARealTLSAnswer(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	host, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := probeRelay(ctx, []relayNode{{host: "relay.test", dial: host, port: port}}, true); err != nil {
		t.Fatalf("a relay that answers: %v", err)
	}
	// A network that lets the connection open and then answers with anything but TLS blocks it too.
	plain, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Close()
	go func() {
		for {
			c, err := plain.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("HTTP/1.1 403 Forbidden\r\n\r\n"))
			c.Close()
		}
	}()
	_, plainPort, _ := net.SplitHostPort(plain.Addr().String())
	if probeRelay(ctx, []relayNode{{host: "relay.test", dial: "127.0.0.1", port: plainPort}}, true) == nil {
		t.Fatal("a filter's plain answer counted as the relay")
	}
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	_, closedPort, _ := net.SplitHostPort(closed.Addr().String())
	closed.Close()
	if probeRelay(ctx, []relayNode{{host: "relay.test", dial: "127.0.0.1", port: closedPort}}, true) == nil {
		t.Fatal("a closed port counted as the relay")
	}
	// One relay that answers is enough; none to try is not; a link without a Tailcat address has none.
	if err := probeRelay(ctx, []relayNode{{host: "relay.test", dial: "127.0.0.1", port: closedPort}, {host: "relay.test", dial: host, port: port}}, true); err != nil {
		t.Fatalf("second relay: %v", err)
	}
	if probeRelay(ctx, nil, true) == nil || probeRegion(ctx, "") == nil {
		t.Fatal("no relays counted as reachable")
	}
}
