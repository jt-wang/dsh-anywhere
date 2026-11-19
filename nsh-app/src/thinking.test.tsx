import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
async function chat() {
  const app = await open('./fixtures/thinking/App.tsx', { locale: 'en-US', host: { handlers: { haptic: null } }, network: {
    [`POST ${ORIGIN}/api/session/modelCatalog`]: { body: { result: { ok: true, value: { groups: [] } } } },
  } })
  await app.waitFor('id:process'); await app.press('id:process')
  await app.waitFor('id:think-toggle-thought:a1')
  return app
}

test('long thinking can collapse mid-read to its own header, without losing other blocks or streamed additions', async () => {
  const app = await chat()
  await app.scroll('id:thread', 1000)
  await app.waitFor('id:think-collapse-reading')
  await app.host.send('fixture.grow', {})
  await app.waitFor('id:think-collapse-reading')
  await app.press('id:think-collapse-reading')
  await app.waitFor('id:think-toggle-thought:a1')
  expect(app.shows('id:think-collapse-thought:a1')).toBe(false)
  expect(app.shows('id:think-toggle-thought:a2')).toBe(true)
  expect(app.texts().includes('Second independent thought.')).toBe(true)
  expect(app.shows('id:think-collapse-reading')).toBe(false)
  await app.press('id:think-toggle-thought:a1')
  await app.scroll('id:thread', 10000)
  await app.waitFor('text:First thought paragraph 64.')
})

test('bottom collapse is explicit, per block, and the existing process disclosure remembers each choice', async () => {
  const app = await chat()
  await app.scroll('id:thread', 2000)
  await app.waitFor('id:think-collapse-thought:a2')
  await app.press('id:think-collapse-thought:a2')
  expect(app.shows('text:Second independent thought.')).toBe(false)
  await app.press('id:think-collapse-thought:a1')
  expect(app.shows('id:think-collapse-thought:a1')).toBe(false)
  await app.press('id:process'); await app.press('id:process')
  expect(app.shows('id:think-collapse-thought:a1')).toBe(false)
  expect(app.shows('text:Second independent thought.')).toBe(false)
  await app.press('id:think-toggle-thought:a2')
  await app.waitFor('text:Second independent thought.')
})
