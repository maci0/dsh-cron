import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/** A schedule service fake with the harness's create/list/delete shapes. */
function fakeSchedule() {
  const records = []
  return {
    records,
    async create(sessionId, request) {
      if (request.every_seconds !== undefined && request.every_seconds < 60) {
        throw Object.assign(new Error('Every interval must be at least 60 seconds.'), { code: 'invalid_rule' })
      }
      const record = { id: `schedule-${String(records.length + 1)}`, sessionId, title: request.title, prompt: request.prompt, scheduledAt: '2026-10-01T11:00:00.000Z', request }
      records.push(record)
      return record
    },
    async list({ sessionId }) {
      return records.filter(record => record.sessionId === sessionId)
    },
    async delete({ sessionId, id }) {
      const index = records.findIndex(record => record.id === id && record.sessionId === sessionId)
      if (index < 0) return { id, deleted: false, code: 'schedule_not_found' }
      records.splice(index, 1)
      return { id, deleted: true }
    },
  }
}

function mount({ schedule = fakeSchedule() } = {}) {
  const commands = []
  const ctx = {
    get: (name) => (name === 'schedule' ? schedule : undefined),
    commands: { register: (def) => { commands.push(def); return () => {} } },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const followups = []
  const agent = { session: { id: 's1' }, followup: (message) => followups.push(message) }
  const run = (rawInput) => commands[0].handler({ rawInput, attachments: [], agent })
  return { commands, run, followups, schedule }
}

test('registers /cron', () => {
  const { commands } = mount()
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'cron')
})

test('a cron expression becomes a cron schedule in this session', async () => {
  const { run, schedule } = mount()
  const result = await run(' */15 9-17 * * 1-5 check the deploy')
  assert.equal(result.kind, 'success', result.text)
  const [record] = schedule.records
  assert.equal(record.sessionId, 's1')
  assert.equal(record.prompt, 'check the deploy')
  assert.equal(record.title, 'check the deploy')
  assert.equal(record.request.cron.expression, '*/15 9-17 * * 1-5')
  assert.equal(typeof record.request.cron.time_zone, 'string')
  assert.match(result.text, /cron \*\/15 9-17 \* \* 1-5/)
  assert.match(result.text, /next run/)
})

test('a human phrase becomes the matching selector', async () => {
  const { run, schedule } = mount()
  assert.equal((await run('every 5 minutes check the queue')).kind, 'success')
  assert.deepEqual(schedule.records[0].request.every_seconds, 300)
  assert.equal((await run('every monday at 9 UTC review PRs')).kind, 'success')
  assert.deepEqual(schedule.records[1].request.weekly, { time: '09:00:00', time_zone: 'UTC', weekdays: [1] })
})

test('a long prompt is titled by its first line, cut to fit', async () => {
  const { run, schedule } = mount()
  const long = `${'word '.repeat(40)}\nsecond line`
  await run(`every day at 9 ${long}`)
  const { title } = schedule.records[0]
  assert.ok(title.length <= 80, `title length ${String(title.length)}`)
  assert.ok(title.endsWith('…'))
  assert.ok(!title.includes('second line'))
})

test('a schedule that cannot be one is an error and creates nothing', async () => {
  const { run, schedule, followups } = mount()
  const result = await run('61 * * * * x')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /minute/)
  assert.equal(schedule.records.length, 0)
  assert.equal(followups.length, 0)
})

test('text no grammar covers is handed to the agent to set up with schedule_create', async () => {
  const { run, schedule, followups } = mount()
  const result = await run('every other thursday after lunch water the plants')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /asked the agent/)
  assert.equal(schedule.records.length, 0, 'the plugin itself creates nothing')
  assert.equal(followups.length, 1)
  const message = followups[0]
  assert.equal(message.source.kind, 'cron')
  const text = message.content.map(block => block.text).join('')
  assert.match(text, /schedule_create/)
  assert.match(text, /every other thursday after lunch water the plants/)
})

test('the service refusing a request is reported with its reason', async () => {
  const schedule = fakeSchedule()
  schedule.create = async () => { throw Object.assign(new Error('The cron expression never matches.'), { code: 'invalid_rule' }) }
  const { run } = mount({ schedule })
  const result = await run('0 0 31 2 * x')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /never matches/)
})

test('list, then delete by number, by id, and all', async () => {
  const { run, schedule } = mount()
  assert.equal((await run('list')).text, 'No schedules in this session.')
  await run('every 5 minutes a')
  await run('every 10 minutes b')
  await run('every 15 minutes c')
  const listed = await run('list')
  assert.match(listed.text, /^1\. a /mu)
  assert.match(listed.text, /^3\. c /mu)
  assert.match(listed.text, /schedule-2/)

  assert.match((await run('delete 2')).text, /Deleted "b"/)
  assert.deepEqual(schedule.records.map(r => r.title), ['a', 'c'])
  assert.match((await run('delete schedule-3')).text, /Deleted "c"/)
  assert.equal((await run('delete 9')).kind, 'error')
  await run('every 20 minutes d')
  assert.match((await run('delete all')).text, /Deleted 2 schedule/)
  assert.equal(schedule.records.length, 0)
})

test('help and an empty argument explain the forms', async () => {
  const { run } = mount()
  for (const input of ['', 'help']) {
    const result = await run(input)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /\/cron <schedule> <prompt>/)
  }
})

test('without the schedule service, /cron names the bundle that provides it', async () => {
  const { run } = mount({ schedule: null })
  const result = await run('every 5 minutes x')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /dsh-experimental-schedule-bundle/)
})
