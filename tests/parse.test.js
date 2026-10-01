import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseSchedule } from '../lib/parse.js'

// Thursday 2026-10-01 10:30 UTC.
const NOW = new Date('2026-10-01T10:30:00Z')
const parse = (text, timeZone = 'UTC') => parseSchedule(text, { now: NOW, timeZone })

/** Assert a parse yields this selector and prompt. */
function expectSchedule(text, selector, prompt, timeZone = 'UTC') {
  const result = parse(text, timeZone)
  assert.equal(result.kind, 'schedule', `${text}: ${JSON.stringify(result)}`)
  assert.deepEqual(result.selector, selector, text)
  assert.equal(result.prompt, prompt, text)
  return result
}

test('five-field cron, with names and macros translated to the service dialect', () => {
  expectSchedule('*/15 9-17 * * 1-5 check the deploy', { cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'UTC' } }, 'check the deploy')
  expectSchedule('0 9 * * MON-FRI standup notes', { cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' } }, 'standup notes')
  expectSchedule('0 0 1 jan,jul * rotate keys', { cron: { expression: '0 0 1 1,7 *', time_zone: 'UTC' } }, 'rotate keys')
  expectSchedule('30 8 * * sun weekly review', { cron: { expression: '30 8 * * 0', time_zone: 'UTC' } }, 'weekly review')
  expectSchedule('@hourly sync', { cron: { expression: '0 * * * *', time_zone: 'UTC' } }, 'sync')
  expectSchedule('@daily backup', { cron: { expression: '0 0 * * *', time_zone: 'UTC' } }, 'backup')
  expectSchedule('@weekly report', { cron: { expression: '0 0 * * 0', time_zone: 'UTC' } }, 'report')
  expectSchedule('@monthly invoice', { cron: { expression: '0 0 1 * *', time_zone: 'UTC' } }, 'invoice')
  expectSchedule('@yearly renew', { cron: { expression: '0 0 1 1 *', time_zone: 'UTC' } }, 'renew')
})

test('cron-shaped input that the dialect cannot take is an error, never a guess', () => {
  for (const [text, message] of [
    ['61 * * * * x', /minute/],
    ['0 24 * * * x', /hour/],
    ['0 0 32 * * x', /day-of-month/],
    ['0 0 * 13 * x', /month/],
    ['0 0 * * 8 x', /day-of-week/],
    ['0 0 L * * x', /day-of-month/],
    ['*/0 * * * * x', /minute/],
    ['5-1 * * * * x', /minute/],
    ['-1 * * * * x', /minute/],
    ['0 9 * * FUNDAY x', /day-of-week/],
    ['*/9007199254740992 * * * * x', /minute/],
    ['@reboot x', /@reboot/],
  ]) {
    const result = parse(text)
    assert.equal(result.kind, 'invalid', text)
    assert.match(result.text, message, text)
  }
  assert.equal(parse('*/5 * * * *').kind, 'invalid', 'a schedule with nothing to run')
  assert.match(parse('*/5 * * * *').text, /what to run/)
})

test('cron schedules preserve the prompt including newlines and indentation', () => {
  const prompt = 'check this script:\n```js\n  run();\n```'
  for (const prefix of ['0 9 * * *', '@daily', '0 9 * * * Europe/Berlin', '@daily Europe/Berlin']) {
    const result = parse(`${prefix}\n${prompt}`)
    assert.equal(result.kind, 'schedule', prefix)
    assert.equal(result.prompt, prompt, prefix)
  }
})

test('intervals must be positive safe integers accepted by the schedule service', () => {
  for (const prefix of ['in 0 seconds', 'in 99999999999999999999 hours', 'every 99999999999999999999 hours', '99999999999999999999m']) {
    assert.equal(parse(`${prefix} check`).kind, 'invalid', prefix)
  }
})

test('intervals: every N units and the compact /loop form', () => {
  expectSchedule('every 5 minutes check the queue', { every_seconds: 300 }, 'check the queue')
  expectSchedule('every minute ping', { every_seconds: 60 }, 'ping')
  expectSchedule('every 2 hours sync', { every_seconds: 7200 }, 'sync')
  expectSchedule('each hour: summarize', { every_seconds: 3600 }, 'summarize')
  expectSchedule('5m check the build', { every_seconds: 300 }, 'check the build')
  expectSchedule('2h review', { every_seconds: 7200 }, 'review')
  expectSchedule('1d digest', { every_seconds: 86400 }, 'digest')
  const tooFast = parse('every 30 seconds ping')
  assert.equal(tooFast.kind, 'invalid')
  assert.match(tooFast.text, /at least one minute/)
})

test('hourly at a minute, and monthly on a day', () => {
  expectSchedule('hourly report', { cron: { expression: '0 * * * *', time_zone: 'UTC' } }, 'report')
  expectSchedule('every hour at :15 check', { cron: { expression: '15 * * * *', time_zone: 'UTC' } }, 'check')
  expectSchedule('monthly on the 1st at 9am pay rent', { cron: { expression: '0 9 1 * *', time_zone: 'UTC' } }, 'pay rent')
  expectSchedule('every month on the 15th at 18:30 invoice', { cron: { expression: '30 18 15 * *', time_zone: 'UTC' } }, 'invoice')
})

test('daily and weekly wall-clock times', () => {
  expectSchedule('every day at 9am standup', { daily: { time: '09:00:00', time_zone: 'UTC' } }, 'standup')
  expectSchedule('daily at 23:15 wrap up', { daily: { time: '23:15:00', time_zone: 'UTC' } }, 'wrap up')
  expectSchedule('daily at noon lunch', { daily: { time: '12:00:00', time_zone: 'UTC' } }, 'lunch')
  expectSchedule('every day at midnight rotate', { daily: { time: '00:00:00', time_zone: 'UTC' } }, 'rotate')
  expectSchedule('at 7:30pm every day journal', { daily: { time: '19:30:00', time_zone: 'UTC' } }, 'journal')
  expectSchedule('every monday at 9 to review PRs', { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1] } }, 'review PRs')
  expectSchedule('every mon, wed and fri at 18:00 gym', { weekly: { time: '18:00:00', time_zone: 'UTC', weekdays: [1, 3, 5] } }, 'gym')
  expectSchedule('every mon, wed, and fri at 18:00 gym', { weekly: { time: '18:00:00', time_zone: 'UTC', weekdays: [1, 3, 5] } }, 'gym')
  expectSchedule('weekdays at 8:45am inbox zero', { weekly: { time: '08:45:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] } }, 'inbox zero')
  expectSchedule('every weekend at 10 plan', { weekly: { time: '10:00:00', time_zone: 'UTC', weekdays: [6, 7] } }, 'plan')
  expectSchedule('every monday to friday at 9 standup', { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5] } }, 'standup')
  expectSchedule('mondays at 9 review', { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1] } }, 'review')
  expectSchedule('every tuesday review', { weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [2] } }, 'review')
  expectSchedule('every day check', { daily: { time: '09:00:00', time_zone: 'UTC' } }, 'check')
  const bad = parse('every day at 25:00 x')
  assert.equal(bad.kind, 'invalid')
  assert.match(bad.text, /25:00/)
})

test('an explicit zone overrides the host zone', () => {
  expectSchedule('every day at 9 Europe/Berlin standup', { daily: { time: '09:00:00', time_zone: 'Europe/Berlin' } }, 'standup')
  expectSchedule('0 9 * * * UTC standup', { cron: { expression: '0 9 * * *', time_zone: 'UTC' } }, 'standup', 'Asia/Shanghai')
  const unknown = parse('every day at 9 Mars/Olympus x')
  assert.equal(unknown.kind, 'invalid')
  assert.match(unknown.text, /Mars\/Olympus/)
})

test('one-shots: in, at, tomorrow, and a date', () => {
  expectSchedule('in 10 minutes check the oven', { after_seconds: 600 }, 'check the oven')
  expectSchedule('in an hour call back', { after_seconds: 3600 }, 'call back')
  expectSchedule('in 30 seconds ping', { after_seconds: 30 }, 'ping')
  // 10:30 UTC now: 3pm is still today, 9am already passed so it means tomorrow.
  expectSchedule('at 3pm deploy', { at: { date: '2026-10-01', time: '15:00:00', time_zone: 'UTC' } }, 'deploy')
  expectSchedule('at 9 deploy', { at: { date: '2026-10-02', time: '09:00:00', time_zone: 'UTC' } }, 'deploy')
  expectSchedule('today at 18:00 wrap', { at: { date: '2026-10-01', time: '18:00:00', time_zone: 'UTC' } }, 'wrap')
  expectSchedule('tomorrow at 9:30 standup', { at: { date: '2026-10-02', time: '09:30:00', time_zone: 'UTC' } }, 'standup')
  expectSchedule('on 2026-12-24 at 18:00 gifts', { at: { date: '2026-12-24', time: '18:00:00', time_zone: 'UTC' } }, 'gifts')
  expectSchedule('2026-12-31 23:59 countdown', { at: { date: '2026-12-31', time: '23:59:00', time_zone: 'UTC' } }, 'countdown')
  // Asia/Shanghai is UTC+8, so it is already 18:30 there; 9am means tomorrow, local date.
  expectSchedule('at 9am wake', { at: { date: '2026-10-02', time: '09:00:00', time_zone: 'Asia/Shanghai' } }, 'wake', 'Asia/Shanghai')
  const past = parse('today at 8am x')
  assert.equal(past.kind, 'invalid')
  assert.match(past.text, /already passed/)
})

test('what no grammar here covers is left to the model', () => {
  for (const text of [
    'every other thursday after lunch water the plants',
    'twice a day remind me to stretch',
    'every 15 minutes during business hours on weekdays check alerts',
    'hourly at 9:30 check alerts',
    'every monday and every friday at 18:00 gym',
    'remind me to drink water',
  ]) {
    assert.equal(parse(text).kind, 'unparsed', text)
  }
})

test('every schedule names itself for the reply', () => {
  assert.equal(parse('every 5 minutes x').description, 'every 5 minutes')
  assert.equal(parse('every day at 9 x').description, 'daily at 09:00 (UTC)')
  assert.equal(parse('every mon, fri at 18:00 x').description, 'weekly on Mon, Fri at 18:00 (UTC)')
  assert.equal(parse('0 9 * * 1-5 x').description, 'cron 0 9 * * 1-5 (UTC)')
  assert.equal(parse('in 10 minutes x').description, 'once in 10 minutes')
  assert.equal(parse('tomorrow at 9 x').description, 'once on 2026-10-02 at 09:00 (UTC)')
})
