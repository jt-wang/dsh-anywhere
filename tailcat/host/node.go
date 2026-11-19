// Adapted from voxt-mobile tools/tailcat-host (https://github.com/jt-wang/voxt-mobile),
// Copyright the Voxt Mobile authors, Apache-2.0. See tailcat/NOTICE.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

const (
	dshStateVersion = 1 // the state this helper persisted before TailPocket
	virtualPort     = 48931
	pairingPort     = 48932
)

// Fixed error vocabulary. Events never carry free text, input echoes or key material.
const (
	errRequest   = "invalid-request"
	errVersion   = "invalid-version"
	errAllowlist = "invalid-allowlist"
	errClientKey = "invalid-client-key"
	errPort      = "invalid-port"
	errState     = "invalid-state"
	errRelay     = "invalid-relay"
	errConfig    = "invalid-config"
	errConfirm   = "nothing-to-confirm"
	errCommand   = "invalid-command"
	errStart     = "start-failed"
	errBusy      = "busy"
	errOperation = "operation-failed"
)

func parseAllowlist(texts []string) string {
	seen := make(map[string]struct{}, len(texts))
	for _, text := range texts {
		var pub key.NodePublic
		if err := pub.UnmarshalText([]byte(text)); err != nil || pub.IsZero() {
			return errClientKey
		}
		if _, exists := seen[pub.String()]; exists {
			return errAllowlist
		}
		seen[pub.String()] = struct{}{}
	}
	return ""
}

// stateDoc reads every persisted form: DSH's own from before TailPocket ({"version":1,"privateKey",
// "presharedKey","region"}), connecthost's bare identity ({"v":1,"key","psk","region",…}, written by
// builds on TailPocket v0.3.0-pre.3) and this helper's envelope ({"tailpocket":1,"identity","keys"}).
type stateDoc struct {
	Version      int               `json:"version"`
	PrivateKey   string            `json:"privateKey"`
	PresharedKey string            `json:"presharedKey"`
	Region       json.RawMessage   `json:"region"`
	V            int               `json:"v"`
	TailPocket   int               `json:"tailpocket"`
	Identity     string            `json:"identity"`
	Keys         map[string]string `json:"keys"`
}

// savedState is what the helper persists: connecthost's identity text and each phone's end-to-end key
// (connecthost State.Keys), so phones paired over the encrypted routes need no new sync after a restart.
type savedState struct {
	TailPocket int               `json:"tailpocket"`
	Identity   string            `json:"identity"`
	Keys       map[string]string `json:"keys,omitempty"`
}

const envelopeVersion = 1

func envelope(identity string, keys map[string]string) string {
	body, _ := json.Marshal(savedState{TailPocket: envelopeVersion, Identity: identity, Keys: keys})
	return string(body)
}

// identityText turns the opaque persisted string into connecthost's Config.Identity and Config.Keys.
// JSON null or "" means a fresh identity (""). A DSH state is rewritten field for field: privateKey is
// the node key, presharedKey the pre-shared key and region the DERP region, which together fix the
// Tailcat address, so phones paired before TailPocket keep reaching the same one. The helper persists
// its envelope from then on (connecthost saves at Start, with the keys it adds), so this runs once.
func identityText(raw json.RawMessage) (string, map[string]string, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil, ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil || text == "" {
		return "", nil, errState
	}
	var doc stateDoc
	if json.Unmarshal([]byte(text), &doc) != nil {
		return "", nil, errState
	}
	switch {
	case doc.TailPocket == envelopeVersion && doc.V == 0 && doc.Version == 0:
		if doc.Identity == "" {
			return "", nil, errState
		}
		return doc.Identity, doc.Keys, "" // connecthost.New validates both
	case doc.TailPocket != 0:
		return "", nil, errState
	case doc.V == 1 && doc.Version == 0:
		return text, nil, "" // connecthost's own
	case doc.Version != dshStateVersion:
		return "", nil, errState
	}
	var private key.NodePrivate
	if private.UnmarshalText([]byte(doc.PrivateKey)) != nil || private.IsZero() {
		return "", nil, errState
	}
	var psk tailcat.PresharedKey
	if psk.UnmarshalText([]byte(doc.PresharedKey)) != nil || psk.IsZero() {
		return "", nil, errState
	}
	var region tailcfg.DERPRegion
	if len(doc.Region) == 0 || string(doc.Region) == "null" || json.Unmarshal(doc.Region, &region) != nil || region.RegionID == 0 {
		return "", nil, errState
	}
	body, err := json.Marshal(struct {
		V      int             `json:"v"`
		Key    string          `json:"key"`
		PSK    string          `json:"psk"`
		Region json.RawMessage `json:"region"`
	}{1, doc.PrivateKey, doc.PresharedKey, doc.Region})
	if err != nil {
		return "", nil, errState
	}
	return string(body), nil, ""
}

// pickRegion chooses the DERP region a new main node uses, as tailcat.Server does when it has none
// (the lowest-latency region of the DERP map). Overridden in tests.
var pickRegion = defaultPickRegion

func defaultPickRegion(ctx context.Context) (*tailcfg.DERPRegion, error) {
	ci := &tailcat.ConnInfo{RegionID: -1}
	if err := ci.Expand(ctx, tailcat.ExpandForServer); err != nil {
		return nil, err
	}
	if len(ci.Region) != 1 || ci.Region[0] == nil || ci.Region[0].RegionID == 0 {
		return nil, errors.New("no usable DERP region")
	}
	return ci.Region[0], nil
}

// withRegion returns identity with its DERP region fixed, creating the identity if it is "". The
// address of the main node is then known before it first runs (mainAddress), so the first phone's
// invitation carries it: connecthost builds the pairing payload before it starts the main node, and
// would otherwise only pick the region then.
func withRegion(ctx context.Context, identity string) (string, error) {
	doc := map[string]json.RawMessage{}
	if identity == "" {
		k, _ := key.NewNode().MarshalText()
		p, _ := tailcat.NewPresharedKey().MarshalText()
		doc["v"], _ = json.Marshal(1)
		doc["key"], _ = json.Marshal(string(k))
		doc["psk"], _ = json.Marshal(string(p))
	} else if json.Unmarshal([]byte(identity), &doc) != nil {
		return "", errors.New(errState)
	}
	if r := doc["region"]; len(r) != 0 && string(r) != "null" {
		return identity, nil
	}
	region, err := pickRegion(ctx)
	if err != nil {
		return "", err
	}
	if doc["region"], err = json.Marshal(region); err != nil {
		return "", err
	}
	body, err := json.Marshal(doc)
	return string(body), err
}

// mainAddress is the Tailcat address the main node has for identity (key, pre-shared key and region),
// exactly as tailcat.Server.TailcatAddr builds it; "" if the identity has no region yet.
func mainAddress(identity string) string {
	var doc struct {
		Key, PSK string
		Region   *tailcfg.DERPRegion
	}
	var private key.NodePrivate
	var psk tailcat.PresharedKey
	if json.Unmarshal([]byte(identity), &doc) != nil || doc.Region == nil || private.UnmarshalText([]byte(doc.Key)) != nil || psk.UnmarshalText([]byte(doc.PSK)) != nil {
		return ""
	}
	ci := tailcat.ConnInfo{ServerPublic: tailcat.NodePublic{NodePublic: private.Public()}, ServerDiscoPublic: tailcat.DiscoPublicForNode(private),
		PresharedKey: psk, Region: []*tailcfg.DERPRegion{doc.Region}}
	return string(ci.Addr())
}

func proxyLoopback(client net.Conn, localPort int, conns *liveConns) {
	defer client.Close()
	remote, err := conns.dial(localPort)
	if err != nil {
		return
	}
	defer conns.done(remote)
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		_ = dst.Close()
	}
	go pipe(remote, client)
	go pipe(client, remote)
	wg.Wait()
}

// liveConns owns every loopback connection so stopping the helper cuts them all.
type liveConns struct {
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	items  map[net.Conn]struct{}
	once   sync.Once
}

func newLiveConns(parent context.Context) *liveConns {
	ctx, cancel := context.WithCancel(parent)
	return &liveConns{ctx: ctx, cancel: cancel, items: map[net.Conn]struct{}{}}
}

func (l *liveConns) dial(port int) (net.Conn, error) {
	conn, err := (&net.Dialer{}).DialContext(l.ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ctx.Err() != nil {
		_ = conn.Close()
		return nil, l.ctx.Err()
	}
	l.items[conn] = struct{}{}
	return conn, nil
}

func (l *liveConns) done(conn net.Conn) {
	_ = conn.Close()
	l.mu.Lock()
	delete(l.items, conn)
	l.mu.Unlock()
}

func (l *liveConns) close() {
	l.once.Do(func() {
		l.cancel()
		l.mu.Lock()
		defer l.mu.Unlock()
		for conn := range l.items {
			_ = conn.Close()
		}
	})
}
