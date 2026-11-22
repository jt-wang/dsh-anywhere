// Why the phone can't reach the computer, from what each part answers. The state on screen all
// the time, whether it is retrying, and why: a slow network, a pairing no longer valid, a blocked network.
import { expect, test } from 'nsh/test'
import { causeOf, failureOf, offersPairAgain, partsOf, SLOW_MS } from './reach.ts'

const offline = { connection: 'offline' as const, network: true }

test('no network on the phone comes first, whatever else is known', () => {
  expect(causeOf({ connection: 'offline', network: false, check: { relay: 'reachable', computer: 'reachable' } })).toBe('no-network')
})

test('nothing checked yet is only trying', () => {
  expect(causeOf({ connection: 'connecting', network: true })).toBe('trying')
  expect(causeOf(offline)).toBe('trying')
})

test('a relay the network does not let through is a blocked network', () => {
  expect(causeOf({ ...offline, check: { relay: 'unreachable', computer: 'unreachable' } })).toBe('blocked')
})

test('a relay that answers and a computer that does not is the computer', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'unreachable' } })).toBe('computer')
})

test('a computer that answers and refuses this phone is the pairing, also on a live connection', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'reachable', access: 'refused' } })).toBe('refused')
  expect(causeOf({ connection: 'online', network: true, check: { access: 'refused' } })).toBe('refused')
})

test('a computer that answers while the companion does not is the companion', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'reachable', access: 'failed' } })).toBe('companion')
})

test('everything answers and the socket is not back yet is still trying', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'reachable', access: 'ok' } })).toBe('trying')
})

test('online is connected, or slow from the time an answer takes', () => {
  expect(causeOf({ connection: 'online', network: true })).toBe('connected')
  expect(causeOf({ connection: 'online', network: true, check: { access: 'ok', latencyMs: SLOW_MS - 1 } })).toBe('connected')
  expect(causeOf({ connection: 'online', network: true, check: { access: 'ok', latencyMs: SLOW_MS } })).toBe('slow')
})

// TailPocket's lastFailure (connectphone routes.go): the reason it gives for the user picks the words.
test('a computer that answered and did not take the phone is not running there, or was reset', () => {
  for (const failure of ['refused', 'handshake-closed'] as const) {
    expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'unreachable', failure } })).toBe('not-running')
    expect(causeOf({ ...offline, check: { failure } })).toBe('not-running')
  }
})

test('nothing answering is no answer, unless this network cannot reach a relay either', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'unreachable', failure: 'no-answer' } })).toBe('no-answer')
  expect(causeOf({ ...offline, check: { relay: 'unreachable', computer: 'unreachable', failure: 'no-answer' } })).toBe('blocked')
})

test('a relay that refused is the relay, whatever DSH saw of the Tailcat relay', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'unreachable', failure: 'relay-down' } })).toBe('relay-down')
  expect(causeOf({ ...offline, check: { relay: 'unreachable', failure: 'relay-down' } })).toBe('relay-down')
})

test('the companion refusing this phone and a working connection come before any lastFailure', () => {
  expect(causeOf({ ...offline, check: { relay: 'reachable', computer: 'reachable', access: 'refused', failure: 'no-answer' } })).toBe('refused')
  expect(causeOf({ connection: 'online', network: true, check: { failure: 'refused' } })).toBe('connected')
  expect(causeOf({ connection: 'offline', network: false, check: { failure: 'refused' } })).toBe('no-network')
})

test('only TailPocket\'s four reasons count; an empty or new one says nothing', () => {
  expect(['refused', 'handshake-closed', 'no-answer', 'relay-down', '', 'denied', undefined, 3].map(failureOf))
    .toEqual(['refused', 'handshake-closed', 'no-answer', 'relay-down', undefined, undefined, undefined, undefined])
})

test('pairing again is offered where the computer may no longer know this phone, never for the network or relay', () => {
  expect((['refused', 'not-running', 'computer', 'no-answer', 'relay-down', 'blocked', 'companion', 'trying', 'connected'] as const).filter(offersPairAgain))
    .toEqual(['refused', 'not-running', 'computer', 'no-answer'])
})

test('each part reads from the cause: only the part that did not answer fails, and nothing behind it is known', () => {
  // A stale "computer unreachable" from diagnose does not make the computer fail when the relay is the one down.
  const stale = { relay: 'reachable', computer: 'unreachable' } as const
  expect(partsOf('relay-down', stale)).toEqual({ phone: true, relay: false })
  expect(partsOf('no-answer', stale)).toEqual({ phone: true, relay: true, computer: false })
  expect(partsOf('no-answer', {})).toEqual({ phone: true, relay: undefined, computer: false })
  expect(partsOf('no-network', stale)).toEqual({ phone: false })
  expect(partsOf('refused', {})).toEqual({ phone: true, relay: true, computer: true, pairing: false })
})
