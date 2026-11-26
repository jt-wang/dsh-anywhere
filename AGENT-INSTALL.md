# Install DSH Anywhere on a computer

For an AI agent installing DSH Anywhere for a person. DSH Anywhere lets their phone use the DeepSeek Harness (DSH)
agents on this computer. The companion runs inside DSH Desktop; the phone reaches it through Tailcat, with no open port
and no VPN. Installing is one command: nothing to clone or build.

It runs on every computer DSH Desktop is built for: Macs with Apple silicon, Intel Macs and Windows x64. DSH Desktop
has no Linux or Windows on Arm app, so neither does DSH Anywhere.

| | Mac (Apple silicon or Intel) | Windows x64 |
|---|---|---|
| DSH Desktop | `/Applications/DeepSeek Harness.app` | installed for the current user, in the folder the person chose (Start menu → DeepSeek Harness → right-click → Open file location) |
| DSH home (`DSH_HOME`, if set, replaces it) | `~/.dsh` | `%USERPROFILE%\.dsh` |
| `dsh` if it is not on PATH | `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"` | `"<DSH Desktop folder>\resources\runtime\cli\bin\dsh.cmd"` |
| DSH Anywhere's private folder (below: *the private folder*) | `~/Library/Application Support/DSHAnywhere` | `%LOCALAPPDATA%\DSHAnywhere` |

DSH Anywhere companion 0.8.3 and earlier, from when the project was called DSH Mobile, kept the private folder under the name
`DSHMobile` in the same place. The companion renames it to `DSHAnywhere` on its first start; paired phones and settings
move with it. Leave both folders alone.

On Windows, run the commands below in PowerShell, with the paths of the Windows column.

The package is `@jt-wang/dsh-anywhere` on npm. Always write the `@jt-wang/` scope: the bare name `dsh-anywhere` on npm
is another author's DSH plugin (remote workspaces over SSH), not this one.

## 1. Check

1. The computer is a Mac (`uname -m` prints `arm64` or `x86_64`) or Windows x64 (in PowerShell,
   `$env:PROCESSOR_ARCHITECTURE` prints `AMD64`). On any other computer (Linux, Windows on Arm), stop and tell the
   person: DSH Anywhere works with DSH Desktop, which DeepSeek makes only for Macs and Windows x64; it would need DSH
   Desktop on one of those. Do not install the package there: it would refuse to start (`unsupported_computer`).
2. DSH Desktop is installed and has been opened once: `profiles/desktop/package.json` exists in the DSH home.
3. `dsh --version` prints `0.2.0-rc.2`, a 0.2.1 or 0.2.3 release or numbered pre-release (`-alpha.N`, `-beta.N`,
   `-rc.N`), a 0.2.2 release candidate or release (`0.2.2-rc.N`, `0.2.2`), or any later version below 1.0.0. If `dsh` is
   not found, use the app's own launcher from the table in its place (on Windows, DSH Desktop's **Manage dsh
   Command…** also puts `dsh` on the user's PATH).
4. Earlier install from source: if `profiles/desktop/cordis.patch.yml` in the DSH home contains
   `# DSH-MOBILE-COMPANION-BEGIN`, tell the person and, with their consent, delete the lines from `BEGIN` to `END`
   inclusive. Paired phones are kept: both installs use the same private folder.
5. Tell the person which phone app to install. Android 9 or later:
   [dsh-anywhere.apk](https://github.com/jt-wang/dsh-anywhere/releases/latest/download/dsh-anywhere.apk). iPhone on iOS 17
   or later: open https://testflight.apple.com/join/nbURjw6a on the iPhone. Both pair the same way
   ([§ 4](#4-pair-the-phone)). Only someone who wants to build the iPhone app themselves follows
   [AGENT-IPHONE.md](AGENT-IPHONE.md).
6. Earlier install from a GitHub download (DSH Anywhere 0.1.10 and before installed the release's
   `dsh-anywhere-darwin-arm64.tgz` as a package named `dsh-anywhere`, which DSH cannot update): if
   `profiles/desktop/package.json` in the DSH home lists `dsh-anywhere` (no scope) under `dependencies`, follow
   [Switch from the GitHub download](#7-switch-from-the-github-download) instead of step 2.

## 2. Install

```sh
dsh plugin --profile desktop add @jt-wang/dsh-anywhere
```

It ends with `+ @jt-wang/dsh-anywhere <version>` and exit code 0. DSH checks the package's supported DSH versions while
installing and refuses it on an unsupported DSH.

## 3. Verify

- `profiles/desktop/package.json` in the DSH home lists `@jt-wang/dsh-anywhere` under `dsh.profile.bundles`.
- DSH Desktop loads the new bundle by itself; if nothing happens within a minute, ask the person to quit and reopen
  DSH. The first start creates `host/host.json` in the private folder (owner-only).
- `host/companion.log` in the private folder ends with `running <version>`. A `failed <version> <code>` line names
  the problem; tell the person what it means and do the next step:
  - `unsupported_dsh_version`: this DSH is not one the companion supports. Ask the person to update DSH Desktop
    (it updates itself), then check `dsh --version` again.
  - `companion_conflict`: the block from step 1.4 is still in the profile. Remove it with their consent, then reopen
    DSH Desktop.
  - `tailcat_helper_missing`: the installed package is damaged. Run
    `dsh plugin --profile desktop add @jt-wang/dsh-anywhere@latest`.
  - `unsupported_computer`: this is not a computer DSH Desktop is built for (for example Linux, or Windows on Arm
    running DSH from npm). Remove the plugin (step 6) and tell the person DSH Anywhere needs a Mac or Windows x64.
  - `unavailable`: it could not start. Check whether another program holds port 19445 (`lsof -nP -iTCP:19445` on a
    Mac, `Get-NetTCPConnection -LocalPort 19445` in PowerShell on Windows); quit that program or ask the person.
  - `unsafe_private_path` (Windows): the private folder's permissions are not owner-only, often because it was copied
    from elsewhere. With the person's consent, rename the folder and reopen DSH Desktop, which creates a new one (paired
    phones must then pair again).

## 4. Pair the phone

The person installs the DSH Anywhere app on the phone, then in DSH Desktop opens **Settings → DSH Anywhere → Pair a phone**
(the same page is on DSH Anywhere's own page under **Plugins**) and scans the QR code with the app within two minutes.
The phone and the computer then both show four emoji; the person chooses **They match, allow** on the computer only
when they are the same. The QR code is a one-use secret: do not copy it anywhere.
The same page lists the paired phones and revokes them. The first pairing on a new computer can take up to a minute
while the companion reaches Tailcat's relays; on Windows, if the firewall asks about `dsh-tailcat-host`, the person may
choose **Cancel**: the phone still reaches the computer through Tailcat's relays, with no open port. The computer must stay
on and awake, with DSH Desktop open, for the phone to reach it.

## 5. Update

DSH Desktop updates the plugin itself: **Plugins** in its sidebar marks `@jt-wang/dsh-anywhere` when a newer version
is out, and its Update button installs it (DSH's own plugin manager, which puts the old version back if the new one
fails), with no restart. From a terminal, `dsh plugin --profile desktop add @jt-wang/dsh-anywhere@latest` installs the
new version too, but a running DSH Desktop keeps the old one until it restarts: ask the person to quit and reopen DSH
Desktop. Either way, check that `companion.log` ends with `running <new version>`. Paired phones stay paired. The phone app says when it and the computer come from different releases, and
which one to update.

## 6. Remove

```sh
dsh plugin --profile desktop remove @jt-wang/dsh-anywhere
```

The private configuration and paired phones stay in the private folder; delete it only if the person wants this
computer to forget its phones.

## 7. Switch from the GitHub download

Once, for a Mac that installed DSH Anywhere 0.1.10 or earlier from the GitHub release (those releases ran only on
Apple-silicon Macs). That package is named
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
the private folder, which neither command touches. Do not run `dsh plugin … update
dsh-anywhere` or add `dsh-anywhere` without the scope: that would install the other author's package.
