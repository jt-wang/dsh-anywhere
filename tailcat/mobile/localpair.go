package dshtailcat

// Same-Wi-Fi pairing crypto, phone role, wire v2 (commit, then reveal), for the Android app that runs
// the wire protocol itself (android/, LocalPairing.kt). TailPocket's connectlocal builds it; DSH keeps
// its own label, which the host's code and seal (host/src/local-pairing.ts) use too. Contract and frozen
// test vector: docs/TAILCAT.md ("Same-Wi-Fi pairing").

import (
	"encoding/base64"
	"encoding/json"

	"github.com/jt-wang/tailpocket/connectlocal"
)

const localPairLabel = "dsh-mobile-local-pairing-v1"

// LocalPairKeyPair returns a fresh attempt as {"private","public","nonce","commit"} (standard base64):
// an X25519 key pair, the 32-byte nonce and the commitment SHA256(label ‖ "commit" ‖ public ‖ nonce)
// the phone sends before it sees the computer's key.
func LocalPairKeyPair() string {
	kp, err := connectlocal.NewKeyPair()
	if err != nil {
		return `{"error":"keypair-failed"}`
	}
	nonce, err := connectlocal.NewNonce()
	if err != nil {
		return `{"error":"keypair-failed"}`
	}
	commit := connectlocal.Commit(localPairLabel, kp.Public[:], nonce)
	b64 := base64.StdEncoding.EncodeToString
	body, err := json.Marshal(struct {
		Private string `json:"private"`
		Public  string `json:"public"`
		Nonce   string `json:"nonce"`
		Commit  string `json:"commit"`
	}{b64(kp.Private[:]), b64(kp.Public[:]), b64(nonce), b64(commit[:])})
	if err != nil {
		return `{"error":"keypair-failed"}`
	}
	return string(body)
}

// LocalPairCode returns the 6-digit confirmation code the phone shows, or "" on invalid input.
func LocalPairCode(private, peerPublic, nonce string) string {
	s := localPairSession(private, peerPublic, nonce)
	if s == nil {
		return ""
	}
	return s.Code
}

// LocalPairOpen decrypts the host's sealed invitation, or returns "" if it does not authenticate.
func LocalPairOpen(private, peerPublic, nonce, sealed string) string {
	s := localPairSession(private, peerPublic, nonce)
	box, err := base64.StdEncoding.DecodeString(sealed)
	if s == nil || err != nil {
		return ""
	}
	plain, err := s.Open(box)
	if err != nil {
		return ""
	}
	return string(plain)
}

// canonical32 decodes standard base64 that is exactly 32 bytes and re-encodes to the same text.
func canonical32(text string) []byte {
	b, err := base64.StdEncoding.DecodeString(text)
	if err != nil || len(b) != 32 || base64.StdEncoding.EncodeToString(b) != text {
		return nil
	}
	return b
}

func localPairSession(privateText, peerText, nonceText string) *connectlocal.Session {
	private, peer, nonce := canonical32(privateText), canonical32(peerText), canonical32(nonceText)
	if private == nil || peer == nil || nonce == nil {
		return nil
	}
	own, err := connectlocal.KeyPairFromPrivate(private)
	if err != nil {
		return nil
	}
	s, err := connectlocal.NewSession(localPairLabel, own, peer, true, nonce)
	if err != nil {
		return nil
	}
	return s
}
