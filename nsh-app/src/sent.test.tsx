import { expect, open, test } from 'nsh/test'

// Was it sent, did the computer get it, is it working?
test('a sent message says where it is, a failed one says why, and a working agent shows it is on it', async () => {
  const app = await open('./fixtures/sent.tsx', { locale: 'en-US' })
  await app.waitFor('text:Delivered')
  const texts = app.texts()
  expect(texts.includes('Sending…')).toBe(true)
  expect(texts.includes('Not sent. Tap to try again')).toBe(true)
  expect(texts.includes('Can’t reach your computer. Check that it is on and DSH is running.')).toBe(true)
  expect(texts.includes('Analyzing the request · This gives the room id')).toBe(true)
})

// A sending message with a full-size photo (3000×4000 px) in a short chat. scripts/scroll-content.mjs runs this file
// with --trace and checks that the chat's scroll content stays within this 390×844 viewport.
test('a sending photo shows in a short chat', async () => {
  const app = await open('./fixtures/sent-photo.tsx', { locale: 'en-US' })
  await app.setViewport(390, 844)
  await app.waitFor('text:see the photo')
  expect(app.shows('text:first message')).toBe(true)
})
