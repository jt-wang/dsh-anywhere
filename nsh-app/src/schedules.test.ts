// Scheduled tasks as DSH 0.2.1-rc.3 keeps them (dsh-schedule): schedule/catalog lists every Host task with its Session,
// schedule/history pages one task's saved deliveries newest first, schedule/delete removes a task with its records.
// DSH 0.2.2 (rc.1 types) gives each task a target instead of a Session, pauses tasks, adds RRULE timing,
// pages history by task id alone and deletes through schedule/edit; schedule/delete is gone (HTTP 404 on rc.1).
import { expect, test } from 'nsh/test'
import { deleteCall, deleted, frequency, historyCall, historyOf, lastSent, nextRun, tasksOf } from './schedules.ts'
import { stringsFor } from './strings.ts'

const en = stringsFor('en-US'), ru = stringsFor('ru-RU')
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'every', title: `Task ${id}`, prompt: 'Synthetic prompt', everySeconds: 300, scheduledAt: '2030-01-01T09:00:00.000Z', sessionId: 's1', status: 'active', ...extra })

test('catalog rows become tasks: enabled ones by next run, then inactive ones, latest first; malformed rows are dropped', () => {
  const tasks = tasksOf([
    task('b', { scheduledAt: '2030-01-02T00:00:00.000Z' }),
    task('a', { scheduledAt: '2030-01-01T00:00:00.000Z' }),
    task('older', { status: 'inactive', kind: 'at', scheduledAt: '2028-01-01T00:00:00.000Z' }),
    task('old', { status: 'inactive', kind: 'at', scheduledAt: '2029-01-01T00:00:00.000Z' }),
    { id: 'x', kind: 'every' }, { title: 'no id' }, 'junk',
  ])
  expect(tasks.map((t) => [t.id, t.active])).toEqual([['a', true], ['b', true], ['old', false], ['older', false]])
  expect(tasks[0]!.sessionId).toBe('s1')
  expect(tasksOf({ not: 'a list' })).toEqual([])
})

test('the last delivery is kept as the task\'s last result', () => {
  const [t] = tasksOf([task('a', { lastDelivery: { scheduledAt: '2030-01-01T08:55:00.000Z', deliveredAt: '2030-01-01T08:55:01.000Z', messageId: 'm1' } })])
  expect(t!.lastDelivery?.messageId).toBe('m1')
  expect(lastSent(t!, Date.parse('2030-01-01T09:00:01.000Z'), en)).toBe('Last sent: 5 min')
  expect(lastSent(tasksOf([task('b')])[0]!, 0, en)).toBe('Not sent yet')
})

test('frequency reads as Desktop words it: the largest whole unit, the rule\'s own zone unless it is the phone\'s', () => {
  const f = (extra: Record<string, unknown>, zone?: string) => frequency(tasksOf([task('a', extra)])[0]!, en, zone)
  expect(f({ everySeconds: 300 })).toBe('Every 5 minutes')
  expect(f({ everySeconds: 3600 })).toBe('Every 1 hour')
  expect(f({ everySeconds: 172800 })).toBe('Every 2 days')
  expect(f({ everySeconds: 90 })).toBe('Every 90 seconds')
  expect(f({ kind: 'at' })).toBe('Once')
  expect(f({ kind: 'after', afterSeconds: 600 })).toBe('Once')
  expect(f({ kind: 'daily', time: '09:00:00.000', timeZone: 'Europe/Moscow' })).toBe('Daily at 09:00 (Europe/Moscow)')
  expect(f({ kind: 'daily', time: '09:30:15.000', timeZone: 'Europe/Moscow' }, 'Europe/Moscow')).toBe('Daily at 09:30:15')
  expect(f({ kind: 'weekly', time: '18:00:00.000', timeZone: 'UTC', weekdays: [1, 3, 5] })).toBe('Weekly on Mon, Wed, Fri at 18:00 (UTC)')
  expect(f({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' }, 'UTC')).toBe('Cron */15 9-17 * * 1-5')
  expect(frequency(tasksOf([task('a', { everySeconds: 300 })])[0]!, ru)).toBe('Раз в 5 минут')
  expect(frequency(tasksOf([task('a', { everySeconds: 60 })])[0]!, ru)).toBe('Раз в минуту')
  expect(frequency(tasksOf([task('a', { kind: 'weekly', time: '18:00:00.000', timeZone: 'UTC', weekdays: [2, 7] })])[0]!, ru, 'UTC')).toBe('По вт, вс в 18:00')
})

test('the next run: due now, soon in minutes or hours, and none once a task is inactive', () => {
  const at = Date.parse('2030-01-01T09:00:00.000Z'), t = tasksOf([task('a')])[0]!
  expect(nextRun(t, at - 5 * 60_000, en)).toBe('in 5 minutes')
  expect(nextRun(t, at - 60_000, en)).toBe('in 1 minute')
  expect(nextRun(t, at - 3 * 3_600_000, en)).toBe('in 3 hours')
  expect(nextRun(t, at + 20_000, en)).toBe('Due now')
  expect(nextRun(t, at + 10 * 60_000, en)).toBe('10 minutes overdue')
  expect(nextRun(t, at - 5 * 60_000, ru)).toBe('через 5 минут')
  expect(nextRun(tasksOf([task('a', { status: 'inactive' })])[0]!, at - 60_000, en)).toBe(undefined)
})

test('a history page: records newest first as DSH sends them, the cursor for more, and why earlier ones are missing', () => {
  const page = historyOf({ id: 'a', records: [{ scheduledAt: '2030-01-01T09:00:00.000Z', deliveredAt: '2030-01-01T09:00:01.000Z', messageId: 'm2', prompt: 'Synthetic prompt' }, { scheduledAt: '2030-01-01T08:55:00.000Z', deliveredAt: '2030-01-01T08:55:01.000Z', messageId: 'm1' }, { messageId: 'bad' }],
    earlierRecordsUnavailable: false, earlierRecordsPruned: true, retention: { days: 30, records: 200 }, nextBefore: 'm1' })
  expect('records' in page && page.records.map((r) => [r.messageId, r.prompt])).toEqual([['m2', 'Synthetic prompt'], ['m1', undefined]])
  expect('records' in page && [page.nextBefore, page.pruned, page.unavailable]).toEqual(['m1', true, false])
  expect(historyOf({ id: 'a', code: 'schedule_not_found' })).toEqual({ code: 'schedule_not_found' })
  expect(historyOf(null)).toEqual({ code: 'unknown' })
})

test('a delete is done only when DSH says it deleted the task', () => {
  expect(deleted({ id: 'a', deleted: true })).toBe(true)
  expect(deleted({ id: 'a', deleted: false, code: 'schedule_not_found' })).toBe(false)
  expect(deleted(undefined)).toBe(false)
})

// A 0.2.2 catalog row (ScheduleCatalogEntry of dsh-schedule 0.2.2-rc.1).
const task022 = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'every', title: `Task ${id}`, prompt: 'Synthetic prompt', everySeconds: 300, scheduledAt: '2030-01-01T09:00:00.000Z',
  target: { kind: 'session', sessionId: 's1' }, involvedSessionIds: ['s1'], status: 'active', updatedAt: '2029-12-31T00:00:00.000Z', ...extra })

test('0.2.2 rows: every target kind is kept, paused and ended tasks follow the active ones, and only active ones run next', () => {
  const tasks = tasksOf([
    task022('ended', { status: 'ended', kind: 'at', scheduledAt: '2029-01-01T00:00:00.000Z' }),
    task022('paused', { status: 'paused', scheduledAt: '2029-06-01T00:00:00.000Z' }),
    task022('new', { target: { kind: 'new', create: {} }, scheduledAt: '2030-01-02T00:00:00.000Z' }),
    task022('once', { target: { kind: 'new_once', sessionId: 's9', create: {} } }),
  ])
  expect(tasks.map((t) => [t.id, t.status])).toEqual([['once', 'active'], ['new', 'active'], ['paused', 'paused'], ['ended', 'ended']])
  expect(nextRun(tasks[2]!, 0, en)).toBe(undefined)
  expect(tasksOf([task('old', { status: 'inactive' }), task('on')]).map((t) => [t.id, t.status])).toEqual([['on', 'active'], ['old', 'ended']])
})

test('an RRULE task reads its rule, without the DTSTART line', () => {
  const [t] = tasksOf([task022('r', { kind: 'rrule', rrule: 'DTSTART;TZID=Europe/Moscow:20300101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO' })])
  expect(frequency(t!, en)).toBe('Repeats FREQ=WEEKLY;BYDAY=MO')
  expect(frequency(t!, ru)).toBe('Повтор FREQ=WEEKLY;BYDAY=MO')
})

test('history and delete are sent the way each DSH takes them', () => {
  const [old] = tasksOf([task('a')]), [now] = tasksOf([task022('b')]), [fresh] = tasksOf([task022('c', { target: { kind: 'new', create: {} } })])
  expect(historyCall(old!)).toEqual(['schedule/history', { request: { sessionId: 's1', id: 'a', limit: 20 } }])
  expect(historyCall(old!, 'm1')).toEqual(['schedule/history', { request: { sessionId: 's1', id: 'a', limit: 20, before: 'm1' } }])
  expect(historyCall(now!, 'm1')).toEqual(['schedule/history', { request: { id: 'b', limit: 20, before: 'm1' } }])
  expect(historyCall(fresh!)).toEqual(['schedule/history', { request: { id: 'c', limit: 20 } }])
  expect(deleteCall(old!)).toEqual(['schedule/delete', { request: { sessionId: 's1', id: 'a' } }])
  expect(deleteCall(now!)).toEqual(['schedule/edit', { request: { id: 'b', action: 'delete' } }])
  expect(deleted({ id: 'b', code: 'schedule_not_found' })).toBe(false)
})

test('a catalog row exactly as DSH 0.2.2-rc.1 sent it through the relay is read (synthetic task; times and id replaced)', () => {
  const row = { id: 'schedule-synthetic-every', kind: 'every', title: 'Synthetic every task', prompt: 'Synthetic scheduled prompt.', everySeconds: 3600, scheduledAt: '2030-01-01T10:00:00.000Z',
    target: { kind: 'new', create: {} }, involvedSessionIds: [], status: 'active', createdAt: '2030-01-01T09:00:00.000Z', updatedAt: '2030-01-01T09:00:00.000Z' }
  const [t] = tasksOf([row])
  expect([t?.id, t?.status, t?.sessionId, frequency(t!, en)]).toEqual([row.id, 'active', undefined, 'Every 1 hour'])
  expect(historyCall(t!)).toEqual(['schedule/history', { request: { id: row.id, limit: 20 } }])
  expect(deleteCall(t!)).toEqual(['schedule/edit', { request: { id: row.id, action: 'delete' } }])
})
