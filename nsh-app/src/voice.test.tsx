import { expect, open, test, type App } from 'nsh/test'

// Every state of the voice flow, on the real component over a synthetic computer and microphone (fixtures/voice).
const fixture = './fixtures/voice/App.tsx'
const handlers = { 'fixture.call': null, 'fixture.rpc': null }
const start = (params: Record<string, unknown> = {}) => open(fixture, { host: { params, handlers } })
const called = (app: App) => app.host.posts().filter(p => p.name === 'fixture.call').map(p => (p.data as { name: string }).name)
const asked = (app: App) => app.host.posts().filter(p => p.name === 'fixture.rpc').map(p => (p.data as { name: string }).name)
const shows = (app: App, text: string) => app.texts().some(t => t.includes(text))

test('ready: the mic records with a timer and level, Done transcribes into the draft and nothing is sent', async () => {
  const app = await start()
  await app.press('id:voice-start'); await app.waitFor('id:voice-timer')
  expect(app.shows('id:voice-level')).toBe(true)
  expect(app.texts().some(t => /^0:0\d \/ 1:00$/.test(t))).toBe(true)
  await app.press('id:voice-stop'); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft Synthetic transcript')).toBe(true)
  expect(asked(app)).toEqual(['speech/catalog', 'speech/transcribe'])
  expect(called(app)).toEqual(['voice.permission', 'voice.record', 'voice.stop'])
})

test('transcribing: Done stays in place, dimmed and inert, under "Transcribing on your computer…"', async () => {
  const app = await start({ transcribe: 'hang' })
  await app.press('id:voice-start'); await app.waitFor('id:voice-stop')
  await app.press('id:voice-stop'); await app.waitFor('id:voice-busy')
  expect(shows(app, 'Transcribing on your computer…')).toBe(true)
  expect(app.shows('id:voice-stop')).toBe(false)
  expect(app.shows('id:voice-cancel')).toBe(true)
})

test('cancel while recording releases the microphone and leaves the draft unchanged', async () => {
  const app = await start()
  await app.press('id:voice-start'); await app.waitFor('id:voice-timer')
  await app.press('id:voice-cancel'); await app.waitFor('id:voice-start')
  expect(called(app)).toEqual(['voice.permission', 'voice.record', 'voice.cancel'])
  expect(app.texts().includes('Existing draft')).toBe(true)
  expect(asked(app)).toEqual(['speech/catalog'])
})

test('no speech model: the sheet explains the download before any microphone use, and follows it to Record', async () => {
  const app = await start({ phase: 'unprepared' })
  await app.press('id:voice-start'); await app.waitFor('id:voice-sheet-download')
  expect(shows(app, 'Download the speech model on your computer')).toBe(true)
  expect(shows(app, 'Needs about 1 GB free on the computer · 1–10 minutes')).toBe(true)
  expect(called(app)).toEqual([])
  await app.press('id:voice-sheet-download'); await app.waitFor('id:voice-sheet-preparing')
  expect(asked(app).includes('speech/prepare')).toBe(true)
  await app.waitFor('text:Downloading the speech model… 96 / 240 MB')
  await app.host.send('fixture.set', { phase: 'standby' }); await app.host.send('fixture.follow', {})
  await app.waitFor('id:voice-sheet-ready')
  await app.press('id:voice-sheet-record'); await app.waitFor('id:voice-timer')
  await app.press('id:voice-cancel')
})

test('voice input off on the computer: one tap turns it on there and goes straight on to the model download', async () => {
  const app = await start({ catalog: 'missing' })
  await app.press('id:voice-start'); await app.waitFor('id:voice-sheet-missing')
  expect(shows(app, 'Turn it on from here')).toBe(true)
  await app.press('id:voice-sheet-turn-on')
  await app.waitFor('id:voice-sheet-download')
  expect(asked(app)).toEqual(['speech/catalog', 'pluginManager/listBundles', 'pluginManager/setBundleEnabled', 'speech/catalog'])
  // Nothing touched the microphone before the computer could transcribe.
  expect(called(app).filter(n => n === 'voice.record')).toEqual([])
})

test('turning voice input on: while the computer works, then each way it can end says what to do', async () => {
  const busy = await start({ catalog: 'missing', enable: 'hang' })
  await busy.press('id:voice-start'); await busy.press('id:voice-sheet-turn-on'); await busy.waitFor('id:voice-sheet-enabling')
  expect(shows(busy, 'Turning on voice input on your computer…')).toBe(true)
  expect(busy.shows('id:voice-sheet-turn-on')).toBe(false)

  const restart = await start({ catalog: 'missing', enable: 'restart' })
  await restart.press('id:voice-start'); await restart.press('id:voice-sheet-turn-on')
  await restart.waitFor('text:Voice input is on. Restart DSH Desktop on your computer to finish, then check again.')
  await restart.press('id:voice-sheet-check'); await restart.waitFor('id:voice-sheet-download')

  const failed = await start({ catalog: 'missing', enable: 'fail' })
  await failed.press('id:voice-start'); await failed.press('id:voice-sheet-turn-on')
  await failed.waitFor('text:This plugin doesn’t work with the DSH Desktop version on your computer. Update DSH Desktop, then try again.')
  expect(failed.texts().filter(t => t.includes('incompatible-version'))).toEqual([])
  expect(failed.shows('id:voice-sheet-turn-on')).toBe(true)

  const old = await start({ catalog: 'missing', bundle: 'none' })
  await old.press('id:voice-start'); await old.press('id:voice-sheet-turn-on')
  await old.waitFor('text:This DSH has no Voice input plugin. Update DSH Desktop on your computer to 0.2.2 or later, then check again.')
  expect(called(old).filter(n => n === 'voice.record')).toEqual([])
})

test('no computer: offline and the sample explain themselves instead of recording', async () => {
  const offline = await start({ catalog: 'offline' })
  await offline.press('id:voice-start'); await offline.waitFor('id:voice-sheet-offline')
  expect(called(offline)).toEqual([])
  const sample = await start({ blocked: 'sample' })
  await sample.press('id:voice-start'); await sample.waitFor('id:voice-sheet-sample')
  expect(shows(sample, 'link yours to use voice input')).toBe(true)
  expect(asked(sample)).toEqual([]); expect(called(sample)).toEqual([])
  await sample.press('id:voice-sheet-ok'); await sample.waitFor('id:voice-start')
})

test('first use: the phone explains the microphone before the system asks, and Not now never asks', async () => {
  const app = await start({ permission: 'undetermined' })
  await app.press('id:voice-start'); await app.waitFor('id:voice-sheet-primer')
  expect(called(app)).toEqual(['voice.permission'])
  await app.press('id:voice-sheet-later')
  expect(called(app)).toEqual(['voice.permission'])
  await app.press('id:voice-start'); await app.waitFor('id:voice-sheet-primer')
  await app.press('id:voice-sheet-continue'); await app.waitFor('id:voice-timer')
  expect(called(app).at(-1)).toBe('voice.record')
  await app.press('id:voice-cancel')
})

test('microphone refused: the sheet shows how to turn it on and opens Settings, never recording', async () => {
  const app = await start({ permission: 'denied' })
  await app.press('id:voice-start'); await app.waitFor('id:voice-sheet-denied')
  await app.press('id:voice-sheet-settings')
  expect(called(app)).toEqual(['voice.permission', 'voice.settings'])
  // Refused at the system's own prompt: the same explanation, not a failure.
  const refused = await start({ permission: 'refuse' })
  await refused.press('id:voice-start'); await refused.waitFor('id:voice-sheet-denied')
  expect(refused.texts().includes('Existing draft')).toBe(true)
})

test('each failure says its own reason and next step, keeps the draft, and can be dismissed', async () => {
  const busy = await start({ record: 'voice/microphone' })
  await busy.press('id:voice-start'); await busy.waitFor('id:voice-error')
  expect(shows(busy, 'Another app, a call or a screen recording may be using it')).toBe(true)
  await busy.press('id:voice-error-dismiss'); expect(busy.shows('id:voice-error')).toBe(false)
  const interrupted = await start({ record: 'voice/interrupted' })
  await interrupted.press('id:voice-start'); await interrupted.waitFor('text:Recording stopped: a call or another app took the microphone. Nothing was sent. Record again when it’s free.')
  const recognizer = await start({ transcribe: 'speech/transcription-failed' })
  await recognizer.press('id:voice-start'); await recognizer.waitFor('id:voice-stop'); await recognizer.press('id:voice-stop')
  await recognizer.waitFor('text:Your computer couldn’t transcribe this recording. Nothing was sent. Check Voice input in DSH Desktop, then record again.')
  const lost = await start({ transcribe: 'network' })
  await lost.press('id:voice-start'); await lost.waitFor('id:voice-stop'); await lost.press('id:voice-stop')
  await lost.waitFor('id:voice-error')
  expect(shows(lost, 'Your computer didn’t answer')).toBe(true)
  for (const app of [busy, interrupted, recognizer, lost]) expect(app.texts().includes('Existing draft')).toBe(true)
})

test('the failure copy follows the app language', async () => {
  const app = await open(fixture, { locale: 'zh-CN', host: { params: { record: 'voice/microphone' } } })
  await app.press('id:voice-start'); await app.waitFor('id:voice-error')
  expect(shows(app, '麦克风无法启动')).toBe(true)
})

test('leaving the foreground or disabling the composer cancels without draft insertion', async () => {
  const app = await open(fixture, { host: {} })
  await app.press('id:voice-start'); await app.waitFor('id:voice-stop')
  await app.host.send('app.state', { active: false }); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft')).toBe(true)
  await app.host.send('app.state', { active: true })
  await app.press('id:voice-start'); await app.waitFor('id:voice-stop')
  await app.press('id:voice-disable'); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft')).toBe(true)
  let refused = false
  try { await app.press('id:voice-start') } catch { refused = true }
  expect(refused).toBe(true)
})

// NSH rejects a host.call after 30 s unless the call says otherwise (nsh/host); voice.record answers only when the take
// ends, so a longer take failed as "Voice input failed" and left the phone recording. Real time: a step waits for the
// native answer, so a manual clock cannot move past it.
test('a take that ends after 30 seconds still reaches the draft through the native host call', async () => {
  const app = await open(fixture, { host: { params: { native: true }, handlers: {
    'voice.permission': { state: 'granted' },
    'voice.record': () => new Promise(resolve => setTimeout(() => resolve({ audioBase64: 'AA==' }), 30_500)),
  } } })
  await app.press('id:voice-start')
  await app.waitFor('text:Existing draft Synthetic transcript')
  expect(app.shows('id:voice-error')).toBe(false)
}, 45_000)
