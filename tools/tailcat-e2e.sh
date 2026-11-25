#!/bin/bash
# Live Tailcat check: real helper + real companion server + reference phone over real DERP.
# Usage: tools/tailcat-e2e.sh   (needs Go via tailcat/go.mod toolchain, Node 22.13+ and network)
# Sandboxes that only allow proxied WebSockets can set DSH_TAILCAT_GO_TAGS=ts_debug_websockets and
# TS_DEBUG_DERP_WS_CLIENT=1; production builds never use that tag.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
tags="ts_omit_ssh${DSH_TAILCAT_GO_TAGS:+,$DSH_TAILCAT_GO_TAGS}"
clang="$(xcrun --find clang)"
mac_sdk="$(xcrun --sdk macosx --show-sdk-path)"
mac_flags="-mmacosx-version-min=14.0 -isysroot $mac_sdk"
(cd "$root/tailcat" && CGO_ENABLED=1 CC="$clang" CGO_CFLAGS="$mac_flags" CGO_LDFLAGS="$mac_flags" go build -trimpath -mod=readonly -tags "$tags" -o "$out/helper" ./host && CGO_ENABLED=1 CC="$clang" CGO_CFLAGS="$mac_flags" CGO_LDFLAGS="$mac_flags" go build -trimpath -mod=readonly -tags "$tags" -o "$out/phone" ./e2e/phone && go build -trimpath -mod=readonly -o "$out/netprobe" ./e2e/netprobe)
verdict() {  # $1: netprobe's exit code
  case "$1" in
    0) echo "tailcat-e2e: FAIL (helper or companion): the network works" ;;
    2) echo "tailcat-e2e: FAIL (runner network): Tailcat's relays are out of reach from this runner" ;;
    3) echo "tailcat-e2e: FAIL (helper): the network works, but the helper's own region pick fails" ;;
    *) echo "tailcat-e2e: FAIL (netprobe exit $1): the probe itself failed; no verdict" ;;
  esac
}
# First the network the helper needs (tailcat/e2e/netprobe), so a runner without it is told apart from a failing
# helper: up to three tries 10 s apart, as the network of a fresh runner may still be coming up.
net=0
for try in 1 2 3; do
  if "$out/netprobe"; then net=0; break; else net=$?; fi
  if [ "$net" -eq 2 ] && [ "$try" -lt 3 ]; then echo "tailcat-e2e: no network to Tailcat's relays yet (try $try of 3), again in 10 s"; sleep 10; else break; fi
done
if [ "$net" -ne 0 ]; then
  [ "$net" -eq 2 ] && echo "tailcat-e2e: 3 tries; the helper was not run"
  verdict "$net"; exit 1
fi
cd "$root/host"
# The runner and phone carry their own deadlines (macOS has no coreutils timeout).
if ! node test/tailcat-live.ts "$out/helper" "$out/phone"; then
  echo "tailcat-e2e: the live check failed; the network now:"
  after=0; "$out/netprobe" || after=$?
  verdict "$after"
  exit 1
fi
