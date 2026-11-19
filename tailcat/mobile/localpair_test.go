package dshtailcat

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jt-wang/tailpocket/connectlocal"
)

// The frozen wire-v2 vector of docs/TAILCAT.md (TailPocket docs/PROTOCOL.md, DSH's label): the host
// (host/src/local-pairing.ts) reproduces it too.
const (
	vPhonePrivate = "ERERERERERERERERERERERERERERERERERERERERERE="
	vPhonePublic  = "e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM="
	vHostPublic   = "D6poTtKIZ7l/Smot7l34zpdOdrcBjj8iocTPJnhXDyA="
	vNonce        = "REREREREREREREREREREREREREREREREREREREREREQ="
	vCommit       = "HnYkDXyQsAK46/99Ac05tBezHWWwGBiGq+FIYIScHcM="
	vCode         = "933437"
	vPlaintext    = `{"version":3}`
	vSealed       = "MzMzMzMzMzMzMzMzZK3iZP3rpvoh+Bk9sxZNBMqdAxZYW+EfL0AKpog="
)

func TestLocalPairFrozenVector(t *testing.T) {
	pub, _ := base64.StdEncoding.DecodeString(vPhonePublic)
	nonce, _ := base64.StdEncoding.DecodeString(vNonce)
	if c := connectlocal.Commit(localPairLabel, pub, nonce); base64.StdEncoding.EncodeToString(c[:]) != vCommit {
		t.Fatal("commit")
	}
	if LocalPairCode(vPhonePrivate, vHostPublic, vNonce) != vCode {
		t.Fatal("code")
	}
	if LocalPairOpen(vPhonePrivate, vHostPublic, vNonce, vSealed) != vPlaintext {
		t.Fatal("open")
	}
	tampered := []byte(vSealed)
	tampered[20] ^= 1
	if LocalPairOpen(vPhonePrivate, vHostPublic, vNonce, string(tampered)) != "" || LocalPairOpen(vPhonePrivate, vPhonePublic, vNonce, vSealed) != "" {
		t.Fatal("tampered or wrong-peer box opened")
	}
	otherNonce := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("U", 32)))
	if LocalPairCode(vPhonePrivate, vHostPublic, otherNonce) == vCode || LocalPairOpen(vPhonePrivate, vHostPublic, otherNonce, vSealed) != "" {
		t.Fatal("the nonce is not bound into the code and key")
	}
	if LocalPairCode("bad", vHostPublic, vNonce) != "" || LocalPairCode(vPhonePrivate, base64.StdEncoding.EncodeToString(make([]byte, 32)), vNonce) != "" ||
		LocalPairCode(vPhonePrivate, vHostPublic, "short") != "" || LocalPairCode(vPhonePrivate, strings.TrimSuffix(vHostPublic, "=")+"", vNonce) != "" {
		t.Fatal("invalid, non-canonical or low-order input accepted")
	}
	var a struct{ Private, Public, Nonce, Commit string }
	if json.Unmarshal([]byte(LocalPairKeyPair()), &a) != nil || LocalPairCode(a.Private, vHostPublic, a.Nonce) == "" {
		t.Fatal("key pair")
	}
	p, _ := base64.StdEncoding.DecodeString(a.Public)
	n, _ := base64.StdEncoding.DecodeString(a.Nonce)
	if c := connectlocal.Commit(localPairLabel, p, n); base64.StdEncoding.EncodeToString(c[:]) != a.Commit {
		t.Fatal("the attempt's commitment does not match its key and nonce")
	}
}
