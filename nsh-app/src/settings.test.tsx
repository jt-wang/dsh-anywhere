// The phone's Settings page (src/settings.tsx): which computer it is linked to and how, the
// appearance, the language and the notifications, and Unlink. Headless: the test plays the shell and the computer.
import { expect, open, test } from 'nsh/test'
import { APK_URL, UPDATE_GUIDE_URL } from './updates.ts'
import { HOST_VERSION } from '../../host/src/phone.ts'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const paired = { paired: true, origin: ORIGIN, token: 'synthetic-device-token' }
const ok = (value: unknown) => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } })
/** DSH's pluginManager/listVersions for DSH Anywhere, newest first, as npm has it. */
const listed = (version: string) => ok({ status: 'listed', installed: '0.8.11', versions: [{ version, tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 })
const onNpm = (version: string) => ({ [`POST ${ORIGIN}/api/pluginManager/listVersions`]: () => listed(version) })

async function settings(granted: boolean, offline = false, info: () => unknown = () => ({ version: '2.4.9', build: '314' }), extra: Record<string, unknown> = {}, platform: 'ios' | 'android' = 'ios', caps: Record<string, unknown> = {}, network: Record<string, () => unknown> = {}) {
  // Connected (a socket that opens) unless offline: the route shows only while the computer answers.
  const app = await open(offline ? '../App.tsx' : './fixtures/connected/App.tsx', {
    platform,
    locale: 'en-US',
    host: { handlers: {
      'app.info': info, 'network.state': { online: !offline },
      'link.state': paired, 'app.state': { active: true }, 'notify.watch': null, 'notify.clear': null, 'notify.permission': { granted },
      'notify.request': { granted: true, decided: true }, 'notify.settings': null, 'link.forget': null, 'link.path': { route: 'relay', kind: 'derp', derpCode: 'tok' }, ...extra,
    } },
    network: {
      [`POST ${ORIGIN}/api/session/list`]: () => ok({ items: [] }),
      [`GET http://127.0.0.1:40001/v1/capabilities`]: () => offline ? { status: 503 } : { body: { hostName: 'DSH Anywhere companion', computerName: 'Studio', hostVersion: '0.7.13', upstreamVersion: '0.2.1-rc.3', ...caps } },
      ...network,
    },
  })
  await app.waitFor('id:more')
  await app.press('id:more')
  await app.press('text:Settings')
  if (!offline) await app.waitFor('text:Studio')
  return app
}

for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: diagnostics has one Off entry; its switches and export live only on the child page`, async () => {
    for (const saved of [null, JSON.stringify({ enabled: false, categories: { interaction: true, performance: true, network: true, resources: true } })]) {
      const app = await settings(true, false, undefined, {
        'diagnostics.preferences.read': saved, 'diagnostics.read': null, 'diagnostics.resources': null,
      }, platform)
      expect(app.count('id:settings-diagnostics')).toBe(1)
      expect(app.shows('id:settings-diagnostics >> text:Off')).toBe(true)
      expect(app.shows('id:diagnostics-enabled')).toBe(false)
      expect(app.shows('id:diagnostics-preview')).toBe(false)
      await app.press('id:settings-diagnostics')
      await app.waitFor('id:diagnostics-enabled')
      expect(app.shows('id:settings-diagnostics')).toBe(false)
      expect(app.shows('text:Off. Previously saved logs remain until cleared or replaced.')).toBe(true)
      for (const category of ['interaction', 'performance', 'network', 'resources']) expect(app.enabled(`id:diagnostics-${category}`)).toBe(false)
      expect(app.host.calls().filter(c => c.name === 'diagnostics.resources').some(c => (c.data as any).enabled)).toBe(false)
      expect(app.host.calls().some(c => c.name === 'diagnostics.write' || c.name === 'diagnostics.preferences.write')).toBe(false)
      await app.back()
      expect(app.shows('id:settings-diagnostics >> text:Off')).toBe(true)
      expect(app.shows('id:diagnostics-preview')).toBe(false)
    }
  })
}

test('Settings says which computer the phone is linked to, how, and the versions on it', async () => {
  const app = await settings(true)
  await app.waitFor('text:2.4.9 (314)')
  const t = app.texts()
  for (const s of ['DSH Anywhere', 'Version (build)', 'Computer', 'Studio', 'End-to-end encrypted tunnel', 'Through a Tailcat relay', '0.2.1-rc.3', '0.7.13', 'Unlink', 'Appearance', 'Language', 'Notifications']) expect([s, t.includes(s)]).toEqual([s, true])
})

test('the installed app version remains readable without the computer; a failed read does not invent a version', async () => {
  const app = await settings(true, true)
  await app.waitFor('text:2.4.9 (314)')
  expect(app.texts().includes('Studio')).toBe(false)
  await app.press('id:settings-language'); await app.press('id:action-zh')
  await app.waitFor('text:版本（构建号）')
  expect(app.texts().includes('2.4.9 (314)')).toBe(true)
  const failed = await settings(true, true, () => { throw new Error('app.info/unavailable') })
  await failed.waitFor('text:Unavailable')
  expect(failed.texts().includes('2.4.9 (314)')).toBe(false)
})

test('Language is one row with the choice; its sheet lists Follow system and each language in its own words, checked', async () => {
  const app = await settings(true)
  expect(app.shows('id:settings-language >> text:Follow system')).toBe(true)
  expect(app.shows('text:Русский')).toBe(false)
  await app.press('id:settings-language'); await app.waitFor('id:action-sheet')
  expect(['Follow system', '简体中文', '繁體中文', 'English', 'Español', 'Français', '한국어', '日本語', 'Русский'].every((n) => app.shows(`id:action-sheet >> text:${n}`))).toBe(true)
  expect(app.shows('id:action-system-on')).toBe(true); expect(app.shows('id:action-ru-on')).toBe(false)
  await app.press('id:action-ru')
  await app.waitFor('text:Компьютер')
  expect(app.shows('id:settings-language >> text:Русский')).toBe(true)
  expect(JSON.parse(app.storage().prefs).language).toBe('ru')
  await app.press('id:settings-language'); await app.waitFor('id:action-ru-on')
  await app.press('id:action-system')
  await app.waitFor('text:Computer')
  expect(JSON.parse(app.storage().prefs).language).toBe('system')
})

test('Android 13+: the in-app language and the per-app language in the phone\'s settings are one choice', async () => {
  let tag = ''
  const language = (data?: { tag?: string }) => { if (typeof data?.tag === 'string') tag = data.tag; return { supported: true, tag } }
  // First launch: the choice here is handed to the phone; a pick here goes there too.
  const app = await settings(true, false, undefined, { 'app.language': language }, 'android')
  await app.press('id:settings-language'); await app.press('id:action-zh-Hant')
  await app.waitFor('text:電腦')
  expect(tag).toBe('zh-Hant')
  await app.press('id:settings-language'); await app.press('id:action-system')
  await app.waitFor('text:Computer')
  expect(tag).toBe('')
  // Changed in the phone's settings while away: coming back follows it.
  tag = 'ja-JP'
  await app.host.send('app.state', { active: true })
  await app.waitFor('id:settings-language >> text:日本語')
  expect(JSON.parse(app.storage().prefs).language).toBe('ja')
})

test('with notifications off for the app, Settings says so and opens the phone\'s settings', async () => {
  const app = await settings(false)
  await app.waitFor('text:Notifications for DSH Anywhere are off in the phone’s settings.')
  await app.press('id:notify-open-settings')
  expect(app.host.calls().some((c) => c.name === 'notify.settings')).toBe(true)
})

test('Unlink says what it costs and needs both steps; Cancel keeps the link', async () => {
  const app = await settings(true)
  await app.press('id:settings-unlink')
  await app.waitFor('id:danger-sheet')
  expect(app.texts()).toContain('This phone forgets the computer and stops showing its chats. Other phones stay connected. To use this phone again, pair it again on the computer.')
  // The word is not typed yet: the red button does not take a press.
  expect(app.enabled('id:danger-confirm')).toBe(false)
  expect(app.host.calls().some((c) => c.name === 'link.forget')).toBe(false)
  await app.press('id:danger-cancel'); await app.wait(300)
  expect(app.host.calls().some((c) => c.name === 'link.forget')).toBe(false)
  await app.press('id:settings-unlink')
  await app.type('id:danger-word', 'dsh anywhere')
  await app.press('id:danger-confirm')
  await app.waitFor('text:Link your computer')
  expect(app.host.calls().some((c) => c.name === 'link.forget')).toBe(true)
})

test('Tailcat only is kept by the shell, which opens a new tunnel with it; the app then follows the new bridge', async () => {
  let on = false, states = 0
  const app = await settings(true, false, undefined, {
    'link.tailcatOnly': (data?: { on?: boolean }) => { if (typeof data?.on === 'boolean') on = data.on; return { on } },
    'link.state': () => { states++; return paired },
  })
  await app.waitFor('text:Tailcat only')
  expect(app.texts().includes('Skip your relay and the local network. Tailcat may still use its own encrypted relay.')).toBe(true)
  const before = states
  await app.press('id:tailcat-only')
  await app.waitUntil(() => on && states > before)
  expect(app.host.calls().filter((c) => c.name === 'link.tailcatOnly').map((c) => c.data ?? null)).toEqual([null, { on: true }])
})

test('the same-network route is named as such', async () => {
  const app = await settings(true, false, undefined, { 'link.path': { route: 'lan', kind: 'lan' } })
  await app.waitFor('text:Direct on the same Wi-Fi')
})

for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: settings shows the route kind, never a relay’s data-centre code`, async () => {
    for (const [path, label] of [
      [{ route: 'relay', relay: 'legacy-code', kind: 'derp', derpCode: 'tok' }, 'Through a Tailcat relay'],
      [{ route: 'relay', kind: 'derp', derpRegion: 1, derpHost: 'region.example.com' }, 'Through a Tailcat relay'],
      [{ route: 'relay', kind: 'derp', derpRegion: 42 }, 'Through a Tailcat relay'],
      [{ route: 'relay', kind: 'derp' }, 'Through a Tailcat relay'],
      [{ route: 'relay', kind: 'relay', relayHost: 'relay.example.com' }, 'Through your relay server (relay.example.com)'],
      [{ route: 'relay', kind: 'relay' }, 'Through your relay server'],
      [{ route: 'direct', kind: 'direct' }, 'Direct to your computer (no relay)'],
      [{ route: 'lan', kind: 'lan' }, 'Direct on the same Wi-Fi'],
    ] as const) {
      const app = await settings(true, false, undefined, { 'link.path': path }, platform)
      await app.waitFor(`text:${label}`)
      expect(app.texts()).toContain(label)
      expect(app.texts().some(t => t.includes('(—)') || t.includes('()'))).toBe(false)
    }
  })
}

// The companion says its release from 0.8.1 (DSH Anywhere 0.1.11); one before it says none and is older than this app.
for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: Settings says which side to update when the app and the computer come from different releases`, async () => {
    const app = (version: string) => () => ({ version, build: '12' })
    const same = await settings(true, false, app('0.1.11'), {}, platform, { release: '0.1.11' })
    await same.waitFor('text:0.1.11 (12)')
    expect(same.shows('id:update-notice')).toBe(false)

    const old = await settings(true, false, app('0.1.11'), {}, platform, { hostVersion: '0.7.15' }, onNpm(HOST_VERSION))
    await old.waitFor('text:Update DSH Anywhere on your computer to 0.1.11')
    await old.press('id:update-action')
    expect(old.openedUrls()).toEqual([UPDATE_GUIDE_URL])
    const behind = await settings(true, false, app('0.1.12'), {}, platform, { release: '0.1.11', hostVersion: '0.8.2' }, onNpm(HOST_VERSION))
    await behind.waitFor('text:Update DSH Anywhere on your computer to 0.1.12')

    // 0.1.10 against 0.1.9 is newer by numbers, older as text.
    const ahead = await settings(true, false, app('0.1.9'), {}, platform, { release: '0.1.10' })
    await ahead.waitFor('text:DSH Anywhere 0.1.10 is available')
    if (platform === 'android') {
      await ahead.press('id:update-action')
      expect(ahead.openedUrls()).toEqual([APK_URL])
    } else {
      expect(ahead.shows('text:Your computer runs a newer version than this app. Update DSH Anywhere in TestFlight.')).toBe(true)
      expect(ahead.shows('id:update-action')).toBe(false)
    }
  })
}

// npm gets a release last (docs/RELEASE.md): an app that came out first, as 0.1.20's did with companion 0.8.10 never on
// npm, does not ask the computer for an update DSH cannot install yet; once DSH lists this release's companion
// (HOST_VERSION) or a later one, the app does. An older release's companion, newer than the computer's, is not enough.
for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: Settings asks to update the computer only once DSH lists a newer DSH Anywhere it can install`, async () => {
    const app = () => ({ version: '0.1.22', build: '23' })
    const caps = { release: '0.1.21', hostVersion: '0.0.2' }
    const notYet = await settings(true, false, app, {}, platform, caps, onNpm('0.0.2'))
    await notYet.waitFor('text:0.1.22 (23)'); await notYet.wait(300)
    expect(notYet.shows('id:update-notice')).toBe(false)
    // Two releases behind, with only the release in between on npm (a 0.1.22 app, companion 0.8.9, npm at 0.8.11).
    const between = await settings(true, false, app, {}, platform, { release: '0.1.19', hostVersion: '0.0.1' }, onNpm('0.0.2'))
    await between.waitFor('text:0.1.22 (23)'); await between.wait(300)
    expect(between.shows('id:update-notice')).toBe(false)
    const unlisted = await settings(true, false, app, {}, platform, caps, { [`POST ${ORIGIN}/api/pluginManager/listVersions`]: () => ok({ status: 'listed', installed: '0.8.11', versions: [] }) })
    await unlisted.waitFor('text:0.1.22 (23)'); await unlisted.wait(300)
    expect(unlisted.shows('id:update-notice')).toBe(false)
    const refused = await settings(true, false, app, {}, platform, caps, { [`POST ${ORIGIN}/api/pluginManager/listVersions`]: () => ok({ status: 'refused' }) })
    await refused.waitFor('text:0.1.22 (23)'); await refused.wait(300)
    expect(refused.shows('id:update-notice')).toBe(false)
    const unanswered = await settings(true, false, app, {}, platform, caps)
    await unanswered.waitFor('text:0.1.22 (23)'); await unanswered.wait(300)
    expect(unanswered.shows('id:update-notice')).toBe(false)
    // A phone that may only read chats cannot ask DSH, so it is not told either.
    let asked = false
    const readOnly = await settings(true, false, app, {}, platform, { ...caps, capabilities: { control: false } }, { [`POST ${ORIGIN}/api/pluginManager/listVersions`]: () => { asked = true; return listed(HOST_VERSION) } })
    await readOnly.waitFor('text:0.1.22 (23)'); await readOnly.wait(300)
    expect(readOnly.shows('id:update-notice')).toBe(false)
    expect(asked).toBe(false)
    const published = await settings(true, false, app, {}, platform, caps, onNpm(HOST_VERSION))
    await published.waitFor('text:Update DSH Anywhere on your computer to 0.1.22')
  })
}

test('a developer build of the app, which has no release number, is not told to update either side', async () => {
  const app = await settings(true, false, () => ({ version: '0.1.11-dev', build: '0' }), {}, 'android', { release: '0.1.12' })
  await app.waitFor('text:0.1.11-dev (0)')
  expect(app.shows('id:update-notice')).toBe(false)
})
