import { expect, open, test } from 'nsh/test'
import { DshError } from './dsh.ts'
import { accountIdentity, noticeVisible, performCuaAction, readComputerStatus, readHostDomain, readPresetComposition, readPresetSettings, setDefaultPreset, type HostSettingsClient } from './host-settings.ts'
import { hostSettingsStrings } from './host-settings-strings.ts'

test('host settings exact preset wire arguments and revision fence; broken or read-only rejected without write', async () => {
  const calls: any[] = []
  const c = { async rpc(method: string, args: unknown) { calls.push({ method, args }); return method === 'agentPresets/list' ? { presets: [{ id: 'ptc', isDefault: false }, { id: 'broken', broken: 'failure' }] } : method === 'settings/describe' ? { writable: true, namespaces: [{ ns: 'agent-preset-registry', revision: 12 }] } : {} } } as HostSettingsClient
  const snapshot = await readPresetSettings(c)
  await readPresetComposition(c, 'ptc')
  expect(calls[2]).toEqual({ method: 'agentPresets/read', args: { agentPreset: 'ptc' } })
  await setDefaultPreset(c, snapshot, 'ptc')
  expect(calls[3]).toEqual({ method: 'settings/mutate', args: { ns: 'agent-preset-registry', expectedRevision: 12, ops: [{ op: 'set', path: ['selectedDefault'], value: 'ptc' }] } })
  const count = calls.length
  for (const [s, id] of [[snapshot, 'broken'], [{ ...snapshot, writable: false }, 'ptc'], [snapshot, 'missing']] as const) {
    let rejected = false
    try { await setDefaultPreset(c, s, id) } catch { rejected = true }
    expect(rejected).toBe(true)
  }
  expect(calls.length).toBe(count)
})

test('host settings account identity is actual client version, locale and east-positive seconds; no guessed platform', () => {
  expect(accountIdentity('fixture-1', 'zh-Hant', -480)).toEqual({ version: 'fixture-1', locale: 'zh-Hant', timezoneOffsetSeconds: 28800 })
  let rejected = false; try { accountIdentity('', 'en') } catch { rejected = true }
  expect(rejected).toBe(true)
  const n = { displayUntil: null } as any
  expect(noticeVisible(n, 1000)).toBe(true)
  expect(noticeVisible({ ...n, displayUntil: '1970-01-01T00:00:01.000Z' }, 1000)).toBe(false)
  expect(noticeVisible({ ...n, displayUntil: 'invalid' })).toBe(false)
})

test('host settings CUA requires confirmation and sends only real operation arguments, never auto retries', async () => {
  const calls: any[] = []
  const c = { async rpc(method: string, args: unknown) { calls.push({ method, args }); throw new DshError('network', 'lost') } } as HostSettingsClient
  let rejected = false
  try { await performCuaAction(c, { method: 'revoke', id: 'app1' }, 'en', false) } catch { rejected = true }
  expect(rejected).toBe(true); expect(calls.length).toBe(0)
  for (const action of [{ method: 'revoke', id: 'app1' }, { method: 'retryApproval', id: 'app2' }, { method: 'requestPermission', permission: 'accessibility' }, { method: 'openSettings', permission: 'screenRecording' }, { method: 'enablePersistentPtc' }] as const) {
    try { await performCuaAction(c, action, 'ja', true) } catch { /* intentional lost response */ }
  }
  expect(calls).toEqual([
    { method: 'cuaAccess/revoke', args: { id: 'app1' } }, { method: 'cuaAccess/retryApproval', args: { id: 'app2' } },
    { method: 'cuaAccess/requestPermission', args: { permission: 'accessibility', locale: 'ja' } }, { method: 'cuaAccess/openSettings', args: { permission: 'screenRecording', locale: 'ja' } }, { method: 'cuaAccess/enablePersistentPtc', args: {} },
  ])
})

test('host settings missing gateway method is distinct from offline, denial and empty', async () => {
  for (const code of ['network', 'unauthorized', 'gateway/access-denied', 'gateway/method-unavailable']) {
    const c = { async rpc() { throw new DshError(code, '') } } as HostSettingsClient
    expect(await readHostDomain(c, 'cuaAccess/systemStatus')).toEqual({ kind: code === 'gateway/method-unavailable' ? 'unavailable' : 'failed' })
  }
})

test('host settings untagged and unknown-platform ready CUA responses are unavailable, not macOS or empty', async () => {
  for (const result of [{ accessibility: true }, { platform: 'linux' }, null]) {
    expect(await readComputerStatus({ async rpc() { return result } } as HostSettingsClient)).toEqual({ kind: 'unavailable' })
  }
})

test('host settings reads the alpha Windows CUA status without a helper PID', async () => {
  const status = { platform: 'windows', sessionLocked: null, captureAvailable: false, elevated: true, helper: { name: 'Synthetic helper' } }
  const client = { async rpc(method: string, args: unknown) {
    expect([method, args]).toEqual(['cuaAccess/systemStatus', {}])
    return status
  } } as HostSettingsClient
  expect(await readComputerStatus(client)).toEqual({ kind: 'ready', value: { ...status, platform: 'win32' } })
})

test('host settings eight dictionaries, Traditional regions and English fallback', () => {
  const en = hostSettingsStrings('en')
  for (const tag of ['zh-CN', 'zh-TW', 'en', 'es', 'fr', 'ko', 'ja', 'ru']) {
    expect(Object.keys(hostSettingsStrings(tag))).toEqual(Object.keys(en))
    expect(Object.values(hostSettingsStrings(tag)).every(v => v.length > 0)).toBe(true)
  }
  expect(hostSettingsStrings('zh-HK')).toEqual(hostSettingsStrings('zh-Hant'))
  expect(hostSettingsStrings('de')).toEqual(en)
})

const fixture = () => open('./host-settings-fixture.tsx', { locale: 'en-US', host: { handlers: { haptic: null } } })
test('host settings native cards read composition, account decimals, conditional inventory and confirm CUA before dispatch', async () => {
  const app = await fixture()
  await app.press('id:host-settings-read'); await app.waitFor('id:host-composition-ptc')
  expect(app.texts()).toContain('Balance: USD 1.00000001')
  expect(app.texts()).toContain('Bonus balance: CNY 2.50')
  expect(app.texts()).toContain('Synthetic diagnostic')
  expect(app.texts()).toContain('conditional · conditional · —')
  await app.press('id:host-composition-ptc'); await app.waitFor('id:host-composition')
  expect(app.texts()).toContain('- name: cordis:synthetic\n')
  await app.press('id:host-revoke-allowed1'); await app.waitFor('id:host-confirmation')
  expect(app.texts().join('\n').includes('"method":"cuaAccess/revoke"')).toBe(false)
  await app.press('id:host-cancel'); await app.waitUntil(() => !app.shows('id:host-confirmation'))
  await app.press('id:host-revoke-allowed1'); await app.press('id:host-confirm')
  await app.waitUntil(() => !app.shows('id:host-revoke-allowed1'))
  expect(app.texts().join('\n').includes('"method":"cuaAccess/revoke","args":{"id":"allowed1"}')).toBe(true)
})

test('host settings Windows observations have no invented permission controls; offline clears authority', async () => {
  const app = await fixture()
  await app.press('id:fixture-windows'); await app.press('id:host-settings-read'); await app.waitFor('id:host-windows-status')
  expect(app.shows('id:host-request-accessibility')).toBe(false)
  expect(app.texts()).toContain('Desktop locked: Unknown · Capture available: No · Elevated: Yes')
  await app.press('id:fixture-offline'); await app.press('id:host-settings-read')
  await app.waitUntil(() => !app.shows('id:host-revoke-allowed1'))
  await app.waitFor('text:Could not read. Check the connection and refresh.')
})

test('host settings lost preset acknowledgement is not replayed and must refresh before another write', async () => {
  const app = await fixture()
  await app.press('id:host-settings-read'); await app.waitFor('id:host-default-ptc')
  await app.press('id:fixture-lost'); await app.press('id:host-default-ptc'); await app.waitFor('id:host-settings-message')
  expect(app.texts().join('\n').split('"method":"settings/mutate"').length - 1).toBe(1)
  let disabled = false
  try { await app.press('id:host-default-ptc') } catch (e) { disabled = String(e).includes('disabled') }
  expect(disabled).toBe(true)
  expect(app.texts().join('\n').split('"method":"settings/mutate"').length - 1).toBe(1)
  await app.press('id:fixture-mac'); await app.press('id:host-settings-read'); await app.waitFor('text:PTC · Default')
})

test('host settings notices read full content and report real events without a login call', async () => {
  const app = await fixture()
  await app.press('id:host-settings-read'); await app.waitFor('id:host-notice-n1')
  await app.press('id:host-notice-n1'); await app.waitFor('id:host-notice-content')
  await app.wait(300)
  expect(app.texts().join('\n').includes('"event":"displayed"')).toBe(false) // Card is still below viewport.
  for (let i = 0; i < 12 && !app.texts().join('\n').includes('"event":"displayed"'); i++) {
    await app.scroll('id:host-notice-content', 350); await app.wait(300)
  }
  await app.waitUntil(() => app.texts().join('\n').includes('"event":"displayed"'))
  await app.press('id:host-notice-action-app_route')
  expect(app.shows('id:host-notice-content')).toBe(true)
  await app.press('id:host-notice-action-dismiss'); await app.waitUntil(() => !app.shows('id:host-notice-n1'))
  expect(app.texts().join('\n').includes('"event":"dismissed"')).toBe(true)
  expect(app.texts().join('\n').includes('account/startSignIn')).toBe(false)
})

test('host settings desktop credential change and foreground/reconnect lifecycle clear authority without manual reads', async () => {
  const app = await fixture()
  await app.press('id:host-settings-read'); await app.waitFor('id:host-profile')
  await app.press('id:fixture-background'); await app.waitUntil(() => !app.shows('id:host-profile'))
  await app.press('id:fixture-resume'); await app.waitFor('id:host-profile')
  await app.press('id:fixture-disconnect'); await app.waitUntil(() => !app.shows('id:host-profile'))
  await app.press('id:fixture-reconnect'); await app.waitFor('id:host-profile')
  await app.press('id:host-notice-n1'); await app.waitFor('id:host-notice-content')
  await app.press('id:fixture-signed-out'); await app.waitUntil(() => !app.shows('id:host-profile'))
  expect(app.shows('id:host-notice-content')).toBe(false)
  expect(app.shows('id:host-signout')).toBe(false)
  expect(app.texts()).toContain('Signed out')
})

test('host settings signout preflight warns, cancellation does not write, lost ACK reads state and never retries', async () => {
  const app = await fixture()
  await app.press('id:host-settings-read'); await app.waitFor('id:host-signout')
  await app.press('id:host-signout'); await app.waitFor('id:host-signout-confirmation')
  expect(app.texts()).toContain('Account tasks are currently running.')
  expect(app.texts().join('\n').includes('"method":"account/signOut"')).toBe(false)
  await app.press('id:host-signout-cancel')
  expect(app.texts().join('\n').includes('"method":"account/signOut"')).toBe(false)
  await app.press('id:fixture-lost-signout'); await app.press('id:host-signout'); await app.press('id:host-signout-confirm')
  await app.waitFor('text:Signed out')
  expect(app.shows('id:host-profile')).toBe(false)
  const log = app.texts().join('\n')
  expect(log.split('"method":"account/signOut"').length - 1).toBe(1)
  expect(log.lastIndexOf('"method":"account/getState"') > log.lastIndexOf('"method":"account/signOut"')).toBe(true)
})
