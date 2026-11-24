#!/usr/bin/env bash
# The header regression check on a device, a required check before every release:
#   tools/header-check.sh ios       a booted iOS simulator (UDID=<id> picks one; default: the booted one)
#   tools/header-check.sh android   an Android emulator or device (ANDROID_SERIAL picks one; default: the first)
# Runs nsh-app/src/header.test.tsx with the platform's own taps (`nsh test --target`): the chats page while the phone
# connects, cannot reach its computer and is connected, and a chat's page while connected, in light and dark, pressing
# new chat and ⋯. Each step leaves a marker in nsh-app/build/header-probe; a probe measures the screen there (iOS:
# ios/DSHUITests/HeaderProbe.swift, from the accessibility frames; Android: uiautomator's bounds), and
# tools/header-check.py judges the header: the icons on the title's line within 1 pt, inside the bar and clear of the
# banner, and the menu and sheet open.
#   NSH            the nsh CLI at the pinned revision (default: nsh on PATH)
#   DSH_DERIVED    Xcode's build folder for the iOS probe (default nsh-app/ios/build/derived)
# Exits non-zero when the test or any measurement fails.
set -euo pipefail
platform="${1:?usage: tools/header-check.sh ios|android}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/nsh-app"
OUT="$APP/build/header-probe"
NSH="${NSH:-nsh}"
rm -rf "$OUT"; mkdir -p "$OUT"
probe=""
relay=""
share=""
stop() {
  touch "$OUT/stop"; [ -z "$share" ] || touch "$share/stop"
  [ -z "$relay" ] || wait "$relay" 2>/dev/null || true
  [ -z "$probe" ] || wait "$probe" 2>/dev/null || true
  [ -z "$share" ] || { cp "$share"/*.json "$OUT"/ 2>/dev/null || true; rm -rf "$share"; }
  probe="" relay="" share=""  # once: the EXIT trap runs it again
}
trap stop EXIT

case "$platform" in
  ios)
    udid="${UDID:-$(xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -1)}"
    [ -n "$udid" ] || { echo "no booted iOS simulator" >&2; exit 2; }
    derived="${DSH_DERIVED:-$APP/ios/build/derived}"
    [ -d "$APP/ios/DSH.xcodeproj" ] || { echo "no ios/DSH.xcodeproj: run nsh-app/ios/build.sh first" >&2; exit 2; }
    # The probe runs in the simulator, which may not write to the checkout (macOS keeps it off removable volumes):
    # it works in the simulator's own data folder, which the relay below keeps in step with $OUT.
    share="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/tmp/dsh-header-probe"
    rm -rf "$share"; mkdir -p "$share"
    TEST_RUNNER_DSH_PROBE_DIR="$share" xcodebuild test -quiet -project "$APP/ios/DSH.xcodeproj" -scheme DSH \
      -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$derived" \
      -only-testing:DSHUITests/HeaderProbe/testProbe > "$OUT/probe.log" 2>&1 &
    probe=$!
    for _ in $(seq 1 600); do [ -f "$share/ready.json" ] && break; kill -0 "$probe" 2>/dev/null || break; sleep 1; done
    [ -f "$share/ready.json" ] || { cat "$OUT/probe.log" >&2; echo "the iOS probe did not start" >&2; exit 1; }
    # Each screenshot the test takes becomes a marker for the probe; each measurement comes back beside it.
    (
      while [ ! -f "$OUT/stop" ]; do
        for png in "$OUT"/*.png; do
          [ -f "$png" ] || continue
          name="$(basename "$png")"
          [ -f "$share/$name" ] || : > "$share/$name"
          json="${name%.png}.json"
          [ ! -f "$share/$json" ] || [ -f "$OUT/$json" ] || cp "$share/$json" "$OUT/$json"
        done
        sleep 0.3
      done
    ) &
    relay=$!
    export NSH_TEST_DEVICE="$udid"
    ;;
  android)
    adb="${ADB:-adb}"
    serial="${ANDROID_SERIAL:-$("$adb" devices | awk 'NR>1 && $2=="device" {print $1; exit}')}"
    [ -n "$serial" ] || { echo "no Android device" >&2; exit 2; }
    export ANDROID_SERIAL="$serial"
    dpi=$("$adb" -s "$serial" shell wm density | tr -d '\r' | awk -F': ' '/Override/ {o=$2} /Physical/ {p=$2} END {print o ? o : p}')
    python3 -c "print(${dpi} / 160)" > "$OUT/density.txt"
    (
      while [ ! -f "$OUT/stop" ]; do
        for png in "$OUT"/*.png; do
          [ -f "$png" ] || continue
          xml="${png%.png}.xml"
          [ -f "$xml" ] && continue
          sleep 1  # the screenshot is taken; let the frame after it settle
          "$adb" -s "$serial" exec-out uiautomator dump /dev/tty 2>/dev/null | sed -n 's/.*\(<?xml.*<\/hierarchy>\).*/\1/p' > "$xml.part" || true
          if [ -s "$xml.part" ]; then mv "$xml.part" "$xml"; else rm -f "$xml.part"; continue; fi
          # The chats page itself (<page>-<connection>-<scheme>): tap ⋯ near its edges and inside its hit slop, and
          # look for the menu after each; Back closes it before the test goes on.
          name="$(basename "${png%.png}")"
          case "$name" in chats-*-*) ;; *) continue ;; esac
          [ "$(tr -cd - <<<"$name" | wc -c | tr -d ' ')" = 2 ] || continue
          taps="{"  # adb reads stdin: each call in this loop gets /dev/null so it leaves the tap list alone
          while IFS=$'\t' read -r label x y; do
            "$adb" -s "$serial" shell input tap "$x" "$y" </dev/null
            sleep 1.2
            if "$adb" -s "$serial" exec-out uiautomator dump /dev/tty </dev/null 2>/dev/null | grep -q 'resource-id="header-menu"'; then
              opened=true; "$adb" -s "$serial" shell input keyevent KEYCODE_BACK </dev/null; sleep 0.8
            else opened=false; fi
            taps="$taps\"$label\": $opened, "
          done < <(python3 "$ROOT/tools/header-check.py" taps "$xml" "$(cat "$OUT/density.txt")")
          printf '%s}\n' "${taps%, }" > "${png%.png}.taps.json"
        done
        sleep 0.3
      done
    ) &
    probe=$!
    ;;
  *) echo "usage: tools/header-check.sh ios|android" >&2; exit 2 ;;
esac

status=0
if [ "$platform" = ios ]; then
  # The iOS host follows the simulator's appearance, not the test's colorScheme: run each scheme's cases in it.
  before="$(xcrun simctl ui "$udid" appearance)"
  for scheme in light dark; do
    xcrun simctl ui "$udid" appearance "$scheme"
    (cd "$APP" && "$NSH" test --target ios --filter "$scheme," src/header.test.tsx) || status=1
  done
  xcrun simctl ui "$udid" appearance "$before"
else
  (cd "$APP" && "$NSH" test --target "$platform" src/header.test.tsx) || status=$?
fi
stop
python3 "$ROOT/tools/header-check.py" "$OUT" || status=1
exit "$status"
