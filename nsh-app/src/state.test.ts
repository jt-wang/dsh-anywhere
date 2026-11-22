import { expect, test } from 'nsh/test'
import { connection, heard, interfaceRequest, network, news, reachState, routeWords, started, turnErrors, waitMs } from './state.ts'

test('TailPocket route kinds distinguish DERP and private relays without inventing a city or showing empty parentheses', () => {
  expect(routeWords({ kind: 'derp' })).toBe('Through a Tailcat relay')
  expect(routeWords({ kind: 'derp', derpCode: ' ', derpHost: '' })).toBe('Through a Tailcat relay')
  // A relay's data-centre code (tok), host or number means nothing to a person: it is not shown.
  expect(routeWords({ kind: 'derp', derpCode: 'tok', derpHost: 'region.example.com', derpRegion: 1 })).toBe('Through a Tailcat relay')
  expect(routeWords({ kind: 'derp', derpRegion: 123 })).toBe('Through a Tailcat relay')
  expect(routeWords({ kind: 'relay', relayHost: 'relay.example.com', derpCode: 'tok' })).toBe('Through your relay server (relay.example.com)')
  expect(routeWords({ kind: 'relay', relayHost: '' })).toBe('Through your relay server')
  expect(routeWords({ kind: 'direct' })).toBe('Direct to your computer (no relay)')
  expect(routeWords({ kind: 'lan' })).toBe('Direct on the same Wi-Fi')
  expect(routeWords({ kind: 'unknown' })).toBe('')
  expect(routeWords(undefined)).toBe('')
})

test('opening a generated interface asks the shell for that call\'s package and the root key, with the device key', () => {
  expect(interfaceRequest({ origin: 'http://127.0.0.1:19446', key: 'k' }, 'call/7 x', 'Tip')).toEqual({
    url: 'http://127.0.0.1:19446/ui/package?call=call%2F7%20x', rootUrl: 'http://127.0.0.1:19446/ui/root.pub', auth: 'k', title: 'Tip',
  })
})

test('without a network on the phone the computer is out of reach, whatever the socket last said', () => {
  expect(reachState(false, 'online')).toBe('offline')
  expect(reachState(false, 'connecting')).toBe('offline')
  expect(reachState(true, 'connecting')).toBe('connecting')
  expect(reachState(true, 'online')).toBe('online')
})

test('the shown connection follows the phone\'s network', () => {
  network.set(false)
  expect(connection()).toBe('offline')
  network.set(true)
  expect(connection()).toBe('connecting')
})

test('DSH’s news on $events: a chat starting or stopping, a turn’s error; other frames are not news', () => {
  const at = news()
  heard({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
  expect(news()).toBe(at + 1)
  expect(started.has('s1')).toBe(false) // a stop with no start before it says nothing
  heard({ type: 'emit', event: 'api-session/error', args: ['s1', 'The model provider refused the request'] })
  expect(turnErrors.get('s1')).toBe('The model provider refused the request')
  expect(news()).toBe(at + 2)
  heard({ type: 'emit', event: 'api-session/activity', args: ['s1', 5] })
  heard({ type: 'waterfall', event: 'approval/request' })
  expect(news()).toBe(at + 2)
  heard({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
  expect(started.get('s1')).toBe('running') // the notifier's next look takes it
  heard({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
  expect(started.get('s1')).toBe('finished')
})

// TailPocket gives up on a dial after max(20 s, routes × 10 s) (link.state dialMs): the app must not give up first.
test('a socket or a call waits longer than TailPocket\'s dial, however many routes the link has', () => {
  for (const dial of [20_000, 30_000, 60_000]) expect(waitMs(dial)).toBeGreaterThan(dial)
  expect(waitMs(undefined)).toBeGreaterThan(20_000)
  expect(waitMs(5_000)).toBeGreaterThan(20_000)
})
