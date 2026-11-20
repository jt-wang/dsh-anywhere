# Workspace settings — rc.5 ownership and acceptance

## Official alignment (2026-11-20)

Extends the existing DSH workspace registry rather than introducing a second registry or writing host files.
The inspected installed packages are **0.2.2-rc.5**. The full read-only settings inventory, section 9, is the
starting point; release-pinned source revision is `9c2670d3bce5275e0d1610272958121af87787bb`.

- `@deepseek-ai/dsh-api-workspace-controller/src/types.ts:64-112` and `commands.ts:71-154` define rename,
  registration deletion, workspace `insertBefore`, and session `insertSessionBefore`. All mutation wire arguments
  are `{request: {...}}`. Omitting the anchor means end, not first position.
  [Official commands](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/api/workspace-controller/src/commands.ts#L71-L154).
- `@deepseek-ai/dsh-workspace/src/entity.ts:152-175`: session moves require both session and anchor already
  accounted in that workspace. This is **not** a cross-directory move or session cwd mutation. UI explicitly says so.
- `@deepseek-ai/dsh-client-ui-workspace/src/client/stores.ts:16-31,82-118`: `groupBy`, `orderBy`, group expansion,
  flat-list session order and archived filters belong to browser-local `dsh.workspace.view.v5`, not a remote
  settings namespace. The phone now implements the same three group modes (`workspace`, `workspace-tree`,
  `flat`), two order modes (`manual`, `updated`) and three filters (`default`, `show`, `only`) in its own
  `prefs.workspaceView`. It never writes desktop localStorage or adds a synchronization RPC. Eight-language
  copy explicitly says “This is the sorting on your phone; it does not affect your computer.” Switching to
  manual captures complete current account orders; switching back to updated clears manual snapshots.
- `tree.ts:145-201,616-641`: implements descending recency with ascending ID ties, retained manual slots,
  new unarchived pins then new ordinary/archive members, and nearest case-sensitive registered path ancestry
  including Windows separators. Rendering partitions pinned unarchived chats first while preserving selected
  relative order, not the pin-array order. Saved unknown-summary members retain their manual slots.
- `rows/WorkspaceBrowser.tsx:980-1018,352-381,452-481`: per-workspace, ungrouped and flat order accounts;
  child groups before a parent's own sessions; archived-only mode promotes descendants past omitted ancestors.
  The shared native phone screen uses these algorithms on both platforms. Deliberate phone presentation
  differences: preserve the phone's previously expanded initial groups (desktop leaves start collapsed),
  explicit accessible up/down controls instead of pointer drag, and retain the phone's archived drawer under
  the default hidden filter. Local group expansion and hidden archive order slots persist across restarts.
  An incomplete offline cached list cannot prune saved manual orders. Remote registry order controls are
  separately labeled as shared entity operations, not desktop window sorting preferences.
- Checked the cached public release/issue inventory used by the parent alignment work: rc.5 release exists at
  [the official release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5);
  the inspected issue-list snapshot has no workspace/sidebar-titled alternative owner. This is not a claim to
  exhaust all future public plans or issues. The installed experimental package list includes
  `dsh-experimental-worktree` and `dsh-experimental-tool-worktree`, not a replacement workspace registry.
  `dsh-experimental-worktree/README.md:28-41` describes Git checkout creation and working-directory changes,
  a separate feature deliberately not invoked by these registration/order controls.

## Integration

Mount the named export from `./workspace-settings.tsx` inside Settings' existing keyboard-aware scroll:

```tsx
<WorkspaceSettings />
// Optionally pass current chat summaries to show titles rather than IDs:
<WorkspaceSettings chats={() => currentChatSummaries()} />
```

Phone view preferences appear immediately, work offline, and are included by `WorkspaceSettings`; the smaller
`WorkspaceViewPreferences` export is also available. Do not mount both in Settings. `SessionsScreen` consumes
these preferences and shows local manual up/down controls. No registry management reads happen until
**Manage workspaces** is pressed. `client` and `online` are optional injection seams; production defaults use
the existing paired DSH client and OS network signal. Closing/unmounting cancels management follow.
Create/folder browsing, archive/unarchive and pin controls remain in their existing surfaces. Keyboard shortcut
and update-channel settings remain computer-only; workspace view grouping/order is **not** computer-only.

Each mutation is sent once. A fresh `workspace/follow` opening baseline is required after it, including after
errors; the live follow stays active for desktop edits and reconnect baselines. A receipt alone cannot confirm
the desired state. Lost acknowledgement plus matching authority confirms only **current state**, not exactly-once
delivery or who made the change. Failed readback retains explicitly stale, non-editable rows; no blind replay.
Removing requires a separate confirmation naming the workspace and path, with explicit directory/files/chats
preservation wording. All product copy is available in eight languages with English fallback.

## Checks actually run

- `nsh test nsh-app`: **528 passed, 0 failed (3m 8s)** on the shared checkout, including existing app,
  cache/offline, settings, prefs and workspace tests plus both new workspace suites. This is headless coverage,
  not device acceptance. The separate final view-suite rerun below also passed after the offline guard change.
- `nsh test nsh-app/src/workspace-settings.test.tsx`: **8 passed**. Public model contracts plus actual native
  component interactions: exact requests, fresh readback/follow, conflicts, lost acknowledgements, no-op receipt
  mismatch, readback failure/offline retention, invalid membership, timeout, concurrent edit suppression,
  confirmation/cancel/removal, rename/order, close/reopen and localization.
- `nsh test nsh-app/src/workspace-settings-view.test.tsx`: **6 passed**. Public preference parsing/storage and
  real native SessionsScreen interactions: all modes, manual moves, archive/search filtering, persisted tree
  collapse, cold restore, eight languages, no remote writes, and incomplete offline-cache slot preservation.
  The headless engine's `texts()` is traversal order, not the y-order of absolutely positioned virtual List
  cells; exact ordering is asserted through public `workspaceViewRows`, not misleading text traversal.
- `node .amp/in/orb-backup/workspace-settings-view-differential.mjs`: **1,800 render cases, 1,800 order cases,
  7 POSIX/Windows ancestry cases passed** against imports of the actual installed rc.5 `tree.ts` exports,
  not duplicated expected algorithms. Covers every grouping/order/filter combination, ties, saved/new slots,
  pins, archives, nested parents, empty groups and collapse.
- `nsh test nsh-app/src/workspaces.test.ts`: **8 passed** (existing fold/group/archive/search controls unchanged).
- `nsh check nsh-app`: **exit 0** on the shared checkout after the concurrent provider-settings type fixes.
  An earlier run reported only provider-settings errors outside this task's ownership; they were not edited here.
- `nsh build nsh-app/src/workspace-settings-fixture.tsx -o .amp/in/orb-backup/workspace-settings-native-bundle --release`:
  **passed**, producing JS plus QuickJS bytecode. Run with `nsh run nsh-app/src/workspace-settings-fixture.tsx`
  or `nsh run nsh-app/src/workspace-settings-fixture.tsx --target ios` on an appropriate native runner.
- `nsh build nsh-app/src/workspace-settings-view-fixture.tsx -o .amp/in/orb-backup/workspace-settings-view-native-bundle --release`:
  **passed**. Run `nsh run nsh-app/src/workspace-settings-view-fixture.tsx` (Android) or add `--target ios`.
  This separate fixture mounts real native SessionsScreen with all local view controls, nested workspaces,
  pinned/archive chats and local manual movement. Its transport permits read methods only and rejects writes.
- `node .amp/in/orb-backup/workspace-settings-gateway.mjs`: **9 checks passed** against the actual installed
  rc.5 Gateway/workspace controller/registry/session persistence. Imports the actual phone `Dsh` and
  `WorkspaceSettingsModel`; only inactive NSH diagnostic primitives are substituted. Phone HTTP and mux frames
  route in memory into the real Gateway. Covers rename, both anchor/end order operations, true name conflict and
  invalid cross-workspace move, acknowledgement/readback loss without replay, ongoing external-edit follow,
  cold durable restoration, and phone-requested registry deletion retaining a real sentinel file, directory and
  readable session projections. **12 mobile requests, 11 follow opens, 0 model calls.**
  Existing isolation guard counters: **0 network attempts, 0 subprocess attempts, 0 outside writes, 0 listeners**.
  Disposable host state was outside the repository and removed after the run. Harness and receipt remain under
  `.amp/in/orb-backup/workspace-settings-gateway*`.

Native component tests above use NSH's headless engine, not a physical Android/iOS device. Fixture release
bundling is not a signed native shell build. No emulator, physical-device, external-network phone/Companion,
live profile or production-readiness acceptance is claimed. No installed runtime/profile modifications,
desktop localStorage bridge, arbitrary host file writes, commit, publication or deployment.
