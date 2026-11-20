import { expect, open, test } from 'nsh/test'

test('voice input stops into current draft, never sends; cancel leaves draft unchanged', async () => {
  const app = await open('./fixtures/voice.tsx')
  await app.press('id:voice-start'); await app.waitFor('id:voice-stop')
  await app.press('id:voice-stop'); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft Synthetic transcript')).toBe(true)
  await app.press('id:voice-start'); await app.waitFor('id:voice-cancel')
  await app.press('id:voice-cancel'); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft Synthetic transcript')).toBe(true)
})

test('voice disabled blocks capture and permission denial is visible without changing draft', async () => {
  const app = await open('./fixtures/voice.tsx')
  await app.press('id:voice-disable')
  let refused = false
  try { await app.press('id:voice-start') } catch { refused = true }
  expect(refused).toBe(true)
  expect(app.texts().includes('Stop and transcribe')).toBe(false)
  await app.press('id:voice-disable'); await app.press('id:voice-denied'); await app.press('id:voice-start')
  await app.waitFor('id:voice-start')
  expect(app.texts().some(t => t.includes('Microphone access was denied'))).toBe(true)
  expect(app.texts().includes('Existing draft')).toBe(true)
})

test('voice leaving foreground or disabling composer cancels without draft insertion', async () => {
  const app = await open('./fixtures/voice.tsx', { host: {} })
  await app.press('id:voice-start'); await app.waitFor('id:voice-stop')
  await app.host.send('app.state', { active: false }); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft')).toBe(true)
  await app.host.send('app.state', { active: true })
  await app.press('id:voice-start'); await app.waitFor('id:voice-stop')
  await app.press('id:voice-disable'); await app.waitFor('id:voice-start')
  expect(app.texts().includes('Existing draft')).toBe(true)
})
