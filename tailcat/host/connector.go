// Adapted from voxt-mobile tools/tailcat-host (https://github.com/jt-wang/voxt-mobile),
// Copyright the Voxt Mobile authors, Apache-2.0. See tailcat/NOTICE.

// The helper is a thin wrapper over TailPocket's connecthost (github.com/jt-wang/tailpocket): connecthost
// owns the Tailcat nodes, the allowlist, the pairing windows and the relays; this file keeps DSH's
// stdin/stdout IPC v3 (docs/TAILCAT.md) and forwards every connection connecthost accepts to the
// companion's loopback TLS listener.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/jt-wang/tailpocket/connecthost"
	"github.com/jt-wang/tailpocket/connectrelay"
)

const (
	protoVersion   = 3
	lineLimit      = 64 * 1024
	pairingWindow  = 120 * time.Second
	persistTimeout = 10 * time.Second
	nameLimit      = 64
	maxAllowed     = 256
	maxRelays      = 4
	tokenLimit     = 4096
)

type config struct {
	Version        int             `json:"version"`
	LocalPort      int             `json:"localPort"`
	State          json.RawMessage `json:"state"`
	AllowedClients []string        `json:"allowedClients"`
	Name           string          `json:"name"`
	// Relays are tailpocket-relay servers, always opaque with appAuth: DSH runs its own pinned TLS end to
	// end and authenticates every connection with the device bearer inside it.
	Relays []relayConfig `json:"relays"`
	// NoLAN turns TailPocket's local network route off; TailcatOnly runs Tailcat alone (no LAN, no relay).
	NoLAN       bool `json:"noLan"`
	TailcatOnly bool `json:"tailcatOnly"`
}

type relayConfig struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

type command struct {
	Command        string   `json:"command"`
	ID             string   `json:"id"`
	OK             bool     `json:"ok"`
	AllowedClients []string `json:"allowedClients"`
	Invitation     string   `json:"invitation"`
	// Emoji opens a v2 window: the phone and the computer show the same four emoji and the computer's
	// user answers with confirm. Without it the window is v1 (same-Wi-Fi pairing, which checks a code).
	Emoji   bool `json:"emoji"`
	Approve bool `json:"approve"`
}

// Option supplies test seams. Nil Signals installs SIGTERM/SIGINT handling.
type Option struct {
	Signals <-chan os.Signal
}

type runtime struct {
	ctx             context.Context
	h               *connecthost.Host
	out             io.Writer
	writeMu, pendMu sync.Mutex
	pending         map[string]chan bool
	serial          uint64
	identity        string // the identity text the host has stored, "" while it has none
	keys            map[string]string
	address         string // the main node's address for identity, known before it first runs
	pairing         *connecthost.Pairing
	pairingMu       sync.Mutex
	confirm         chan bool // the open emoji window's pending question, nil while none waits
}

// Run reads one configuration line, then commands, until stdin closes or a signal arrives.
// stdout is private typed IPC; nothing is written to logs.
func Run(in io.Reader, out io.Writer, opt Option) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), lineLimit)
	emitFixed := func(code string) error {
		_, _ = io.WriteString(out, `{"event":"error","code":"`+code+"\"}\n")
		return errors.New(code)
	}
	if !scanner.Scan() {
		return emitFixed(errRequest)
	}
	var cfg config
	if json.Unmarshal(scanner.Bytes(), &cfg) != nil {
		return emitFixed(errRequest)
	}
	if cfg.Version != protoVersion {
		return emitFixed(errVersion)
	}
	if cfg.LocalPort < 1024 || cfg.LocalPort > 65534 {
		return emitFixed(errPort)
	}
	if len(cfg.AllowedClients) > maxAllowed {
		return emitFixed(errAllowlist)
	}
	if code := parseAllowlist(cfg.AllowedClients); code != "" {
		return emitFixed(code)
	}
	identity, keys, code := identityText(cfg.State)
	if code != "" {
		return emitFixed(code)
	}
	if len(cfg.Relays) > maxRelays {
		return emitFixed(errRelay)
	}
	if cfg.TailcatOnly && len(cfg.Relays) > 0 { // as connecthost: Tailcat only has no relay
		return emitFixed(errConfig)
	}
	var relays []connecthost.Relay
	for _, rl := range cfg.Relays {
		if !connectrelay.ValidURL(rl.URL) || rl.Token == "" || len(rl.Token) > tokenLimit || strings.ContainsFunc(rl.Token, unicode.IsSpace) {
			return emitFixed(errRelay)
		}
		// Opaque connections carry no phone identity (connecthost.PhoneOf is "", "opaque" in TailPocket's
		// helper IPC); DSH needs none here: the companion's pinned TLS and device bearer decide each one.
		relays = append(relays, connecthost.Relay{URL: rl.URL, Token: rl.Token, Opaque: true, AppAuth: true})
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The main node's region is fixed before connecthost starts, so its address is known for the first
	// phone's invitation. Without a region (no phone paired yet, offline) the helper exits; the companion
	// restarts it with backoff.
	identity, err := withRegion(ctx, identity)
	if err != nil {
		return emitFixed(errStart)
	}
	r := &runtime{ctx: ctx, out: out, pending: map[string]chan bool{}, identity: identity, keys: keys, address: mainAddress(identity)}
	h, err := connecthost.New(connecthost.Config{Name: cleanName(cfg.Name), Identity: identity, Keys: keys,
		Allowed: cfg.AllowedClients, Save: r.save, Relays: relays, NoLAN: cfg.NoLAN, TailcatOnly: cfg.TailcatOnly})
	switch {
	case errors.Is(err, connecthost.ErrInvalidIdentity):
		return emitFixed(errState)
	case errors.Is(err, connecthost.ErrInvalidPhone):
		return emitFixed(errClientKey)
	case err != nil:
		return emitFixed(errConfig)
	}
	r.h = h
	conns := newLiveConns(ctx)
	defer func() {
		cancel()
		r.closePairing()
		_ = h.Close()
		conns.close()
	}()
	// Every connection connecthost hands over (Tailcat on 48931 from an allowed phone, or an opaque
	// relay stream) goes to the companion's TLS listener on loopback, and nowhere else.
	go func() {
		for {
			c, err := h.Listener().Accept()
			if err != nil {
				return
			}
			go proxyLoopback(c, cfg.LocalPort, conns)
		}
	}()

	signals := opt.Signals
	if signals == nil {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
		defer signal.Stop(ch)
		signals = ch
	}
	commands := make(chan command)
	go func() {
		defer close(commands)
		for scanner.Scan() {
			var cmd command
			if json.Unmarshal(scanner.Bytes(), &cmd) != nil {
				cancel()
				return
			}
			select {
			case commands <- cmd:
			case <-ctx.Done():
				return
			}
		}
	}()
	var operations sync.WaitGroup
	tasks := make(chan func() error, 16)
	operations.Add(1)
	go func() {
		defer operations.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case fn := <-tasks:
				if ctx.Err() == nil {
					if err := fn(); err != nil {
						_ = r.emit(map[string]any{"event": "error", "code": errOperation})
					}
				}
			}
		}
	}()
	defer func() { cancel(); operations.Wait() }()
	launch := func(fn func() error) {
		select {
		case tasks <- fn:
		default:
			_ = r.emit(map[string]any{"event": "error", "code": errBusy})
		}
	}
	launch(func() error {
		// Start saves a migrated identity (with the keys connecthost adds) before anything else, and
		// brings up the main node when a phone is allowed: an empty allowlist runs no node at all.
		if err := h.Start(ctx); err != nil {
			return err
		}
		return r.emit(map[string]any{"event": "ready", "address": h.Address()})
	})
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-signals:
			return nil
		case cmd, ok := <-commands:
			if !ok {
				return nil
			}
			switch cmd.Command {
			case "ack":
				r.pendMu.Lock()
				ch := r.pending[cmd.ID]
				r.pendMu.Unlock()
				if ch != nil {
					select {
					case ch <- cmd.OK:
					default:
					}
				}
			case "pair":
				invitation, emoji := cmd.Invitation, cmd.Emoji
				launch(func() error { return r.beginPairing(invitation, emoji) })
			case "confirm":
				// Answered here, not as a task: the window's question blocks a task-free goroutine.
				r.pairingMu.Lock()
				ch := r.confirm
				r.pairingMu.Unlock()
				if ch == nil {
					_ = r.emit(map[string]any{"event": "error", "code": errConfirm})
					continue
				}
				select {
				case ch <- cmd.Approve:
				default:
				}
			case "cancelPairing":
				launch(func() error {
					r.closePairing() // the window's own goroutine stays silent: this answers once
					return r.emit(map[string]any{"event": "pairingClosed"})
				})
			case "setAllowed":
				keys := append([]string{}, cmd.AllowedClients...)
				if len(keys) > maxAllowed {
					_ = r.emit(map[string]any{"event": "error", "code": errAllowlist})
					continue
				}
				if code := parseAllowlist(keys); code != "" {
					_ = r.emit(map[string]any{"event": "error", "code": code})
					continue
				}
				launch(func() error {
					if err := r.setAllowed(keys); err != nil {
						return err
					}
					return r.emit(map[string]any{"event": "ready", "address": h.Address()})
				})
			default:
				_ = r.emit(map[string]any{"event": "error", "code": errCommand})
			}
		}
	}
}

func cleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if runes := []rune(name); len(runes) > nameLimit {
		name = string(runes[:nameLimit])
	}
	return name
}

func (r *runtime) emit(v any) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return json.NewEncoder(r.out).Encode(v)
}

// save is connecthost's Config.Save: the host stores state and allowlist and acks before the change
// takes effect. state is connecthost's identity text, opaque to the host.
func (r *runtime) save(st connecthost.State) error {
	if err := r.persist(envelope(st.Identity, st.Keys), st.Allowed); err != nil {
		return err
	}
	r.pendMu.Lock()
	r.identity, r.keys = st.Identity, st.Keys
	r.pendMu.Unlock()
	return nil
}

func (r *runtime) persist(state any, keys []string) error {
	r.pendMu.Lock()
	r.serial++
	id := strconv.FormatUint(r.serial, 10)
	ch := make(chan bool, 1)
	r.pending[id] = ch
	r.pendMu.Unlock()
	defer func() {
		r.pendMu.Lock()
		delete(r.pending, id)
		r.pendMu.Unlock()
	}()
	if keys == nil {
		keys = []string{}
	}
	if err := r.emit(map[string]any{"event": "persist", "id": id, "state": state, "allowedClients": keys}); err != nil {
		return err
	}
	timer := time.NewTimer(persistTimeout)
	defer timer.Stop()
	select {
	case ok := <-ch:
		if ok {
			return nil
		}
		return errors.New("persistence-rejected")
	case <-r.ctx.Done():
		return r.ctx.Err()
	case <-timer.C:
		return errors.New("persistence-timeout")
	}
}

// setAllowed applies the host's allowlist. Only removals revoke phone by phone, so the other phones
// keep their connections; anything else replaces the list (which restarts the main node). An
// unchanged list is persisted again so the host's view and the helper's agree.
func (r *runtime) setAllowed(keys []string) error {
	current := r.h.Allowed()
	var added, removed []string
	for _, k := range keys {
		if !slices.Contains(current, k) {
			added = append(added, k)
		}
	}
	for _, k := range current {
		if !slices.Contains(keys, k) {
			removed = append(removed, k)
		}
	}
	switch {
	case len(added) > 0:
		return r.h.SetAllowed(r.ctx, keys)
	case len(removed) > 0:
		for _, k := range removed {
			if err := r.h.Revoke(r.ctx, k); err != nil {
				return err
			}
		}
		return nil
	}
	r.pendMu.Lock()
	identity, phoneKeys := r.identity, r.keys
	r.pendMu.Unlock()
	// Never JSON null for a stored identity: null would make the host forget it.
	var state any // null: a fresh identity no phone has used yet has nothing to restore
	if identity != "" {
		state = envelope(identity, phoneKeys)
	}
	return r.persist(state, current)
}

func (r *runtime) closePairing() {
	r.pairingMu.Lock()
	p := r.pairing
	r.pairing = nil
	r.pairingMu.Unlock()
	if p != nil {
		p.Close()
	}
}

// beginPairing opens a connecthost pairing window, replacing any open one. The phone's reply carries
// DSH's invitation v4 as TailPocket's payload: invitation is its template, with $TAILCAT_ADDRESS (the
// main node's address, known before the first phone since the region is fixed at start) and
// $PHONE_KEY filled in. An emoji window hands out only the v2 invite and asks the host (pairRequest)
// before any phone pairs; a v1 window hands out the v1 invite for same-Wi-Fi pairing.
func (r *runtime) beginPairing(invitation string, emoji bool) error {
	r.closePairing()
	h := r.h
	address := r.address
	if address == "" {
		address = h.Address()
	}
	if address == "" {
		return errors.New("no main address")
	}
	opts := connecthost.PairOptions{TTL: pairingWindow, Payload: func(phone connecthost.Phone) (string, error) {
		return strings.NewReplacer("$TAILCAT_ADDRESS", address, "$PHONE_KEY", phone.Key).Replace(invitation), nil
	}}
	if emoji {
		opts.Confirm = r.askHost
	}
	p, err := h.Pair(r.ctx, opts)
	if err != nil {
		return err
	}
	r.pairingMu.Lock()
	r.pairing = p
	r.pairingMu.Unlock()
	go func() {
		phone, err := p.Wait(r.ctx)
		r.pairingMu.Lock()
		current := r.pairing == p // closePairing (cancel, or a newer window) already took it
		if current {
			r.pairing = nil
		}
		r.pairingMu.Unlock()
		switch {
		case err == nil:
			_ = r.emit(map[string]any{"event": "paired", "address": h.Address(), "client": phone.Key})
		case current && r.ctx.Err() == nil:
			// Expired, refused on the computer, or the phone left an emoji check: the code is spent.
			_ = r.emit(map[string]any{"event": "pairingClosed"})
		}
	}()
	if emoji {
		text, err := json.Marshal(p.InviteV2())
		if err != nil {
			p.Close()
			return err
		}
		return r.emit(map[string]any{"event": "pairing2", "invite": string(text), "expiresAt": p.Expires().Unix()})
	}
	inv := p.Invite()
	return r.emit(map[string]any{"event": "pairing", "address": inv.Address, "port": inv.Port,
		"key": inv.Key, "proof": inv.Proof, "expiresAt": inv.ExpiresAt})
}

// askHost is the emoji window's Confirm: the host shows device and emoji to its user and answers with
// confirm. A phone that leaves, or 55 s without an answer, cancels the question (and ends the window).
func (r *runtime) askHost(ctx context.Context, req connecthost.PairRequest) bool {
	ch := make(chan bool, 1)
	r.pairingMu.Lock()
	r.confirm = ch
	r.pairingMu.Unlock()
	defer func() {
		r.pairingMu.Lock()
		r.confirm = nil
		r.pairingMu.Unlock()
	}()
	emoji := req.Emoji
	if emoji == nil {
		emoji = []string{}
	}
	if r.emit(map[string]any{"event": "pairRequest", "device": req.Device, "route": req.Route, "emoji": emoji}) != nil {
		return false
	}
	select {
	case ok := <-ch:
		return ok
	case <-ctx.Done():
		_ = r.emit(map[string]any{"event": "pairRequestCancelled"})
		return false
	}
}
