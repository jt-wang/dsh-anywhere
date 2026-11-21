# Build DSH for TestFlight

The TestFlight workflow builds a signed iOS IPA on GitHub. A release operator can trigger it with Actions write access; Apple signing material stays in the workflow's `apple-release` environment.

Start with **Actions → TestFlight → Run workflow** on the default branch. Set `source_sha` to that branch's full commit SHA, choose the version and an unused build number, and leave `upload` false. The artifact contains `DSH.ipa` and `summary.json`, including the source SHA and IPA hash. This mode signs and checks the IPA locally on the runner without contacting App Store Connect.

After reviewing that run, a run with `upload` true rebuilds the requested source, validates the IPA with Apple, then uploads it. A successful upload command still requires App Store Connect processing before the build is available to testers. It does not submit an App Store release. Native UI testing is a separate release check.

## Read App Store Connect before choosing a build

Set `status_only=true` and `upload=false` to skip the entire archive job. This mode uses only the three ASC secrets in the existing `apple-release` environment; it does not request signing credentials or install an SDK. Supply the proposed version/build and the exact default-branch source SHA as usual.

The `dsh-testflight-status-<run_id>` artifact contains `asc-status.json`: the app ID, UTC query time, fully paginated iOS build inventory across versions and processing states, highest and next numeric build, whether the proposed build number is already occupied, and app-owned beta groups with explicit/automatic build access. A missing proposed build is a successful inventory result, not an upload or processing acceptance. Choose a number only after inspecting this receipt. Concurrent uploads outside this workflow can still consume it; recheck rather than blindly retry an uncertain upload.

After an upload succeeds, the status job waits at most 20 minutes for that exact version/build to reach `VALID`, then records processing, beta states and group access. It changes no groups, testers, export-compliance declarations, reviews or releases. `VALID` and group access are separate from tester eligibility; check the internal state and the intended tester's TestFlight app. If Apple is still processing after the observation deadline, use a new read-only run, not a new upload.

For example, inventory only (no build or upload):

```sh
gh workflow run testflight.yml --ref main \
  -f source_sha="$RELEASE_SHA" -f version="$RELEASE_VERSION" \
  -f build="$PROPOSED_BUILD" -f upload=false -f status_only=true
```

## Submit a VALID build for Beta App Review

Set `submit_beta=true` with `upload=false` and `status_only=false` to put one VALID build on the external group behind a public TestFlight link and submit it for Beta App Review. It never builds, never touches another build or group, and never submits for App Store review. `public_link` is the code after `https://testflight.apple.com/join/`; exactly one external group must have that link. `what_to_test` is the en-US What to Test text (1 to 4000 characters). Each step is skipped when App Store Connect already has it, so a rerun is safe. The ASC key needs the App Manager or Admin role; a weaker key fails with Apple's error code in the receipt.

```sh
gh workflow run testflight.yml --ref main \
  -f source_sha="$MAIN_SHA" -f version="$RELEASE_VERSION" -f build="$BUILD" \
  -f upload=false -f status_only=false -f submit_beta=true \
  -f public_link="$LINK_CODE" -f what_to_test="$WHAT_TO_TEST"
```

The `dsh-testflight-submit-<run_id>` artifact contains `asc-submit.json`: what was written, whether the group has the build, and the `beta_review_state` read back afterwards.

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

The first four are required for either archive mode, not for `status_only`. The three ASC secrets are required when `upload` or `status_only` is true. The p12 identity must match a certificate in the profile; the profile must be unexpired, belong to the team and exact bundle, and allow App Store distribution. An ASC key does not replace the signing private key. Use the existing App Store Connect app record.

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

The workflow selects Xcode 26.3 on the standard GitHub-hosted `macos-15-intel` runner, prepares Go, and downloads [XcodeGen 2.45.4](https://github.com/yonaskolb/XcodeGen/releases/tag/2.45.4) with a pinned SHA-256 check before extracting it. Intel hosting avoids the macOS ARM capacity cancellations observed on 2026-11-19; the device and simulator framework targets remain ARM64. It builds the pinned NSH CLI and iOS frameworks, then runs `tools/build-tailcat.sh`, `nsh-app/ios/build.sh` and the existing `check-testflight.sh`. The CI wrapper also extracts the IPA and requires `codesign --verify --deep --strict` to succeed before writing its success summary. Framework compilation includes simulator slices but does not start a simulator.

The NSH checkout is pinned and receives `nsh-app/ios/nsh-window-tap.patch` before compilation. The dependency step runs `runtime_sdk.py prepare` without signing credentials. Its receipt binds the workflow run/attempt/SHA, source checkout, patch, builder, CLI and framework files. Archive verifies that receipt before importing signing material; `build.sh` verifies the framework before and after copying and never recompiles it in this path. A missing or mismatched receipt fails without a rebuild fallback. Local builds without a receipt prepare the SDK first; preparation refuses signing or ASC secret variables. The private receipt stays on the runner; the artifact summary retains its hash.

Signing uses a temporary keychain and profile. Cleanup attempts each operation even if another fails, restores the source version and keychain search list, and reports failure if cleanup fails. The ASC key is written in a separate temporary directory for validation/upload and removed afterward. A forced runner termination can prevent process cleanup; use the GitHub-hosted runner specified by the workflow. Only the IPA and summary are retained as artifacts for seven days.

Offline command-boundary tests are available on macOS with Python 3.11 or newer and PyYAML:

```sh
python3 nsh-app/ios/runtime_patch_test.py
python3 nsh-app/ios/testflight_ci_test.py
python3 nsh-app/ios/asc_status_test.py
python3 .github/tests/testflight_workflow_test.py
```

These substitute signing, build and upload tools with synthetic commands. They check failure propagation and credential-file cleanup; a real hosted archive and upload remain separate checks.
