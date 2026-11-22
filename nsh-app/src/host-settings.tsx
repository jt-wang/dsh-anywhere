import { cleanup, effect, host, locale, signal, Text, untracked, View, windowSize, type JSX, type ViewRef } from 'nsh'
import { appActive, connection, dsh, network } from './state.ts'
import { language } from './strings.ts'
import { DshError } from './dsh.ts'
import { accountIdentity, noticeVisible, performCuaAction, pluginText, readComputerStatus, readHostDomain, readPresetComposition, readPresetSettings, setDefaultPreset, type AccountNotice, type Applications, type Balance, type ComputerAccess, type CuaAction, type Inventory, type InventoryRow, type PresetDocument, type PresetSettings, type Profile, type PtcConfiguration, type ReadResult, type SystemPermission } from './host-settings.ts'
import { hostSettingsStrings } from './host-settings-strings.ts'
import { HostAccount, type AccountClient, type HostAccountSnapshot } from './host-settings-account.ts'

const activeLocale = () => language() === 'system' ? locale() : language()
const words = () => hostSettingsStrings(activeLocale())
const value = <T,>(r: ReadResult<T> | undefined): T | undefined => r?.kind === 'ready' ? r.value : undefined
function Action(props: { id: string; label: string; disabled?: boolean; press: () => void }) {
  return <View testID={props.id} role="button" accessibilityLabel={props.label} accessibilityState={{ disabled: !!props.disabled }} onPress={() => { if (!props.disabled) props.press() }} class={`min-h-[44px] justify-center rounded-[9px] bg-secondary px-3 ${props.disabled ? 'opacity-40' : 'active:opacity-60'}`}><Text class="text-foreground text-[14px]">{props.label}</Text></View>
}
function State(props: { result?: ReadResult<unknown> }) {
  return <If when={props.result && props.result.kind !== 'ready'}><Text class="text-muted-foreground text-[13px]">{props.result?.kind === 'unavailable' ? words().unavailable : words().failed}</Text></If>
}
function InventoryEntry(props: { row: InventoryRow }) {
  return <View class="border-t border-border py-2 gap-1"><Text class="text-foreground text-[13px]">{pluginText(props.row.meta?.title, activeLocale()) || props.row.moduleName}</Text><If when={props.row.meta?.title}><Text class="text-muted-foreground text-[12px]">{props.row.moduleName}</Text></If><Text class="text-muted-foreground text-[12px]">{props.row.entryId ?? '—'} · {String(props.row.enabled)} · {props.row.fiberPhase ?? '—'}</Text><If when={props.row.meta?.description}><Text class="text-muted-foreground text-[12px]">{pluginText(props.row.meta?.description, activeLocale())}</Text></If><If when={props.row.diagnostic || props.row.condition || props.row.meta?.error}><Text class="text-muted-foreground text-[12px]">{[props.row.diagnostic, props.row.condition, props.row.meta?.error].filter(Boolean).join('\n')}</Text></If></View>
}

// A data response is not an impression. Wait for a laid-out, foreground, visible native frame.
function NoticeFrame(props: { notice: () => AccountNotice | undefined; active: () => boolean; shown: (id: string) => void; children?: JSX.Element }) {
  let node: ViewRef | undefined
  effect(() => {
    const id = props.notice()?.id, active = props.active(), viewport = windowSize()
    if (!id || !active) return
    let cancelled = false, frame: number | undefined, timer: number | undefined
    const check = () => {
      frame = requestAnimationFrame(() => { timer = setTimeout(() => { void (async () => {
        const m = await node?.measure()
        if (cancelled || !props.active() || props.notice()?.id !== id) return
        if (m && m.bounds.size.width > 0 && m.bounds.size.height > 0 && m.pagePosition.y < viewport.height && m.pagePosition.y + m.bounds.size.height > 0 && m.pagePosition.x < viewport.width && m.pagePosition.x + m.bounds.size.width > 0) props.shown(id)
        else timer = setTimeout(check, 250) // Scroll offsets are included by measure().
      })().catch(() => {}) }, 0) })
    }
    check()
    cleanup(() => { cancelled = true; cancelAnimationFrame(frame); clearTimeout(timer) })
  })
  return <View ref={r => { node = r }} testID="host-notice-content" class="gap-2">{props.children}</View>
}

/** Mount inside the existing settings ScrollView. No native shell or shared settings edits required. */
/** `section`: one page of Computer settings (Agent presets, Computer use, Account, Built-in plugins), read at once. */
export function HostSettings(props: { client?: () => AccountClient; clientVersion?: string; active?: () => boolean; online?: () => boolean; section?: 'presets' | 'cua' | 'account' | 'inventory' } = {}) {
  const client = props.client ?? dsh
  const want = (s: NonNullable<typeof props.section>) => !props.section || props.section === s
  const open = signal(!!props.section), busy = signal(false), message = signal('')
  const presets = signal<ReadResult<PresetSettings> | undefined>(undefined), composition = signal<PresetDocument | undefined>(undefined)
  const system = signal<ReadResult<ComputerAccess> | undefined>(undefined), apps = signal<ReadResult<Applications> | undefined>(undefined), ptc = signal<ReadResult<PtcConfiguration> | undefined>(undefined)
  const snapshot = signal<HostAccountSnapshot>({ generation: 0 }), inventory = signal<ReadResult<Inventory> | undefined>(undefined)
  const account = () => snapshot().state, profile = () => snapshot().profile, balance = () => snapshot().balance
  const notices = () => snapshot().notices, notice = () => snapshot().notice, identityMissing = () => snapshot().identityMissing
  const pending = signal<{ label: string; action: CuaAction } | undefined>(undefined), signOut = signal<{ generation: number; running: boolean } | undefined>(undefined)
  const foreground = props.active ?? appActive, online = props.online ?? (() => props.client ? true : connection() === 'online')
  let alive = true
  const lifecycle = new HostAccount(client, async () => accountIdentity(props.clientVersion ?? (await host.call<{ version: string }>('app.info')).version, activeLocale()), s => { if (alive) snapshot.set(s) })
  effect(() => {
    const enabled = open() && want('account') && foreground() && (props.client ? true : network())
    if (enabled) { client(); activeLocale() }
    untracked(() => { if (enabled) lifecycle.start(); else lifecycle.stop() })
    cleanup(() => lifecycle.stop())
  })
  let wasOnline: boolean | undefined
  effect(() => {
    const connected = online(), enabled = open() && want('account') && foreground()
    untracked(() => {
      if (enabled && !connected) lifecycle.disconnected()
      else if (enabled && connected && wasOnline === false) void lifecycle.refresh()
      wasOnline = connected
    })
  })
  cleanup(() => { alive = false; lifecycle.stop() })
  const bool = (v: boolean | null) => v === null ? words().unknown : v ? words().yes : words().no
  const readCua = async () => {
    const [s, a, p] = await Promise.all([readComputerStatus(client()), readHostDomain<Applications>(client(), 'cuaAccess/applications'), readHostDomain<PtcConfiguration>(client(), 'cuaAccess/ptcConfiguration')])
    if (alive) { system.set(s); apps.set(a); ptc.set(p) }
  }
  const load = async () => {
    if (busy()) return
    open.set(true); busy.set(true); message.set(''); pending.set(undefined); signOut.set(undefined); composition.set(undefined)
    // Clear earlier authority before reads: a failed refresh must not leave actionable stale grants.
    presets.set(undefined); system.set(undefined); apps.set(undefined); ptc.set(undefined); inventory.set(undefined)
    try {
      await Promise.all([
        want('presets') && readPresetSettings(client()).then(v => { if (alive) presets.set({ kind: 'ready', value: v }) }, () => { if (alive) presets.set({ kind: 'failed' }) }),
        want('cua') && readCua(), want('account') && lifecycle.refresh(), want('inventory') && readHostDomain<Inventory>(client(), 'pluginInventory/list').then(v => { if (alive) inventory.set(v) }),
      ])
    } finally { if (alive) busy.set(false) }
  }
  const run = async (work: () => Promise<void>, mutation = false) => {
    if (busy()) return
    busy.set(true); message.set('')
    try { await work() }
    catch (e) { if (alive) message.set(e instanceof DshError && e.code === 'settings/conflict' ? words().conflict : mutation ? words().uncertain : words().failed) }
    finally { if (alive) busy.set(false) }
  }
  const choose = (id: string) => void run(async () => {
    const snapshot = value(presets())
    if (!snapshot) return
    // Disable further edits even when the response is lost. Refresh is the only next action.
    presets.set({ kind: 'ready', value: { ...snapshot, writable: false } })
    const updated = await setDefaultPreset(client(), snapshot, id)
    if (alive) presets.set({ kind: 'ready', value: updated })
  }, true)
  const ask = (label: string, action: CuaAction) => { if (!busy()) pending.set({ label, action }) }
  const confirm = () => {
    const selected = pending(); if (!selected) return
    pending.set(undefined)
    void run(async () => {
      // Uncertain delivery is never replayed automatically, even when the UI refresh fails.
      system.set(undefined); apps.set(undefined); ptc.set(undefined)
      await performCuaAction(client(), selected.action, activeLocale(), true)
      await readCua()
    }, true)
  }
  const readNotice = (id: string) => void run(() => lifecycle.readNotice(id))
  const noticeAction = (n: AccountNotice, dismiss: boolean) => void run(() => lifecycle.noticeAction(n.id, dismiss), true)
  const permission = (p: SystemPermission) => <View class="gap-2 py-2"><Text class="text-foreground text-[14px]">{words()[p]} · {bool((value(system()) as Extract<ComputerAccess, { platform: 'darwin' }>)[p])}</Text><View class="flex-row flex-wrap gap-2"><Action id={`host-request-${p}`} label={words().request} disabled={busy()} press={() => ask(`${words()[p]} · ${words().request}`, { method: 'requestPermission', permission: p })} /><Action id={`host-settings-${p}`} label={words().settings} disabled={busy()} press={() => ask(`${words()[p]} · ${words().settings}`, { method: 'openSettings', permission: p })} /></View></View>
  if (props.section) void load()
  return <View testID="host-settings" class="gap-3 pt-5">
    <If when={!props.section}>
      <Text class="text-muted-foreground text-[13px] font-medium">{words().title}</Text>
      <Action id="host-settings-read" label={words().refresh} disabled={busy()} press={() => void load()} />
    </If>
    <If when={busy()}><Text class="text-muted-foreground text-[13px]">{words().loading}</Text></If>
    <If when={message()}><Text testID="host-settings-message" class="text-destructive text-[13px]">{message()}</Text></If>
    <If when={pending()}><View testID="host-confirmation" class="border border-border rounded-[14px] p-[14px] gap-3"><Text class="text-foreground text-[15px]">{pending()?.label}</Text><Text class="text-muted-foreground text-[13px]">{words().computer}</Text><Action id="host-confirm" label={words().confirm} disabled={busy()} press={confirm} /><Action id="host-cancel" label={words().cancel} press={() => pending.set(undefined)} /></View></If>
    <If when={open()}>
      <If when={want('presets')}><View testID="host-presets" class="rounded-[14px] bg-card border border-border p-[14px] gap-2"><Text class="text-foreground text-[15px] font-medium">{words().presets}</Text><State result={presets()} />
        <If when={value(presets())?.presets.length === 0}><Text class="text-muted-foreground">{words().empty}</Text></If>
        {(value(presets())?.presets ?? []).map(p => <View class="border-t border-border py-2 gap-2"><Text class="text-foreground text-[14px]">{p.name || p.id}{p.isDefault ? ` · ${words().current}` : ''}</Text><Text class="text-muted-foreground text-[13px]">{p.id}{p.description ? ` · ${p.description}` : ''}</Text><If when={p.broken}><Text class="text-destructive text-[13px]">{p.broken}</Text></If><View class="flex-row flex-wrap gap-2"><Action id={`host-composition-${p.id}`} label={words().composition} disabled={busy()} press={() => void run(async () => { composition.set(undefined); const doc = await readPresetComposition(client(), p.id); if (alive) composition.set(doc) })} /><Action id={`host-default-${p.id}`} label={words().makeDefault} disabled={busy() || !value(presets())?.writable || !!p.broken || p.isDefault} press={() => choose(p.id)} /></View></View>)}
        <If when={composition()}><View testID="host-composition"><Text class="text-foreground text-[14px]">{composition()?.name || composition()?.agentPreset}</Text><Text class="text-muted-foreground text-[12px] font-mono">{composition()?.content}</Text></View></If>
      </View>
      </If><If when={want('cua')}><View testID="host-cua" class="rounded-[14px] bg-card border border-border p-[14px] gap-2"><Text class="text-foreground text-[15px] font-medium">{words().cua}</Text><Text class="text-muted-foreground text-[13px]">{words().computer}</Text><State result={system()} />
        <If when={value(system())?.platform === 'darwin'}>{permission('accessibility')}{permission('screenRecording')}</If>
        <If when={value(system())?.platform === 'win32'}><Text testID="host-windows-status" class="text-muted-foreground text-[13px]">{words().sessionLocked}: {bool((value(system()) as Extract<ComputerAccess, { platform: 'win32' }>)?.sessionLocked ?? null)} · {words().captureAvailable}: {bool(!!(value(system()) as Extract<ComputerAccess, { platform: 'win32' }>)?.captureAvailable)} · {words().elevated}: {bool(!!(value(system()) as Extract<ComputerAccess, { platform: 'win32' }>)?.elevated)}</Text></If>
        <State result={ptc()} /><If when={value(ptc())}><Text class="text-foreground text-[14px]">{words().persistent}: {bool(!!value(ptc())?.persistent)}</Text><If when={value(ptc())?.writable && !value(ptc())?.persistent}><Action id="host-enable-ptc" label={words().enable} disabled={busy()} press={() => ask(words().enable, { method: 'enablePersistentPtc' })} /></If></If>
        <State result={apps()} />
        {[{ key: 'allowedApps' as const, label: words().allowed, method: 'revoke' as const }, { key: 'blockedApps' as const, label: words().blocked, method: 'retryApproval' as const }].map(group => <View class="gap-2"><Text class="text-foreground text-[14px]">{group.label}</Text><If when={value(apps())?.[group.key].length === 0}><Text class="text-muted-foreground text-[13px]">{words().empty}</Text></If>{(value(apps())?.[group.key] ?? []).map(a => <View class="border-t border-border py-2 gap-1"><Text class="text-foreground text-[14px]">{a.name}</Text><Text class="text-muted-foreground text-[12px]">{a.executablePath || a.id}</Text><Action id={`host-${group.method}-${a.id}`} label={group.method === 'revoke' ? words().revoke : words().retry} disabled={busy()} press={() => ask(`${a.name} · ${group.method === 'revoke' ? words().revoke : words().retry}`, { method: group.method, id: a.id })} /></View>)}</View>)}
      </View>
      </If><If when={want('account')}><View testID="host-account" class="rounded-[14px] bg-card border border-border p-[14px] gap-2"><Text class="text-foreground text-[15px] font-medium">{words().account}</Text><Text class="text-muted-foreground text-[13px]">{words().callback}</Text><State result={account()} /><If when={value(account())}><Text class="text-foreground text-[14px]">{value(account())?.status === 'signed-out' ? words().signedOut : words().stored}</Text><If when={value(account())?.attempt}><Text class="text-muted-foreground text-[13px]">{value(account())?.attempt?.phase} · {value(account())?.attempt?.errorCode ?? ''}</Text></If></If>
        <If when={identityMissing()}><Text class="text-muted-foreground text-[13px]">{words().identity}</Text></If>
        <If when={snapshot().uncertain}><Text class="text-destructive text-[13px]">{words().uncertain}</Text></If>
        <If when={snapshot().canSignOut}><Action id="host-signout" label={words().signOut} disabled={busy()} press={() => void run(async () => { const ticket = await lifecycle.prepareSignOut(); if (alive) signOut.set(ticket) })} /></If>
        <If when={signOut() && signOut()?.generation === snapshot().generation}><View testID="host-signout-confirmation" class="gap-2 border border-border rounded-[9px] p-3"><Text class="text-foreground text-[14px]">{words().signOutWarning}</Text><If when={signOut()?.running}><Text class="text-destructive text-[13px]">{words().runningTasks}</Text></If><Action id="host-signout-confirm" label={words().signOut} disabled={busy()} press={() => { const ticket = signOut(); signOut.set(undefined); if (ticket) void run(() => lifecycle.signOut(true, ticket.generation), true) }} /><Action id="host-signout-cancel" label={words().cancel} press={() => signOut.set(undefined)} /></View></If>
        <State result={profile()} /><If when={value(profile())?.status === 'ready'}><Text testID="host-profile" class="text-foreground text-[14px]">{words().profile}: {(value(profile()) as Extract<Profile, { status: 'ready' }>)?.value.name ?? '—'} · {(value(profile()) as Extract<Profile, { status: 'ready' }>)?.value.contact ?? '—'}</Text></If><If when={value(profile())?.status === 'failed'}><Text class="text-muted-foreground text-[13px]">{words().profile}: {words().failed}</Text></If>
        <State result={balance()} /><If when={value(balance())?.status === 'failed'}><Text class="text-muted-foreground text-[13px]">{words().balance}: {words().failed}</Text></If><If when={value(balance())?.status === 'ready'}><Text class="text-foreground text-[14px]">{words().balance}: {(value(balance()) as Extract<Balance, { status: 'ready' }>)?.value.map(w => `${w.currency} ${w.balance}`).join(' · ') || '—'}</Text><Text class="text-foreground text-[14px]">{words().bonus}: {(value(balance()) as Extract<Balance, { status: 'ready' }>)?.bonusWallets.map(w => `${w.currency} ${w.balance}`).join(' · ') || '—'}</Text></If>
        <Text class="text-foreground text-[14px]">{words().notices}</Text><State result={notices()} /><If when={value(notices())?.notifications.filter(n => noticeVisible(n)).length === 0}><Text class="text-muted-foreground text-[13px]">{words().empty}</Text></If>{(value(notices())?.notifications.filter(n => noticeVisible(n)) ?? []).map((n, i) => <Action id={`host-notice-${n.id}`} label={`${words().content} ${i + 1}`} disabled={busy()} press={() => readNotice(n.id)} />)}
        <If when={notice()}><NoticeFrame notice={notice} active={() => foreground() && online()} shown={id => void lifecycle.presented(id, snapshot().generation)}><Text class="text-foreground text-[14px]">{notice()?.title}</Text><Text class="text-muted-foreground text-[13px]">{notice()?.body}</Text>{(notice()?.actions ?? []).map(a => <Action id={`host-notice-action-${a.target.type}`} label={a.label} disabled={busy()} press={() => { const n = notice(); if (n) noticeAction(n, a.target.type === 'dismiss') }} />)}</NoticeFrame></If>
      </View>
      </If><If when={want('inventory')}><View testID="host-plugins" class="rounded-[14px] bg-card border border-border p-[14px] gap-2"><Text class="text-foreground text-[15px] font-medium">{words().plugins}</Text><Text class="text-muted-foreground text-[13px]">{words().clientSync}</Text><State result={inventory()} /><If when={value(inventory())?.entries.length === 0}><Text class="text-muted-foreground text-[13px]">{words().empty}</Text></If>{(value(inventory())?.entries ?? []).map(row => <InventoryEntry row={row} />)}{(value(inventory())?.agentPresets ?? []).map(p => <View class="gap-1"><Text class="text-foreground text-[14px]">{p.name || p.id}{p.isDefault ? ` · ${words().current}` : ''}</Text><If when={p.broken}><Text class="text-destructive text-[13px]">{p.broken}</Text></If>{p.rows.map(row => <InventoryEntry row={row} />)}</View>)}</View></If>
    </If>
  </View>
}
