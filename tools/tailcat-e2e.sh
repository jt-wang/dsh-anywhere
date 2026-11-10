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
(cd "$root/tailcat" && CGO_ENABLED=1 CC="$clang" CGO_CFLAGS="$mac_flags" CGO_LDFLAGS="$mac_flags" go build -trimpath -mod=readonly -tags "$tags" -o "$out/helper" ./host && CGO_ENABLED=1 CC="$clang" CGO_CFLAGS="$mac_flags" CGO_LDFLAGS="$mac_flags" go build -trimpath -mod=readonly -tags "$tags" -o "$out/phone" ./e2e/phone)
cd "$root/host"
# The runner and phone carry their own deadlines (macOS has no coreutils timeout).
node test/tailcat-live.ts "$out/helper" "$out/phone"
