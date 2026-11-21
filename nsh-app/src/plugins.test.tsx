// Settings › Plugins on your computer (src/plugins.tsx): DSH Desktop's plugins, changed from the phone.
import { expect, open, test, type App } from 'nsh/test'

const start = (params: Record<string, unknown> = {}, locale = 'en-US') => open('./fixtures/plugins/App.tsx', { locale, host: { params, handlers: { 'fixture.rpc': null } } })
const writes = (app: App) => app.host.posts().filter(p => p.name === 'fixture.rpc').map(p => (p.data as { name: string }).name).filter(n => n !== 'pluginManager/listBundles')

test('lists the plugins in DSH Desktop\'s groups, by their own names, with what each is', async () => {
  const app = await start()
  await app.waitFor('id:plugin-dsh-experimental-voice-input-bundle')
  expect(app.texts()).toContain('Extensions')
  expect(app.texts()).toContain('Voice input')
  expect(app.texts()).toContain('Not installed · 0.2.2')
  expect(app.texts()).toContain('More plugins')
  expect(app.texts()).toContain('Computer use')
  expect(app.texts()).toContain('Transcribe recordings locally with SenseVoice; first use requires installing dependencies.')
})

test('no plugin shows its package id, also in a language DSH\'s bundles lack or when DSH has no metadata for one', async () => {
  for (const [locale, voice, cua] of [['en-US', 'Voice input', 'Computer use'], ['ko-KR', '음성 입력', '컴퓨터 사용'], ['zh-Hant-TW', '語音輸入', 'Computer Use']]) {
    const app = await start({}, locale)
    await app.waitFor('id:plugin-dsh-cua-bundle')
    expect(app.texts()).toContain(voice)
    expect(app.texts()).toContain(cua)
    expect(app.texts().filter(t => /dsh-|@deepseek-ai/.test(t))).toEqual([])
  }
})

test('turning a shipped plugin on changes the computer at once and reads the answer back', async () => {
  const app = await start()
  await app.press('id:plugin-dsh-experimental-voice-input-bundle-switch')
  await app.waitUntil(() => writes(app).length === 1)
  expect(writes(app)).toEqual(['pluginManager/setBundleEnabled'])
  expect(app.shows('id:action-sheet')).toBe(false)
})

test('installing a plugin and turning one off ask first; Cancel changes nothing', async () => {
  const app = await start()
  await app.press('id:plugin-dsh-experimental-auto-review-switch'); await app.waitFor('id:action-yes')
  expect(app.texts()).toContain('Install Auto authorization review?')
  expect(app.texts()).toContain('Auto authorization review 0.2.2 downloads to DSH Desktop on your computer and turns on.')
  expect(app.texts()).toContain('Install Auto authorization review')
  await app.press('id:action-no'); await app.wait(300)
  expect(writes(app)).toEqual([])
  await app.press('id:plugin-dsh-experimental-auto-review-switch'); await app.press('id:action-yes')
  await app.waitUntil(() => writes(app).length === 1)
  expect(writes(app)).toEqual(['pluginManager/installBundle'])
  await app.press('id:plugin-dsh-cua-bundle-switch'); await app.waitFor('id:action-yes')
  expect(app.texts()).toContain('Turn off Computer use?')
  expect(app.texts()).toContain('Turn off Computer use')
  await app.press('id:action-yes')
  await app.waitUntil(() => writes(app).length === 2)
})

test('a change that needs a restart, or that fails, says so on its row', async () => {
  const restart = await start({ answer: 'restart' })
  await restart.press('id:plugin-dsh-experimental-voice-input-bundle-switch')
  await restart.waitFor('text:Done. Restart DSH Desktop on your computer to finish.')
  const failed = await start({ answer: 'fail' })
  await failed.press('id:plugin-dsh-experimental-voice-input-bundle-switch')
  await failed.waitFor('text:This plugin doesn’t work with the DSH Desktop version on your computer. Update DSH Desktop, then try again.')
  expect(failed.texts().filter(t => t.includes('incompatible-version'))).toEqual([])
  const unknown = await start({ answer: 'fail', code: 'operation-error' })
  await unknown.press('id:plugin-dsh-experimental-voice-input-bundle-switch')
  await unknown.waitFor('text:Your computer couldn’t make the change. Try again, or open Plugins in DSH Desktop to see why.')
  expect(unknown.texts().filter(t => t.includes('operation-error'))).toEqual([])
})

test('a phone that only reads, an old DSH and an unreachable computer each say why; the last can try again', async () => {
  const readOnly = await start({ mode: 'forbidden' })
  await readOnly.waitFor('id:plugins-readOnly')
  expect(readOnly.texts().some(t => t.startsWith('This phone can only read chats.'))).toBe(true)
  const old = await start({ mode: 'old' })
  await old.waitFor('id:plugins-unsupported')
  const down = await start({ mode: 'down' })
  await down.waitFor('id:plugins-failed')
  await down.host.send('fixture.mode', {})
  await down.press('id:plugins-retry')
  await down.waitFor('id:plugin-dsh-experimental-voice-input-bundle')
})
