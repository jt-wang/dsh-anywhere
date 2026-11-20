// The link to the owner's computer lives in the native shell (Link.java: Tailcat, pinned TLS, the device token in the
// Android Keystore). The app only learns the bridge origin and the token to send.
import { cleanup, computed, effect, host, signal, untracked } from 'nsh'
import { Dsh, type ConnectionState, type DshError } from './dsh.ts'
import { Pending } from './events.ts'
import type { Check } from './reach.ts'
import { readable, S } from './strings.ts'
import { tryComputer, TRY_KEY, TRY_ORIGIN } from './tryit.ts'
import { OfflineCache } from './cache.ts'
import { oneAtATime } from './progress.ts'

export interface Settings { origin: string; key: string }
export interface LinkPath { kind?: string; derpRegion?: number; derpCode?: string; derpHost?: string; relayHost?: string }
type LinkState = { paired: false } | { paired: true; origin: string; token: string; cacheId?: string }
export const settings = signal<Settings | null>(null)
export const offlineCache = signal<OfflineCache | undefined>(undefined)
export const refreshLists = signal(0)
export const loaded = signal(false)
export const linking = signal(false)
export const linkError = signal('')
/** The four emoji of an emoji pairing (the shell's link.emoji), while the computer's user compares and confirms them. */
export const pairEmoji = signal<string[]>([])
/** This phone reaches computers over Tailcat only: never a relay or local network route a computer offers (link.tailcatOnly). */
export const tailcatOnly = signal(false)
/** On the sample of tryit.ts: no link, nothing leaves the phone, and nothing is kept for the next launch. */
export const trying = signal(false)
const socketState = signal<ConnectionState>('connecting')
/** Whether Android says the phone has a network (the shell's `network` event). The link runs inside a tunnel whose
 * connections outlive a network change, so the socket alone does not notice the phone going offline. */
export const network = signal(true)
export const reachState = (online: boolean, socket: ConnectionState): ConnectionState => (online ? socket : 'offline')
export const connection = computed(() => (trying() ? 'online' : reachState(network(), socketState())))
/** What each part last answered (reach.ts), when the next try is, and how the tunnel goes now, for the connection's state. */
export const check = signal<Check | undefined>(undefined)
export const retryAt = signal<number | undefined>(undefined)
export const routeText = signal('')
let client: Dsh | undefined
/** Approvals and questions the agent waits on, across chats; `asks` changes whenever they do. */
export const pending = new Pending()
export const asks = signal(0)
/** DSH's own news on $events (emit frames {event, args}): a chat started or stopped running (api-session/status
 * [sessionId, running]), a step or turn failed (api-session/error [sessionId, message]). `news` changes with each. */
export const news = signal(0)
export const turnErrors = new Map<string, string>()
/** Chats DSH said started running ('running'), and then stopped ('finished'), until the notifier's next look takes them. */
export const started = new Map<string, 'running' | 'finished'>()
export function heard(frame: unknown) {
  const f = frame as { type?: unknown; event?: unknown; args?: unknown } | undefined
  if (f?.type !== 'emit' || !Array.isArray(f.args)) return
  if (f.event === 'api-session/error' && typeof f.args[0] === 'string') turnErrors.set(f.args[0], typeof f.args[1] === 'string' ? f.args[1] : '')
  else if (f.event !== 'api-session/status') return
  else if (typeof f.args[0] === 'string') {
    if (f.args[1] === true) started.set(f.args[0], 'running')
    else if (started.get(f.args[0]) === 'running') started.set(f.args[0], 'finished')
  }
  news.update((n) => n + 1)
}
let stopEvents: (() => void) | undefined

export function dsh(): Dsh {
  const s = settings(); if (!s) throw new Error('not linked')
  if (!client || client.origin !== s.origin) {
    client?.close()
    const made: Dsh = client = new Dsh(s.origin, s.key, s.origin === TRY_ORIGIN ? tryComputer() : { onStuck: async () => {
      const next = await host.call<LinkState>('link.reset')
      if (next.paired && client === made) { made.origin = next.origin; settings.set({ origin: next.origin, key: next.token }) }
    } })
    client.onState = (c) => { socketState.set(c); if (c === 'online') refreshLists.update((n) => n + 1) }
    client.onRetryAt = (at) => retryAt.set(at)
    client.setForeground(appActive())
    client.setRetryEnabled((network() || trying()) && (appActive() || backgroundWatch()))
    stopEvents = client.stream('$events', {}, (frame) => { heard(frame); pending.apply(frame); asks.update((n) => n + 1) })
  }
  return client
}
const adopt = async (state: LinkState, sample = false) => {
  const old = offlineCache()
  const identity = state.paired && !sample ? state.cacheId : undefined
  if (old?.data.identity !== identity) { old?.clear(); offlineCache.set(undefined) }
  // Native pairing may have been removed while this process was not running.
  if (!state.paired && !old) await OfflineCache.discard()
  trying.set(sample); stopEvents?.(); client?.close(); client = undefined
  pending.apply({ type: 'ready', clientId: '' }); asks.update((n) => n + 1)
  check.set(undefined); retryAt.set(undefined); routeText.set(''); lastLook = 0
  if (identity && !offlineCache()) offlineCache.set(await OfflineCache.open(identity))
  settings.set(state.paired ? { origin: state.origin, key: state.token } : null)
}

/** Whether the app is on screen (the shell's app.state); true where the shell does not say. */
export const appActive = signal(true)
/** Only the notifier's known running tasks need reconnects while the app is away. */
export const backgroundWatch = signal(false)
/** Read on entry/resume/reconnect, then at most every 30 s; no timer while hidden or without a network. */
export function pollForeground(run: () => Promise<unknown>, visible: () => boolean = () => true) {
  let stopped = false
  const load = oneAtATime(async () => {
    if (!stopped && appActive() && (network() || trying()) && visible()) await run()
  })
  effect(() => {
    refreshLists()
    if (!appActive() || (!network() && !trying()) || !visible()) return
    untracked(load)
    const timer = setInterval(load, 30_000)
    cleanup(() => clearInterval(timer))
  })
  cleanup(() => { stopped = true })
  return load
}
/** The person asked to try the computer again now. */
export function reconnect() { client?.retryNow(); lastLook = 0; refreshLists.update((n) => n + 1) }

// While the connection fails: which part answers. While it works: how long an answer takes and how it goes. Only on screen.
const FAILING_MS = 15_000, WORKING_MS = 30_000, GRACE_MS = 3_000
let lastLook = 0, looking = false
async function look() {
  if (looking || !appActive() || !network() || !settings() || trying()) return
  looking = true; lastLook = Date.now()
  try {
    if (connection() === 'online') {
      const asked = Date.now()
      const access = await askComputer()
      check.set({ access, ...(access === 'ok' ? { latencyMs: Date.now() - asked } : {}) })
      const r = await host.call<LinkPath>('link.path').catch(() => undefined)
      routeText.set(routeWords(r))
    } else {
      const d = await host.call<Check & { error?: string }>('link.diagnose')
      if (d.error) return
      check.set({ relay: d.relay, computer: d.computer, ...(d.computer === 'reachable' ? { access: await askComputer() } : {}) })
    }
    if (check()?.access === 'refused') { client?.hold(); offlineCache()?.clear(); offlineCache.set(undefined) }
  } catch { /* a shell without link.diagnose: the state stays as it is */ } finally { looking = false }
}
/** How the tunnel reaches the computer (link.path), in words; nothing while unknown. */
export function routeWords(r: LinkPath | undefined) {
  switch (r?.kind) {
    case 'direct': return S.pathDirect
    case 'lan': return S.pathLan
    case 'relay': return S.pathPrivateRelay(r.relayHost?.trim() || undefined)
    case 'derp': return S.pathRelay(r.derpCode?.trim().toUpperCase() || r.derpHost?.trim() || (r.derpRegion && r.derpRegion > 0 ? `#${r.derpRegion}` : undefined))
    default: return ''
  }
}
async function askComputer(): Promise<NonNullable<Check['access']>> {
  try { await dsh().computer(); return 'ok' } catch (e) { return (e as DshError).code === 'unauthorized' ? 'refused' : 'failed' }
}
function watchReach() {
  effect(() => {
    if (!appActive() || !network() || !settings()) return
    const online = connection() === 'online'
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      untracked(look)
      timer = setTimeout(tick, online ? WORKING_MS : FAILING_MS)
    }
    timer = setTimeout(tick, online ? Math.max(0, WORKING_MS - (Date.now() - lastLook)) : GRACE_MS)
    cleanup(() => clearTimeout(timer))
  })
  effect(() => {
    const foreground = appActive(), retry = (network() || trying()) && (foreground || backgroundWatch())
    untracked(() => { client?.setForeground(foreground); client?.setRetryEnabled(retry) })
  })
}

export async function boot() {
  watchReach()
  try { await adopt(await host.call<LinkState>('link.state')) } catch (e) { linkError.set(readable(e)) }
  loaded.set(true)
  // opened from a pairing QR or link (dshm1:…), now or while running
  const pending = (host.params as { pair?: string } | undefined)?.pair
  if (pending && !settings()) await pairWith(pending)
  // Back on a network: try the computer now instead of at the next retry.
  try { host.on('network', (data) => { const online = (data as { online?: boolean } | undefined)?.online !== false; network.set(online); if (online) reconnect() }) } catch {}
  host.call<{ online: boolean }>('network.state').then((v) => network.set(v.online !== false), () => {})
  // Back on screen: try the computer now. A connection that died while the app was away would otherwise wait for the
  // next retry, up to 15 seconds later.
  const onScreen = (v: unknown) => (v as { active?: boolean } | undefined)?.active !== false
  try { host.on('app.state', (data) => { appActive.set(onScreen(data)); if (appActive()) reconnect(); else offlineCache()?.flush() }) } catch {}
  host.call('app.state').then((v) => appActive.set(onScreen(v)), () => {})
  try { host.on('pair', (data) => { const text = (data as { text?: string } | undefined)?.text; if (text) pairWith(text) }) } catch {}
  try { host.on('link.emoji', (data) => { const e = (data as { emoji?: unknown } | undefined)?.emoji; pairEmoji.set(Array.isArray(e) ? e.filter((x): x is string => typeof x === 'string') : []) }) } catch {}
  host.call<{ on?: boolean }>('link.tailcatOnly').then((v) => tailcatOnly.set(v?.on === true), () => {})
}
/** Tailcat only on or off: the shell keeps it and opens a new tunnel with it, so the app follows the new bridge. */
export async function setTailcatOnly(on: boolean) {
  tailcatOnly.set(on)
  try {
    const v = await host.call<{ on?: boolean }>('link.tailcatOnly', { on })
    tailcatOnly.set(v?.on === true)
    if (!trying()) await adopt(await host.call<LinkState>('link.state'))
  } catch (e) { tailcatOnly.set(!on); linkError.set(readable(e)) }
}
export async function pairWith(text: string) {
  linking.set(true); linkError.set('')
  try { await adopt(await host.call<LinkState>('link.pair', { text })) } catch (e) { linkError.set(readable(e)) } finally { linking.set(false); pairEmoji.set([]) }
}
export async function scan() {
  let text: string
  try { text = await host.call<string>('link.scan') } catch (e) { if ((e as Error).message !== 'cancelled') linkError.set(readable(e)); return }
  await pairWith(text)
}
/** The link screen comes at once. Telling the computer goes on behind it, up to 30 seconds when the computer is silent;
 * a code linked meanwhile waits for that on the link's own thread. */
export function unlink() {
  const real = !trying()
  adopt({ paired: false })
  if (real) host.call('link.forget').catch(() => {})
}
/** The sample instead of a link. Only an unlinked phone offers it, so there is no link to lose. */
export function tryIt() {
  adopt({ paired: true, origin: TRY_ORIGIN, token: TRY_KEY }, true)
}
export const PRIVACY_URL = 'https://dsh-anywhere.jingtao.io/privacy/'

/** What the shell's `ui.open` needs for a module the agent built with show_interface (companion ui-modules.ts). */
export const interfaceRequest = (s: Settings, callId: string, title: string) => ({
  url: `${s.origin}/ui/package?call=${encodeURIComponent(callId)}`, rootUrl: `${s.origin}/ui/root.pub`, auth: s.key, title,
})
export const interfaceError = signal('')
export async function openInterface(callId: string, title: string) {
  const s = settings(); if (!s) return
  interfaceError.set('')
  try { await host.call('ui.open', interfaceRequest(s, callId, title)) } catch (e) { interfaceError.set(readable(e)) }
}

/** Answers an approval or question ($events/result) and forgets it here; the computer withdraws it everywhere else. */
export async function answer(eventId: string, args: unknown) {
  await dsh().rpc('$events/result', args as Record<string, unknown>)
  pending.drop(eventId); asks.update((n) => n + 1)
}
