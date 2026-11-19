// Command phone is a reference Tailcat phone for end-to-end checks of docs/TAILCAT.md. It does what
// the phone app does with the same mobile library (TailPocket's connectmobile): an emoji pairing from a
// bootstrap v2 (or /pair from a v1), the invitation v4 from the link's payload, then the normal forward
// (TP-FWD and the connection's token first), pinned HTTPS to the companion, one authenticated read and a sync.
// It prints only statuses, never keys or tokens.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jt-wang/tailpocket/connectmobile"
)

type bootstrap struct {
	Version int             `json:"version"`
	Expires int64           `json:"expiresAt"`
	Invite  json.RawMessage `json:"invite"` // version 2: TailPocket's v2 invite
	Tailcat struct {
		Address string `json:"address"`
		Port    int    `json:"port"`
		Key     string `json:"key"`
		Proof   string `json:"proof"`
	} `json:"tailcat"`
}

type normalInvitation struct {
	Version        int    `json:"version"`
	BaseURL        string `json:"baseUrl"`
	PinSHA256      string `json:"pinSha256"`
	CertificatePEM string `json:"certificatePem"`
	PairingToken   string `json:"pairingToken"`
	Tailcat        struct {
		Address string `json:"address"`
		Port    int    `json:"port"`
	} `json:"tailcat"`
}

type forward struct {
	Handle int64  `json:"handle"`
	Port   int    `json:"port"`
	Token  string `json:"token"`
	Error  string `json:"error"`
}

func main() {
	path := flag.String("invitation", "", "bootstrap v1 or v2 JSON file")
	timeout := flag.Duration("timeout", 90*time.Second, "overall deadline")
	flag.Parse()
	if err := run(*path, *timeout); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
}

func run(path string, timeout time.Duration) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var boot bootstrap
	if err := json.Unmarshal(raw, &boot); err != nil || (boot.Version != 1 && boot.Version != 2) {
		return errors.New("not a bootstrap v1 or v2")
	}
	deadline := time.Now().Add(timeout)

	// 1. The phone's durable Tailcat identity is created once. Bootstrap v2 is TailPocket's v2 invite: both
	// screens show four emoji and the computer's user confirms. Bootstrap v1 (same-Wi-Fi) is a v1 invite.
	phoneKey := connectmobile.NewKey()
	var linkText string
	ms := func() int { return int(time.Until(deadline) / time.Millisecond) }
	if boot.Version == 2 {
		first := connectmobile.Pair2(1, string(boot.Invite), phoneKey, "Reference phone", "", ms())
		var shown struct {
			Emoji []string `json:"emoji"`
		}
		if json.Unmarshal([]byte(first), &shown) == nil && len(shown.Emoji) == 4 {
			fmt.Println("emoji:", strings.Join(shown.Emoji, " "))
			linkText = connectmobile.Pair2Finish(1, ms())
		} else {
			linkText = first
		}
	} else {
		invite, _ := json.Marshal(map[string]any{"v": 1, "address": boot.Tailcat.Address, "port": boot.Tailcat.Port,
			"key": boot.Tailcat.Key, "proof": boot.Tailcat.Proof, "expiresAt": boot.Expires / 1000})
		linkText = connectmobile.Pair(1, string(invite), phoneKey, "Reference phone", "", ms())
	}
	var link struct {
		Address string `json:"address"`
		Port    int    `json:"port"`
		Payload string `json:"payload"`
		Error   string `json:"error"`
	}
	if json.Unmarshal([]byte(linkText), &link) != nil || link.Error != "" {
		return fmt.Errorf("/pair: %s", link.Error)
	}
	fmt.Println("pairing node: ok (invitation received)")

	// The reply's address is authoritative; the payload is the invitation v4 for the TLS identity.
	var normalInv normalInvitation
	if err := json.Unmarshal([]byte(link.Payload), &normalInv); err != nil || normalInv.Version != 4 || normalInv.Tailcat.Port != 48931 || link.Port != 48931 || !strings.HasPrefix(link.Address, "tc") {
		return errors.New("invalid normal invitation")
	}
	if normalInv.Tailcat.Address != link.Address {
		return errors.New("invitation names another node (or none)")
	}

	// 2. Normal node with the same durable key, pinned HTTPS through the loopback forward.
	var normal forward
	if json.Unmarshal([]byte(connectmobile.Connect(linkText, "")), &normal) != nil || normal.Error != "" || normal.Port == 0 {
		return fmt.Errorf("connect failed: %s", normal.Error)
	}
	defer connectmobile.Stop(normal.Handle)
	base, err := url.Parse(normalInv.BaseURL)
	if err != nil {
		return err
	}
	block, _ := pem.Decode([]byte(normalInv.CertificatePEM))
	if block == nil {
		return errors.New("bad certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	tlsConfig := &tls.Config{ServerName: base.Hostname(), RootCAs: pool, MinVersion: tls.VersionTLS12,
		VerifyConnection: func(state tls.ConnectionState) error {
			sum := sha256.Sum256(state.PeerCertificates[0].RawSubjectPublicKeyInfo)
			if "sha256/"+base64.StdEncoding.EncodeToString(sum[:]) != normalInv.PinSHA256 {
				return errors.New("pin mismatch")
			}
			return nil
		}}
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		TLSClientConfig: tlsConfig, ForceAttemptHTTP2: false, DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", normal.Port))
			if err == nil {
				// A raw (TLS) connection through the forward starts with the connection's token.
				_, err = io.WriteString(c, "TP-FWD "+normal.Token+"\n")
			}
			return c, err
		},
	}}
	var token string
	for attempt := 1; ; attempt++ {
		body := strings.NewReader(fmt.Sprintf(`{"pairingToken":%q,"deviceName":"Reference phone"}`, normalInv.PairingToken))
		response, err := client.Post(normalInv.BaseURL+"/v1/pairings", "application/json", body)
		if err == nil {
			payload, _ := io.ReadAll(io.LimitReader(response.Body, 65536))
			response.Body.Close()
			if response.StatusCode != 201 {
				return fmt.Errorf("/v1/pairings status %d", response.StatusCode)
			}
			var paired struct {
				DeviceToken string `json:"deviceToken"`
			}
			if json.Unmarshal(payload, &paired) != nil || paired.DeviceToken == "" {
				return errors.New("/v1/pairings: no device token")
			}
			token = paired.DeviceToken
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("/v1/pairings: %w", err)
		}
		fmt.Printf("companion not reachable yet (attempt %d)\n", attempt)
		time.Sleep(2 * time.Second)
	}
	fmt.Println("pairing: 201, device token received")
	request, _ := http.NewRequest("GET", normalInv.BaseURL+"/v1/workspaces", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("/v1/workspaces: %w", err)
	}
	response.Body.Close()
	fmt.Printf("workspaces: %d\n", response.StatusCode)
	if response.StatusCode != 200 {
		return errors.New("authenticated read failed")
	}
	// 3. The phone registers its end-to-end key and learns the host's routes (an opaque relay, if any).
	var synced struct {
		Via   []struct{ T, M string } `json:"via"`
		Error string                  `json:"error"`
	}
	if json.Unmarshal([]byte(connectmobile.Sync(normal.Handle, 30000)), &synced) != nil || synced.Error != "" {
		return fmt.Errorf("sync: %s", synced.Error)
	}
	fmt.Printf("sync: ok, %d route(s) besides Tailcat\n", len(synced.Via))
	fmt.Println("PASS: phone paired and read over Tailcat")
	return nil
}
