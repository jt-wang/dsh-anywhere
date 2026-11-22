// What the bar under each header says about reaching the computer (src/status.tsx).
import { expect, open, test } from 'nsh/test'

const fixture = './fixtures/connection/App.tsx'
const start = () => open(fixture, { clock: {} })
const bar = (app: Awaited<ReturnType<typeof start>>) => app.texts().find((t) => t.startsWith('Can’t reach') || t.startsWith('Connecting') || t.startsWith('No network')) ?? null
const late = async (app: Awaited<ReturnType<typeof start>>, step: string) => { await app.clock.runFor(100); await app.press(`id:${step}`); await app.clock.runFor(3_100) }

for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: the bar and connection panel distinguish route kinds; a Tailcat relay is never named by its code`, async () => {
    const app = await open(fixture, { platform, clock: {} })
    await app.press('id:chats')
    for (const [step, label] of [
      ['derp-code', 'Through a Tailcat relay'],
      ['derp-host', 'Through a Tailcat relay'],
      ['derp-id', 'Through a Tailcat relay'],
      ['derp-unnamed', 'Through a Tailcat relay'],
      ['relay-host', 'Through your relay server (relay.example.com)'],
      ['relay-unnamed', 'Through your relay server'],
      ['direct', 'Direct to your computer (no relay)'],
      ['lan', 'Direct on the same Wi-Fi'],
    ]) {
      await app.press(`id:${step}`); await app.clock.runFor(100)
      expect(app.texts()).toContain(`Connected · ${label}`)
      await app.press('id:connection'); await app.clock.runFor(400)
      expect(app.texts()).toContain(label)
      expect(app.texts()).toContain('Relays only forward encrypted data. They cannot read its contents.')
      expect(app.texts().some(t => t.includes('(—)') || t.includes('()'))).toBe(false)
      await app.back(); await app.clock.runFor(400)
    }
  })
}

// Seen on the Android emulator: back from the background, the connection of before had died and the first new try
// failed too, and the red "Can’t reach your computer" showed for the second it took to get through.
test('a connection lost and found again within a few seconds says nothing', async () => {
  const app = await start()
  await app.clock.runFor(100)
  await app.press('id:offline'); await app.clock.runFor(1_000)
  expect(bar(app)).toBe(null)
  await app.press('id:connecting'); await app.clock.runFor(1_000)
  await app.press('id:online'); await app.clock.runFor(5_000)
  expect(bar(app)).toBe(null)
})

// Seen on the Android emulator: the connection failed while the app was away, so the red bar was already there when it
// came back, and stayed until the next retry, up to 15 seconds later.
test('back on screen, a connection that failed while away gets a few seconds again before the bar says so', async () => {
  const app = await start()
  await app.clock.runFor(100)
  await app.press('id:away'); await app.press('id:offline'); await app.clock.runFor(60_000)
  await app.press('id:back'); await app.clock.runFor(2_000)
  expect(bar(app)).toBe(null)
  await app.clock.runFor(1_100)
  expect(bar(app)).toBe('Can’t reach your computer. Retrying…')
})

test('a computer still out of reach after a few seconds is said, with a way to try again', async () => {
  const app = await start()
  await app.clock.runFor(100)
  await app.press('id:offline'); await app.clock.runFor(3_100)
  expect(bar(app)).toBe('Can’t reach your computer. Retrying…')
  expect(app.texts()).toContain('Try again')
  await app.press('id:online'); await app.clock.runFor(100)
  expect(bar(app)).toBe(null)
})

test('trying for a few seconds says it is still trying', async () => {
  const app = await start()
  await app.clock.runFor(100)
  await app.press('id:connecting'); await app.clock.runFor(3_100)
  expect(bar(app)).toBe('Connecting to your computer…')
})

test('a phone without a network says so at once', async () => {
  const app = await start()
  await app.clock.runFor(100)
  await app.press('id:no-network'); await app.clock.runFor(100)
  expect(bar(app)).toBe('No network on this phone')
})

// Not having to open Settings to see the connection, whether it retries, and why it fails.
for (const [step, title, why] of [
  ['blocked', 'This network can’t reach the relay', 'Try another Wi-Fi or mobile data'],
  ['computer', 'Your computer isn’t answering', 'Check that it is on, awake, and DSH is running'],
  ['companion', 'DSH on your computer isn’t answering', 'Open DSH on your computer again'],
] as const) {
  test(`${step}: the bar says why and when it tries again, and the sheet says what to do`, async () => {
    const app = await start()
    await late(app, step)
    await app.waitFor(`text:${title}`)
    await app.press('id:next-try')
    await app.clock.runFor(100)
    expect(app.texts().some((t) => /^Retrying in \d+ s$/.test(t))).toBe(true)
    await app.press('id:reconnect')
    await app.waitFor('text:retried:1 scanned:0')
    await app.press('id:connection')
    await app.clock.runFor(400)
    expect(app.texts().some((t) => t.includes(why))).toBe(true)
  })
}

test('a computer that refuses this phone: no more retries, and a way to link again', async () => {
  const app = await start()
  await late(app, 'refused')
  await app.waitFor('text:This phone is no longer linked')
  expect(app.texts()).toContain('Not retrying')
  expect(app.texts()).not.toContain('Try again')
  await app.press('id:relink')
  await app.waitFor('id:pair-own')
  expect(app.texts()).toContain('Only scan the code on your own computer’s screen. This phone stays linked as it is until the new link works.')
  expect(app.texts()).toContain('retried:0 scanned:0')
  await app.press('id:reach-scan')
  await app.waitFor('text:retried:0 scanned:1')
})

test('link again cannot be cancelled while the camera or replacement pairing is pending', async () => {
  const app = await open(fixture, { platform: 'android', clock: {}, host: { handlers: {
    'link.scan': () => { throw new Error('camera unavailable') },
    'link.pair': async () => {
      expect(app.shows('id:reach-back')).toBe(false)
      await app.back()
      await app.clock.runFor(400)
      expect(app.shows('id:pair-own')).toBe(true)
      throw new Error('pairing declined')
    },
  } } })
  await app.press('id:slow-scan')
  await late(app, 'refused')
  await app.press('id:relink')
  await app.waitFor('id:reach-back')
  await app.press('id:reach-scan')
  expect(app.shows('id:reach-back')).toBe(false)
  await app.back()
  await app.clock.runFor(400)
  expect(app.shows('id:pair-own')).toBe(true)
  await app.clock.runFor(2_000)
  await app.waitFor('id:reach-link-error')
  await app.press('id:paste')
  await app.type('id:code', 'synthetic-code')
  await app.press('id:link-code')
  await app.waitFor('text:pairing declined')
  await app.press('id:reach-back')
  expect(app.shows('id:pair-own')).toBe(false)
})

test('link again allows pasting when the camera fails, without forgetting the old link', async () => {
  const app = await open(fixture, { clock: {}, host: { handlers: {
    'link.scan': () => { throw new Error('camera unavailable') },
    'link.pair': { paired: true, origin: 'http://127.0.0.1:19446', token: 'synthetic-new-token' },
    'link.forget': null,
    'link.path': {},
  } } })
  await late(app, 'no-answer')
  await app.press('id:connection')
  await app.clock.runFor(400)
  await app.press('id:reach-relink')
  await app.waitFor('id:pair-own')
  await app.press('id:reach-scan')
  await app.waitFor('id:reach-link-error')
  await app.press('id:paste')
  await app.type('id:code', ' synthetic-code ')
  await app.press('id:link-code')
  await app.clock.runFor(400)
  expect(app.shows('id:reach-sheet')).toBe(false)
  expect(app.host.calls().filter((c) => c.name === 'link.pair').map((c) => c.data)).toEqual([{ text: 'synthetic-code' }])
  expect(app.host.calls().some((c) => c.name === 'link.forget')).toBe(false)
})

test('the chats page always shows the state, how it goes included; a chat only a problem, with the dot in its header', async () => {
  const app = await start()
  await app.clock.runFor(100)
  expect(app.texts()).not.toContain('Connected')
  expect(app.shows('label:Connection: Connected')).toBe(true)
  await app.press('id:direct')
  await app.press('id:chats')
  await app.clock.runFor(100)
  expect(app.texts()).toContain('Connected · Direct to your computer (no relay)')
})

test('the chats page keeps saying connected through a short drop, then says what is wrong', async () => {
  const app = await start()
  await app.press('id:chats')
  await app.clock.runFor(100)
  await app.press('id:offline'); await app.clock.runFor(1_000)
  expect(app.texts()).toContain('Connected')
  await app.clock.runFor(2_100)
  expect(app.texts()).not.toContain('Connected')
  expect(bar(app)).toBe('Can’t reach your computer. Retrying…')
})

test('a slow connection is said while connected, also in a chat', async () => {
  const app = await start()
  await late(app, 'slow')
  await app.waitFor('text:Connection is slow')
  await app.press('id:connection')
  await app.clock.runFor(400)
  expect(app.texts()).toContain('About 2400 ms')
})

test('the dot opens the sheet, which goes through each part', async () => {
  const app = await start()
  await late(app, 'computer')
  await app.press('id:connection-dot')
  await app.clock.runFor(400)
  for (const t of ['Phone’s network', 'Relay', 'Your computer', 'Pairing']) expect(app.texts()).toContain(t)
  expect(app.texts()).toContain('Relays only forward encrypted data. They cannot read its contents.')
})

// A computer that is off and one that removed this phone look the same to the tunnel, so both ways out are offered.
test('a computer not answering can also be linked again from the sheet', async () => {
  const app = await start()
  await late(app, 'computer')
  await app.press('id:connection')
  await app.clock.runFor(400)
  await app.press('id:reach-relink')
  await app.waitFor('id:pair-own')
  await app.press('id:reach-back')
  await app.clock.runFor(400)
  expect(app.shows('id:pair-own')).toBe(false)
  expect(app.texts()).toContain('Pairing')
  expect(app.texts()).toContain('retried:0 scanned:0')
})

// A silent revocation looks like no answer. Pairing again is opt-in and never offered for a relay failure.
for (const [step, title, why, pairAgain] of [
  ['not-running', 'DSH Anywhere isn’t running on your computer, or the computer was reset', 'Open DSH on your computer. If it was reset, link again.', true],
  ['no-answer', 'No answer from your computer', 'Wake the computer or try another network.', true],
  ['relay-down', 'Your relay server can’t be reached', 'Check the relay server, or try again later.', false],
] as const) {
  test(`TailPocket's ${step}: the bar and the sheet say it, with what to do`, async () => {
    const app = await start()
    await late(app, step)
    await app.waitFor(`text:${title}`)
    expect(app.texts()).not.toContain('Can’t reach your computer')
    await app.press('id:connection')
    await app.clock.runFor(400)
    expect(app.texts().some((t) => t.includes(why))).toBe(true)
    expect(app.shows('id:reach-retry')).toBe(true)
    expect(app.shows('id:reach-relink')).toBe(pairAgain)
    // Each row follows the cause: only the part that did not answer is "Not working", and nothing past it is known.
    // With the relay down, the computer was never asked.
    const texts = app.texts()
    const row = (name: string) => texts[texts.indexOf(name) + 1]
    expect([row('Relay'), row('Your computer'), row('Pairing')])
      .toEqual(step === 'relay-down' ? ['Not working', 'Not known', 'Not known'] : ['OK', 'Not working', 'Not known'])
    expect(app.texts()).toContain('retried:0 scanned:0')
  })
}
