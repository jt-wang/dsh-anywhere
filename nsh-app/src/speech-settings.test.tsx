import { expect, open, test } from 'nsh/test'

test('speech settings selects host language, prepares from selected source, and cancels with authoritative state', async () => {
  const app = await open('./fixtures/speech-settings.tsx')
  await app.waitFor('id:speech-language-local-zh')
  await app.press('id:speech-language-local-zh')
  await app.waitFor('text:✓ zh')
  await app.press('id:speech-source-local-1'); await app.press('id:speech-prepare-local')
  await app.waitFor('text:120.0 / 241.4 MB')
  expect(app.texts().some(t => t.includes('"downloadSource":"https://hf-mirror.com"'))).toBe(true)
  await app.press('id:speech-cancel-local'); await app.waitFor('id:speech-prepare-local')
  expect(app.texts().some(t => t.includes('speech/cancelPreparation'))).toBe(true)
})

test('lost speech acknowledgement confirms configured language by catalog, but does not silently repeat preparation', async () => {
  const app = await open('./fixtures/speech-settings.tsx')
  await app.waitFor('id:speech-language-local-en'); await app.press('id:speech-lost')
  await app.press('id:speech-language-local-en'); await app.waitFor('text:✓ en')
  expect(app.texts().includes('The computer has not confirmed this value. Refresh before trying again.')).toBe(false)
  await app.press('id:speech-prepare-local'); await app.waitFor('id:speech-settings-error')
  expect(app.texts().includes('The computer has not confirmed this value. Refresh before trying again.')).toBe(true)
  expect(app.texts().filter(t => t.includes('speech/prepare')).join('').split('speech/prepare').length).toBe(2)
})
