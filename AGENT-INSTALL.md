# Install DSH Anywhere on a Mac

For an AI agent installing DSH Anywhere for a person. DSH Anywhere lets their phone use the DeepSeek Harness (DSH)
agents on this Mac. The companion runs inside DSH Desktop; the phone reaches it through Tailcat, with no open port
and no VPN. Installing is one command: nothing to clone or build.

The package is `@jt-wang/dsh-anywhere` on npm. Always write the `@jt-wang/` scope: the bare name `dsh-anywhere` on npm
is another author's DSH plugin (remote workspaces over SSH), not this one.

## 1. Check

1. Apple-silicon Mac: `uname -m` prints `arm64`.
2. DSH Desktop is installed (`/Applications/DeepSeek Harness.app`) and has been opened once:
   `~/.dsh/profiles/desktop/package.json` exists (`$DSH_HOME/profiles/desktop/…` if `DSH_HOME` is set).
3. `dsh --version` prints `0.2.0-rc.2`, a 0.2.1 version (`0.2.1`, `0.2.1-alpha.N`, `-beta.N`, `-rc.N`) or a 0.2.2
   release candidate or release (`0.2.2-rc.N`, `0.2.2`). If `dsh` is
   not found, use the app's own launcher in its place:
   `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"`.
4. Earlier install from source: if `~/.dsh/profiles/desktop/cordis.patch.yml` contains
   `# DSH-MOBILE-COMPANION-BEGIN`, tell the person and, with their consent, delete the lines from `BEGIN` to `END`
   inclusive. Paired phones are kept: both installs use the same private folder.
5. Tell the person which phone app to install. Android 9 or later:
   [dsh-anywhere.apk](https://github.com/jt-wang/dsh-anywhere/releases/latest/download/dsh-anywhere.apk). iPhone on iOS 17
   or later: open https://testflight.apple.com/join/nbURjw6a on the iPhone. Both pair the same way
   ([§ 4](#4-pair-the-phone)). Only someone who wants to build the iPhone app themselves follows
   [AGENT-IPHONE.md](AGENT-IPHONE.md).
6. Earlier install from a GitHub download (DSH Anywhere 0.1.10 and before installed the release's
   `dsh-anywhere-darwin-arm64.tgz` as a package named `dsh-anywhere`, which DSH cannot update): if
   `~/.dsh/profiles/desktop/package.json` lists `dsh-anywhere` (no scope) under `dependencies`, follow
   [Switch from the GitHub download](#7-switch-from-the-github-download) instead of step 2.

## 2. Install

```sh
dsh plugin --profile desktop add @jt-wang/dsh-anywhere
```

It ends with `+ @jt-wang/dsh-anywhere <version>` and exit code 0. DSH checks the package's supported DSH versions while
installing and refuses it on an unsupported DSH.

## 3. Verify

- `~/.dsh/profiles/desktop/package.json` lists `@jt-wang/dsh-anywhere` under `dsh.profile.bundles`.
- DSH Desktop loads the new bundle by itself; if nothing happens within a minute, ask the person to quit and reopen
  DSH. The first start creates `~/Library/Application Support/DSHMobile/host/host.json` (owner-only).
- `~/Library/Application Support/DSHMobile/host/companion.log` ends with `running <version>`. A `failed <version>
  <code>` line names the problem: `unsupported_dsh_version` (DSH version not supported), `companion_conflict` (the
  block from step 1.4 is still there), `tailcat_helper_missing` (damaged package: install again), `unavailable` (could not start; check whether another
  program holds port 19445).

## 4. Pair the phone

The person installs the DSH Anywhere app on the phone, then in DSH Desktop opens **Settings → Mobile → Pair a phone**
and scans the QR code with the app within two minutes. The QR code is a one-use secret: do not copy it anywhere.

## 5. Update

DSH Desktop updates the plugin itself: **Plugins** in its sidebar marks `@jt-wang/dsh-anywhere` when a newer version
is out, and its Update button installs it (DSH's own plugin manager, which puts the old version back if the new one
fails). From a terminal, `dsh plugin --profile desktop add @jt-wang/dsh-anywhere@latest` does the same. Then check that
`companion.log` ends with `running <new version>`; if it does not within a minute, ask the person to quit and reopen
DSH Desktop. Paired phones stay paired. The phone app says when it and the computer come from different releases, and
which one to update.

## 6. Remove

```sh
dsh plugin --profile desktop remove @jt-wang/dsh-anywhere
```

The private configuration and paired phones stay in `~/Library/Application Support/DSHMobile/`; delete that folder
only if the person wants this Mac to forget its phones.

## 7. Switch from the GitHub download

Once, for a Mac that installed DSH Anywhere 0.1.10 or earlier from the GitHub release. That package is named
`dsh-anywhere`, the same name as another author's npm plugin, so first make sure the one installed here is ours:

```sh
P=~/.dsh/profiles/desktop/node_modules/dsh-anywhere
grep -q '"description": "DSH Anywhere: use DeepSeek Harness on this Mac from your phone"' "$P/package.json" \
  && test -f "$P/dist/tailcat/dsh-tailcat-host-darwin-arm64" && echo ours || echo "not ours"
```

- `not ours`: the `dsh-anywhere` here is the other author's plugin, which the person installed on purpose. Leave it
  alone and install with step 2. (The two cannot be told apart by name; this one has neither our description nor the
  Tailcat helper.)
- `ours`: tell the person, and with their consent switch to the npm package. Remove first, so two companions never
  run at once:

```sh
dsh plugin --profile desktop remove dsh-anywhere
dsh plugin --profile desktop add @jt-wang/dsh-anywhere
```

Then verify as in step 3. Paired phones stay paired and need nothing: pairing and settings live in
`~/Library/Application Support/DSHMobile/`, which neither command touches. Do not run `dsh plugin … update
dsh-anywhere` or add `dsh-anywhere` without the scope: that would install the other author's package.
