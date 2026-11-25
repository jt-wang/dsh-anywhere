// The header's buttons, on a linked phone while it connects, cannot reach its computer and is connected
// (header-fixture.tsx): a press on each opens what it names, on the chats page and, connected, in a chat. A required check before every release: headless in
// `nsh test`, and with each platform's own taps by `nsh test --target ios` and `--target android`
// (tools/header-check.sh), where the same steps leave a marker for the probe that measures the header on screen.
import { signal } from 'nsh'
import { expect, open, test, type App } from 'nsh/test'
import { menuButton } from './ui.tsx'

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

// `trace`: the app shows what ⋯ and its menu saw (App.tsx `menuTrace`), for the Android probe's double tap.
async function linked(connection: string, scheme: 'light' | 'dark', trace = false) {
  const app = await open('../header-fixture.tsx', { host: { params: { connection, ...(trace ? { menuTrace: true } : {}) } }, colorScheme: scheme })
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
    }, 300_000)
  }
  // A chat's header: its connection dot, activity and ⋯ (only a linked computer that answers lists chats).
  test(`${scheme}, online: a chat's header ⋯ opens its menu`, async () => {
    const app = await linked('online', scheme)
    await app.press('text:First chat')
    await app.waitFor('id:chat-more', { timeout: 20_000 })
    await mark(app, `chat-online-${scheme}`)
    await app.press('id:chat-more')
    await app.waitFor('id:header-menu', { timeout: 20_000 })
    await mark(app, `chat-menu-online-${scheme}`)
  }, 300_000)
}

// The ⋯ menu takes every press on ⋯ (WANG-121). A press on ⋯ while the menu is open closes it as the finger goes
// down; that press must not open it again as it lifts, however long the finger stays, and the next press opens it
// however soon it comes. A device's own taps come seconds apart and hold a long press into an `onPress`, so there
// the held press is the check; headless presses follow each other at once, so there the quick press is.
for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}, online: ⋯ closes its menu, a press right after opens it again, and holding ⋯ keeps it closed`, async () => {
    const app = await linked('online', scheme, true)
    const menu = () => app.shows('id:header-menu')
    await app.press('id:more')
    await app.waitFor('id:header-menu', { timeout: 20_000 })
    await app.press('id:more') // closes it, and does not open it again on lifting
    await app.waitFor('id:header-menu', { state: 'gone', timeout: 20_000 })
    await app.wait(800)
    expect(menu()).toBe(false)
    await app.press('id:more') // the next press, with no wait before it
    await app.waitFor('id:header-menu', { timeout: 5_000 })
    await mark(app, `menu-again-${scheme}`, 15_000) // the Android probe double-taps ⋯ here (tools/header-check.sh)
    await app.press('id:more')
    await app.waitFor('id:header-menu', { state: 'gone', timeout: 20_000 })
    await app.press('id:more') // straight after closing it: opens
    await app.waitFor('id:header-menu', { timeout: 5_000 })
    await app.longPress('id:more') // held on an open menu: closes it, and lifting does not open it
    await app.waitFor('id:header-menu', { state: 'gone', timeout: 20_000 })
    await app.wait(800)
    expect(menu()).toBe(false)
    await mark(app, `menu-held-${scheme}`)
    await app.press('id:more') // and after that, a press opens it
    await app.waitFor('id:header-menu', { timeout: 5_000 })
    await app.press('id:new-chat') // a press outside closes it (and does what it does); ⋯ then opens it
    await app.waitFor('id:header-menu', { state: 'gone', timeout: 20_000 })
    await app.waitFor('id:quick-chat', { timeout: 20_000 })
    await app.back()
    await app.waitFor('id:quick-chat', { state: 'gone', timeout: 20_000 })
    await app.press('id:more')
    await app.waitFor('id:header-menu', { timeout: 5_000 })
  }, 300_000)
}

// The same, event by event, in the orders the platforms deliver one finger's events (measured on boop-35, an iPhone
// 17 Pro simulator and headless, WANG-121), which headless presses alone cannot: the menu's press outside belongs to
// the finger on ⋯ only while that finger is down. A tap outside, then a separate tap on ⋯ at the very same point,
// opens the menu; a cancelled press, then an activation without a finger, toggles.
test("⋯ pairs the events of one finger, in each platform's order, and an activation without a finger toggles", () => {
  const ev = { pagePosition: { x: 375, y: 50 }, position: { x: 18, y: 18 }, modifiers: { control: false, alt: false, shift: false, platform: false }, clickCount: 1 }
  type B = ReturnType<typeof menuButton>
  // The core sends a press outside only when the menu is shown as the finger goes down (`shown`).
  const orders: Record<string, (b: B, shown: boolean) => void> = {
    android: (b, shown) => { b.props.onTouchStart(); if (shown) b.outside(); b.props.onPressDown(); b.props.onTouchEnd(); b.props.onPressUp(); b.props.onPress(ev) },
    ios: (b, shown) => { b.props.onPressDown(); b.props.onTouchStart(); if (shown) b.outside(); b.props.onTouchEnd(); b.props.onPressUp(); b.props.onPress(ev) },
    headless: (b, shown) => { b.props.onTouchStart(); b.props.onPressDown(); b.props.onPressUp(); b.props.onPress(ev); b.props.onTouchEnd(); if (shown) b.outside() },
  }
  for (const [name, order] of Object.entries(orders)) {
    const open = signal(false), b = menuButton(open)
    const tap = (b: B) => order(b, open())
    const is = (v: boolean, step: string) => { if (open() !== v) throw new Error(`${name}: ${step}: menu ${open() ? 'open' : 'closed'}`) }
    b.props.onPress() // opened without a finger
    is(true, 'activation without a finger opens')
    tap(b) // same point, same finger: closes and does not reopen as it lifts
    is(false, 'a tap on ⋯ closes')
    tap(b) // the next finger opens it at once
    is(true, 'the next tap opens')
    b.outside() // a tap outside, at the point ⋯ is about to be (no finger on ⋯) ...
    is(false, 'a tap outside closes')
    tap(b) // ... then a separate tap on ⋯ at that same point opens it
    is(true, 'a separate tap after a tap outside opens')
    b.props.onTouchStart(); b.props.onPressDown(); b.outside(); b.props.onTouchCancel() // held and cancelled: no press
    is(false, 'a cancelled press closes')
    b.props.onPress() // an activation without a finger is not that press
    is(true, 'activation after a cancel opens')
    b.props.onPress()
    is(false, 'activation closes')
    b.props.onPress()
    is(true, 'activation opens')
    b.props.onTouchStart(); b.props.onPressDown(); b.outside(); b.props.onTouchCancel() // closed by a press cancelled ...
    is(false, 'a cancelled press closes it again')
    tap(b) // ... and a finger after it is a new one
    is(true, 'a tap after a cancelled press opens')
    tap(b)
    is(false, 'and closes')
    tap(b)
    is(true, 'a tap after all that opens')
  }
})
