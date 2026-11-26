#!/usr/bin/env bash
# CI runs this after actions/setup-go (go-version-file: tailcat/go.mod): the Go on PATH must be go.mod's toolchain,
# the one version every workflow builds Tailcat with. Leave GOTOOLCHAIN unset in the workflows: with
# GOTOOLCHAIN=local, setup-go reads go.mod's `go` line (1.27.1) instead of its toolchain line (setup-go installer.ts).
set -euo pipefail
want="$(sed -n 's/^toolchain //p' "$(dirname "$0")/go.mod")"
have="$(go env GOVERSION)"
[ -n "$want" ] || { echo "tailcat/go.mod has no toolchain line" >&2; exit 1; }
[ "$have" = "$want" ] || { echo "Go is $have, tailcat/go.mod's toolchain is $want" >&2; exit 1; }
echo "Go $have = tailcat/go.mod's toolchain"
