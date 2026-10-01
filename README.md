# dsh-cron

Run a prompt on a schedule in a DeepSeek Harness session: `/cron` takes a cron
expression or plain English like "every weekday at 9am", parses it in code,
and hands the timer to the harness schedule service, which keeps it across
restarts and wakes the session when it is due. Only text no grammar reads goes
to the model.

## What you get

```
/cron */15 9-17 * * 1-5 check the deploy      # cron; MON-FRI, JAN and @daily work too
/cron every 5 minutes check the queue         # fixed interval (at least one minute)
/cron 5m check the build                      # the same, as /loop takes it
/cron every day at 9am standup notes          # daily wall-clock time
/cron every mon, wed and fri at 18:00 gym log # weekly
/cron monthly on the 1st at 9am pay rent      # monthly, as cron
/cron in 10 minutes check the oven            # once, after a delay
/cron tomorrow at 9:30 review the PR          # once, at a time
/cron every day at 9 Europe/Berlin standup    # an explicit zone (the host zone otherwise)
/cron list                                    # this session's schedules
/cron delete 2                                # by list number, by id, or all
```

Each run arrives in the session as a message with the prompt, the way a
`/loop` round does.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start.

```sh
dsh plugin --profile web add github:maci0/dsh-cron#v0.1.1 @deepseek-ai/dsh-experimental-schedule-bundle@0.2.0-rc.2
```

Pin a release tag: a bare `github:` spec floats on `main`. To upgrade, run the same command with the newer tag, then restart `dsh web` (bundle layers compose at boot).

The timers belong to the harness schedule service, which ships in the optional
`@deepseek-ai/dsh-experimental-schedule-bundle` (also on the Plugins page,
Official group). Without it `/cron` answers an error that names the bundle.

## How it works

`/cron <schedule> <prompt>` tries, in order:

1. **Cron.** When the first five tokens are cron-shaped (numbers, `*`, month or
   day names, `,` `-` `/`), they are read as the service's five-field Vixie
   dialect: names become numbers and `@hourly`, `@daily`, `@weekly`,
   `@monthly`, `@yearly` become their expressions. A field the dialect cannot
   take (out of range, `L`, `W`, `#`, `?`, a zero step, an inverted range) is
   an error naming the field, never a guess.
2. **Phrases.** A small English grammar: `every N minutes|hours|days|weeks`
   and the compact `5m`/`2h`/`1d` (fixed intervals); `hourly`, `every hour at
   :15`; `every day|daily`, a weekday, a list (`mon, wed and fri`), a range
   (`monday to friday`), `weekdays`, `weekends`, each optionally `at <time>`
   (weekly or daily wall-clock); `monthly on the 15th at 18:30` (cron);
   `in 10 minutes`, `at 3pm`, `today|tomorrow at <time>`, `on 2026-12-24 at
   18:00` (once). Times are `9`, `9:30`, `9am`, `7:30pm`, `21:00`, `noon`,
   `midnight`; a day phrase with no time means 09:00. A trailing IANA zone or
   `UTC` overrides the host zone.
3. **The model.** Anything else, including a recognized start followed by a
   qualifier the grammar does not read (`every 15 minutes during business
   hours …`), is sent to the agent as a message asking it to set the schedule
   up with its `schedule_create` tool and report what it created.

The prompt is what follows the schedule (a leading `:` or `to` is dropped); the
task title is its first line, cut to 80 characters. The reply names the
schedule and its next run in the host zone. The service validates again and
its refusal (for example a date that never occurs) is reported with its code.

## Limits

- Recurring intervals are at least one minute, the service's floor.
- The phrase grammar is English only; other languages reach the model.
- The model fallback runs as an agent turn, so it needs a working model route,
  and its result is whatever the agent creates (it reports it in the session).

## Development

```sh
bun test   # parser table, the /cron handler over a fake schedule service, and a real Cordis mount
```

For local development, install the checkout into a profile with
`dsh plugin --profile <name> add <path-to-checkout>`.

dsh loads plugins on Node `^22.19.0 || >=24.0.0`; development and tests run on bun.

## Licence

MIT. See [LICENSE](LICENSE).
