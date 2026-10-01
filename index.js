/**
 * dsh-cron: `/cron <schedule> <prompt>` runs a prompt on a schedule in this
 * session, the way `/loop` repeats one across turns.
 *
 * The schedule is parsed in code first: a five-field cron expression, or a
 * phrase like "every 5 minutes", "weekdays at 9am", "tomorrow at 15:00"
 * (lib/parse.js). Only when neither grammar reads it is the text handed to the
 * agent, which sets the timer up itself with the harness's `schedule_create`
 * tool. Timers belong to the harness schedule service, which keeps them across
 * restarts and wakes a cold session when one is due.
 *
 *   /cron <schedule> <prompt>     create a schedule in this session
 *   /cron list                    this session's schedules
 *   /cron delete <n|id|all>       remove one by list number or id, or all
 *   /cron help                    the forms
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

import { parseSchedule } from './lib/parse.js'

export const name = 'cron'
export const inject = ['commands']

/** The optional bundle that mounts the harness schedule service. */
const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'
/** Longest task title shown in lists; the service allows 120. */
const MAX_TITLE = 80

const USAGE = [
  'Usage: /cron <schedule> <prompt>',
  '  cron:      /cron */15 9-17 * * 1-5 check the deploy   (names like MON-FRI and @daily work too)',
  '  interval:  /cron every 5 minutes check the queue       (/cron 5m … as /loop takes it)',
  '  daily:     /cron every day at 9am standup notes',
  '  weekly:    /cron every mon, wed and fri at 18:00 gym log',
  '  once:      /cron in 10 minutes check the oven · /cron tomorrow at 9:30 review',
  '  zone:      add an IANA zone after the time: /cron every day at 9 Europe/Berlin …',
  'Anything else is handed to the agent to set up with schedule_create.',
  '/cron list · /cron delete <n|id|all>',
].join('\n')

/** The host's IANA zone, used unless the schedule names one. */
function hostTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** A task name from the prompt's first line, cut to fit lists. */
function titleOf(prompt) {
  const line = prompt.split('\n')[0].trim()
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1).trimEnd()}…`
}

/** A stored UTC target in the host's zone, as YYYY-MM-DD HH:MM. */
function localTime(iso, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** The message that asks the agent to read a schedule this plugin could not. */
function agentRequest(text, timeZone) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '[cron] Set this up with the schedule_create tool. It matched neither a cron expression nor the',
        `/cron phrase grammar, so read the timing and the task from it yourself. Use time zone ${timeZone}`,
        'unless it names another. If it cannot be expressed as one schedule, say why instead of guessing.',
        'Then reply with what you created: title, timing, next run.',
        '',
        `Request: ${text}`,
      ].join('\n'),
    }],
    source: { kind: 'cron', form: 'relay' },
  })
}

async function create(schedule, invocation, text) {
  const timeZone = hostTimeZone()
  const parsed = parseSchedule(text, { now: new Date(), timeZone })
  if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.text }
  if (parsed.kind === 'unparsed') {
    invocation.agent.followup(agentRequest(text, timeZone))
    return { kind: 'success', text: 'No cron expression or built-in phrase matched; asked the agent to set it up with schedule_create.' }
  }
  const title = titleOf(parsed.prompt)
  let record
  try {
    record = await schedule.create(invocation.agent.session.id, { prompt: parsed.prompt, title, ...parsed.selector }, invocation.signal)
  } catch (error) {
    // The service validates again (e.g. a cron date that never occurs) and
    // names its rule; anything else propagates.
    if (typeof error?.code !== 'string') throw error
    return { kind: 'error', text: `The schedule service refused it (${error.code}): ${error.message}` }
  }
  return {
    kind: 'success',
    text: `Scheduled "${title}": ${parsed.description}; next run ${localTime(record.scheduledAt, timeZone)} (${timeZone}). /cron list shows it.`,
  }
}

async function list(schedule, sessionId) {
  const records = await schedule.list({ sessionId })
  if (records.length === 0) return { kind: 'success', text: 'No schedules in this session.' }
  const timeZone = hostTimeZone()
  return {
    kind: 'success',
    text: records.map((record, index) => `${String(index + 1)}. ${record.title} · next ${localTime(record.scheduledAt, timeZone)} (${timeZone}) · ${record.id}`).join('\n'),
  }
}

async function remove(schedule, sessionId, target) {
  const records = await schedule.list({ sessionId })
  const chosen = target === 'all'
    ? records
    : records.filter((record, index) => record.id === target || String(index + 1) === target)
  if (chosen.length === 0) return { kind: 'error', text: `No schedule "${target}" in this session; /cron list shows them.` }
  const deleted = []
  for (const record of chosen) {
    const result = await schedule.delete({ sessionId, id: record.id })
    if (result.deleted) deleted.push(record)
  }
  if (target === 'all') return { kind: 'success', text: `Deleted ${String(deleted.length)} schedule(s).` }
  if (deleted.length === 0) return { kind: 'error', text: `Schedule "${target}" was already gone.` }
  return { kind: 'success', text: `Deleted "${deleted[0].title}".` }
}

async function cronHandler(invocation, ctx) {
  const input = invocation.rawInput.trim()
  const verb = input.toLowerCase()
  if (verb === '' || verb === 'help') return { kind: 'success', text: USAGE }
  // Read per call: the service comes from an optional bundle, and /cron should
  // say what is missing rather than vanish when it is not mounted.
  const schedule = ctx.get('schedule')
  if (schedule == null) {
    return { kind: 'error', text: `/cron needs the harness schedule service: enable ${SCHEDULE_BUNDLE} (Plugins page, Official group) or list it in the profile's dsh.profile.bundles.` }
  }
  const sessionId = invocation.agent.session.id
  if (verb === 'list') return list(schedule, sessionId)
  const deleteMatch = /^delete\s+(\S+)$/iu.exec(input)
  if (deleteMatch !== null) return remove(schedule, sessionId, deleteMatch[1].toLowerCase() === 'all' ? 'all' : deleteMatch[1])
  return create(schedule, invocation, input)
}

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-cron:cron',
    name: 'cron',
    description: 'Run a prompt on a schedule: /cron <cron expression or phrase> <prompt>, /cron list, /cron delete <n|id|all>',
    input: { hint: '<schedule> <prompt> | list | delete <n|id|all> | help' },
    handler: (invocation) => cronHandler(invocation, ctx),
  }))
}
