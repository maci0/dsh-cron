/**
 * Real-composition test: the plugin mounts into a real `@deepseek-ai/cordis`
 * `Context`, registers /cron, finds the schedule service only when one is
 * mounted, and releases the command when its fiber disposes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'

import { apply, inject } from '../index.js'

class CommandsSeam extends Service {
  registered = new Map()

  constructor(ctx) {
    super(ctx, 'commands')
  }

  register(definition) {
    return this.ctx.effect(() => {
      this.registered.set(definition.name, definition)
      return () => { this.registered.delete(definition.name) }
    })
  }
}

class ScheduleSeam extends Service {
  created = []

  constructor(ctx) {
    super(ctx, 'schedule')
  }

  async create(sessionId, request) {
    this.created.push({ sessionId, request })
    return { id: 'schedule-1', title: request.title, scheduledAt: '2026-10-01T11:00:00.000Z' }
  }
}

const invoke = (commands, rawInput) => commands.registered.get('cron').handler({
  rawInput, attachments: [], agent: { session: { id: 's1' }, followup() {} },
})

test('mounts, reaches a mounted schedule service, and releases /cron', async () => {
  const ctx = new Context()
  const commands = new CommandsSeam(ctx)
  const schedule = new ScheduleSeam(ctx)
  const fiber = await ctx.plugin({ name: 'cron', inject, apply }, {})
  assert.deepEqual([...commands.registered.keys()], ['cron'])

  const result = await invoke(commands, 'every 5 minutes check')
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(schedule.created.map(c => c.request.every_seconds), [300])

  await fiber.dispose()
  assert.deepEqual([...commands.registered.keys()], [], 'the command is released with the fiber')
})

test('without a schedule service the command still mounts and says what is missing', async () => {
  const ctx = new Context()
  const commands = new CommandsSeam(ctx)
  const fiber = await ctx.plugin({ name: 'cron', inject, apply }, {})
  const result = await invoke(commands, 'every 5 minutes check')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /schedule-bundle/)
  await fiber.dispose()
})
