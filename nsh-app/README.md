# DSH Anywhere: the phone app

The phone app for DeepSeek Harness: your chats from DSH on your Mac, the agent's work as it happens, send and stop,
and the small native interfaces the agent builds with `show_interface`. Written in TSX on [NSH](https://nsh.dev),
in small native shells for Android (`android/`) and iOS (`ios/`).

## Use it

1. On the Mac: DSH › Settings › Mobile › **Pair a phone** (needs the companion installed with `--generative-ui`
   for interfaces: `node tools/install-host.mjs --profile desktop --generative-ui --activate`).
2. On the phone: **Scan pairing code**. The phone reaches the Mac through Tailcat; nothing is exposed to the internet.

When an answer is ready, a turn stops with an error, or an agent waits for your decision in a chat you are not
looking at, the app shows a banner at the top; with the app in the background, the phone shows a notification, and
tapping it opens that chat. The phone asks for permission the first time one of your own chats starts working.
On Android the app keeps watching while a chat runs (an ongoing notification says so). On iOS it watches only for
the short time iOS gives an app after you leave it (tens of seconds); news from a turn that ends later shows when you
come back.

## Build and test

For changing the app. To just use it, download it from the [latest release](https://github.com/jt-wang/dsh-anywhere/releases/latest). The Mac companion builds from [its own section](../docs/SETUP-MAC.md#build-and-install-from-source).

```sh
# NSH from source (v0.3.0 lacks fixes this app needs):
#   git clone -b dsh-anywhere https://github.com/jt-wang/nsh
#   cd nsh && cargo build --release -p nsh-cli && cargo xtask android --release --abi arm64-v8a
export NSH_SOURCE=/path/to/nsh
"$NSH_SOURCE/target/release/nsh" test            # app tests (fold, client, link screen)
"$NSH_SOURCE/target/release/nsh" check
android/build.sh                                  # → android/build/DSH.apk (arm64)
node android/app/src/test/make-fixtures.ts android/app/src/test/resources   # once: synthetic test keys
(cd android && ./gradlew testReleaseUnitTest)     # shell tests: pairing validation, pinned TLS bridge
```

The Tailcat library comes from `tools/build-tailcat.sh` (into `android/app/libs/`).

`android/build.sh` signs with the debug key unless `DSH_ANDROID_KEYSTORE` names a PKCS12 release key (alias `release`)
and `DSH_ANDROID_KEYSTORE_PASSWORD` holds its password. An APK signed with another key cannot update one already
installed, so every APK you hand out must come from the same release key; keep the key and its password backed up.

The public repository's `Android release` workflow builds this NSH shell on Linux from an exact main commit.
It uses `ANDROID_RELEASE_KEYSTORE`, `ANDROID_RELEASE_PASSWORD` and `ANDROID_RELEASE_KEY_ALIAS` only for the final
signing step, verifies the certificate against the previously shipped APK, and retains the APK as a run artifact.
The version and build come from `nsh.json`; dispatch with `gh workflow run android-release.yml --ref main -f source_sha=<commit>`.

```sh
keytool -genkeypair -alias release -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12 \
  -keystore release.p12 -dname "CN=Your app"     # once; keep release.p12 outside the repository
```

iOS needs Xcode and xcodegen. The runtime fix in `ios/nsh-window-tap.patch` is based on
`jt-wang/nsh` revision `7b3031fb7c9b93b0dee65f48a227bcf15d2bda38`. Apply it in a separate NSH source checkout
before building the app. It gives a handled header press priority over system taps on both `UIWindow` and
`UINavigationBar`. On iPhone 17 Pro Max / iOS 27.2, the system tap is on the navigation bar: the old window-only
patch let buttons highlight but swallowed the press before its JS callback. The same arbitration also prevents
an unwanted scroll-to-top; the app's JS callbacks do not need remapping. Local `ios/build.sh` runs prepare the patched SDK before
copying it. CI prepares it without signing credentials, then supplies `DSH_NSH_RECEIPT`; the app build verifies
the run identity, revision, patch and framework file hashes instead of compiling again. Missing or mismatched
receipts stop the build. Cargo's compilation cache is retained.

```sh
# From nsh-app/, with NSH_SOURCE pointing to that separate checkout at the revision above:
git -C "$NSH_SOURCE" apply --check "$PWD/ios/nsh-window-tap.patch"
git -C "$NSH_SOURCE" apply "$PWD/ios/nsh-window-tap.patch"
git -C "$NSH_SOURCE" apply --check "$PWD/nsh-number-pad.patch"
git -C "$NSH_SOURCE" apply "$PWD/nsh-number-pad.patch"
```

`nsh-number-pad.patch` goes into both platforms' builds (Android's release workflow applies it too). NSH's
`NumberInput` shows a decimal pad whenever its minimum is not negative; with the patch, a whole minimum and a whole
step get the digits-only pad (iOS `NumberPad`, Android's unsigned number keyboard), as the Settings pages' counts,
seconds and kilobytes need.

```sh
ios/build.sh                                      # → ios/build/DSH.app for the simulator
DEVICE=1 ios/build.sh                             # for a phone, signed by your own Apple team: ios/signing.env.example, ../AGENT-IPHONE.md
ARCHIVE=1 DSH_TEAM=<team id> DSH_PROFILE="<App Store profile>" ios/build.sh   # → ios/build/export/DSH.ipa for TestFlight, then ios/check-testflight.sh runs on it
(cd ios/DSHKit && swift test)                     # shell tests: pairing validation, pinned TLS bridge, upload
```

`ios/DSHUITests/HeaderButtonsTests.swift` exercises the sample app through UIKit taps and keyboard input:
home creation and menus, chat menus and reading position, send, approvals, questions and stop. After `ios/build.sh`,
run `xcodebuild test -project ios/DSH.xcodeproj -scheme DSH -destination 'platform=iOS Simulator,id=<UUID>' -only-testing:DSHUITests/HeaderButtonsTests`
on a fresh, unpaired simulator. These are native simulator checks, not acceptance of a physical iPhone, the
TestFlight package, or a live DSH host. Keep both iOS 26.1 and the affected iOS 27.x in the acceptance matrix.

Navigation-bar fix validation (2026-11-17): all 13 tests passed on iPhone 17 Pro Max / iOS 27.2 (24B8117),
iPhone Duo / iOS 27.1 (24A94425), and iPhone 17 Pro Max / iOS 26.1 (23B86). The app, tests and both runtime slices
were built with Xcode 27.2 (27B52), SDK 27.2; Xcode 26.1.1 (17B100) drove the 26.1 run without rebuilding.
Swapping back to the window-only SDK on 27.2 made the same home-menu, new-chat and chat-reading-position tests
fail because their menus/sheet never appeared. No diagnostic instrumentation is needed in the candidate.
The unsigned Release device build also links the navigation-bar check into both PressRecognizer arbitration
methods. The remaining device acceptance target is iPhone 17 Pro Max / iOS 27.2.1 with a newly distributed build.

The iOS Tailcat framework comes from `IOS_ONLY=1 tools/build-tailcat.sh` (into `ios/Frameworks/`).

An APK built on your machine carries the build paths of NSH's native library (Cargo's registry under your home
folder, the checkout's folder) unless the runtime is built with them remapped. For an APK you hand out:

```sh
cd "$NSH_SOURCE"
US=$'\x1f'   # Cargo's separator for encoded flags; paths may contain spaces
CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/cargo${US}--remap-path-prefix=$HOME/.rustup=/rustup${US}--remap-path-prefix=$PWD=/nsh${US}--remap-path-prefix=$HOME=/home" \
CC_SHELL_ESCAPED_FLAGS=1 CFLAGS_aarch64_linux_android="'-ffile-prefix-map=$PWD=/nsh' '-ffile-prefix-map=$HOME=/home'" \
  cargo xtask android --release --abi arm64-v8a
```

## How it is put together

- `src/dsh.ts` speaks DSH's own web protocol (calls and one multiplexed socket); `src/fold.ts` turns the session
  stream into what DSH Desktop draws; `src/chat.tsx`, `src/sessions.tsx`, `App.tsx` are the screens.
- The shell (`android/app/src/main/java/dev/dshmobile/nsh/`): `Link` pairs and connects, `Bridge` is a local port
  whose connections continue as TLS pinned to the computer's certificate, `Vault` keeps the link encrypted with an
  Android Keystore key, `Modules` verifies and runs generated interfaces. The iOS shell (`ios/DSH/`) gives the app
  the same host functions; what it decides on its own (pairing input, the pinned bridge, uploads) is in `ios/DSHKit`.
- The companion (`host/`) relays `/dsh/*` to DSH for the owner's paired phone (`host/src/dsh-relay.ts`).
- Adding a workspace (`src/folderpicker.tsx`, `src/folders.ts`): recent projects first, then the computer's folders.
  DSH Desktop on its own computer keeps its folder listing for its own window, so the companion lists folders itself
  (`/dsh/companion/folders/*`, `host/src/folders.ts`), only in your home folder and your workspace folders. A typed
  path that does not exist is offered for creation; only its last folder is created, after you confirm.
