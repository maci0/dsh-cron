/**
 * Parse the schedule at the start of a `/cron` argument into the harness
 * schedule service's selectors, deterministically: a five-field cron
 * expression (names and @macros translated to the service's numeric dialect)
 * or a phrase from a small English grammar. What follows the schedule is the
 * prompt. Text neither grammar covers is `unparsed`, and the caller hands it to
 * the model; text that is clearly a schedule but cannot be one is `invalid`
 * and is reported, never guessed at.
 *
 * @module dsh-cron/parse
 */

/** The service's fixed-interval floor. */
const MIN_EVERY_SECONDS = 60
/** Time used when a recurring day phrase names no time ("every monday"). */
const DEFAULT_TIME = '09:00:00'

const UNIT_SECONDS = { s: 1, second: 1, sec: 1, m: 60, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800 }

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const ISO_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, base: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, base: 0 },
]

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

/** Words that, right after a recognized schedule, mean the schedule goes on in a way this grammar does not read. */
const QUALIFIERS = /^(during|between|from|on|except|until|till|unless|starting|after|before|only|while|when|if|but|except)\b/u

/** One cron atom: `*`, a number, or an L/W/#/? form the dialect rejects but cron users write. */
const CRON_ATOM = /^(\*|\d+|L|\d+[LW]|\d+#\d+|\?)$/u
const CRON_NAMES = new Set([...MONTH_NAMES, ...DOW_NAMES])

/** Whether a token is shaped like a cron field (atoms or real month/day names), which decides whether input is meant as cron. */
function isCronToken(token) {
  return token.split(/[,\-/]/u).every(atom => CRON_ATOM.test(atom) || CRON_NAMES.has(atom.toLowerCase()))
}

/** Weekday words: ISO number (Mon 1 .. Sun 7). */
const WEEKDAY_WORDS = [
  [/^mon(day)?s?$/u, 1], [/^tue(s|sday)?s?$/u, 2], [/^wed(nesday)?s?$/u, 3], [/^thu(r|rs|rsday)?s?$/u, 4],
  [/^fri(day)?s?$/u, 5], [/^sat(urday)?s?$/u, 6], [/^sun(day)?s?$/u, 7],
]
const WEEKDAY = '(?:mon(?:day)?s?|tue(?:s|sday)?s?|wed(?:nesday)?s?|thu(?:r|rs|rsday)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)'
const TIME = '(?:noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)'
const ZONE = '(?:\\s+(utc|[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)+))?'
// A range before a list: "monday to friday" must not stop at "monday".
const DAYSPEC = `(?:day|weekdays?|weekends?|${WEEKDAY}\\s*(?:-|to|through|thru)\\s*${WEEKDAY}|${WEEKDAY}(?:\\s*(?:,|and|&)\\s*${WEEKDAY})*)`

/** @returns {{ kind: 'invalid', text: string }} */
const invalid = (text) => ({ kind: 'invalid', text })

/**
 * Parse one `/cron` argument.
 * @param {string} input - the text after `/cron`.
 * @param {{ now: Date, timeZone: string }} context - the clock and the host's IANA zone.
 * @returns {{ kind: 'schedule', selector: object, prompt: string, description: string }
 *   | { kind: 'invalid', text: string } | { kind: 'unparsed' }}
 */
export function parseSchedule(input, context) {
  const text = input.trim()
  const cron = parseCron(text, context)
  if (cron !== undefined) return cron
  return parseHuman(text, context)
}

// --- cron ---

function parseCron(text, context) {
  const tokens = text.split(/\s+/u)
  const macro = tokens[0]?.toLowerCase()
  if (macro?.startsWith('@')) {
    if (!(macro in MACROS)) return invalid(`${tokens[0]} is not a schedule this plugin can set (use a five-field cron expression).`)
    return finishCron(MACROS[macro], tokens.slice(1), context)
  }
  if (tokens.length < 5 || !tokens.slice(0, 5).every(isCronToken)) return undefined
  // Five cron-shaped tokens are meant as cron; anything they get wrong is reported.
  const fields = []
  for (const [index, token] of tokens.slice(0, 5).entries()) {
    const field = normalizeCronField(token, CRON_FIELDS[index])
    if (typeof field !== 'string') return field
    fields.push(field)
  }
  return finishCron(fields.join(' '), tokens.slice(5), context)
}

function finishCron(expression, rest, context) {
  const { zone, words } = takeZone(rest, context)
  if (zone.kind === 'invalid') return zone
  return schedule({ cron: { expression, time_zone: zone.value } }, words.join(' '), `cron ${expression} (${zone.value})`)
}

/** Translate names to numbers and check one field against the service's dialect. */
function normalizeCronField(token, field) {
  const fail = () => invalid(`cron ${field.name} field "${token}" is not valid: use *, a value, a-b, */n or a-b/n, or a comma list of those, within ${field.min}-${field.max}.`)
  const value = (raw) => {
    const lower = raw.toLowerCase()
    if (field.names !== undefined && field.names.includes(lower)) return field.names.indexOf(lower) + field.base
    if (!/^\d+$/u.test(raw)) return undefined
    const number = Number(raw)
    return number >= field.min && number <= field.max ? number : undefined
  }
  const parts = []
  for (const part of token.split(',')) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/iu.exec(part)
    if (match === null) return fail()
    const [, range, step] = match
    if (step !== undefined && (Number(step) < 1 || (range !== '*' && !range.includes('-')))) return fail()
    let out = range
    if (range !== '*') {
      const [from, to] = range.split('-').map(value)
      if (from === undefined || (range.includes('-') && (to === undefined || to < from))) return fail()
      out = range.includes('-') ? `${from}-${to}` : `${from}`
    }
    parts.push(step === undefined ? out : `${out}/${step}`)
  }
  return parts.join(',')
}

// --- human grammar ---

function parseHuman(text, context) {
  const lower = text.toLowerCase()
  for (const rule of RULES) {
    const match = rule.pattern.exec(lower)
    if (match === null) continue
    const rest = text.slice(match[0].length)
    if (QUALIFIERS.test(rest.trim().toLowerCase())) return { kind: 'unparsed' }
    // The grammar matched lowercased text; read the zone back in the user's casing.
    const lowered = match.groups?.zone
    const at = lowered === undefined ? -1 : lower.lastIndexOf(lowered, match[0].length - lowered.length)
    const zone = resolveZone(at < 0 ? undefined : text.slice(at, at + lowered.length), context)
    if (zone.kind === 'invalid') return zone
    const built = rule.build(match.groups ?? {}, { ...context, timeZone: zone.value })
    if (built.kind === 'invalid') return built
    return schedule(built.selector, rest, built.description)
  }
  return { kind: 'unparsed' }
}

/** Anchored at the start; the match's end is where the prompt begins. Order matters: specific before general. */
const RULES = [
  {
    // in 10 minutes / in an hour
    pattern: new RegExp(`^in\\s+(?<count>\\d+|an?)\\s+(?<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\\b`, 'u'),
    build: ({ count, unit }) => {
      const seconds = amount(count) * unitSeconds(unit)
      return { selector: { after_seconds: seconds }, description: `once in ${plural(amount(count), unitName(unit))}` }
    },
  },
  {
    // hourly / hourly at :15 / every hour at :15 (a bare "every hour" is a fixed interval)
    pattern: /^(?:hourly(?:\s+at\s+:?(?<minute>\d{1,2})(?:\s+past)?)?|(?:every|each)\s+hour\s+at\s+:?(?<atMinute>\d{1,2})(?:\s+past)?)(?=\s|$)/u,
    build: ({ minute: hourlyMinute, atMinute }, context) => {
      const minute = hourlyMinute ?? atMinute
      const m = minute === undefined ? 0 : Number(minute)
      if (m > 59) return invalid(`minute ${minute} is not a minute of the hour.`)
      const expression = `${m} * * * *`
      return { selector: { cron: { expression, time_zone: context.timeZone } }, description: `cron ${expression} (${context.timeZone})` }
    },
  },
  {
    // monthly on the 1st at 9am / every month on the 15th
    pattern: new RegExp(`^(?:monthly|(?:every|each)\\s+month)(?:\\s+on\\s+the\\s+(?<dom>\\d{1,2})(?:st|nd|rd|th)?)?(?:\\s+at\\s+(?<time>${TIME}))?${ZONE.replace('(utc', '(?<zone>utc')}(?=\\s|$)`, 'u'),
    build: ({ dom, time }, context) => {
      const day = dom === undefined ? 1 : Number(dom)
      if (day < 1 || day > 31) return invalid(`day ${dom} is not a day of the month.`)
      const clock = parseTime(time ?? DEFAULT_TIME.slice(0, 5))
      if (clock.kind === 'invalid') return clock
      const expression = `${clock.minute} ${clock.hour} ${day} * *`
      return { selector: { cron: { expression, time_zone: context.timeZone } }, description: `cron ${expression} (${context.timeZone})` }
    },
  },
  {
    // every day at 9 / every mon, wed and fri at 18:00 / weekdays at 8:45 / mondays at 9
    pattern: new RegExp(`^(?:(?:every|each)\\s+(?<days>${DAYSPEC})|(?<bare>daily|${DAYSPEC.replace('(?:day|', '(?:')}))(?:\\s+at\\s+(?<time>${TIME}))?${ZONE.replace('(utc', '(?<zone>utc')}(?=\\s|$|[,:;])`, 'u'),
    build: ({ days, bare, time }, context) => recurringDays(days ?? bare, time, context),
  },
  {
    // at 7:30pm every day / at 9 on weekdays
    pattern: new RegExp(`^at\\s+(?<time>${TIME})\\s+(?:every\\s+(?<days>${DAYSPEC})|on\\s+(?<on>${DAYSPEC})|(?<daily>daily))${ZONE.replace('(utc', '(?<zone>utc')}(?=\\s|$|[,:;])`, 'u'),
    build: ({ time, days, on, daily }, context) => recurringDays(days ?? on ?? daily, time, context),
  },
  {
    // every 5 minutes / every minute / each hour (fixed rate)
    pattern: /^(?:every|each)\s+(?:(?<count>\d+)\s+)?(?<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b/u,
    build: ({ count, unit }) => every(count === undefined ? 1 : Number(count), unit),
  },
  {
    // 5m / 2h / 1d, as /loop takes them
    pattern: /^(?<count>\d+)(?<unit>[smhdw])(?=\s|$)/u,
    build: ({ count, unit }) => every(Number(count), unit),
  },
  {
    // on 2026-12-24 at 18:00 / 2026-12-31 23:59 / tomorrow at 9 / today at 18:00 / at 3pm
    pattern: new RegExp(`^(?:(?:on\\s+)?(?<date>\\d{4}-\\d{2}-\\d{2})(?:\\s+(?:at\\s+)?(?<dateTime>${TIME}))?|(?<day>today|tonight|tomorrow)(?:\\s+at\\s+(?<dayTime>${TIME}))|at\\s+(?<atTime>${TIME}))${ZONE.replace('(utc', '(?<zone>utc')}(?=\\s|$|[,:;])`, 'u'),
    build: (groups, context) => oneShot(groups, context),
  },
]

function every(count, unit) {
  const seconds = count * unitSeconds(unit)
  if (seconds < MIN_EVERY_SECONDS) return invalid(`a repeating schedule must be at least one minute apart (got ${plural(count, unitName(unit))}).`)
  return { selector: { every_seconds: seconds }, description: `every ${count === 1 ? unitName(unit) : plural(count, unitName(unit))}` }
}

function recurringDays(spec, time, context) {
  const clock = time === undefined ? { hour: 9, minute: 0 } : parseTime(time)
  if (clock.kind === 'invalid') return clock
  const hhmmss = time === undefined ? DEFAULT_TIME : `${pad(clock.hour)}:${pad(clock.minute)}:00`
  const days = weekdaysOf(spec)
  if (days.length === 7) {
    return { selector: { daily: { time: hhmmss, time_zone: context.timeZone } }, description: `daily at ${hhmmss.slice(0, 5)} (${context.timeZone})` }
  }
  return {
    selector: { weekly: { time: hhmmss, time_zone: context.timeZone, weekdays: days } },
    description: `weekly on ${days.map(day => ISO_DAY_LABELS[day - 1]).join(', ')} at ${hhmmss.slice(0, 5)} (${context.timeZone})`,
  }
}

/** ISO weekday numbers a day phrase covers, ascending. */
function weekdaysOf(spec) {
  const phrase = spec.trim()
  if (phrase === 'day' || phrase === 'daily') return [1, 2, 3, 4, 5, 6, 7]
  if (/^weekdays?$/u.test(phrase)) return [1, 2, 3, 4, 5]
  if (/^weekends?$/u.test(phrase)) return [6, 7]
  const range = new RegExp(`^(${WEEKDAY})\\s*(?:-|to|through|thru)\\s*(${WEEKDAY})$`, 'u').exec(phrase)
  if (range !== null) {
    const from = weekday(range[1])
    const to = weekday(range[2])
    const out = []
    for (let day = from; ; day = day % 7 + 1) {
      out.push(day)
      if (day === to) break
    }
    return out.sort((a, b) => a - b)
  }
  return [...new Set(phrase.split(/\s*(?:,|and|&)\s*/u).map(weekday))].sort((a, b) => a - b)
}

function weekday(word) {
  return WEEKDAY_WORDS.find(([pattern]) => pattern.test(word))[1]
}

function oneShot({ date, dateTime, day, dayTime, atTime }, context) {
  const today = localParts(context.now, context.timeZone)
  let target
  let raw
  if (date !== undefined) {
    if (!validDate(date)) return invalid(`${date} is not a calendar date.`)
    target = date
    raw = dateTime ?? '00:00'
  } else if (day !== undefined) {
    target = day === 'tomorrow' ? addDays(today.date, 1) : today.date
    raw = dayTime
  } else {
    raw = atTime
  }
  const clock = parseTime(raw)
  if (clock.kind === 'invalid') return clock
  const time = `${pad(clock.hour)}:${pad(clock.minute)}:00`
  // A bare "at T" is the next T: today while it is still ahead, else tomorrow.
  if (target === undefined) target = time > today.time ? today.date : addDays(today.date, 1)
  if (target < today.date || (target === today.date && time <= today.time)) {
    return invalid(`${target} ${time.slice(0, 5)} (${context.timeZone}) has already passed.`)
  }
  return {
    selector: { at: { date: target, time, time_zone: context.timeZone } },
    description: `once on ${target} at ${time.slice(0, 5)} (${context.timeZone})`,
  }
}

// --- shared pieces ---

function schedule(selector, rest, description) {
  const prompt = rest.trim().replace(/^[,:;-]+\s*/u, '').replace(/^(to|then)\s+/iu, '').trim()
  if (prompt === '') return invalid(`${description}: what to run? Put the prompt after the schedule, e.g. /cron every day at 9 check the deploy.`)
  return { kind: 'schedule', selector, prompt, description }
}

/** A trailing zone token on cron input; the host zone otherwise. */
function takeZone(words, context) {
  const first = words[0]
  if (first !== undefined && (/^utc$/iu.test(first) || /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/u.test(first))) {
    return { zone: resolveZone(first, context), words: words.slice(1) }
  }
  return { zone: { kind: 'zone', value: context.timeZone }, words }
}

function resolveZone(raw, context) {
  if (raw === undefined) return { kind: 'zone', value: context.timeZone }
  if (/^utc$/iu.test(raw)) return { kind: 'zone', value: 'UTC' }
  // The grammar lowercased the text; Intl canonicalizes the zone's case.
  try {
    return { kind: 'zone', value: new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone }
  } catch {
    return invalid(`${raw} is not a time zone (use an IANA name like Europe/Berlin, or UTC).`)
  }
}

/** 9, 9:30, 9am, 9:30pm, 21:00, noon, midnight. */
function parseTime(raw) {
  const text = raw.trim().toLowerCase()
  if (text === 'noon') return { hour: 12, minute: 0 }
  if (text === 'midnight') return { hour: 0, minute: 0 }
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/u.exec(text)
  const fail = invalid(`${raw} is not a time of day.`)
  if (match === null) return fail
  let hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (minute > 59) return fail
  if (match[3] !== undefined) {
    if (hour < 1 || hour > 12) return fail
    hour = hour % 12 + (match[3] === 'pm' ? 12 : 0)
  } else if (hour > 23) return fail
  return { hour, minute }
}

/** The local calendar date and HH:MM:SS of `now` in `timeZone`. */
function localParts(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` }
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function validDate(date) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === date
}

function amount(count) {
  return /^an?$/u.test(count) ? 1 : Number(count)
}

function unitSeconds(unit) {
  return UNIT_SECONDS[unit.replace(/s$/u, '')] ?? UNIT_SECONDS[unit]
}

function unitName(unit) {
  const seconds = unitSeconds(unit)
  return { 1: 'second', 60: 'minute', 3600: 'hour', 86400: 'day', 604800: 'week' }[seconds]
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function pad(n) {
  return String(n).padStart(2, '0')
}
