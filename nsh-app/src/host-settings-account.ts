// Foreground lifetime of the official rc.5 account/watch envelope and account notices.
// The host alone owns credentials and logout revocation retries.
import { readHostDomain, noticeVisible, reportNotice, type AccountIdentity, type AccountNotice, type AccountState, type Balance, type HostSettingsClient, type NoticeBatch, type Profile, type ReadResult } from './host-settings.ts'

export interface AccountUpdate { type: 'snapshot' | 'credentials-changed'; state: AccountState }
export interface AccountClient extends HostSettingsClient {
  stream(endpoint: string, args: unknown, item: (v: unknown) => void, failed?: (e: unknown) => void): () => void
}
export interface HostAccountSnapshot {
  state?: ReadResult<AccountState>; profile?: ReadResult<Profile | null>; balance?: ReadResult<Balance | null>
  notices?: ReadResult<NoticeBatch | null>; notice?: AccountNotice; identityMissing?: boolean
  uncertain?: boolean; generation: number; canSignOut?: boolean
}
export interface AccountClock { now(): number; later(fn: () => void, ms: number): unknown; cancel(timer: unknown): void }
const clock: AccountClock = { now: Date.now, later: (f, ms) => setTimeout(f, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) }
const ready = <T,>(r: ReadResult<T> | undefined) => r?.kind === 'ready' ? r.value : undefined
const MAX_TIMER = 2147483647

export class HostAccount {
  private active = false
  private generation = 0
  private identity: AccountIdentity | undefined
  private stops: (() => void)[] = []
  private poll: unknown
  private expiry: unknown
  private shown = new Set<string>()
  private snapshot: HostAccountSnapshot = { generation: 0 }
  private request = 0
  private lifetime = 0
  private detailsRevision = 0
  private noticesStarted = false
  private streamsFailed = false
  private signOutInFlight = false
  constructor(private readonly client: () => AccountClient, private readonly metadata: () => Promise<AccountIdentity>, private readonly publish: (s: HostAccountSnapshot) => void, private readonly time: AccountClock = clock) {}

  private set(patch: Partial<HostAccountSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch, generation: this.generation }
    this.publish(this.snapshot)
  }
  /** Clears retained identity and fences every pending read/report before notifying the UI. */
  private clear(state?: ReadResult<AccountState>) {
    this.generation++; this.request++; this.detailsRevision++; this.identity = undefined; this.shown.clear()
    this.noticesStarted = false
    this.time.cancel(this.poll); this.time.cancel(this.expiry); this.poll = this.expiry = undefined
    this.snapshot = { generation: this.generation, state }
    this.publish(this.snapshot)
  }
  start() {
    this.stop(); this.active = true; this.streamsFailed = false
    const owner = this.generation
    const lifetime = this.lifetime
    const live = () => this.active && lifetime === this.lifetime
    try {
      // First stream frame on reconnect is a fresh baseline, even when status is unchanged.
      const watch = this.client().stream('account/watch', {}, v => {
        if (!live()) return
        const update = v as AccountUpdate
        if (!update || !['snapshot', 'credentials-changed'].includes(update.type) || !['signed-out', 'credential-stored'].includes(update.state?.status)) { this.disconnected(); return }
        const reset = update.type === 'credentials-changed' || ready(this.snapshot.state)?.status !== update.state.status
        if (reset) this.clear({ kind: 'ready', value: update.state })
        else this.set({ state: { kind: 'ready', value: update.state }, profile: undefined, balance: undefined })
        void this.details(this.generation)
      }, () => { if (live()) this.streamFailed() })
      this.stops.push(watch)
      this.stops.push(this.client().stream('account/watchExpiry', {}, v => {
        if (!live() || v !== 'session-expired') return
        this.clear(); void this.refresh()
      }, () => { if (live()) this.streamFailed() }))
    } catch { this.streamFailed() }
    if (this.streamsFailed) return // No automatic reopen loop after capability/permission refusal.
    // Initial read also supports a transport which has not delivered its first stream frame yet.
    if (this.active && this.generation === owner) void this.refresh()
    else if (this.active && !this.snapshot.state) void this.refresh()
  }
  stop() {
    this.active = false; this.lifetime++
    const stops = this.stops; this.stops = []
    for (const stop of stops) stop()
    this.clear()
  }
  /** A carrier failure invalidates authority, but keeps Dsh's reconnecting streams registered. */
  disconnected() { if (this.active) this.clear({ kind: 'failed' }) }
  private streamFailed() { this.streamsFailed = true; this.disconnected() }
  async refresh() {
    if (!this.active) return
    if (this.streamsFailed) { this.start(); return }
    this.clear()
    const g = this.generation
    const state = await readHostDomain<AccountState>(this.client(), 'account/getState')
    if (!this.active || g !== this.generation) return
    this.set({ state }); await this.details(g)
  }
  private valid(g: number) { return this.active && this.generation === g }
  private async details(g: number) {
    if (!this.valid(g) || ready(this.snapshot.state)?.status !== 'credential-stored') return
    const revision = ++this.detailsRevision
    const current = () => this.valid(g) && revision === this.detailsRevision
    let identity: AccountIdentity
    try { identity = await this.metadata() }
    catch { if (current()) this.set({ identityMissing: true }); return }
    if (!current()) return
    this.identity = identity; this.set({ canSignOut: !this.signOutInFlight })
    await Promise.all([
      readHostDomain<Profile | null>(this.client(), 'account/getProfile', { client: identity }).then(profile => { if (current()) { if (profile.kind === 'ready' && profile.value === null) this.clear({ kind: 'failed' }); else this.set({ profile }) } }),
      readHostDomain<Balance | null>(this.client(), 'account/getBalance', { client: identity }).then(balance => { if (current()) { if (balance.kind === 'ready' && balance.value === null) this.clear({ kind: 'failed' }); else this.set({ balance }) } }),
      !this.noticesStarted ? this.readNotices(g) : Promise.resolve(),
    ])
  }
  private async readNotices(g: number, delay = 600000) {
    if (!this.valid(g) || !this.identity) return
    this.noticesStarted = true
    const result = await readHostDomain<NoticeBatch | null>(this.client(), 'account/getNotifications', { client: this.identity })
    if (!this.valid(g)) return
    const batch = ready(result)
    if (batch) {
      const ms = batch.nextPollAfterSeconds * 1000
      if (Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER) delay = ms
      const notifications = batch.notifications.filter(n => noticeVisible(n, this.time.now()))
      // Server consumption is not local dismissal: retain the presented card until its deadline.
      const retained = this.snapshot.notice
      if (retained && noticeVisible(retained, this.time.now()) && !notifications.some(n => n.id === retained.id)) notifications.unshift(retained)
      this.set({ notices: { kind: 'ready', value: { ...batch, notifications } } })
    } else if (result.kind !== 'ready') this.set({ notices: result })
    else { this.clear({ kind: 'failed' }); return }
    this.expireAtDeadline(g)
    this.poll = this.time.later(() => { this.poll = undefined; void this.readNotices(g, delay) }, delay)
  }
  private expireAtDeadline(g: number) {
    this.time.cancel(this.expiry)
    const batch = ready(this.snapshot.notices)
    const all = [...(batch?.notifications ?? []), ...(this.snapshot.notice ? [this.snapshot.notice] : [])]
    const deadlines = all.flatMap(n => n.displayUntil === null ? [] : [Date.parse(n.displayUntil)]).filter(Number.isFinite)
    if (!deadlines.length) return
    this.expiry = this.time.later(() => {
      if (!this.valid(g)) return
      const n = this.snapshot.notice
      this.set({ notice: n && noticeVisible(n, this.time.now()) ? n : undefined,
        ...(batch ? { notices: { kind: 'ready' as const, value: { ...batch, notifications: batch.notifications.filter(n => noticeVisible(n, this.time.now())) } } } : {}) })
      this.expireAtDeadline(g)
    }, Math.max(1, Math.min(MAX_TIMER, Math.min(...deadlines) - this.time.now())))
  }
  async readNotice(id: string) {
    if (!this.active || !this.identity) return
    const g = this.generation, request = ++this.request, identity = this.identity
    this.set({ notice: undefined })
    const n = await this.client().rpc<AccountNotice | null>('account/getNotificationContent', { id, client: identity })
    if (!this.valid(g) || request !== this.request || !n || n.id !== id || !noticeVisible(n, this.time.now())) return
    this.set({ notice: n }); this.expireAtDeadline(g)
    // No displayed report here. The native card must first confirm a visible laid-out frame.
  }
  async presented(id: string, generation: number) {
    if (!this.valid(generation) || this.snapshot.notice?.id !== id || !noticeVisible(this.snapshot.notice, this.time.now()) || this.shown.has(id) || !this.identity) return
    this.shown.add(id) // A lost ACK is not permission to report displayed a second time.
    await this.event(id, 'displayed', generation, this.identity)
  }
  private async event(id: string, event: 'displayed' | 'cta_clicked' | 'dismissed', g: number, identity: AccountIdentity) {
    try {
      const accepted = await reportNotice(this.client(), identity, id, event)
      if (!this.valid(g)) return
      if (!accepted) { this.clear(); void this.refresh() }
    } catch { if (this.valid(g)) this.set({ uncertain: true }) }
  }
  async noticeAction(id: string, dismiss: boolean) {
    const n = this.snapshot.notice, identity = this.identity, g = this.generation
    if (!this.active || !identity || n?.id !== id || !noticeVisible(n, this.time.now())) return
    if (dismiss) {
      const batch = ready(this.snapshot.notices)
      this.set({ notice: undefined, ...(batch ? { notices: { kind: 'ready' as const, value: { ...batch, notifications: batch.notifications.filter(n => n.id !== id) } } } : {}) })
      this.expireAtDeadline(g)
    }
    // CTA to app_route:account stays in this account card and does not close it.
    await this.event(id, dismiss ? 'dismissed' : 'cta_clicked', g, identity)
  }
  async prepareSignOut(): Promise<{ generation: number; running: boolean }> {
    const g = this.generation
    if (!this.active || !this.identity || !this.snapshot.canSignOut) throw new Error('Account unavailable')
    const running = await this.client().rpc<boolean>('account/hasRunningAccountTasks', {})
    if (!this.valid(g)) throw new Error('Account changed')
    return { generation: g, running }
  }
  async signOut(confirmed: boolean, generation: number) {
    if (!confirmed || !this.valid(generation) || !this.identity || !this.snapshot.canSignOut || this.signOutInFlight) throw new Error('Account confirmation expired')
    const identity = this.identity, lifetime = this.lifetime
    this.signOutInFlight = true; this.clear()
    let uncertain = false
    try { await this.client().rpc('account/signOut', { client: identity }) }
    catch { uncertain = true }
    finally {
      // Always re-read authority, never repeat signOut. Revocation retries belong to the host.
      if (this.active && lifetime === this.lifetime) await this.refresh()
      this.signOutInFlight = false
      if (this.active && lifetime === this.lifetime) this.set({ uncertain, canSignOut: !uncertain && ready(this.snapshot.state)?.status === 'credential-stored' && !!this.identity })
    }
  }
}
