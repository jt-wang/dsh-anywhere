// The header's buttons, on a linked phone while it connects, cannot reach its computer and is connected
// (header-fixture.tsx): a press on each opens what it names, on the chats page and, connected, in a chat. A required check before every release: headless in
// `nsh test`, and with each platform's own taps by `nsh test --target ios` and `--target android`
// (tools/header-check.sh), where the same steps leave a marker for the probe that measures the header on screen.
import { expect, open, test, type App } from 'nsh/test'

const PROBE = 'build/header-probe'
const states = [
  ['connecting', 'Connecting to your computer…'],
  ['offline', 'No answer from your computer'],
  ['online', 'Connected'],
] as const

// On a device the screenshot is the marker the probe waits for, and the screen holds still while it measures; a
// headless run, which cannot draw, goes on at once.
let headless = false
async function mark(app: App, name: string, holdMs = 6_000) {
  if (headless) return
  try { await app.screenshot(`${PROBE}/${name}.png`) } catch (e) {
    if (!String(e).includes('needs a real platform')) throw e
    headless = true
    return
  }
  await app.wait(holdMs)
}

async function linked(connection: string, scheme: 'light' | 'dark') {
  const app = await open('../header-fixture.tsx', { host: { params: { connection } }, colorScheme: scheme })
  await app.waitFor('id:more', { timeout: 90_000 })
  return app
}

const bar = (app: App) => app.texts().find((t) => states.some(([, line]) => t.startsWith(line)))

for (const scheme of ['light', 'dark'] as const) {
  for (const [connection, line] of states) {
    test(`${scheme}, ${connection}: the chats header's new chat and ⋯ open what they name`, async () => {
      const app = await linked(connection, scheme)
      await app.waitUntil(() => bar(app)?.startsWith(line) ?? false, { timeout: 30_000 })
      await mark(app, `chats-${connection}-${scheme}`, 25_000)
      await app.press('id:new-chat')
      await app.waitFor('id:quick-chat', { timeout: 20_000 })
      await mark(app, `chats-new-${connection}-${scheme}`)
      await app.back()
      await app.waitFor('id:quick-chat', { state: 'gone', timeout: 20_000 })
      await app.press('id:more')
      await app.waitFor('id:header-menu', { timeout: 20_000 })
      expect(app.shows('id:menu-settings')).toBe(true)
      await mark(app, `chats-menu-${connection}-${scheme}`)
      if (connection !== 'online') return
      // A chat's header: its connection dot, activity and ⋯ (only a linked computer that answers lists chats).
      await app.back()
      await app.waitFor('id:header-menu', { state: 'gone', timeout: 20_000 })
      await app.press('text:First chat')
      await app.waitFor('id:chat-more', { timeout: 20_000 })
      await mark(app, `chat-${connection}-${scheme}`)
      await app.press('id:chat-more')
      await app.waitFor('id:header-menu', { timeout: 20_000 })
      await mark(app, `chat-menu-${connection}-${scheme}`)
    }, 300_000)
  }
}
