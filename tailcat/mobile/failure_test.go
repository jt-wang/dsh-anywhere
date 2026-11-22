package dshtailcat

import (
	"encoding/json"
	"testing"
)

func fakeFailure(t *testing.T, link, failure string) {
	t.Helper()
	l, f := linkOf, lastFailureOf
	t.Cleanup(func() { linkOf, lastFailureOf = l, f })
	linkOf = func(handle int64) string {
		if handle != 7 {
			return `{"error":"unknown-handle"}`
		}
		return link
	}
	lastFailureOf = func(handle int64) string {
		if handle != 7 {
			return `{"error":"unknown-handle"}`
		}
		return failure
	}
}

func failureOf(t *testing.T, handle int64) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(Failure(handle)), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// The bound follows TailPocket's forward: max(20 s, routes × 10 s), Tailcat counted with the Link's routes.
func TestDialMsCountsTailcatAndEveryRoute(t *testing.T) {
	for _, c := range []struct {
		via  string
		want int
	}{
		{``, 20_000},
		{`,"via":[{"t":"lan","a":"192.0.2.1:7"}]`, 20_000},
		{`,"via":[{"t":"lan","a":"192.0.2.1:7"},{"t":"relay","u":"wss://relay.example"}]`, 30_000},
		{`,"via":[{"t":"lan"},{"t":"lan"},{"t":"relay"},{"t":"relay"},{"t":"relay"}]`, 60_000},
	} {
		fakeFailure(t, `{"address":"tc-test","port":48931,"name":"","key":"k"`+c.via+`}`, `{}`)
		if got := DialMs(7); got != c.want {
			t.Errorf("via %q: %d, want %d", c.via, got, c.want)
		}
	}
	if got := DialMs(8); got != 20_000 {
		t.Errorf("unknown handle: %d", got)
	}
}

func TestFailurePassesTailPocketsReasonOnly(t *testing.T) {
	link := `{"address":"tc-test","port":48931,"name":"","key":"k","via":[{"t":"lan"},{"t":"relay"}]}`
	fakeFailure(t, link, `{"code":"unreachable","reason":"handshake-closed","route":"relay","routes":[{"t":"lan","r":"no-answer"},{"t":"relay","r":"handshake-closed"}],"at":1795340000000}`)
	out := failureOf(t, 7)
	if out["reason"] != "handshake-closed" || out["code"] != "unreachable" || out["route"] != "relay" || out["dialMs"] != float64(30_000) || out["at"] != float64(1795340000000) {
		t.Fatalf("%v", out)
	}
	if _, ok := out["routes"]; ok {
		t.Fatalf("routes leaked: %v", out)
	}
	// Nothing failed since the last connection that worked: no reason, still the bound.
	fakeFailure(t, link, `{}`)
	if out := failureOf(t, 7); out["reason"] != "" || out["dialMs"] != float64(30_000) {
		t.Fatalf("none: %v", out)
	}
	// A reason this app does not know is not shown as one.
	fakeFailure(t, link, `{"code":"revoked","reason":"something-new"}`)
	if out := failureOf(t, 7); out["reason"] != "" || out["code"] != "revoked" {
		t.Fatalf("unknown reason: %v", out)
	}
	if out := failureOf(t, 8); out["error"] != "unknown-handle" {
		t.Fatalf("unknown handle: %v", out)
	}
}
