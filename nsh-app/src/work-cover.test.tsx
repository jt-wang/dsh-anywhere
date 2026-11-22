import { expect, open, test } from 'nsh/test'

test('nested local sheets keep the visible work line static until the last covering surface closes', async () => {
  const app = await open('./fixtures/work-cover.tsx')
  await app.waitFor('id:current-working-text')
  await app.press('id:open-sheet')
  await app.waitFor('id:open-nested')
  expect(app.count('id:current-working-text')).toBe(0)
  expect(app.texts()).toContain('Analyzing the reference request')
  await app.press('id:open-nested')
  await app.press('id:close-parent')
  expect(app.count('id:current-working-text')).toBe(0)
  await app.press('id:close-nested')
  await app.waitFor('id:current-working-text')
})

test('a header popover pauses the same line and dismissal restores its eligibility', async () => {
  const app = await open('./fixtures/work-cover.tsx')
  await app.waitFor('id:current-working-text')
  await app.press('id:open-menu')
  await app.waitFor('id:menu-done')
  expect(app.count('id:current-working-text')).toBe(0)
  await app.press('id:menu-done')
  await app.waitFor('id:current-working-text')
})

test('unmounting an open surface releases its work cover', async () => {
  const app = await open('./fixtures/work-cover.tsx')
  await app.waitFor('id:current-working-text')
  await app.press('id:open-sheet')
  await app.waitFor('id:unmount-sheet')
  expect(app.count('id:current-working-text')).toBe(0)
  await app.press('id:unmount-sheet')
  await app.waitFor('id:current-working-text')
})
