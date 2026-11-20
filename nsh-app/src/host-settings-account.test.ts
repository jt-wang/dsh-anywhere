import { expect, test } from 'nsh/test'
import { HostAccount, type AccountClient, type AccountClock, type HostAccountSnapshot } from './host-settings-account.ts'
import { accountIdentity, type AccountNotice, type AccountState } from './host-settings.ts'

const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve() }
function deferred<T = unknown>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const state = (status: AccountState['status'] = 'credential-stored'): AccountState => ({ status, links: { usageUrl: 'https://synthetic.invalid', topUpUrl: 'https://synthetic.invalid' }, attempt: null })
const note = (until: string | null = null): AccountNotice => ({ id: 'n1', createdAt: '2026-01-01', displayUntil: until, title: 'Synthetic', body: 'Fixture only', actions: [] })
function fixture() {
  let now = 0, next = 0, snapshot: HostAccountSnapshot = { generation: 0 }
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: AccountClock = { now: () => now, later(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id }, cancel(id) { timers.delete(id as number) } }
  const calls: { method: string; args: any }[] = []
  const streams = new Map<string, { item: (v: any) => void; failed: (e: unknown) => void }>()
  const handlers: Record<string, () => unknown> = {
    'account/getState': () => state(), 'account/getProfile': () => ({ status: 'ready', value: { id: 'synthetic', name: 'Current', contact: null } }),
    'account/getBalance': () => ({ status: 'ready', value: [], bonusWallets: [] }),
    'account/getNotifications': () => ({ nextPollAfterSeconds: 2, notifications: [note()] }), 'account/getNotificationContent': () => note(),
    'account/reportNotificationEvent': () => true, 'account/hasRunningAccountTasks': () => true, 'account/signOut': () => state('signed-out'),
  }
  const client = {
    async rpc(method: string, args: any) { calls.push({ method, args }); if (!handlers[method]) throw new Error(`Unexpected ${method}`); return handlers[method]() },
    stream(method: string, args: unknown, item: (v: any) => void, failed: (e: unknown) => void) { calls.push({ method, args }); streams.set(method, { item, failed }); return () => { streams.delete(method) } },
  } as AccountClient
  const account = new HostAccount(() => client, async () => accountIdentity('fixture-1', 'en', 0), s => { snapshot = s }, clock)
  const advance = async (ms: number) => {
    now += ms
    for (const [id, t] of [...timers]) if (t.at <= now && timers.delete(id)) t.fn()
    await settle()
  }
  const count = (method: string) => calls.filter(c => c.method === `account/${method}`).length
  return { account, calls, streams, handlers, timers, advance, count, snapshot: () => snapshot }
}

test('account exact stream envelopes fence late profile/content and stale callbacks across credentials and foreground lifetimes', async () => {
  const f = fixture(), profile = deferred(), content = deferred()
  f.handlers['account/getProfile'] = () => profile.promise
  f.handlers['account/getNotificationContent'] = () => content.promise
  f.account.start(); await settle()
  expect(f.calls.filter(c => c.method.includes('watch'))).toEqual([{ method: 'account/watch', args: {} }, { method: 'account/watchExpiry', args: {} }])
  const reading = f.account.readNotice('n1'), old = f.streams.get('account/watch')!
  old.item({ type: 'credentials-changed', state: state('signed-out') })
  expect(f.snapshot().profile).toBe(undefined); expect(f.snapshot().notices).toBe(undefined)
  profile.resolve({ status: 'ready', value: { name: 'Old account' } }); content.resolve(note())
  await reading; await settle()
  expect(f.snapshot().profile).toBe(undefined); expect(f.snapshot().notice).toBe(undefined)
  f.handlers['account/getState'] = () => state('signed-out')
  f.account.stop(); expect(f.streams.size).toBe(0); expect(f.timers.size).toBe(0)
  f.account.start(); await settle()
  old.item({ type: 'credentials-changed', state: state() }); await settle()
  expect(f.snapshot().state).toEqual({ kind: 'ready', value: state('signed-out') })
  expect(f.snapshot().canSignOut).toBe(undefined)
  f.account.stop()
})

test('account notification server cadence starts after settlement, never overlaps, preserves presented consumed card and progress updates', async () => {
  const f = fixture(), pending = deferred()
  f.handlers['account/getNotifications'] = () => pending.promise
  f.account.start(); await settle(); await f.advance(20000)
  expect(f.count('getNotifications')).toBe(1); expect(f.timers.size).toBe(0)
  pending.resolve({ nextPollAfterSeconds: 2, notifications: [note()] }); await settle()
  await f.advance(1999); expect(f.count('getNotifications')).toBe(1)
  await f.account.readNotice('n1')
  f.handlers['account/getNotifications'] = () => ({ nextPollAfterSeconds: 4, notifications: [] })
  await f.advance(1); expect(f.count('getNotifications')).toBe(2)
  expect(f.snapshot().notice?.id).toBe('n1')
  const generation = f.snapshot().generation
  f.streams.get('account/watch')!.item({ type: 'snapshot', state: state() }); await settle()
  expect(f.snapshot().generation).toBe(generation); expect(f.snapshot().notice?.id).toBe('n1')
  await f.advance(3999); expect(f.count('getNotifications')).toBe(2)
  await f.advance(1); expect(f.count('getNotifications')).toBe(3)
  f.account.stop()
})

test('account notice expiry clears card/list/actions without dismissal reporting; expiry stream rebaselines', async () => {
  const f = fixture(), n = note('1970-01-01T00:00:01.000Z')
  f.handlers['account/getNotifications'] = () => ({ nextPollAfterSeconds: 600, notifications: [n] })
  f.handlers['account/getNotificationContent'] = () => n
  f.account.start(); await settle(); await f.account.readNotice('n1')
  await f.advance(1000)
  expect(f.snapshot().notice).toBe(undefined)
  expect(f.snapshot().notices).toEqual({ kind: 'ready', value: { nextPollAfterSeconds: 600, notifications: [] } })
  await f.account.noticeAction('n1', true); expect(f.count('reportNotificationEvent')).toBe(0)
  f.handlers['account/getState'] = () => state('signed-out')
  f.streams.get('account/watchExpiry')!.item('session-expired')
  expect(f.snapshot().profile).toBe(undefined); await settle()
  expect(f.snapshot().state).toEqual({ kind: 'ready', value: state('signed-out') })
  f.account.stop()
})

test('account reports displayed only on presentation, deduplicates lost ACK, retains CTA and handles false acknowledgement as lost authority', async () => {
  const f = fixture()
  f.account.start(); await settle(); await f.account.readNotice('n1')
  expect(f.count('reportNotificationEvent')).toBe(0)
  f.handlers['account/reportNotificationEvent'] = () => { throw new Error('lost ACK') }
  const g = f.snapshot().generation
  await f.account.presented('n1', g); await f.account.presented('n1', g)
  expect(f.count('reportNotificationEvent')).toBe(1); expect(f.snapshot().uncertain).toBe(true)
  await f.account.noticeAction('n1', false); expect(f.snapshot().notice?.id).toBe('n1')
  f.handlers['account/reportNotificationEvent'] = () => false
  f.handlers['account/getState'] = () => state('signed-out')
  await f.account.noticeAction('n1', true); await settle()
  expect(f.snapshot().notice).toBe(undefined); expect(f.snapshot().profile).toBe(undefined)
  expect(f.snapshot().state).toEqual({ kind: 'ready', value: state('signed-out') })
  expect(f.calls.filter(c => c.method.endsWith('reportNotificationEvent')).map(c => c.args.event)).toEqual(['displayed', 'cta_clicked', 'dismissed'])
  f.account.stop()
})

test('account disconnect cancels polling and pending reads; reconnect snapshot rebaselines even same credential status', async () => {
  const f = fixture()
  f.account.start(); await settle(); await f.account.readNotice('n1')
  f.account.disconnected()
  expect(f.snapshot().profile).toBe(undefined); expect(f.snapshot().notice).toBe(undefined); expect(f.timers.size).toBe(0)
  f.handlers['account/getProfile'] = () => ({ status: 'ready', value: { id: 'new', name: 'New', contact: null } })
  f.streams.get('account/watch')!.item({ type: 'snapshot', state: state() }); await settle()
  expect(f.snapshot().profile).toEqual({ kind: 'ready', value: { status: 'ready', value: { id: 'new', name: 'New', contact: null } } })
  expect(f.count('getNotifications')).toBe(2)
  f.account.stop()
})

test('account signout confirmation is generation fenced, lost ACK gets one authoritative read not a replay', async () => {
  const f = fixture()
  f.account.start(); await settle()
  let ticket = await f.account.prepareSignOut()
  expect(ticket.running).toBe(true)
  let rejected = false; try { await f.account.signOut(false, ticket.generation) } catch { rejected = true }
  expect(rejected).toBe(true); expect(f.count('signOut')).toBe(0)
  f.streams.get('account/watch')!.item({ type: 'credentials-changed', state: state() }); await settle()
  rejected = false; try { await f.account.signOut(true, ticket.generation) } catch { rejected = true }
  expect(rejected).toBe(true); expect(f.count('signOut')).toBe(0)
  ticket = await f.account.prepareSignOut()
  f.handlers['account/signOut'] = () => { f.handlers['account/getState'] = () => state('signed-out'); throw new Error('lost ACK after removal') }
  await f.account.signOut(true, ticket.generation)
  expect(f.count('signOut')).toBe(1)
  expect(f.snapshot().state).toEqual({ kind: 'ready', value: state('signed-out') })
  expect(f.snapshot().uncertain).toBe(true); expect(f.snapshot().canSignOut).toBe(false)
  expect(f.calls[f.calls.length - 1].method).toBe('account/getState')
  f.account.stop()
})

test('account credential-safe null detail clears all authority, without a refresh loop or further notices', async () => {
  const f = fixture()
  f.handlers['account/getProfile'] = () => null
  f.account.start(); await settle(); await f.advance(600000)
  expect(f.snapshot().profile).toBe(undefined); expect(f.snapshot().notices).toBe(undefined)
  expect(f.count('getState')).toBe(1); expect(f.timers.size).toBe(0)
  f.account.stop()
})

test('account stream refusal clears authority and refresh reopens subscriptions; stale report cannot clear replacement credentials', async () => {
  const f = fixture(), acknowledgement = deferred<boolean>()
  f.account.start(); await settle(); await f.account.readNotice('n1')
  f.handlers['account/reportNotificationEvent'] = () => acknowledgement.promise
  const reporting = f.account.presented('n1', f.snapshot().generation)
  f.streams.get('account/watch')!.failed(new Error('access revoked'))
  expect(f.snapshot().profile).toBe(undefined); expect(f.timers.size).toBe(0)
  await f.account.refresh(); await settle()
  expect(f.count('watch')).toBe(2); expect(f.snapshot().canSignOut).toBe(true)
  const generation = f.snapshot().generation
  acknowledgement.resolve(false); await reporting
  expect(f.snapshot().generation).toBe(generation); expect(f.snapshot().canSignOut).toBe(true)
  f.account.stop()
})

test('account signout with lost ACK and failed authoritative read leaves no authority and never retries', async () => {
  const f = fixture()
  f.account.start(); await settle()
  const ticket = await f.account.prepareSignOut()
  f.handlers['account/signOut'] = () => { f.handlers['account/getState'] = () => { throw new Error('offline') }; throw new Error('lost ACK') }
  await f.account.signOut(true, ticket.generation)
  expect(f.count('signOut')).toBe(1); expect(f.snapshot().state).toEqual({ kind: 'failed' })
  expect(f.snapshot().profile).toBe(undefined); expect(f.snapshot().canSignOut).toBe(false)
  let rejected = false; try { await f.account.signOut(true, ticket.generation) } catch { rejected = true }
  expect(rejected).toBe(true); expect(f.count('signOut')).toBe(1)
  f.account.stop()
})
