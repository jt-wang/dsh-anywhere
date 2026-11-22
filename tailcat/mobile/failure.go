package dshtailcat

import (
	"encoding/json"

	"github.com/jt-wang/tailpocket/connectmobile"
)

// lastFailureOf is connectmobile.LastFailure, replaced in tests.
var lastFailureOf = connectmobile.LastFailure

// DialMs is how long a connection through the handle's forward may take before it ends: TailPocket's
// forward bounds each dial by max(20 s, routes × 10 s), routes being Tailcat and every route the
// computer's Link names (docs/PROTOCOL.md of tailpocket v0.3.6, connectphone Session.Forward). The
// Link counts every route it names, so this is never shorter than the forward's own bound; the app
// waits at least this long before it gives up, or TailPocket records the dial it gave up on as
// no-answer. 20000 for a handle connectmobile.Connect did not return.
func DialMs(handle int64) int {
	var link struct {
		Via   []json.RawMessage `json:"via"`
		Error string            `json:"error"`
	}
	routes := 1
	if json.Unmarshal([]byte(linkOf(handle)), &link) == nil && link.Error == "" {
		routes += len(link.Via)
	}
	return max(20_000, routes*10_000)
}

// Failure is why the handle's last connection attempt failed, for the message the person sees:
// {"reason":r,"code":c,"route":t,"at":unixMillis,"dialMs":n}. reason is TailPocket's
// ("refused", "handshake-closed", "no-answer", "relay-down", or "" when code says it or nothing
// failed since the last connection that worked); dialMs is DialMs. {"error":"unknown-handle"} for a
// handle connectmobile.Connect did not return.
//
// None of it is authenticated: anything on the network can refuse a connection, close a handshake or
// pose as the relay. It must never unpair, forget the link or replace the computer's pinned key.
func Failure(handle int64) string {
	var f struct {
		Code   string `json:"code"`
		Reason string `json:"reason"`
		Route  string `json:"route"`
		At     int64  `json:"at"`
		Error  string `json:"error"`
	}
	if json.Unmarshal([]byte(lastFailureOf(handle)), &f) != nil || f.Error != "" {
		return `{"error":"unknown-handle"}`
	}
	switch f.Reason {
	case "refused", "handshake-closed", "no-answer", "relay-down":
	default:
		f.Reason = ""
	}
	body, _ := json.Marshal(map[string]any{"reason": f.Reason, "code": f.Code, "route": f.Route, "at": f.At, "dialMs": DialMs(handle)})
	return string(body)
}
