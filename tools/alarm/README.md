# alarm

Timed alarms and reminders for pi — agent-callable tools and user slash commands.

## Naming convention

| Layer | Style | Format | Example |
|-------|-------|--------|---------|
| Tool (agent) | `snake_case` | `<prefix>_<verb>` | `alarm_set`, `alarm_schedule`, `alarm_list`, `alarm_cancel` |
| Command (user) | `kebab-case` | `/<prefix>-<verb>` | `/alarm-set`, `/alarm-in`, `/alarm-at`, `/alarm-list`, `/alarm-cancel` |

- **prefix**: identifies the source extension (`alarm`)
- **verb**: a single action word (`set`, `in`, `at`, `schedule`, `list`, `cancel`)

## Tools

### `alarm_now`

Get the current date and time. No parameters.

### `alarm_set`

Create a timed alarm with a **relative delay** (seconds from now).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | ✅ | Reminder content |
| `delay` | number | ✅ | Seconds from now. Must be positive. |
| `expiresIn` | string | no (default `"300"`) | Seconds or `"never"` — session restore expiry |

```
alarm_set(message="Check build results", delay=300)
alarm_set(message="Deploy complete", delay=600, expiresIn="never")
```

### `alarm_schedule`

Create a timed alarm at an **absolute ISO 8601 timestamp**. Strictly validated — must be valid ISO format and in the future.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | ✅ | Reminder content |
| `at` | string | ✅ | ISO 8601 (e.g. `2026-06-26T14:30:00Z`, `2026-06-26T14:30:00+08:00`, or date-only `2026-06-26`). Must be in the future. |
| `expiresIn` | string | no (default `"300"`) | Seconds or `"never"` — session restore expiry |

```
alarm_schedule(message="Team meeting", at="2026-06-26T14:30:00Z")
alarm_schedule(message="Production deploy", at="2026-06-26T09:00:00+08:00")
```

### `alarm_list`

List all pending alarms. No parameters.

### `alarm_cancel`

Cancel a pending alarm by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | ✅ | Alarm ID (from `alarm_list`) |

```
alarm_cancel(id=2)
```

**Expiry on session restore (`expiresIn`):**

- `"300"` (default) — If overdue by >5 min when session resumes, silently discard
- `"never"` — Always fire on resume, regardless of delay

## Commands

### `/alarm-set`

Forward natural language to the LLM, which uses `alarm_now` + `alarm_set` / `alarm_schedule` to create the alarm.

```bash
/alarm-set remind me to check the logs in 10 minutes
```

### `/alarm-in`

Set an alarm with a **relative delay**. First token is the delay, rest is the message.

```
/alarm-in <delay> <message>
```

**Delay formats:** `30s`, `5m`, `1h30m`, `2h15m30s`, `300` (bare seconds)

```bash
/alarm-in 5m Check build results
/alarm-in 1h30m Take a break
/alarm-in 300s Coffee ready
```

If parsing fails, falls back to LLM.

### `/alarm-at`

Set an alarm at an **absolute time**. First token(s) are the time, rest is the message.

```
/alarm-at <time> <message>
```

**Time formats:** `14:30`, `2:30pm`, `tomorrow 9:00`, `2026-06-26T14:30:00Z`

```bash
/alarm-at 14:30 Team meeting
/alarm-at tomorrow 9:00 Deploy to production
/alarm-at 2026-06-26T14:30:00Z Release deadline
```

If parsing fails, falls back to LLM.

### Status Bar

A persistent status indicator in the footer shows the count of pending alarms (e.g. `⏰ 2 pending`). It disappears when no alarms are pending.

### `/alarm-list`

List all pending alarms.

### `/alarm-cancel`

Cancel an alarm by ID.

```bash
/alarm-cancel 2
```

### `/alarm-clear`

Cancel all pending alarms.

## Install

```bash
pi install https://github.com/Traveler0014/pi-alarm.git
```

## License

MIT
