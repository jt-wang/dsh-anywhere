// Package dshtailcat is DSH's addition to TailPocket's phone library. The app binds it together with
// github.com/jt-wang/tailpocket/connectmobile (tools/build-tailcat.sh), which does everything else:
// keys, pairing, the loopback forward, Path, Sync and the Android getifaddrs interface list.
// Contract: docs/TAILCAT.md ("Go mobile API"). Nothing panics or throws across the language boundary,
// and no answer echoes input, addresses or key material.
package dshtailcat

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"time"

	"github.com/jt-wang/tailpocket/connectmobile"
	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

var errInvalid = errors.New("invalid")

// Diagnose reports which part answers, for telling the person why the computer can't be reached:
// {"relay":"reachable"|"unreachable","computer":"reachable"|"unreachable","latencyMs":n} (latency only
// with an answer), or {"error":"unknown-handle"} for a handle connectmobile.Connect did not return.
// It takes at most eight seconds. "relay" is whether this network reaches a Tailcat relay of the
// computer's region; "computer" is whether connectmobile.Path got an answer, and latencyMs how long it
// took. Tailcat gives a client it does not allow no reply, so a phone removed on the computer reads as
// a computer that does not answer.
func Diagnose(handle int64) string {
	var link struct {
		Address string `json:"address"`
		Error   string `json:"error"`
	}
	if json.Unmarshal([]byte(linkOf(handle)), &link) != nil || link.Error != "" {
		return `{"error":"unknown-handle"}`
	}
	ctx, cancel := context.WithTimeout(context.Background(), diagnoseLimit)
	defer cancel()
	relayed := make(chan error, 1)
	go func() { relayed <- probeRegionOf(ctx, link.Address) }()
	type answer struct {
		latency time.Duration
		ok      bool
	}
	pinged := make(chan answer, 1)
	go func() {
		start := time.Now()
		var path struct {
			Route string `json:"route"`
		}
		ok := json.Unmarshal([]byte(pathOf(handle, int(diagnoseLimit/time.Millisecond))), &path) == nil && path.Route != ""
		pinged <- answer{time.Since(start), ok}
	}()
	out := struct {
		Relay     string `json:"relay"`
		Computer  string `json:"computer"`
		LatencyMs *int64 `json:"latencyMs,omitempty"`
	}{"unreachable", "unreachable", nil}
	// Both end by the limit, so each answer is read whole: a silent computer uses up the limit, and a
	// select against ctx.Done() would then pick at random between that and the relay's answer.
	if a := <-pinged; a.ok {
		ms := a.latency.Milliseconds()
		out.Relay, out.Computer, out.LatencyMs = "reachable", "reachable", &ms
	} else if err := <-relayed; err == nil {
		out.Relay = "reachable"
	}
	body, err := json.Marshal(out)
	if err != nil {
		return `{"error":"unknown-handle"}`
	}
	return string(body)
}

// probeRegion says whether this network lets the phone reach a relay of the region in a Tailcat address.
func probeRegion(ctx context.Context, address string) error {
	if address == "" {
		return errInvalid
	}
	info, err := tailcat.ParseAddr(tailcat.Addr(address))
	if err != nil {
		return err
	}
	if err := info.Expand(ctx); err != nil {
		return err
	}
	return probeRelay(ctx, relayNodes(info.Region), false)
}

type relayNode struct{ host, dial, port string }

func relayNodes(regions []*tailcfg.DERPRegion) []relayNode {
	var nodes []relayNode
	for _, region := range regions {
		for _, node := range region.Nodes {
			dial := node.IPv4
			if dial == "" || dial == "none" {
				dial = node.HostName
			}
			port := node.DERPPort
			if port == 0 {
				port = 443
			}
			nodes = append(nodes, relayNode{host: node.HostName, dial: dial, port: strconv.Itoa(port)})
		}
	}
	return nodes
}

// probeRelay finishes a TLS handshake with one of the nodes: a network that blocks them refuses, stays
// silent or answers as something else. Nothing is sent after the handshake. skipVerify is for tests'
// own certificates.
func probeRelay(ctx context.Context, nodes []relayNode, skipVerify bool) error {
	last := error(errInvalid)
	for _, node := range nodes {
		dialer := tls.Dialer{Config: &tls.Config{ServerName: node.host, InsecureSkipVerify: skipVerify, MinVersion: tls.VersionTLS12}}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(node.dial, node.port))
		if err == nil {
			_ = conn.Close()
			return nil
		}
		last = err
	}
	return last
}

// Test seams.
var (
	diagnoseLimit = 8 * time.Second
	linkOf        = connectmobile.Link
	pathOf        = connectmobile.Path
	probeRegionOf = probeRegion
)
