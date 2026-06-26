/**
 * AlarmManager — core alarm/timer logic.
 *
 * Responsibilities:
 *  - Create relative (alarm_set) and absolute (alarm_schedule) timers
 *  - Cancel timers by id or label
 *  - List active alarms
 *  - Serialize state for session persistence
 *  - Reconstruct state on session restore
 *  - Fire callbacks on trigger (decoupled from pi)
 *
 * Design:
 *  - UUID-based alarm IDs (collision-free across sessions)
 *  - State is entirely self-contained — no globals, no side effects
 *  - All timer management (setTimeout/clearTimeout) is encapsulated
 *  - `timer.unref()` allows Node to exit even with pending alarms
 */

import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────

export interface Alarm {
  id: string;
  message: string;
  label?: string;
  triggerAt: number; // epoch ms
  expiresIn: number | "never"; // seconds after triggerAt
  status: "pending" | "fired" | "cancelled";
  createdAt: number; // epoch ms
}

export interface AlarmState {
  alarms: Alarm[];
}

type FireCallback = (alarm: Alarm) => void;

interface ActiveAlarm {
  entry: Alarm;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_EXPIRES_IN_SEC = 300;

// ── AlarmManager ───────────────────────────────────────────

export class AlarmManager {
  private alarms = new Map<string, ActiveAlarm>();
  private onFire: FireCallback;

  constructor(onFire: FireCallback) {
    this.onFire = onFire;
  }

  // ── public API ──────────────────────────────────────────

  /** Schedule a relative-duration alarm. */
  setRelative(
    seconds: number,
    message: string,
    expiresIn: number | "never" = DEFAULT_EXPIRES_IN_SEC,
    label?: string,
  ): Alarm {
    if (seconds <= 0) throw new Error(`Duration must be positive, got ${seconds}s`);
    return this.schedule({
      id: randomUUID(),
      message,
      label,
      triggerAt: Date.now() + seconds * 1000,
      expiresIn,
      status: "pending",
      createdAt: Date.now(),
    });
  }

  /** Schedule an absolute-time alarm. */
  setAbsolute(
    at: Date,
    message: string,
    expiresIn: number | "never" = DEFAULT_EXPIRES_IN_SEC,
    label?: string,
  ): Alarm {
    const triggerAt = at.getTime();
    if (triggerAt <= Date.now()) throw new Error(`Alarm time ${at.toISOString()} is in the past`);
    return this.schedule({
      id: randomUUID(),
      message,
      label,
      triggerAt,
      expiresIn,
      status: "pending",
      createdAt: Date.now(),
    });
  }

  /** Cancel one alarm by id. Returns true if removed. */
  cancel(id: string): boolean {
    const alarm = this.alarms.get(id);
    if (!alarm) return false;
    clearTimeout(alarm.timer);
    this.alarms.delete(id);
    return true;
  }

  /** Cancel all alarms matching a label. Returns count. */
  cancelByLabel(label: string): number {
    let count = 0;
    for (const [id, alarm] of this.alarms) {
      if (alarm.entry.status === "pending" && alarm.entry.label === label) {
        alarm.entry.status = "cancelled";
        clearTimeout(alarm.timer);
        this.alarms.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Cancel all pending alarms. Returns count. */
  cancelAll(): number {
    let count = 0;
    for (const [id, alarm] of this.alarms) {
      if (alarm.entry.status === "pending") {
        alarm.entry.status = "cancelled";
        clearTimeout(alarm.timer);
        this.alarms.delete(id);
        count++;
      }
    }
    return count;
  }

  /** List all alarms sorted by triggerAt ascending. */
  list(): Alarm[] {
    return [...this.alarms.values()]
      .map((a) => a.entry)
      .sort((a, b) => a.triggerAt - b.triggerAt);
  }

  /** Get all alarms (including fired/cancelled) for serialization. */
  getAll(): Alarm[] {
    return [...this.alarms.values()].map((a) => ({ ...a.entry }));
  }

  /** Count of pending alarms. */
  get pendingCount(): number {
    let count = 0;
    for (const alarm of this.alarms.values()) {
      if (alarm.entry.status === "pending") count++;
    }
    return count;
  }

  // ── persistence ─────────────────────────────────────────

  /** Serialize all alarms for session persistence. */
  serialize(): AlarmState {
    return { alarms: this.getAll() };
  }

  /**
   * Reconstruct alarms from persisted state.
   * Future alarms are re-scheduled. Overdue alarms within expiresIn
   * fire immediately; those beyond are silently dropped.
   * always-fire (expiresIn === "never") overdue alarms fire immediately.
   */
  reconstruct(state: AlarmState): void {
    const now = Date.now();
    for (const entry of state.alarms) {
      if (entry.status !== "pending") continue;
      const delay = entry.triggerAt - now;

      if (delay > 0) {
        // Future — re-schedule
        this.schedule({ ...entry });
        continue;
      }

      // Overdue
      if (entry.expiresIn === "never") {
        this.onFire(entry);
        continue;
      }

      const graceMs = entry.expiresIn * 1000;
      if (-delay <= graceMs) {
        // Within grace period
        this.onFire(entry);
        continue;
      }

      // Too old — silently drop
    }
  }

  /**
   * On tree navigation, cancel overdue alarms without re-firing.
   */
  reconstructSilent(state: AlarmState): void {
    const now = Date.now();
    for (const entry of state.alarms) {
      if (entry.status !== "pending") continue;
      if (entry.triggerAt <= now) continue; // Overdue — skip
      this.schedule({ ...entry });
    }
  }

  /** Destroy all pending timers. Safe to call multiple times. */
  destroy(): void {
    for (const [, alarm] of this.alarms) {
      clearTimeout(alarm.timer);
    }
    this.alarms.clear();
  }

  // ── internal ────────────────────────────────────────────

  private schedule(entry: Alarm): Alarm {
    const delay = Math.max(0, entry.triggerAt - Date.now());
    const timer = setTimeout(() => {
      this.alarms.delete(entry.id);
      this.onFire(entry);
    }, delay);
    timer.unref(); // Allow Node to exit
    this.alarms.set(entry.id, { entry, timer });
    return entry;
  }
}
