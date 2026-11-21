// Everything the composer opens while the person is typing: the keyboard goes away first, so what opens is never behind
// it or on top of it (the iPhone, 2026-11-21: the voice sheet and the controls sheet stayed under the keyboard).
// "The keyboard is away" is read as a person would notice it: a key typed after the sheet opens no longer lands in the
// draft. The real app on its sample chats (Try it), so no computer is needed.
import { expect, open, test } from 'nsh/test'

const typing = async () => {
  const app = await open('./fixtures/tryit/App.tsx', { host: { handlers: { 'link.state': { paired: false } } }, network: {} })
  await app.waitFor('id:try-it')
  await app.press('id:try-it')
  await app.press('text:Fix the failing login test')
  await app.waitFor('id:composer')
  await app.type('id:composer', 'Draft')
  // While the composer has the focus, a key goes into the draft.
  await app.keyboard.press('a')
  expect(app.value('id:composer')).toBe('Drafta')
  return app
}

for (const [entry, opens] of [
  ['attach', 'action-sheet'],
  ['controls-open', 'controls'],
  ['model', 'model-sheet'],
  ['voice-start', 'voice-sheet-sample'],
  ['connection-dot', 'reach-sheet'],
  ['chat-more', 'header-menu'],
] as const) {
  test(`with the keyboard up, ${entry} puts it away before ${opens} opens`, async () => {
    const app = await typing()
    await app.press(`id:${entry}`)
    await app.waitFor(`id:${opens}`)
    await app.keyboard.press('b')
    expect(app.value('id:composer')).toBe('Drafta')
  })
}

test('with the keyboard up, the activity button puts it away before its panel opens', async () => {
  const app = await open('./fixtures/activity.tsx')
  await app.type('id:field', 'Draft')
  await app.press('id:activity')
  await app.waitFor('id:activity-panel')
  await app.keyboard.press('b')
  expect(app.value('id:field')).toBe('Draft')
})
