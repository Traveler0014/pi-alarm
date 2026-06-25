# alarm

Timed alarms and reminders for pi — agent-callable tools and user slash commands.

## Tools (agent-facing, snake_case)

Each tool does one thing: relative vs absolute time are separate tools.

### `now`

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

### `alarm_set_at`

Create a timed alarm at an **absolute ISO 8601 timestamp**. Strictly validated — must be valid ISO format and in the future.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | ✅ | Reminder content |
| `at` | string | ✅ | ISO 8601 (e.g. `2026-06-26T14:30:00Z`, `2026-06-26T14:30:00+08:00`, or date-only `2026-06-26`). Must be in the future. |
| `expiresIn` | string | no (default `"300"`) | Seconds or `"never"` — session restore expiry |

```
alarm_set_at(message="Team meeting", at="2026-06-26T14:30:00Z")
alarm_set_at(message="Production deploy", at="2026-06-26T09:00:00+08:00")
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

## Commands (user-facing, kebab-case)

### `/alarm-set`

Set a timed alarm with semantic time specification.

```
/alarm-set in <delay> <message>
/alarm-set at <time> <message>
```

**Relative (`in`):** `30s`, `5m`, `1h30m`, `2h15m30s`, `300` (seconds)

**Absolute (`at`):** `14:30`, `2:30pm`, `tomorrow 9:00`, `2026-06-26T14:30:00Z`

```bash
/alarm-set in 5m Check build results
/alarm-set in 1h30m Take a break
/alarm-set at 14:30 Team meeting
/alarm-set at tomorrow 9:00 Deploy to production
```

If time parsing fails, falls back to the LLM agent (uses `now` + `alarm_set` for `in`, `now` + `alarm_set_at` for `at`).

### `/alarm-list`

List all pending alarms.

### `/alarm-cancel`

Cancel an alarm by ID.

```bash
/alarm-cancel 2
```

### `/alarm-clear`

Cancel all pending alarms.

```bash
/alarm-clear
```

## UI

### Widget

```
⏰ Next: 4m 32s — Check build results
```

### Status

```
⏰ 3 alarms
```

### Fired alarms

Reminder content displayed prominently, alarm metadata as dimmed footer:

```
⏰ Check build results
  #2 @ 2026-06-25T15:35:00.000Z
```

## Install

```bash
pi install https://github.com/Traveler0014/pi-extension-template.git
```

## License

MIT
