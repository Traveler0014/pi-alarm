/**
 * Alarm Extension — Timed reminders for pi
 *
 * Tools (agent-facing, KISS):
 * - `now`          — get current date/time (Node.js Date, cross-platform)
 * - `alarm_set`    — create a timed alarm (relative delay in seconds)
 * - `alarm_schedule` — create a timed alarm (absolute ISO 8601 timestamp)
 * - `alarm_list`   — list pending alarms
 * - `alarm_cancel` — cancel an alarm by ID
 *
 * Commands (user-facing):
 * - /alarm-set in <delay> <msg> | /alarm-set at <time> <msg>
 * - /alarm-list
 * - /alarm-cancel <id>
 * - /alarm-clear
 *
 * State is persisted via pi.appendEntry() and reconstructed on session_start
 * and session_tree. Overdue alarms are fired on restore if within expiresIn
 * tolerance, otherwise silently discarded.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────────

interface Alarm {
  id: number;
  message: string;
  triggerAt: number; // Unix ms
  expiresIn: number | "never"; // Seconds after triggerAt; restore beyond → discard
  status: "pending" | "fired" | "cancelled";
  createdAt: number; // Unix ms
}

interface AlarmState {
  alarms: Alarm[];
  nextId: number;
}

interface ParseResult {
  triggerAt: number;
  rest: string; // remaining text after the time portion
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_EXPIRES_IN_SEC = 300; // 5 minutes
const CUSTOM_TYPE = "alarm-state";
const MESSAGE_TYPE = "alarm";

/** Validate strict ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS(.ms)Z.
 *  Only UTC (Z suffix) is accepted for reliable cross-platform Date.parse. */
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/;

// ── Time Parsing ───────────────────────────────────────────────────────────

/** Parse relative time for "in" prefix: 30s, 5m, 1h30m, bare seconds */
function parseRelativeTime(input: string): ParseResult | null {
  const now = Date.now();
  const s = input.trimStart();
  let m: RegExpMatchArray | null;

  // 1h30m15s, 1h30m, 2h
  m = s.match(/^(\d+)h(?:(\d+)m)?(?:(\d+)s)?(?=\s|$)/);
  if (m) {
    const ms =
      (parseInt(m[1]) * 3600 + parseInt(m[2] || "0") * 60 + parseInt(m[3] || "0")) * 1000;
    return { triggerAt: now + ms, rest: s.slice(m[0].length).trim() };
  }

  // 5m30s, 5m
  m = s.match(/^(\d+)m(?:(\d+)s)?(?=\s|$)/);
  if (m) {
    const ms = (parseInt(m[1]) * 60 + parseInt(m[2] || "0")) * 1000;
    return { triggerAt: now + ms, rest: s.slice(m[0].length).trim() };
  }

  // 30s
  m = s.match(/^(\d+)s(?=\s|$)/);
  if (m) {
    return { triggerAt: now + parseInt(m[1]) * 1000, rest: s.slice(m[0].length).trim() };
  }

  // Bare number → seconds
  m = s.match(/^(\d+)(?=\s|$)/);
  if (m) {
    const sec = parseInt(m[1]);
    if (sec > 0 && sec < 31_536_000) {
      // < 1 year
      return { triggerAt: now + sec * 1000, rest: s.slice(m[0].length).trim() };
    }
  }

  return null;
}

/** Parse absolute time for "at" prefix: HH:MM, tomorrow HH:MM, ISO 8601 */
function parseAbsoluteTime(input: string): ParseResult | null {
  const now = new Date();
  let s = input.trimStart();

  // "tomorrow" / "tmr" prefix
  let baseDate = new Date(now);
  const tmrMatch = s.match(/^(?:tomorrow|tmr)\s+/i);
  if (tmrMatch) {
    baseDate.setDate(baseDate.getDate() + 1);
    s = s.slice(tmrMatch[0].length);
  }

  // HH:MM or HH:MM:SS, optional am/pm
  const timeMatch = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1]);
    const min = parseInt(timeMatch[2]);
    const sec = parseInt(timeMatch[3] || "0");
    const ampm = timeMatch[4]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    baseDate.setHours(h, min, sec, 0);
    if (!tmrMatch && baseDate.getTime() <= now.getTime()) {
      baseDate.setDate(baseDate.getDate() + 1);
    }
    return { triggerAt: baseDate.getTime(), rest: s.slice(timeMatch[0].length).trim() };
  }

  // ISO 8601 date or datetime
  const isoMatch = s.match(
    /^(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/,
  );
  if (isoMatch) {
    const ts = Date.parse(isoMatch[1]);
    if (!isNaN(ts)) {
      return { triggerAt: ts, rest: s.slice(isoMatch[0].length).trim() };
    }
  }

  return null;
}

/** Parse expiresIn string: "300" → 300, "never" → "never", anything else → default */
function parseExpiresIn(value: string | undefined): number | "never" {
  if (!value) return DEFAULT_EXPIRES_IN_SEC;
  if (value.toLowerCase() === "never") return "never";
  const num = parseInt(value, 10);
  return isNaN(num) || num <= 0 ? DEFAULT_EXPIRES_IN_SEC : num;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatLocalTime(ts: number): string {
  const d = new Date(ts);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const m = String(Math.abs(offset) % 60).padStart(2, "0");
  const iso = d.toISOString().replace("Z", "");
  return `${iso}${sign}${h}:${m}`;
}

function formatTriggerAt(triggerAt: number): string {
  return formatLocalTime(triggerAt);
}

function formatRemaining(triggerAt: number): string {
  const remaining = Math.max(0, Math.ceil((triggerAt - Date.now()) / 1000));
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Extension Entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // In-memory state
  let alarms: Alarm[] = [];
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let uiCtx: ExtensionContext | null = null;

  // ── State Management ─────────────────────────────────────────────────

  function persistState() {
    pi.appendEntry(CUSTOM_TYPE, {
      alarms: alarms.map((a) => ({ ...a })),
      nextId,
    } as AlarmState);
  }

  function reconstructState(ctx: ExtensionContext) {
    alarms = [];
    nextId = 1;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE) {
        const data = (entry as any).data as AlarmState;
        if (data) {
          alarms = data.alarms.map((a) => ({ ...a }));
          nextId = data.nextId;
        }
      }
    }
  }

  // ── Timer Management ─────────────────────────────────────────────────

  function scheduleAlarm(alarm: Alarm) {
    cancelTimer(alarm.id);
    const delay = Math.max(0, alarm.triggerAt - Date.now());
    if (delay <= 0) {
      fireAlarm(alarm.id);
      return;
    }
    const timerId = setTimeout(() => fireAlarm(alarm.id), delay);
    timers.set(alarm.id, timerId);
  }

  function cancelTimer(id: number) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function clearAllTimers() {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  }

  function fireAlarm(id: number) {
    const alarm = alarms.find((a) => a.id === id);
    if (!alarm || alarm.status !== "pending") return;

    alarm.status = "fired";
    timers.delete(id);

    const now = new Date();
    const content = alarm.message;

    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content,
        display: true,
        details: {
          alarmId: alarm.id,
          alarmMessage: alarm.message,
          firedAt: now.getTime(),
        },
      },
      { triggerTurn: true },
    );

    uiCtx?.ui.notify(`ALARM: ${alarm.message}`, "warning");
    persistState();
  }

  /** Create a new alarm, schedule it, persist, and update UI */
  function createAlarm(
    triggerAt: number,
    message: string,
    expiresIn: number | "never",
  ): Alarm {
    const alarm: Alarm = {
      id: nextId++,
      message,
      triggerAt,
      expiresIn,
      status: "pending",
      createdAt: Date.now(),
    };
    alarms.push(alarm);
    scheduleAlarm(alarm);
    persistState();
    return alarm;
  }

  // ── Session Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;

    reconstructState(ctx);

    const now = Date.now();

    // Handle overdue alarms
    for (const alarm of alarms) {
      if (alarm.status !== "pending") continue;
      const overdue = now - alarm.triggerAt;
      if (overdue <= 0) continue;

      if (alarm.expiresIn === "never") {
        fireAlarm(alarm.id);
      } else if (overdue <= alarm.expiresIn * 1000) {
        fireAlarm(alarm.id);
      } else {
        alarm.status = "cancelled";
      }
    }

    // Schedule remaining pending alarms
    for (const alarm of alarms) {
      if (alarm.status === "pending") {
        scheduleAlarm(alarm);
      }
    }

    persistState();
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructState(ctx);
    clearAllTimers();

    // On tree navigation, cancel overdue alarms (don't re-fire)
    const now = Date.now();
    for (const alarm of alarms) {
      if (alarm.status === "pending") {
        if (alarm.triggerAt <= now) {
          alarm.status = "cancelled";
        } else {
          scheduleAlarm(alarm);
        }
      }
    }

    persistState();
  });

  pi.on("session_shutdown", async () => {
    clearAllTimers();
    uiCtx = null;
  });

  // ── Tool: now ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "alarm_now",
    label: "Alarm Now",
    description:
      "Get the current date and time. Call this before setting alarms or scheduling tasks to determine the correct time.",
    promptSnippet: "Get current date and time",
    parameters: Type.Object({}),

    async execute() {
      const now = new Date();
      return {
        content: [{ type: "text", text: `Current time: ${formatLocalTime(now.getTime())}` }],
        details: {
          iso: now.toISOString(),
          local: formatLocalTime(now.getTime()),
          timestamp: now.getTime(),
          timezoneOffsetMin: now.getTimezoneOffset(),
        },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("alarm_now")), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as { local?: string } | undefined;
      return new Text(theme.fg("muted", details?.local ?? ""), 0, 0);
    },
  });

  // ── Tool: alarm-set (relative delay) ────────────────────────────────

  pi.registerTool({
    name: "alarm_set",
    label: "Alarm Set",
    description:
      "Create a timed alarm with a relative delay in seconds from now. Use alarm_now tool first to check the current time. For absolute times, use alarm_schedule.",
    promptSnippet: "Create a timed alarm (relative delay in seconds)",
    promptGuidelines: [
      "Use alarm_now tool to get the current time before calling alarm_set.",
      "Use alarm_set for relative times (delay in seconds from now).",
      "Use alarm_schedule for absolute times (ISO 8601 timestamp).",
      "Use alarm_list to check pending alarms. Use alarm_cancel to cancel one.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "Reminder content" }),
      delay: Type.Number({ description: "Seconds from now to trigger the alarm. Must be positive." }),
      expiresIn: Type.Optional(
        Type.String({
          description:
            "Expiry tolerance on session restore: number of seconds or 'never'. Default: '300' (5 min). Use 'never' to always fire regardless of delay.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const now = new Date();

      if (!params.message) {
        return {
          content: [
            { type: "text", text: `Error: 'message' is required.\nCurrent time: ${formatLocalTime(now.getTime())}` },
          ],
          details: { error: "message required" },
        };
      }

      if (params.delay === undefined || params.delay === null) {
        return {
          content: [
            { type: "text", text: `Error: 'delay' is required.\nCurrent time: ${formatLocalTime(now.getTime())}` },
          ],
          details: { error: "delay required" },
        };
      }

      if (typeof params.delay !== "number" || params.delay <= 0) {
        return {
          content: [
            { type: "text", text: `Error: 'delay' must be a positive number (seconds).\nCurrent time: ${formatLocalTime(now.getTime())}` },
          ],
          details: { error: "invalid delay" },
        };
      }

      const triggerAt = now.getTime() + params.delay * 1000;
      const expiresIn = parseExpiresIn(params.expiresIn);
      const alarm = createAlarm(triggerAt, params.message, expiresIn);

      return {
        content: [
          {
            type: "text",
            text:
              `Alarm #${alarm.id} set for ${formatTriggerAt(triggerAt)} ` +
              `(${formatRemaining(triggerAt)} from now): ${params.message}` +
              (expiresIn === "never" ? " [never expires]" : ` [expires in ${expiresIn}s]`),
          },
        ],
        details: { alarmId: alarm.id, triggerAt, message: params.message },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm_set"));
      text += "\n  " + theme.fg("dim", "message: ") + theme.fg("text", `"${args.message}"`);
      text += "\n  " + theme.fg("dim", "delay: ") + theme.fg("accent", `${args.delay}s`);
      if (args.expiresIn) {
        text += "\n  " + theme.fg("dim", "expiresIn: ") + theme.fg("muted", args.expiresIn);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as
        | { alarmId?: number; triggerAt?: number; message?: string }
        | undefined;
      if (!details?.alarmId) {
        const t = result.content[0];
        return new Text(theme.fg("error", t?.type === "text" ? t.text : "Error"), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", `#${details.alarmId}`) +
          theme.fg("muted", ` ${details.message} → ${formatTriggerAt(details.triggerAt!)}`),
        0,
        0,
      );
    },
  });

  // ── Tool: alarm_schedule (absolute ISO 8601) ───────────────────────

  pi.registerTool({
    name: "alarm_schedule",
    label: "Alarm Schedule",
    description:
      "Create a timed alarm at a specific absolute time. The timestamp must be ISO 8601 format and in the future. Use alarm_now tool first to check current time.",
    promptSnippet: "Create a timed alarm (absolute ISO 8601 timestamp)",
    promptGuidelines: [
      "STEP 1: Call alarm_now to get current time. Note the timestamp in the output (it includes local offset like +08:00).",
      "STEP 2: Convert the user's desired local time to UTC by subtracting the offset. e.g. if alarm_now shows +08:00 and user wants 5pm local, compute 17:00 - 08:00 = 09:00Z → '2026-06-25T09:00:00Z'.",
      "STEP 3: Use the resulting UTC timestamp (Z suffix) as the 'at' parameter. Always use Z, never ±HHMM.",
      "Date-only format (2026-06-26) is also accepted, interpreted as midnight UTC.",
      "The timestamp must be in the future; past timestamps are rejected.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "Reminder content" }),
      at: Type.String({
        description:
          "ISO 8601 UTC timestamp (e.g., 2026-06-26T14:30:00Z or 2026-06-26). Z suffix only. Must be in the future.",
      }),
      expiresIn: Type.Optional(
        Type.String({
          description:
            "Expiry tolerance on session restore: number of seconds or 'never'. Default: '300' (5 min). Use 'never' to always fire regardless of delay.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const now = new Date();

      if (!params.message) {
        return {
          content: [
            { type: "text", text: `Error: 'message' is required.\nCurrent time: ${formatLocalTime(now.getTime())}` },
          ],
          details: { error: "message required" },
        };
      }

      if (!params.at || !ISO_PATTERN.test(params.at.trim())) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: 'at' must be a valid ISO 8601 UTC timestamp (e.g., 2026-06-26T14:30:00Z).\n` +
                `Current time: ${formatLocalTime(now.getTime())}`,
            },
          ],
          details: { error: "invalid timestamp format" },
        };
      }

      const triggerAt = Date.parse(params.at);
      if (isNaN(triggerAt)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: could not parse '${params.at}'. Use UTC format with Z suffix (e.g., 2026-06-26T14:30:00Z).\n` +
                `Current time: ${formatLocalTime(now.getTime())}`,
            },
          ],
          details: { error: "unparseable timestamp" },
        };
      }

      if (triggerAt <= now.getTime()) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: timestamp '${params.at}' is in the past.\n` +
                `  Parsed UTC:  ${new Date(triggerAt).toISOString()}\n` +
                `  Current UTC: ${now.toISOString()}\n` +
                `  Current local: ${formatLocalTime(now.getTime())}\n` +
                `Please call alarm_now to check the current time, then convert your desired local time to UTC by subtracting the offset.`,
            },
          ],
          details: { error: "past timestamp", triggerAt, now: now.getTime() },
        };
      }

      const expiresIn = parseExpiresIn(params.expiresIn);
      const alarm = createAlarm(triggerAt, params.message, expiresIn);

      return {
        content: [
          {
            type: "text",
            text:
              `Alarm #${alarm.id} set for ${formatTriggerAt(triggerAt)} ` +
              `(${formatRemaining(triggerAt)} from now): ${params.message}` +
              (expiresIn === "never" ? " [never expires]" : ` [expires in ${expiresIn}s]`),
          },
        ],
        details: { alarmId: alarm.id, triggerAt, message: params.message },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm_schedule"));
      text += "\n  " + theme.fg("dim", "message: ") + theme.fg("text", `"${args.message}"`);
      text += "\n  " + theme.fg("dim", "at: ") + theme.fg("accent", args.at);
      if (args.expiresIn) {
        text += "\n  " + theme.fg("dim", "expiresIn: ") + theme.fg("muted", args.expiresIn);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as
        | { alarmId?: number; triggerAt?: number; message?: string }
        | undefined;
      if (!details?.alarmId) {
        const t = result.content[0];
        return new Text(theme.fg("error", t?.type === "text" ? t.text : "Error"), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", `#${details.alarmId}`) +
          theme.fg("muted", ` ${details.message} → ${formatTriggerAt(details.triggerAt!)}`),
        0,
        0,
      );
    },
  });

  // ── Tool: alarm-list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "alarm_list",
    label: "Alarm List",
    description: "List all pending alarms.",
    promptSnippet: "List pending alarms",
    parameters: Type.Object({}),

    async execute() {
      const pending = alarms.filter((a) => a.status === "pending");
      const text = pending.length
        ? pending
            .map(
              (a) =>
                `#${a.id}: "${a.message}" — in ${formatRemaining(a.triggerAt)} (${formatTriggerAt(a.triggerAt)})`,
            )
            .join("\n")
        : "No pending alarms";
      return {
        content: [{ type: "text", text }],
        details: { pending: pending.map((a) => ({ id: a.id, message: a.message, triggerAt: a.triggerAt })) },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("alarm_list")), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { pending?: Array<{ id: number; message: string; triggerAt: number }> }
        | undefined;
      const pending = details?.pending ?? [];
      if (pending.length === 0)
        return new Text(theme.fg("dim", "No pending alarms"), 0, 0);
      let text = theme.fg("muted", `${pending.length} alarm(s):`);
      const show = expanded ? pending : pending.slice(0, 5);
      for (const a of show) {
        text += `\n  ${theme.fg("accent", `#${a.id}`)} ${theme.fg("text", a.message)} ${theme.fg("dim", formatTriggerAt(a.triggerAt))}`;
      }
      if (!expanded && pending.length > 5) {
        text += theme.fg("dim", `\n  ... ${pending.length - 5} more`);
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Tool: alarm-cancel ───────────────────────────────────────────────

  pi.registerTool({
    name: "alarm_cancel",
    label: "Alarm Cancel",
    description: "Cancel a pending alarm by its ID. Get the ID from alarm_list.",
    promptSnippet: "Cancel an alarm by ID",
    promptGuidelines: [
      "Use alarm_list first to find the alarm ID, then use alarm_cancel with that ID.",
    ],
    parameters: Type.Object({
      id: Type.Number({ description: "Alarm ID to cancel" }),
    }),

    async execute(_toolCallId, params) {
      const alarm = alarms.find((a) => a.id === params.id);
      if (!alarm) {
        return {
          content: [{ type: "text", text: `Alarm #${params.id} not found` }],
          details: { error: "not found" },
        };
      }
      if (alarm.status !== "pending") {
        return {
          content: [
            { type: "text", text: `Alarm #${alarm.id} is already ${alarm.status}` },
          ],
          details: { error: "not pending" },
        };
      }

      alarm.status = "cancelled";
      cancelTimer(alarm.id);
      persistState();

      return {
        content: [{ type: "text", text: `Alarm #${alarm.id} cancelled: "${alarm.message}"` }],
        details: { id: alarm.id },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm_cancel"));
      text += "\n  " + theme.fg("dim", "id: ") + theme.fg("accent", `#${args.id}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as { error?: string; id?: number } | undefined;
      if (details?.error) {
        const t = result.content[0];
        return new Text(
          theme.fg("error", t?.type === "text" ? t.text : "Error"),
          0,
          0,
        );
      }
      return new Text(
        theme.fg("success", "✓ Cancelled ") + theme.fg("dim", `#${details?.id}`),
        0,
        0,
      );
    },
  });

  // ── Commands ─────────────────────────────────────────────────────────

  // /alarm-set in <delay> <msg> | /alarm-set at <time> <msg>
  pi.registerCommand("alarm-set", {
    description:
      "Set a timed alarm — /alarm-set in <delay> <msg> | /alarm-set at <time> <msg>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify(
          "Usage: /alarm-set in <delay> <msg> | /alarm-set at <time> <msg>",
          "warning",
        );
        return;
      }

      // /alarm-set in <delay> <msg>
      const inMatch = input.match(/^in\s+(.+)$/i);
      if (inMatch) {
        const rest = inMatch[1].trim();
        const parsed = parseRelativeTime(rest);
        if (parsed) {
          const message = parsed.rest || "Alarm";
          const alarm = createAlarm(parsed.triggerAt, message, DEFAULT_EXPIRES_IN_SEC);
          ctx.ui.notify(
            `⏰ Alarm #${alarm.id} set in ${formatRemaining(parsed.triggerAt)}: ${message}`,
            "info",
          );
          return;
        }

        // Fallback to LLM
        if (ctx.isIdle()) {
          pi.sendUserMessage(
            `The user wants to set an alarm with relative time: "${rest}". ` +
              `Please use the alarm_now tool to check the current time, ` +
              `then use the alarm_set tool to set it.`,
          );
        } else {
          ctx.ui.notify("Agent is busy, try again in a moment", "warning");
        }
        return;
      }

      // /alarm-set at <time> <msg>
      const atMatch = input.match(/^at\s+(.+)$/i);
      if (atMatch) {
        const rest = atMatch[1].trim();
        const parsed = parseAbsoluteTime(rest);
        if (parsed) {
          const message = parsed.rest || "Alarm";
          const alarm = createAlarm(parsed.triggerAt, message, DEFAULT_EXPIRES_IN_SEC);
          ctx.ui.notify(
            `⏰ Alarm #${alarm.id} set for ${formatTriggerAt(parsed.triggerAt)}: ${message}`,
            "info",
          );
          return;
        }

        // Fallback to LLM
        if (ctx.isIdle()) {
          pi.sendUserMessage(
            `The user wants to set an alarm at a specific time: "${rest}". ` +
              `Please use the alarm_now tool to check the current time, ` +
              `then use the alarm_schedule tool to set it.`,
          );
        } else {
          ctx.ui.notify("Agent is busy, try again in a moment", "warning");
        }
        return;
      }

      ctx.ui.notify(
        "Usage: /alarm-set in <delay> <msg> | /alarm-set at <time> <msg>",
        "warning",
      );
    },
  });

  // /alarm-list
  pi.registerCommand("alarm-list", {
    description: "List all pending alarms",
    handler: async (_args, ctx) => {
      const pending = alarms.filter((a) => a.status === "pending");
      if (pending.length === 0) {
        ctx.ui.notify("No pending alarms", "info");
        return;
      }
      const lines = pending.map(
        (a) => `#${a.id}: "${a.message}" — in ${formatRemaining(a.triggerAt)}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /alarm-cancel <id>
  pi.registerCommand("alarm-cancel", {
    description: "Cancel an alarm by ID — /alarm-cancel <id>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /alarm-cancel <id>", "warning");
        return;
      }

      const id = parseInt(input, 10);
      if (isNaN(id)) {
        ctx.ui.notify("Usage: /alarm-cancel <id>", "warning");
        return;
      }

      const alarm = alarms.find((a) => a.id === id);
      if (!alarm || alarm.status !== "pending") {
        ctx.ui.notify(`Alarm #${id} not found or not pending`, "warning");
        return;
      }

      alarm.status = "cancelled";
      cancelTimer(id);
      persistState();
      ctx.ui.notify(`Alarm #${id} cancelled`, "info");
    },
  });

  // /alarm-clear
  pi.registerCommand("alarm-clear", {
    description: "Cancel all pending alarms",
    handler: async (_args, ctx) => {
      let count = 0;
      for (const a of alarms) {
        if (a.status === "pending") {
          a.status = "cancelled";
          cancelTimer(a.id);
          count++;
        }
      }
      if (count === 0) {
        ctx.ui.notify("No pending alarms to clear", "info");
        return;
      }
      persistState();
      ctx.ui.notify(`Cleared ${count} alarm${count > 1 ? "s" : ""}`, "info");
    },
  });

  // ── Message Renderer ─────────────────────────────────────────────────

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as
      | { alarmId?: number; firedAt?: number }
      | undefined;
    const content = typeof message.content === "string" ? message.content : "";

    // Label line (like user message "You" header but for alarms)
    let text =
      theme.fg("customMessageLabel", "ALARM");

    // Main content: bold, same text color as custom messages
    text += "\n" + theme.fg("customMessageText", theme.bold(content));

    // Footer: alarm metadata (secondary, dimmed)
    const meta: string[] = [];
    if (details?.alarmId) meta.push(`#${details.alarmId}`);
    if (details?.firedAt)
      meta.push(`@ ${formatLocalTime(details.firedAt)}`);
    if (meta.length > 0) {
      text += "\n" + theme.fg("dim", meta.join(" "));
    }

    // Bubble background — same style as user/custom messages, distinct color
    return new Text(text, 1, 0, (s) => theme.bg("customMessageBg", s));
  });
}
