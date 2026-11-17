# Build DSH for TestFlight

The TestFlight workflow builds a signed iOS IPA on GitHub. A release operator can trigger it with Actions write access; Apple signing material stays in the workflow's `apple-release` environment.

Start with **Actions → TestFlight → Run workflow** on the default branch. Set `source_sha` to that branch's full commit SHA, choose the version and an unused build number, and leave `upload` false. The artifact contains `DSH.ipa` and `summary.json`, including the source SHA and IPA hash. This mode signs and checks the IPA locally on the runner without contacting App Store Connect.

After reviewing that run, a run with `upload` true rebuilds the requested source, validates the IPA with Apple, then uploads it. A successful upload command still requires App Store Connect processing before the build is available to testers. It does not submit an App Store release. Native UI testing is a separate release check.

## Repository setup

A repository administrator creates the `apple-release` environment and restricts its deployment branches to the exact default branch, with no tag rule. Required reviewers are optional. Store the following as **environment secrets**, so the branch restriction protects their use:

| Secret | Value supplied by the administrator | Used by |
| --- | --- | --- |
| `APPLE_TEAM_ID` | Apple Developer team ID | Signing preflight and archive |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64-encoded Distribution certificate and its private key, exported as p12 | Signing preflight and archive |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Nonempty p12 export password | Signing preflight and archive |
| `IOS_PROVISION_PROFILE_BASE64` | Base64-encoded App Store profile for `io.jingtao.dshanywhere` | Signing preflight and archive |
| `ASC_KEY_ID` | App Store Connect API key ID | Upload preflight and upload |
| `ASC_ISSUER_ID` | App Store Connect API issuer ID | Upload preflight and upload |
| `ASC_PRIVATE_KEY_P8` | App Store Connect API private key, including PEM line breaks | Upload preflight and upload |

The first four are required for either mode. The three ASC secrets are required only when `upload` is true. The p12 identity must match a certificate in the profile; the profile must be unexpired, belong to the team and exact bundle, and allow App Store distribution. An ASC key does not replace the signing private key. Use the existing App Store Connect app record.

Protect changes to the default branch and workflow. Give automation Actions write access without permission to bypass that protection or administer environment secrets. The workflow checks the dispatch event, source ref/SHA and workflow ref/SHA; checkout uses the run's exact SHA. Branch restrictions are the server-side control: checks inside a workflow cannot protect secrets from someone allowed to replace that workflow.

## CLI dispatch

From this repository, after selecting a release version and unused build number, the equivalent command is:

```sh
gh workflow run testflight.yml --ref main \
  -f source_sha="$RELEASE_SHA" \
  -f version="$RELEASE_VERSION" \
  -f build="$RELEASE_BUILD" \
  -f upload=false
```

Use the actual default branch if it changes. The SHA must still match the branch when GitHub creates the run. Change `upload` to `true` only for an intended upload. Ordinary pushes do not trigger this workflow. If an upload fails or loses its response, check App Store Connect for that version/build before dispatching again.

## Build and cleanup

The workflow selects Xcode 26.3 on `macos-15`, prepares Go, checks that `uname -m` is `arm64`, and downloads [XcodeGen 2.45.4](https://github.com/yonaskolb/XcodeGen/releases/tag/2.45.4) with a pinned SHA-256 check before extracting it. It builds the pinned NSH CLI and iOS frameworks, then runs `tools/build-tailcat.sh`, `nsh-app/ios/build.sh` and the existing `check-testflight.sh`. The CI wrapper also extracts the IPA and requires `codesign --verify --deep --strict` to succeed before writing its success summary. Framework compilation includes simulator slices but does not start a simulator.

The NSH checkout is pinned and receives `nsh-app/ios/nsh-window-tap.patch` before compilation. The dependency step runs `runtime_sdk.py prepare` without signing credentials. Its receipt binds the workflow run/attempt/SHA, source checkout, patch, builder, CLI and framework files. Archive verifies that receipt before importing signing material; `build.sh` verifies the framework before and after copying and never recompiles it in this path. A missing or mismatched receipt fails without a rebuild fallback. Local builds without a receipt prepare the SDK first; preparation refuses signing or ASC secret variables. The private receipt stays on the runner; the artifact summary retains its hash.

Signing uses a temporary keychain and profile. Cleanup attempts each operation even if another fails, restores the source version and keychain search list, and reports failure if cleanup fails. The ASC key is written in a separate temporary directory for validation/upload and removed afterward. A forced runner termination can prevent process cleanup; use the GitHub-hosted runner specified by the workflow. Only the IPA and summary are retained as artifacts for seven days.

Offline command-boundary tests are available on macOS with Python 3.11 or newer and PyYAML:

```sh
python3 nsh-app/ios/runtime_patch_test.py
python3 nsh-app/ios/testflight_ci_test.py
python3 .github/tests/testflight_workflow_test.py
```

These substitute signing, build and upload tools with synthetic commands. They check failure propagation and credential-file cleanup; a real hosted archive and upload remain separate checks.
