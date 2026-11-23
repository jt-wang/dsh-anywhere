// Settings › Computer settings (src/computer-settings.tsx): DSH Desktop's settings in its groups, changed through DSH's
// own calls, and the danger zone. The whole app over a stand-in DSH shaped as 0.2.2-rc.5 answers (fixtures/computer-dsh.ts).
import { expect, open, test, type App } from 'nsh/test'
import { computerDsh, ORIGIN, SELF, VOICE } from './fixtures/computer-dsh.ts'

async function computerSettings(options: Parameters<typeof computerDsh>[0] = {}, platform: 'ios' | 'android' = 'ios') {
  const dsh = computerDsh(options)
  const app = await open('./fixtures/connected/App.tsx', {
    platform, locale: 'en-US',
    host: { handlers: {
      'app.info': { version: '0.1.18', build: '19' }, 'network.state': { online: true }, 'link.state': { paired: true, origin: ORIGIN, token: 'synthetic-device-token' },
      'app.state': { active: true }, 'notify.watch': null, 'notify.clear': null, 'notify.permission': { granted: true }, 'link.forget': null, 'link.path': { kind: 'direct' }, haptic: null,
    } },
    network: dsh.network,
  })
  await app.waitFor('id:more')
  await app.press('id:more')
  await app.press('text:Settings')
  await app.press('id:settings-computer')
  return { app, dsh }
}
const writes = (dsh: ReturnType<typeof computerDsh>) => dsh.calls.filter(c => !/\/(describe|catalog|list[A-Za-z]*)$/.test(c.method) && c.method !== 'session/list')

test('Computer settings is one row in Settings, opening DSH Desktop\'s groups, each saying what it is set to', async () => {
  const { app, dsh } = await computerSettings()
  await app.waitFor('id:computer-general')
  for (const t of ['DSH Desktop', 'General', 'Models', 'Agent presets', 'Account', 'Workspaces', 'Built-in plugins', 'Plugins', 'Subagent', 'Web search and fetch', 'Shell', 'Computer use', 'Voice input']) expect(app.texts()).toContain(t)
  expect(app.texts()).toContain('Workspace write · System')
  expect(app.texts()).toContain('Depth 1 · up to 8 at once')
  expect(app.texts()).toContain('Commands stop after 60 s')
  // A group this computer's DSH doesn't have (here Agent loop) takes no row.
  expect(app.shows('id:computer-loop')).toBe(false)
  expect(app.texts()).not.toContain('Agent loop')
  // DSH Anywhere is not counted among the plugins: Voice input of Voice input and Computer use.
  expect(app.texts()).toContain('1 of 2 on')
  expect(app.texts()).toContain('Other plugin settings')
  // Read without a button, and nothing written by reading.
  expect(app.shows('text:Read computer settings')).toBe(false)
  expect(writes(dsh)).toEqual([])
})

test('General: a switch, a choice and a number each write DSH\'s exact path with its revision; the page shows the computer\'s answer', async () => {
  const { app, dsh } = await computerSettings()
  await app.press('id:computer-general')
  await app.waitFor('id:field-codingView')
  await app.press('id:field-codingView')
  await app.waitUntil(() => writes(dsh).length === 1)
  expect(writes(dsh)[0]).toEqual({ method: 'settings/mutate', args: { ns: 'ui-settings', ops: [{ op: 'set', path: ['enabled'], value: false }], expectedRevision: 1 } })
  await app.press('id:field-appearance')
  await app.press('text:Dark')
  await app.waitUntil(() => writes(dsh).length === 2)
  expect(writes(dsh)[1]!.args).toEqual({ ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: 'dark' }], expectedRevision: 1 })
  await app.waitUntil(() => dsh.calls.filter(c => c.method === 'settings/describe').length >= 3)
  // The choice's menu may still be closing; once it has, the page shows the one answer.
  await app.waitUntil(() => app.texts().filter(t => t === 'Dark').length === 1)
  // A conflict (changed in DSH Desktop meanwhile) reads the computer again and says so; it is not retried.
  dsh.conflictNext()
  await app.press('id:field-busyEnter')
  await app.press('text:Steer')
  await app.waitFor('id:field-busyEnter-outcome')
  expect(app.texts()).toContain('This changed on your computer meanwhile. The new value is shown; change it again if you still want to.')
  expect(writes(dsh).filter(w => (w.args as any).ns === 'ui-conversation').length).toBe(1)
})

test('Full access asks first with DSH\'s acknowledgement; nothing is written until it is given', async () => {
  const { app, dsh } = await computerSettings()
  await app.press('id:computer-general')
  await app.press('id:field-permission')
  await app.press('text:Full access')
  await app.waitFor('id:danger-sheet')
  expect(app.texts()).toContain('Enable Full access?')
  expect(app.enabled('id:danger-confirm')).toBe(false)
  await app.press('id:danger-ack')
  await app.press('id:danger-confirm')
  await app.waitUntil(() => writes(dsh).length === 1)
  expect(writes(dsh)[0]!.args).toEqual({ ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }], expectedRevision: 1 })
})

test('shortcuts, the update channel and restarting DSH Desktop are marked Only on the computer, each with why', async () => {
  const { app } = await computerSettings()
  await app.press('id:computer-general')
  for (const id of ['shortcuts', 'channel', 'restart']) await app.waitFor(`id:computer-only-${id}`)
  expect(app.texts().filter(t => t === 'Only on the computer').length).toBe(4) // the section's title and three rows
  expect(app.texts()).toContain('DSH Desktop has no way to be restarted by another program. Quit and reopen it on the computer.')
})

test('DSH Anywhere has no switch among the plugins; the danger zone turns it off only after the sheet and the typed word', async () => {
  const { app, dsh } = await computerSettings()
  await app.press('id:computer-plugins')
  await app.waitFor('id:plugin-dsh-experimental-voice-input-bundle')
  expect(app.shows('id:plugin-dsh-anywhere')).toBe(false)
  expect(app.shows('id:plugin-dsh-anywhere-switch')).toBe(false)
  expect(app.texts().filter(t => t.includes('DSH Anywhere'))).toEqual([])
  await app.back()
  await app.waitFor('id:danger-off')
  // One-line rows under no title; the consequence is a footer, and in full in the sheet.
  expect(app.texts()).not.toContain('Danger zone')
  expect(app.texts()).toContain('Both disconnect this phone and every paired phone at once. To use a phone again, turn DSH Anywhere back on, or install it again, on the computer.')
  await app.press('id:danger-off')
  await app.waitFor('id:danger-sheet')
  expect(app.texts()).toContain('This phone and every paired phone disconnect at once. It can only be turned on again in DSH Desktop on the computer: Plugins › Installed › DSH Anywhere.')
  expect(app.texts()).toContain('Turn off DSH Anywhere and disconnect')
  expect(app.enabled('id:danger-confirm')).toBe(false)
  await app.type('id:danger-word', 'DSH')
  expect(app.enabled('id:danger-confirm')).toBe(false)
  await app.press('id:danger-cancel'); await app.wait(300)
  expect(writes(dsh)).toEqual([])
  await app.press('id:danger-off')
  await app.type('id:danger-word', 'DSH Anywhere')
  await app.press('id:danger-confirm')
  await app.waitFor('id:danger-note')
  expect(writes(dsh)).toEqual([{ method: 'pluginManager/setBundleEnabled', args: { name: SELF, enabled: false } }])
  expect(app.texts()).toContain('DSH Anywhere is turning off on your computer. This phone disconnects now.')
})

test('the DSH Anywhere group offers the newer version DSH lists, outside the danger zone, and updates after one confirmation', async () => {
  const { app, dsh } = await computerSettings()
  await app.waitFor('id:computer-self-update')
  expect(app.texts()).toContain('New version 0.8.8')
  expect(app.texts()).toContain('Phones disconnect for a moment and reconnect on their own once it is installed.')
  expect(app.shows('id:danger-update')).toBe(false)
  expect(app.shows('id:danger-off')).toBe(true)
  await app.press('id:computer-self-update')
  await app.waitFor('id:action-sheet-message')
  expect(app.texts()).toContain('Update and reconnect')
  await app.press('id:action-no'); await app.wait(300)
  expect(writes(dsh)).toEqual([])
  await app.press('id:computer-self-update')
  await app.waitFor('id:action-yes')
  await app.press('id:action-yes')
  await app.waitFor('id:self-note')
  expect(writes(dsh)).toEqual([{ method: 'pluginManager/updateBundle', args: { name: SELF, version: '0.8.8', options: { registry: { url: 'https://registry.npmjs.org/' } } } }])
})

// Companions up to 0.8.6 crash DSH Desktop's host when a phone updates, turns off or removes them through the relay
// (they keep the change after DSH has stopped them). Such a computer shows the newer version and where to install it.
test('a computer on DSH Anywhere 0.8.6 offers no update, turn-off or uninstall on the phone, only DSH Desktop\'s Plugins page', async () => {
  const { app, dsh } = await computerSettings({ selfVersion: '0.8.6' })
  await app.waitFor('id:computer-self-update-on-computer')
  expect(app.texts()).toContain('New version 0.8.8')
  expect(app.texts()).toContain('Install it on the computer: Update on DSH Desktop’s Plugins page.')
  expect(app.shows('id:computer-self-update')).toBe(false)
  expect(app.shows('id:danger-zone')).toBe(false)
  expect(app.shows('id:danger-off')).toBe(false)
  expect(app.shows('id:danger-uninstall')).toBe(false)
  expect(app.texts()).toContain('With DSH Anywhere 0.8.6 on the computer, update, turn it off or uninstall it on DSH Desktop’s Plugins page. From 0.8.7 on, this phone can do it too.')
  expect(writes(dsh)).toEqual([])
})

test('Shell shows seconds and kilobytes and writes DSH\'s milliseconds and bytes', async () => {
  const { app, dsh } = await computerSettings()
  await app.press('id:computer-shell')
  await app.waitFor('id:field-timeout')
  expect(app.value('id:field-timeout')).toBe('60')
  expect(app.value('id:field-maxOutput')).toBe('64')
  expect(app.texts()).toContain('KB')
  await app.clear('id:field-timeout')
  await app.type('id:field-timeout', '90')
  await app.submit('id:field-timeout')
  await app.waitUntil(() => writes(dsh).length === 1)
  expect(writes(dsh)[0]!.args).toEqual({ ns: 'bash-sandbox', ops: [{ op: 'set', path: ['timeoutMs'], value: 90000 }], expectedRevision: 1 })
})

test('a plugin\'s update and uninstall each ask twice: which, then DSH Desktop\'s confirmation', async () => {
  const { app, dsh } = await computerSettings()
  await app.press('id:computer-plugins')
  await app.press('id:plugin-dsh-experimental-voice-input-bundle-more')
  await app.waitFor('text:Update to 0.2.3')
  expect(app.texts()).toContain('Uninstall')
  await app.press('text:Update to 0.2.3')
  await app.waitFor('id:action-sheet-message')
  expect(app.texts()).toContain('The update replaces 0.2.2 with 0.2.3; the plugin may stop briefly. If the installation fails, 0.2.2 is kept or installed again.')
  await app.press('id:action-no'); await app.wait(300)
  expect(writes(dsh)).toEqual([])
  await app.press('id:plugin-dsh-experimental-voice-input-bundle-more')
  await app.press('text:Uninstall')
  await app.waitFor('text:Uninstall Voice input?')
  await app.press('id:action-yes')
  await app.waitUntil(() => writes(dsh).length === 1)
  expect(writes(dsh)).toEqual([{ method: 'pluginManager/removeBundle', args: { name: VOICE } }])
})

test('a phone that may only read sees the settings without controls and no danger zone', async () => {
  const { app, dsh } = await computerSettings({ control: false })
  await app.waitFor('id:computer-read-only')
  expect(app.shows('id:danger-zone')).toBe(false)
  await app.press('id:computer-general')
  await app.waitFor('id:field-codingView')
  expect(app.enabled('id:field-codingView')).toBe(false)
  await app.back()
  await app.press('id:computer-plugins')
  await app.waitFor('id:plugins-view-only')
  expect(app.shows('id:plugin-dsh-experimental-voice-input-bundle-more')).toBe(false)
  expect(writes(dsh)).toEqual([])
})

test('a computer that cannot be read says why and can try again', async () => {
  const { app, dsh } = await computerSettings({ down: true })
  await app.waitFor('id:computer-failed')
  dsh.up()
  await app.press('id:computer-retry')
  await app.waitFor('id:computer-general')
})

test('settings a plugin declares for itself show as a form under Other plugin settings', async () => {
  const { app, dsh } = await computerSettings()
  await app.press('id:computer-other')
  await app.waitFor('text:Max retries')
  expect(app.texts()).toContain('Auto review')
  await app.press('id:field-auto-review-enabled')
  await app.waitUntil(() => writes(dsh).length === 1)
  expect(writes(dsh)[0]!.args).toEqual({ ns: 'auto-review', ops: [{ op: 'set', path: ['enabled'], value: false }], expectedRevision: 1 })
})

export type { App }
