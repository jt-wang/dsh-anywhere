import { expect, test } from 'nsh/test'
import { PageChannel, readPageMessage, terminalPage } from './terminal-page.ts'

test('the page inlines xterm.js and closes each inline tag only once', () => {
  const html = terminalPage({ dark: true, fontSize: 13, scrollback: 1000 })
  expect(html.includes('FitAddon')).toBe(true)
  expect(html.match(/<\/script>/g)?.length).toBe(3)
  expect(html.match(/<\/style>/g)?.length).toBe(1)
  expect(html.includes('"fontSize":13')).toBe(true)
  expect(html.includes('#000000')).toBe(true)
  expect(terminalPage({ dark: false, fontSize: 13, scrollback: 1000 }).includes('#FFFFFF')).toBe(true)
})

test('only well-formed page messages are read', () => {
  expect(readPageMessage('{"t":"ready","cols":80,"rows":24}')).toEqual({ t: 'ready', cols: 80, rows: 24 })
  expect(readPageMessage('{"t":"size","cols":0,"rows":24}')).toBe(undefined)
  expect(readPageMessage('{"t":"input","data":"ls"}')).toEqual({ t: 'input', data: 'ls' })
  expect(readPageMessage('{"t":"input","data":5}')).toBe(undefined)
  expect(readPageMessage('not json')).toBe(undefined)
  expect(readPageMessage('{"t":"other"}')).toBe(undefined)
})

test('output waits for the page, then goes in one message per flush, in order with resets', async () => {
  const sent: string[] = []
  const ch = new PageChannel((m) => sent.push(m))
  ch.write('a'); ch.reset(); ch.write('b'); ch.write('c')
  await new Promise((r) => setTimeout(r, 30))
  expect(sent).toEqual([])
  ch.ready()
  await new Promise((r) => setTimeout(r, 30))
  expect(sent.map((m) => JSON.parse(m))).toEqual([{ t: 'write', data: 'a' }, { t: 'reset' }, { t: 'write', data: 'bc' }])
  ch.key('up')
  expect(JSON.parse(sent.at(-1)!)).toEqual({ t: 'key', name: 'up' })
  ch.lost()
  ch.write('d')
  await new Promise((r) => setTimeout(r, 30))
  expect(sent.length).toBe(4)
})

test('background drops pending and incoming display output and keys; resume sends only a fresh snapshot', async () => {
  const sent: unknown[] = []
  const ch = new PageChannel((m) => sent.push(JSON.parse(m)))
  ch.ready(); ch.write('pending')
  ch.setActive(false)
  ch.reset(); ch.write('hidden'); ch.key('up'); ch.send({ t: 'focus' })
  await new Promise((r) => setTimeout(r, 30))
  expect(sent).toEqual([])
  ch.setActive(true); ch.reset(); ch.write('fresh')
  await new Promise((r) => setTimeout(r, 30))
  expect(sent).toEqual([{ t: 'reset' }, { t: 'write', data: 'fresh' }])
  ch.write('destroyed'); ch.lost()
  await new Promise((r) => setTimeout(r, 30))
  expect(sent.length).toBe(2)
})
