/**
 * Alarm Extension — Timed reminders for pi
 *
 * Tools (agent-facing, KISS):
 * - `alarm_now`   — get current date/time (Node.js Date, cross-platform)
 * - `alarm_set`    — create a timed alarm (absolute ISO 8601 timestamp)
 * - `alarm_wait`   — create a timed alarm (relative seconds from now)
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
import { AlarmManager, type Alarm, type AlarmState } from "./manager.js";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_EXPIRES_IN_SEC = 300;
const CUSTOM_TYPE = "alarm-state";
const MESSAGE_TYPE = "alarm";

// ── Time Parsing ───────────────────────────────────────────────────────────

interface ParseResult {
  triggerAt: number;
  rest: string; // remaining text after the time portion
}

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
  const absOff = Math.abs(offset);
  const offH = String(Math.floor(absOff / 60)).padStart(2, "0");
  const offM = String(absOff % 60).padStart(2, "0");

  // Use local time components so the string round-trips correctly
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${sign}${offH}:${offM}`;
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
  // ── State ─────────────────────────────────────────────────────────────

  let manager: AlarmManager | null = null;
  let uiCtx: ExtensionContext | null = null;

  function getManager(): AlarmManager {
    if (!manager) {
      manager = new AlarmManager(fireAlarm);
    }
    return manager;
  }

  // ── State Persistence ─────────────────────────────────────────────────

  function persistState() {
    if (!manager) return;
    pi.appendEntry(CUSTOM_TYPE, manager.serialize());
  }

  function updateStatusBar() {
    if (!uiCtx || !manager) return;
    const count = manager.pendingCount;
    if (count > 0) {
      uiCtx.ui.setStatus("alarm", uiCtx.ui.theme.fg("warning", `${count} alarm${count > 1 ? "s" : ""}`));
    } else {
      uiCtx.ui.setStatus("alarm", undefined);
    }
  }

  function fireAlarm(alarm: Alarm): void {
    if (alarm.status !== "pending") return;
    alarm.status = "fired";

    const now = new Date();
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: alarm.message,
        display: true,
        details: {
          alarmId: alarm.id.slice(0, 8),
          alarmLabel: alarm.label,
          alarmMessage: alarm.message,
          firedAt: now.getTime(),
        },
      },
      { triggerTurn: true },
    );

    persistState();
    updateStatusBar();
  }

  // ── Session Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    const mgr = getManager();

    // Reconstruct alarms from persisted session entries
    const states: AlarmState[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE) {
        const data = (entry as any).data as AlarmState;
        if (data) states.push(data);
      }
    }
    // Use the latest state
    if (states.length > 0) {
      mgr.reconstruct(states[states.length - 1]);
    }

    persistState();
    updateStatusBar();
  });

  pi.on("session_tree", async (_event, ctx) => {
    const mgr = getManager();
    mgr.destroy();
    manager = new AlarmManager(fireAlarm);

    const states: AlarmState[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && (entry as any).customType === CUSTOM_TYPE) {
        const data = (entry as any).data as AlarmState;
        if (data) states.push(data);
      }
    }
    if (states.length > 0) {
      manager.reconstructSilent(states[states.length - 1]);
    }

    persistState();
    updateStatusBar();
  });

  pi.on("session_shutdown", async () => {
    manager?.destroy();
    manager = null;
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

  // ── Tool: alarm_wait (relative) ───────────────────────────────────

  pi.registerTool({
    name: "alarm_wait",
    label: "Alarm Wait",
    description:
      "Wait for a specified duration before being re-awakened. Use alarm_now tool first to check the current time. For absolute times, use alarm_set.",
    promptSnippet: "Wait: alarm_wait(seconds=N, message?, label?, expiresIn?)",
    promptGuidelines: [
      "Use alarm_now tool to get the current time before calling alarm_wait.",
      "Use alarm_wait for relative times (delay in seconds from now).",
      "Use alarm_set for absolute times (ISO 8601 timestamp).",
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
      const mgr = getManager();
      const alarm = mgr.setRelative(params.delay, params.message, expiresIn, params.label);
      persistState();
      updateStatusBar();

      return {
        content: [
          {
            type: "text",
            text:
              `Alarm #${alarm.id.slice(0, 8)} set for ${formatTriggerAt(triggerAt)} ` +
              `(${formatRemaining(triggerAt)} from now): ${params.message}` +
              (params.label ? ` [${params.label}]` : "") +
              (expiresIn === "never" ? " [never expires]" : ` [expires in ${expiresIn}s]`),
          },
        ],
        details: { alarmId: alarm.id.slice(0, 8), triggerAt, message: params.message, label: params.label },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm_wait"));
      text += "\n  " + theme.fg("dim", "message: ") + theme.fg("text", `"${args.message}"`);
      if (args.label) text += "\n  " + theme.fg("dim", "label: ") + theme.fg("muted", args.label);
      text += "\n  " + theme.fg("dim", "delay: ") + theme.fg("accent", `${args.delay}s`);
      if (args.expiresIn) {
        text += "\n  " + theme.fg("dim", "expiresIn: ") + theme.fg("muted", args.expiresIn);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as
        | { alarmId?: string; triggerAt?: number; message?: string }
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

  // ── Tool: alarm_set (absolute) ────────────────────────────────────

  pi.registerTool({
    name: "alarm_set",
    label: "Alarm Set",
    description:
      "Schedule an alarm at an absolute date/time (ISO 8601). When the alarm fires, a message will be injected to wake you up. Use alarm_now to get the current time before computing the target time.",
    promptSnippet: "Set alarm: alarm_set(at='ISO datetime', message?, label?, expiresIn?)",
    promptGuidelines: [
      "Call alarm_now first to get the current time and local offset (e.g., +08:00).",
      "Use the offset from alarm_now to construct the timestamp. e.g., if alarm_now shows +08:00 and the user wants 5pm local: '2026-06-25T17:00:00+08:00'.",
      "You may also use Z suffix for UTC: '2026-06-25T09:00:00Z'. Date-only format (2026-06-26) = midnight UTC.",
      "Both 'Z', '+HH:MM', and '+HHMM' formats are accepted by Date.parse.",
      "The timestamp must be in the future; past timestamps are rejected with diagnostic info.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "Reminder content" }),
      at: Type.String({
        description:
          "ISO 8601 timestamp (e.g., 2026-06-26T14:30:00Z, 2026-06-26T14:30:00+08:00, or date-only 2026-06-26). Must be in the future.",
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

      if (!params.at || !params.at.trim()) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: 'at' is required. Please provide an ISO 8601 UTC timestamp (e.g., 2026-06-26T14:30:00Z).\n` +
                `Current time: ${formatLocalTime(now.getTime())}`,
            },
          ],
          details: { error: "at required" },
        };
      }

      // Strict ISO 8601 format validation
      const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      const atTrimmed = params.at.trim();
      if (!ISO_PATTERN.test(atTrimmed)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: invalid ISO 8601 format '${params.at}'. Expected: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS±HH:MM.\n` +
                `Current time: ${formatLocalTime(now.getTime())}`,
            },
          ],
          details: { error: "invalid ISO format" },
        };
      }

      const triggerAt = Date.parse(atTrimmed);
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
      const mgr = getManager();
      const alarm = mgr.setAbsolute(new Date(triggerAt), params.message, expiresIn, params.label);
      persistState();
      updateStatusBar();

      return {
        content: [
          {
            type: "text",
            text:
              `Alarm #${alarm.id.slice(0, 8)} set for ${formatTriggerAt(triggerAt)} ` +
              `(${formatRemaining(triggerAt)} from now): ${params.message}` +
              (params.label ? ` [${params.label}]` : "") +
              (expiresIn === "never" ? " [never expires]" : ` [expires in ${expiresIn}s]`),
          },
        ],
        details: { alarmId: alarm.id.slice(0, 8), triggerAt, message: params.message, label: params.label },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm_set"));
      text += "\n  " + theme.fg("dim", "message: ") + theme.fg("text", `"${args.message}"`);
      if (args.label) text += "\n  " + theme.fg("dim", "label: ") + theme.fg("muted", args.label);
      text += "\n  " + theme.fg("dim", "at: ") + theme.fg("accent", args.at);
      if (args.expiresIn) {
        text += "\n  " + theme.fg("dim", "expiresIn: ") + theme.fg("muted", args.expiresIn);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as
        | { alarmId?: string; triggerAt?: number; message?: string }
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
      const mgr = getManager();
      const pending = mgr.list().filter((a) => a.status === "pending");
      const text = pending.length
        ? pending
            .map(
              (a) =>
                `#${a.id.slice(0, 8)}${a.label ? ` [${a.label}]` : ""}: "${a.message}" — in ${formatRemaining(a.triggerAt)} (${formatTriggerAt(a.triggerAt)})`,
            )
            .join("\n")
        : "No pending alarms";
      return {
        content: [{ type: "text", text }],
        details: { pending: pending.map((a) => ({ id: a.id.slice(0, 8), message: a.message, triggerAt: a.triggerAt, label: a.label })) },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("alarm_list")), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { pending?: Array<{ id: string; message: string; triggerAt: number; label?: string }> }
        | undefined;
      const pending = details?.pending ?? [];
      if (pending.length === 0)
        return new Text(theme.fg("dim", "No pending alarms"), 0, 0);
      let text = theme.fg("muted", `${pending.length} alarm(s):`);
      const show = expanded ? pending : pending.slice(0, 5);
      for (const a of show) {
        text += `\n  ${theme.fg("accent", `#${a.id.slice(0, 8)}`)}${a.label ? theme.fg("muted", ` [${a.label}]`) : ""} ${theme.fg("text", a.message)} ${theme.fg("dim", formatTriggerAt(a.triggerAt))}`;
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
    description: "Cancel an active alarm or timer by its id or label. Use alarm_list to find alarm ids.",
    promptSnippet: "Cancel alarm: alarm_cancel(alarm_id='...') or alarm_cancel(label='...')",
    promptGuidelines: [
      "Use alarm_cancel when the user no longer needs a scheduled alarm or timer.",
    ],
    parameters: Type.Object({
      alarm_id: Type.Optional(Type.String({ description: "ID of the alarm to cancel (from alarm_list)." })),
      label: Type.Optional(Type.String({ description: "Cancel all alarms with this label." })),
    }),

    async execute(_toolCallId, params) {
      const mgr = getManager();

      if (params.alarm_id) {
        // Find by prefix match (agent sees truncated IDs)
        const matches = mgr.list().filter((a) => a.id.startsWith(params.alarm_id));
        if (matches.length === 0) {
          return { content: [{ type: "text", text: `Alarm "${params.alarm_id}" not found` }], details: { error: "not found" } };
        }
        mgr.cancel(matches[0].id);
        persistState();
        updateStatusBar();
        return {
          content: [{ type: "text", text: `Cancelled alarm "${params.alarm_id.slice(0, 8)}": ${matches[0].message}` }],
          details: { id: params.alarm_id.slice(0, 8) },
        };
      }

      if (params.label) {
        const count = mgr.cancelByLabel(params.label);
        persistState();
        updateStatusBar();
        if (count > 0) {
          return { content: [{ type: "text", text: `Cancelled ${count} alarm(s) with label "${params.label}".` }], details: { count } };
        }
        return { content: [{ type: "text", text: `No alarms found with label "${params.label}".` }], details: {} };
      }

      return { content: [{ type: "text", text: "Error: provide alarm_id or label to cancel." }], details: { error: "missing param" } };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("alarm_cancel"));
      if (args.alarm_id) text += "\n  " + theme.fg("dim", "id: ") + theme.fg("accent", `#${args.alarm_id?.slice(0, 8) ?? "?"}`);
      if (args.label) text += "\n  " + theme.fg("dim", "label: ") + theme.fg("muted", args.label);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as { error?: string; id?: string; count?: number } | undefined;
      if (details?.error) {
        const t = result.content[0];
        return new Text(theme.fg("error", t?.type === "text" ? t.text : "Error"), 0, 0);
      }
      if (details?.count !== undefined) {
        return new Text(theme.fg("success", `Cancelled ${details.count} alarm(s)`), 0, 0);
      }
      return new Text(theme.fg("success", `Cancelled #${details?.id ?? "?"}`), 0, 0);
    },
  });

  // ── Commands ─────────────────────────────────────────────────────────

  // /alarm-set <anything> — always forward to LLM
  pi.registerCommand("alarm-set", {
    description: "Set a timed alarm via LLM — any natural language input",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /alarm-set <natural language description>", "warning");
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(
          `The user wants to set an alarm: "${input}". ` +
          `Please use alarm_now to check the current time, then use alarm_wait or alarm_set.`,
        );
      } else {
        ctx.ui.notify("Agent is busy, try again in a moment", "warning");
      }
    },
  });

  // /alarm-in <delay> <msg>
  pi.registerCommand("alarm-in", {
    description: "Set a timed alarm with relative delay — /alarm-in <delay> <msg>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /alarm-in <delay> <msg>  (e.g. 5m, 1h30m, 300s)", "warning");
        return;
      }

      const parsed = parseRelativeTime(input);
      if (parsed) {
        const message = parsed.rest || "Alarm";
        const mgr = getManager();
        const seconds = Math.round((parsed.triggerAt - Date.now()) / 1000);
        const alarm = mgr.setRelative(seconds, message, DEFAULT_EXPIRES_IN_SEC);
        persistState();
        updateStatusBar();
        ctx.ui.notify(
          `Alarm #${alarm.id.slice(0, 8)} set in ${formatRemaining(parsed.triggerAt)}: ${message}`,
          "info",
        );
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(
          `The user wants to set an alarm with relative time: "${input}". ` +
          `Please use alarm_now to check the current time, then use alarm_wait.`,
        );
      } else {
        ctx.ui.notify("Agent is busy, try again in a moment", "warning");
      }
    },
  });

  // /alarm-at <time> <msg>
  pi.registerCommand("alarm-at", {
    description: "Set a timed alarm at an absolute time — /alarm-at <time> <msg>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /alarm-at <time> <msg>  (e.g. 14:30, tomorrow 9:00, 2026-06-26T14:30:00Z)", "warning");
        return;
      }

      const parsed = parseAbsoluteTime(input);
      if (parsed) {
        const message = parsed.rest || "Alarm";
        const mgr = getManager();
        const alarm = mgr.setAbsolute(new Date(parsed.triggerAt), message, DEFAULT_EXPIRES_IN_SEC);
        persistState();
        updateStatusBar();
        ctx.ui.notify(
          `Alarm #${alarm.id.slice(0, 8)} set for ${formatTriggerAt(parsed.triggerAt)}: ${message}`,
          "info",
        );
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(
          `The user wants to set an alarm at a specific time: "${input}". ` +
          `Please use alarm_now to check the current time, then use alarm_set.`,
        );
      } else {
        ctx.ui.notify("Agent is busy, try again in a moment", "warning");
      }
    },
  });

  // /alarm-list
  pi.registerCommand("alarm-list", {
    description: "List all pending alarms",
    handler: async (_args, ctx) => {
      const mgr = getManager();
      const pending = mgr.list().filter((a) => a.status === "pending");
      if (pending.length === 0) {
        ctx.ui.notify("No pending alarms.", "info");
        return;
      }
      const lines = pending.map((a) => {
        const label = a.label ? ` [${a.label}]` : "";
        return `#${a.id.slice(0, 8)}${label} in ${formatRemaining(a.triggerAt)} — ${a.message || "(no message)"}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /alarm-cancel <id> — interactive selection or quick mode
  pi.registerCommand("alarm-cancel", {
    description: "Cancel an alarm — interactive selection or quick mode: /alarm-cancel <id>",
    handler: async (args, ctx) => {
      const input = args.trim();
      const mgr = getManager();

      // Quick mode: ID or label provided
      if (input) {
        const pending = mgr.list().filter((a) => a.status === "pending");
        // Try exact ID match first
        const byId = pending.find((a) => a.id.slice(0, 8) === input || a.id === input);
        if (byId) {
          mgr.cancel(byId.id);
          persistState();
          updateStatusBar();
          const label = byId.label ? ` [${byId.label}]` : "";
          ctx.ui.notify(`Cancelled #${byId.id.slice(0, 8)}${label}: ${byId.message}`, "info");
          return;
        }

        // Then prefix match
        const byPrefix = pending.filter((a) => a.id.startsWith(input));
        if (byPrefix.length === 1) {
          const a = byPrefix[0];
          mgr.cancel(a.id);
          persistState();
          updateStatusBar();
          const label = a.label ? ` [${a.label}]` : "";
          ctx.ui.notify(`Cancelled #${a.id.slice(0, 8)}${label}: ${a.message}`, "info");
          return;
        }

        // Then label match
        const byLabel = pending.filter((a) => a.label === input);
        if (byLabel.length > 0) {
          const count = mgr.cancelByLabel(input);
          persistState();
          updateStatusBar();
          ctx.ui.notify(`Cancelled ${count} alarm(s) with label "${input}".`, "info");
          return;
        }

        ctx.ui.notify(`No pending alarm matching "${input}".`, "warning");
        return;
      }

      // Interactive mode: select from pending list
      const pending = mgr.list().filter((a) => a.status === "pending");
      if (pending.length === 0) {
        ctx.ui.notify("No pending alarms.", "info");
        return;
      }

      const choices = pending.map((a) => {
        const label = a.label ? ` [${a.label}]` : "";
        return `#${a.id.slice(0, 8)}${label} in ${formatRemaining(a.triggerAt)} — ${a.message || "(no message)"}`;
      });
      const choice = await ctx.ui.select("Select alarm to cancel:", choices);
      if (choice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const match = choice.match(/#([a-f0-9]+)/);
      if (!match) { ctx.ui.notify("Failed to parse alarm ID.", "warning"); return; }
      const selectedPrefix = match[1];
      const alarm = pending.find((a) => a.id.startsWith(selectedPrefix));
      if (!alarm || alarm.status !== "pending") {
        ctx.ui.notify(`Alarm #${selectedPrefix} not found or not pending`, "warning");
        return;
      }

      mgr.cancel(alarm.id);
      persistState();
      updateStatusBar();
      const label = alarm.label ? ` [${alarm.label}]` : "";
      ctx.ui.notify(`Cancelled #${alarm.id.slice(0, 8)}${label}: ${alarm.message}`, "info");
    },
  });

  // /alarm-clear — show summary + confirm before clearing
  pi.registerCommand("alarm-clear", {
    description: "Cancel all pending alarms",
    handler: async (_args, ctx) => {
      const mgr = getManager();
      const pending = mgr.list().filter((a) => a.status === "pending");
      if (pending.length === 0) {
        ctx.ui.notify("No pending alarms to clear.", "info");
        return;
      }

      // Show summary and confirm
      const summary =
        `${pending.length} alarm(s) pending:` +
        pending.slice(0, 5).map((a) => {
          const label = a.label ? ` [${a.label}]` : "";
          return `\n  #${a.id.slice(0, 8)}${label} — ${a.message || "(no message)"}`;
        }).join("") +
        (pending.length > 5 ? `\n  ... and ${pending.length - 5} more` : "");

      const confirmed = await ctx.ui.confirm("Clear all alarms?", summary);
      if (!confirmed) { ctx.ui.notify("Cancelled.", "info"); return; }

      const count = mgr.cancelAll();
      persistState();
      updateStatusBar();
      ctx.ui.notify(`Cleared ${count} alarm${count > 1 ? "s" : ""}.`, "info");
    },
  });

  // ── Message Renderer ─────────────────────────────────────────────────

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as
      | { alarmId?: string; firedAt?: number }
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
