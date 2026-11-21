// How the phone reaches the computer has one source: the shell's path watch pushes each change as the link.path event,
// and the chats page and Settings both show it from there. Seen on an iPhone (2026-11-21): the chats page said
// "Through a Tailcat relay" while Settings said "Direct", each from its own link.path asked on its own timer.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const ok = (value: unknown) => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } })
const RELAY = 'Through a Tailcat relay', DIRECT = 'Direct to your computer (no relay)', LAN = 'Direct on the same Wi-Fi'

for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: a path change reaches the chats page and Settings together, without asking the shell again`, async () => {
    const app = await open('./fixtures/pathsync/App.tsx', {
      platform, locale: 'en-US',
      host: { handlers: {
        'link.state': { paired: true, origin: ORIGIN, token: 'synthetic-device-token' }, 'network.state': { online: true }, 'app.state': { active: true },
        'app.info': { version: '0.1.15', build: '16' }, 'notify.permission': { granted: true }, 'notify.watch': null, 'notify.clear': null,
        // The shell's last path as the app starts: Tailcat has not found the direct path yet.
        'link.path': { route: 'relay', kind: 'derp', derpCode: 'tok' },
      } },
      network: {
        [`POST ${ORIGIN}/api/session/list`]: () => ok({ items: [] }),
        [`GET http://127.0.0.1:40001/v1/capabilities`]: () => ({ body: { hostName: 'DSH Anywhere companion', computerName: 'Studio', hostVersion: '0.8.4', upstreamVersion: '0.2.2' } }),
      },
    })
    await app.waitFor('id:home >> text:Connected · ' + RELAY)
    await app.waitFor('id:settings >> text:' + RELAY)
    const asked = app.host.calls().filter((c) => c.name === 'link.path').length

    for (const [path, label] of [[{ route: 'direct', kind: 'direct' }, DIRECT], [{ route: 'lan', kind: 'lan' }, LAN], [{ route: 'relay', kind: 'derp', derpCode: 'tok' }, RELAY]] as const) {
      await app.host.send('link.path', path)
      // No wait: the event's own render already shows it on both.
      expect(app.shows(`id:home >> text:Connected · ${label}`)).toBe(true)
      expect(app.shows(`id:settings >> text:${label}`)).toBe(true)
    }
    // Nothing asked the shell again: the pages follow the event, not a timer.
    expect(app.host.calls().filter((c) => c.name === 'link.path').length).toBe(asked)
  })
}
