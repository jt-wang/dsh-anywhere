// Command netprobe goes through the network steps a Tailcat helper takes before it is first ready (the helper
// says only "start-failed" when one fails): resolve the DERP map's host, fetch the map, measure the regions
// (netcheck; a run that measures none only warns), the helper's own region pick (ConnInfo.Expand for a server), then direct TLS to the chosen region's
// relays. tools/tailcat-e2e.sh runs it to tell a runner without network from a helper that fails on a working one.
//
// One line per step: "netprobe <step> ok|fail|warn <ms>ms <detail>". A failure is a fixed category (dns, timeout,
// refused, unreachable, reset, tls, proxy, http-<status>, no-regions, other), never Go's error text, which can
// carry resolver or proxy addresses. Exit 0: the helper's steps pass; 2: the network failed before the helper's
// region pick (dns, derpmap or a netcheck error); 3: the network worked and the helper's own region pick failed. The relay
// step only warns: the helper can still reach a relay through another node, port or proxied transport.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

type httpStatus int

func (s httpStatus) Error() string { return fmt.Sprintf("http-%d", int(s)) }

// category names what went wrong without the error's text.
func category(err error) string {
	var dns *net.DNSError
	var status httpStatus
	var op *net.OpError
	var cert *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	switch {
	case errors.As(err, &status):
		return status.Error()
	case errors.As(err, &dns):
		return "dns"
	case errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err):
		return "timeout"
	case errors.As(err, &op) && op.Op == "proxyconnect":
		return "proxy"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	case errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH):
		return "unreachable"
	case errors.Is(err, syscall.ECONNRESET) || errors.Is(err, io.EOF):
		return "reset"
	case errors.As(err, &cert) || errors.As(err, &record):
		return "tls"
	case errors.Is(err, errNoRegions):
		return "no-regions"
	}
	return "other"
}

var errNoRegions = errors.New("no-regions")

func step(name string, run func() (string, error)) bool {
	start := time.Now()
	detail, err := run()
	ms := time.Since(start).Milliseconds()
	if err != nil {
		fmt.Printf("netprobe %s fail %dms %s\n", name, ms, category(err))
		return false
	}
	fmt.Printf("netprobe %s ok %dms %s\n", name, ms, detail)
	return true
}

// Overridden in tests.
var (
	pickBestRegion = tailcat.PickBestRegion
	expandRegion   = func(ctx context.Context) (*tailcfg.DERPRegion, error) {
		ci := &tailcat.ConnInfo{RegionID: -1}
		if err := ci.Expand(ctx, tailcat.ExpandForServer); err != nil {
			return nil, err
		}
		if len(ci.Region) != 1 || ci.Region[0] == nil {
			return nil, errNoRegions
		}
		return ci.Region[0], nil
	}
)

// afterMap measures the regions of a fetched DERP map, then takes the helper's own region pick. A netcheck that
// measured no region only warns: Expand then picks a region of the map at random, as the helper does. It returns
// the exit code (0, 2 or 3) and the helper's region.
func afterMap(ctx context.Context, dm *tailcfg.DERPMap) (int, *tailcfg.DERPRegion) {
	start := time.Now()
	nctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	id, err := pickBestRegion(nctx, dm)
	cancel()
	ms := time.Since(start).Milliseconds()
	switch {
	case err != nil:
		fmt.Printf("netprobe netcheck fail %dms %s\n", ms, category(err))
		fmt.Println("netprobe verdict: network: this machine cannot reach Tailcat's DERP map or relays")
		return 2, nil
	case id == 0 || dm.Regions[id] == nil:
		fmt.Printf("netprobe netcheck warn %dms no region measured; the helper picks one of %d at random\n", ms, len(dm.Regions))
	default:
		fmt.Printf("netprobe netcheck ok %dms region %d\n", ms, id)
	}
	var region *tailcfg.DERPRegion
	if !step("helper-region", func() (string, error) {
		r, err := expandRegion(ctx)
		if err != nil {
			return "", err
		}
		region = r
		return fmt.Sprintf("region %d", r.RegionID), nil
	}) {
		fmt.Println("netprobe verdict: helper: the network works, the helper's own region pick fails")
		return 3, nil
	}
	return 0, region
}

func main() {
	ctx := context.Background()
	mapURL, _ := url.Parse(tailcat.DefaultDERPMapURL)
	var dm tailcfg.DERPMap
	network := step("dns", func() (string, error) {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		addrs, err := net.DefaultResolver.LookupHost(ctx, mapURL.Hostname())
		return fmt.Sprintf("%d address(es)", len(addrs)), err
	}) && step("derpmap", func() (string, error) {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "GET", tailcat.DefaultDERPMapURL, nil)
		req.Header.Set("Tailcat-Mode", "server")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		if err != nil {
			return "", err
		}
		if res.StatusCode != http.StatusOK {
			return "", httpStatus(res.StatusCode)
		}
		if json.Unmarshal(body, &dm) != nil || len(dm.Regions) == 0 {
			return "", errNoRegions
		}
		return fmt.Sprintf("%d region(s)", len(dm.Regions)), nil
	})
	if !network {
		fmt.Println("netprobe verdict: network: this machine cannot reach Tailcat's DERP map or relays")
		os.Exit(2)
	}
	code, region := afterMap(ctx, &dm)
	if code != 0 {
		os.Exit(code)
	}
	// Direct TLS to each node of the region, for the log only.
	reached, last := 0, error(nil)
	start := time.Now()
	for _, node := range region.Nodes {
		dialer := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: &tls.Config{ServerName: node.HostName}}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(node.HostName, "443"))
		if err != nil {
			last = err
			continue
		}
		conn.Close()
		reached++
	}
	ms := time.Since(start).Milliseconds()
	if reached == 0 {
		cat := "no-nodes"
		if last != nil {
			cat = category(last)
		}
		fmt.Printf("netprobe relay warn %dms direct TLS to none of %d node(s): %s\n", ms, len(region.Nodes), cat)
	} else {
		fmt.Printf("netprobe relay ok %dms direct TLS to %d of %d node(s)\n", ms, reached, len(region.Nodes))
	}
	fmt.Println("netprobe verdict: network ok")
}
