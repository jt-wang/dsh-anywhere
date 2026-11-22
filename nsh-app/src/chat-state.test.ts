import { expect, test } from 'nsh/test'
import { composerState } from './chat-state.ts'
import { outgoing } from './outbox.ts'
import type { Draft } from './attach.ts'

test('replacing a detail page preserves unsent photos, failed messages and an in-flight completion without retrying', () => {
  const link = {}
  const a = composerState(link, ['a'], 'saved text')
  const photo: Draft = { kind: 'image', id: 'reference', name: 'reference.png', mediaType: 'image/png', data: 'c2FtcGxl' }
  a.draft.set('Unfinished caption'); a.attached.set([photo]); a.uploading.set(true)
  const failed = { ...outgoing('failed', 'Retry me', [photo], [], []), state: 'failed' as const, error: 'Not delivered' }
  a.outbox.set([failed, outgoing('pending', 'Still sending', [], [], [])])
  const b = composerState(link, ['b'])
  expect(b.draft()).toBe(''); expect(b.attached()).toEqual([]); expect(b.outbox()).toEqual([])
  const returned = composerState(link, ['a'], 'stale disk text')
  expect(returned.draft()).toBe('Unfinished caption'); expect(returned.attached()).toEqual([photo])
  expect(returned.outbox()[0]).toEqual(failed); expect(returned.uploading()).toBe(true)
  // The original asynchronous sender still owns this request; returning must not resend it.
  a.outbox.update((items) => items.map((o) => o.id === 'pending' ? { ...o, state: 'queued' } : o))
  a.uploading.set(false)
  expect(returned.outbox().map((o) => [o.id, o.state])).toEqual([['failed', 'failed'], ['pending', 'queued']])
  expect(returned.uploading()).toBe(false)
})

test('another linked computer and another child address cannot inherit unsent content', () => {
  const link = {}
  composerState(link, ['parent', 'child']).draft.set('Private to this address')
  expect(composerState({}, ['parent', 'child'], 'new computer').draft()).toBe('new computer')
  expect(composerState(link, ['parent']).draft()).toBe('')
  expect(composerState(link, ['other-parent', 'child']).draft()).toBe('')
})
