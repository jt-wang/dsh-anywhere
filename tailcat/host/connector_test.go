package main

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jt-wang/tailpocket/connectmobile"
	"github.com/jt-wang/tailpocket/connectrelay"
	"github.com/tailscale/tailcat"
	"tailscale.com/envknob"
	"tailscale.com/net/netcheck"
	"tailscale.com/syncs"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration"
	"tailscale.com/types/key"
)

// Real Tailcat nodes against a DERP server in this process: no internet. As in tailcat's own tests,
// skip the portmapper and captive portal probes, which reach the real network.
func TestMain(m *testing.M) {
	envknob.Setenv("IN_TS_TEST", "true")
	netcheck.HookStartCaptivePortalDetection.SetForTest(func(context.Context, *netcheck.Client, *tailcfg.DERPMap, tailcfg.DERPRegionID, func(bool)) (<-chan struct{}, func()) {
		return syncs.ClosedChan(), func() {}
	})
	os.Exit(m.Run())
}

// helper runs Run over pipes and decodes every event.
type helper struct {
	t      *testing.T
	write  *io.PipeWriter
	events chan map[string]any
	done   chan error
	once   sync.Once
}

func runHelper(t *testing.T, cfg map[string]any) *helper {
	t.Helper()
	input, write := io.Pipe()
	read, output := io.Pipe()
	h := &helper{t: t, write: write, events: make(chan map[string]any, 64), done: make(chan error, 1)}
	go func() {
		defer close(h.events)
		dec := json.NewDecoder(read)
		for {
			var e map[string]any
			if dec.Decode(&e) != nil {
				return
			}
			h.events <- e
		}
	}()
	go func() { h.done <- Run(input, output, Option{Signals: make(chan os.Signal)}); _ = output.Close() }()
	t.Cleanup(func() { h.stop() })
	h.send(cfg)
	return h
}

func (h *helper) send(v any) {
	h.t.Helper()
	if json.NewEncoder(h.write).Encode(v) != nil {
		h.t.Fatal("IPC write failed")
	}
}

func (h *helper) event(kind string) map[string]any {
	h.t.Helper()
	select {
	case e := <-h.events:
		if e["event"] != kind {
			h.t.Fatalf("event %v, want %s", e, kind)
		}
		return e
	case <-time.After(30 * time.Second):
		h.t.Fatalf("timeout waiting for %s", kind)
		return nil
	}
}

// persisted takes a persist event, checks its allowlist and acknowledges it.
func (h *helper) persisted(allowed ...string) map[string]any {
	h.t.Helper()
	e := h.event("persist")
	got, _ := json.Marshal(e["allowedClients"])
	want, _ := json.Marshal(append([]string{}, allowed...))
	if string(got) != string(want) {
		h.t.Fatalf("persisted allowlist %s, want %s", got, want)
	}
	h.send(map[string]any{"command": "ack", "id": e["id"], "ok": true})
	return e
}

func (h *helper) stop() {
	h.once.Do(func() {
		_ = h.write.Close()
		select {
		case <-h.done:
		case <-time.After(10 * time.Second):
			h.t.Error("helper did not stop on stdin EOF")
		}
	})
}

// dshState is what DSH's own helper persisted before TailPocket (marshalState, protocol 3).
func dshState(t *testing.T, private key.NodePrivate, psk tailcat.PresharedKey, region *tailcfg.DERPRegion) string {
	t.Helper()
	k, _ := private.MarshalText()
	p, _ := psk.MarshalText()
	r, _ := json.Marshal(region)
	body, _ := json.Marshal(map[string]any{"version": 1, "privateKey": string(k), "presharedKey": string(p), "region": json.RawMessage(r)})
	return string(body)
}

// oldAddress is the address DSH's own helper gave phones for this identity: a bare tailcat.Server
// with the same key, pre-shared key and region (node.go realStart before TailPocket).
func oldAddress(t *testing.T, private key.NodePrivate, psk tailcat.PresharedKey, region *tailcfg.DERPRegion) string {
	t.Helper()
	s := &tailcat.Server{Key: private, PresharedKey: psk, Region: region, AllowedClients: []key.NodePublic{key.NewNode().Public()}, Logf: func(string, ...any) {}}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	return string(s.TailcatAddr())
}

// savedIdentity is connecthost's identity text inside a persisted state (the helper's envelope).
func savedIdentity(t *testing.T, state any) string {
	t.Helper()
	text, _ := state.(string)
	var env savedState
	if json.Unmarshal([]byte(text), &env) != nil || env.TailPocket != envelopeVersion || env.Identity == "" {
		t.Fatalf("persisted state is not the helper's envelope")
	}
	return env.Identity
}

// companion is the stand-in for the companion's loopback TLS listener; phones pin its certificate.
func companion(t *testing.T) (*httptest.Server, int) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "companion:"+r.URL.Path) }))
	t.Cleanup(srv.Close)
	return srv, srv.Listener.Addr().(*net.TCPAddr).Port
}

// pinnedGet speaks TLS to the companion over c, trusting only its certificate, and returns the body.
func pinnedGet(c net.Conn, srv *httptest.Server, path string) (string, error) {
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	conn := tls.Client(c, &tls.Config{RootCAs: pool, ServerName: "example.com", MinVersion: tls.VersionTLS12})
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := io.WriteString(conn, "GET "+path+" HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"); err != nil {
		return "", err
	}
	raw, err := io.ReadAll(conn)
	_, body, _ := strings.Cut(string(raw), "\r\n\r\n")
	return body, err
}

func TestIdentityTextMapsDSHStateOneToOne(t *testing.T) {
	private, psk := key.NewNode(), tailcat.NewPresharedKey()
	region := &tailcfg.DERPRegion{RegionID: 19, RegionCode: "fix", Nodes: []*tailcfg.DERPNode{{Name: "fix", RegionID: 19, HostName: "loopback.invalid", DERPPort: 443}}}
	raw, _ := json.Marshal(dshState(t, private, psk, region))
	text, keys, code := identityText(raw)
	var doc struct {
		V            int
		Key, PSK     string
		Region       *tailcfg.DERPRegion
		Noise, Relay string
	}
	if code != "" || keys != nil || json.Unmarshal([]byte(text), &doc) != nil {
		t.Fatalf("migration failed: %q", code)
	}
	k, _ := private.MarshalText()
	p, _ := psk.MarshalText()
	if doc.V != 1 || doc.Key != string(k) || doc.PSK != string(p) || doc.Region == nil || doc.Region.RegionID != 19 || len(doc.Region.Nodes) != 1 || doc.Noise != "" || doc.Relay != "" {
		t.Fatalf("fields do not map one to one: %+v", doc)
	}
	// connecthost's own identity passes through; null means a fresh identity.
	// connecthost's own identity (pre.3 builds) passes through; this helper's envelope carries the keys.
	again, _ := json.Marshal(text)
	if same, _, code := identityText(again); code != "" || same != text {
		t.Fatal("a connecthost identity must pass through unchanged")
	}
	phoneKeys := map[string]string{key.NewNode().Public().String(): "bm9pc2U"}
	wrapped, _ := json.Marshal(envelope(text, phoneKeys))
	if same, got, code := identityText(wrapped); code != "" || same != text || len(got) != 1 {
		t.Fatal("the envelope must give back identity and keys")
	}
	if fresh, _, code := identityText(json.RawMessage("null")); fresh != "" || code != "" {
		t.Fatal("null state")
	}
	for _, bad := range []string{`"not-json"`, `"{\"version\":2}"`, `"{\"version\":1,\"privateKey\":\"privkey:00\"}"`, `{"version":1}`, `""`, `"{\"tailpocket\":1}"`, `"{\"tailpocket\":2,\"identity\":\"x\"}"`} {
		if _, _, code := identityText(json.RawMessage(bad)); code != errState {
			t.Fatalf("%s: want %s, got %q", bad, errState, code)
		}
	}
}

func TestInvalidConfigurationRejectedBeforeStart(t *testing.T) {
	client := key.NewNode().Public().String()
	cases := []struct{ body, want, leak string }{
		{`not json`, errRequest, ""},
		{`{"version":2,"localPort":8080,"state":null,"allowedClients":[]}`, errVersion, ""},
		{`{"version":3,"localPort":80,"state":null,"allowedClients":[]}`, errPort, ""},
		{`{"version":3,"localPort":65535,"state":null,"allowedClients":[]}`, errPort, ""},
		{`{"version":3,"localPort":8080,"state":null,"allowedClients":["` + client + `","` + client + `"]}`, errAllowlist, ""},
		{`{"version":3,"localPort":8080,"state":null,"allowedClients":["nodekey:00"]}`, errClientKey, "nodekey:00"},
		{`{"version":3,"localPort":8080,"state":"not-json","allowedClients":[]}`, errState, "not-json"},
		{`{"version":3,"localPort":8080,"state":"{\"v\":1,\"key\":\"privkey:00\"}","allowedClients":[]}`, errState, "privkey:00"},
		{`{"version":3,"localPort":8080,"state":{"version":1},"allowedClients":[]}`, errState, ""},
		{`{"version":3,"localPort":8080,"state":null,"allowedClients":[],"relays":[{"url":"ws://192.0.2.1","token":"secret-token"}]}`, errRelay, "secret-token"},
		{`{"version":3,"localPort":8080,"state":null,"allowedClients":[],"relays":[{"url":"wss://relay.example","token":""}]}`, errRelay, ""},
		{`{"version":3,"localPort":8080,"state":null,"allowedClients":[],"tailcatOnly":true,"relays":[{"url":"wss://relay.example","token":"t"}]}`, errConfig, ""},
		{`{"version":3,"localPort":8080,"padding":"` + strings.Repeat("x", 70000) + `"}`, errRequest, ""},
	}
	for _, tc := range cases {
		var out strings.Builder
		err := Run(strings.NewReader(tc.body+"\n"), &out, Option{Signals: make(chan os.Signal)})
		if err == nil || strings.TrimSpace(out.String()) != `{"event":"error","code":"`+tc.want+`"}` {
			t.Fatalf("%s: got %q", tc.want, out.String())
		}
		if tc.leak != "" && strings.Contains(out.String(), tc.leak) {
			t.Fatal("rejection echoed input")
		}
	}
}

// A computer paired before TailPocket keeps its Tailcat address and allowlist, and a phone that kept
// its old invitation v4 (address, port 48931, durable key) still reaches the companion's TLS listener.
func TestMigratedStateKeepsAddressAllowlistAndOldPhoneConnects(t *testing.T) {
	dm := integration.RunDERPAndSTUN(t, func(string, ...any) {}, "127.0.0.1")
	region := dm.Regions[1]
	private, psk := key.NewNode(), tailcat.NewPresharedKey()
	phoneKey := connectmobile.NewKey()
	phone := connectmobile.PublicKey(phoneKey)
	stored := oldAddress(t, private, psk, region) // what the old phone keeps in its invitation v4
	srv, port := companion(t)

	h := runHelper(t, map[string]any{"version": 3, "localPort": port, "state": dshState(t, private, psk, region), "allowedClients": []string{phone}, "name": "Studio Mac"})
	// Start saves the migrated identity (once for the keys connecthost adds, again as the main node
	// starts), always with the same allowlist, before it says ready.
	saved := h.persisted(phone)
	saved = h.persisted(phone)
	ready := h.event("ready")
	if ready["address"] != stored {
		t.Fatal("the migrated main node has another Tailcat address than the one phones stored")
	}
	k, _ := private.MarshalText()
	p, _ := psk.MarshalText()
	var doc struct {
		V            int
		Key, PSK     string
		Noise, Relay string
	}
	if json.Unmarshal([]byte(savedIdentity(t, saved["state"])), &doc) != nil || doc.V != 1 || doc.Key != string(k) || doc.PSK != string(p) || doc.Noise == "" || doc.Relay == "" {
		t.Fatal("the saved state is not connecthost's identity for the same keys")
	}

	// The old phone: nothing but its stored address, port 48931 and durable key.
	link, _ := json.Marshal(map[string]any{"address": stored, "port": 48931, "name": "", "key": phoneKey})
	var fwd struct {
		Handle int64
		Port   int
		Token  string
		Error  string
	}
	if json.Unmarshal([]byte(connectmobile.Connect(string(link), "")), &fwd) != nil || fwd.Error != "" {
		t.Fatalf("connect: %s", fwd.Error)
	}
	defer connectmobile.Stop(fwd.Handle)
	c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", itoa(fwd.Port)))
	if err != nil {
		t.Fatal(err)
	}
	// A raw (TLS) connection through the forward starts with TP-FWD and the connection's token.
	if _, err := io.WriteString(c, "TP-FWD "+fwd.Token+"\n"); err != nil {
		t.Fatal(err)
	}
	if body, err := pinnedGet(c, srv, "/v1/workspaces"); body != "companion:/v1/workspaces" {
		t.Fatalf("old phone did not reach the companion: %q %v", body, err)
	}

	// The next start reads connecthost's identity as it is and keeps the address.
	h.stop()
	again := runHelper(t, map[string]any{"version": 3, "localPort": port, "state": saved["state"], "allowedClients": []string{phone}, "name": "Studio Mac"})
	if next := again.persisted(phone); next["state"] != saved["state"] {
		t.Fatal("restart rewrote the identity")
	}
	if ready := again.event("ready"); ready["address"] != stored {
		t.Fatal("restart from the migrated identity moved the address")
	}
}

// A new phone pairs through TailPocket: the reply carries DSH's invitation v4 as payload, the host has
// stored the phone before the reply, and removing it persists and stops the main node.
func TestPairingCarriesTheInvitationInThePayload(t *testing.T) {
	dm := integration.RunDERPAndSTUN(t, func(string, ...any) {}, "127.0.0.1")
	_, port := companion(t)
	// A computer that never paired a phone has no region yet: the helper picks it at start, so the first
	// phone's invitation already names the main node's real address.
	pickRegion = func(context.Context) (*tailcfg.DERPRegion, error) { return dm.Regions[1], nil }
	t.Cleanup(func() { pickRegion = defaultPickRegion })
	h := runHelper(t, map[string]any{"version": 3, "localPort": port, "state": nil, "allowedClients": []string{}, "name": " Owner\x07's Mac "})
	h.persisted()
	if ready := h.event("ready"); ready["address"] != "" {
		t.Fatal("a computer without phones advertised an address")
	}
	template := `{"version":4,"tailcat":{"address":"$TAILCAT_ADDRESS","port":48931},"client":"$PHONE_KEY"}`
	h.send(map[string]any{"command": "pair", "invitation": template})
	e := h.event("pairing")
	if e["port"] != float64(pairingPort) || len(e["proof"].(string)) != 43 || !strings.HasPrefix(e["key"].(string), "privkey:") || len(e) != 6 {
		t.Fatalf("pairing event %v", e)
	}
	phoneKey := connectmobile.NewKey()
	phone := connectmobile.PublicKey(phoneKey)
	invite, _ := json.Marshal(map[string]any{"v": 1, "address": e["address"], "port": e["port"], "key": e["key"], "proof": e["proof"], "expiresAt": e["expiresAt"]})
	replies := make(chan string, 1)
	go func() { replies <- connectmobile.Pair(1, string(invite), phoneKey, "Test phone", "", 60000) }()
	h.persisted(phone)
	paired := h.event("paired")
	var link struct {
		Address, Name, Payload, Error string
		Port                          int
	}
	if json.Unmarshal([]byte(<-replies), &link) != nil || link.Error != "" {
		t.Fatalf("pair: %s", link.Error)
	}
	if paired["client"] != phone || paired["address"] != link.Address || link.Port != virtualPort || link.Name != "Owner's Mac" {
		t.Fatalf("paired %v, link %+v", paired, link)
	}
	// No main node ran before this phone, and still the payload names its address.
	if link.Address == "" || link.Payload != `{"version":4,"tailcat":{"address":"`+link.Address+`","port":48931},"client":"`+phone+`"}` {
		t.Fatalf("payload %s", link.Payload)
	}
	h.send(map[string]any{"command": "cancelPairing"})
	h.event("pairingClosed")
	h.send(map[string]any{"command": "setAllowed", "allowedClients": []string{"nodekey:bad"}})
	if e := h.event("error"); e["code"] != errClientKey {
		t.Fatal("invalid setAllowed key")
	}
	h.send(map[string]any{"command": "setAllowed", "allowedClients": []string{}})
	h.persisted()
	if ready := h.event("ready"); ready["address"] != "" {
		t.Fatal("an empty allowlist must stop the main node")
	}
	h.send(map[string]any{"command": "nope"})
	if e := h.event("error"); e["code"] != errCommand {
		t.Fatal("unknown command")
	}
}

// An allowlist the host sends again unchanged is persisted with the stored identity, never null:
// null would make the host forget the identity and move the address.
func TestUnchangedAllowlistKeepsTheStoredIdentity(t *testing.T) {
	dm := integration.RunDERPAndSTUN(t, func(string, ...any) {}, "127.0.0.1")
	first := runHelper(t, map[string]any{"version": 3, "localPort": 18080, "state": dshState(t, key.NewNode(), tailcat.NewPresharedKey(), dm.Regions[1]), "allowedClients": []string{}, "name": ""})
	stored := first.persisted()["state"]
	first.event("ready")
	first.stop()
	h := runHelper(t, map[string]any{"version": 3, "localPort": 18080, "state": stored, "allowedClients": []string{}, "name": ""})
	h.event("ready") // nothing new to save
	h.send(map[string]any{"command": "setAllowed", "allowedClients": []string{}})
	if again := h.persisted(); again["state"] != stored {
		t.Fatalf("unchanged allowlist persisted state %v", again["state"])
	}
	h.event("ready")
}

func TestRejectedPersistenceFailsTheOperation(t *testing.T) {
	dm := integration.RunDERPAndSTUN(t, func(string, ...any) {}, "127.0.0.1")
	h := runHelper(t, map[string]any{"version": 3, "localPort": 18080, "state": dshState(t, key.NewNode(), tailcat.NewPresharedKey(), dm.Regions[1]), "allowedClients": []string{}, "name": ""})
	persist := h.event("persist")
	h.send(map[string]any{"command": "ack", "id": persist["id"], "ok": false})
	if e := h.event("error"); e["code"] != errOperation {
		t.Fatal("rejected persistence must fail the start")
	}
}

// An opaque relay stream reaches the companion's TLS listener as it is: the phone's own pinned TLS
// runs end to end through the relay, with no Noise layer.
func TestOpaqueRelayReachesTheCompanionTLSListener(t *testing.T) {
	const token = "relay-token-for-tests"
	relay, err := connectrelay.NewServer(connectrelay.Config{Token: token, PublicHost: "127.0.0.1", Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(relay)
	t.Cleanup(func() { relay.Close(); ts.Close() })
	url := "ws" + strings.TrimPrefix(ts.URL, "http")
	srv, port := companion(t)
	region := &tailcfg.DERPRegion{RegionID: 19, RegionCode: "fix", Nodes: []*tailcfg.DERPNode{{Name: "fix", RegionID: 19, HostName: "loopback.invalid", DERPPort: 443}}}
	h := runHelper(t, map[string]any{"version": 3, "localPort": port, "state": dshState(t, key.NewNode(), tailcat.NewPresharedKey(), region),
		"allowedClients": []string{}, "name": "x", "relays": []map[string]string{{"url": url, "token": token}}})
	saved := h.persisted()
	h.event("ready")
	// Paired phones learn the room from the host's routes; the test reads it from the saved identity.
	var doc struct{ Relay string }
	seed, err := base64.RawURLEncoding.DecodeString(func() string { _ = json.Unmarshal([]byte(savedIdentity(t, saved["state"])), &doc); return doc.Relay }())
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatal("no relay key in the saved identity")
	}
	room := connectrelay.RoomFor(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	deadline := time.Now().Add(20 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, err := connectrelay.DialPhone(ctx, url, room, nil)
		cancel()
		if err == nil {
			var body string
			// Until the host has registered its room, the relay closes a phone's stream (4404).
			if body, err = pinnedGet(c, srv, "/v1/pairings"); body == "companion:/v1/pairings" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("relay never carried a stream: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

// An emoji window: the phone (connectmobile Pair2) and the computer see the same four emoji, nothing is
// saved before the computer's user says yes, and a no ends the window without pairing anyone.
func TestEmojiWindowAsksTheComputerFirst(t *testing.T) {
	dm := integration.RunDERPAndSTUN(t, func(string, ...any) {}, "127.0.0.1")
	_, port := companion(t)
	h := runHelper(t, map[string]any{"version": 3, "localPort": port, "state": dshState(t, key.NewNode(), tailcat.NewPresharedKey(), dm.Regions[1]), "allowedClients": []string{}, "name": "Mac"})
	h.persisted()
	h.event("ready")
	h.send(map[string]any{"command": "confirm", "approve": true})
	if e := h.event("error"); e["code"] != errConfirm {
		t.Fatal("confirm with nothing waiting")
	}
	template := `{"version":4,"tailcat":{"address":"$TAILCAT_ADDRESS","port":48931},"client":"$PHONE_KEY"}`
	pair := func(op int64, approve bool) (string, map[string]any) {
		h.send(map[string]any{"command": "pair", "invitation": template, "emoji": true})
		e := h.event("pairing2")
		if _, v1 := e["proof"]; v1 || len(e) != 3 {
			t.Fatalf("an emoji window must hand out the v2 invite only: %v", e)
		}
		phoneKey := connectmobile.NewKey()
		first := connectmobile.Pair2(op, e["invite"].(string), phoneKey, "Test phone", "", 60000)
		var shown struct{ Emoji []string }
		if json.Unmarshal([]byte(first), &shown) != nil || len(shown.Emoji) != 4 {
			t.Fatalf("the phone shows no emoji: %s", first)
		}
		req := h.event("pairRequest")
		got, _ := json.Marshal(req["emoji"])
		want, _ := json.Marshal(shown.Emoji)
		if string(got) != string(want) || req["device"] != "Test phone" {
			t.Fatalf("the computer asks about %v, the phone shows %s", req, want)
		}
		h.send(map[string]any{"command": "confirm", "approve": approve})
		if approve {
			h.persisted(connectmobile.PublicKey(phoneKey))
			h.event("paired")
		} else {
			h.event("pairingClosed")
		}
		finish := 60000
		if !approve {
			// TailPocket v0.3.0-pre.5 closes the window's node on a no without telling a phone that paired
			// over Tailcat: it reads "unauthorized" only when its own wait ends. The contract here is that
			// it gets no link and the window is gone.
			finish = 3000
		}
		defer connectmobile.Cancel(op)
		return connectmobile.Pair2Finish(op, finish), map[string]any{"phone": connectmobile.PublicKey(phoneKey)}
	}
	denied, _ := pair(7, false)
	if !strings.Contains(denied, `"error"`) {
		t.Fatalf("a no must refuse the phone: %s", denied)
	}
	linkText, who := pair(8, true)
	var link struct{ Address, Payload, Error string }
	if json.Unmarshal([]byte(linkText), &link) != nil || link.Error != "" || link.Address == "" ||
		link.Payload != `{"version":4,"tailcat":{"address":"`+link.Address+`","port":48931},"client":"`+who["phone"].(string)+`"}` {
		t.Fatalf("link %s", linkText)
	}
}
