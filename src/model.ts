/// アプリ側 `MustDo/Shared/Todo.swift` と同じ値。名前を変えない。

/// 繰り返しの種類。iOS カレンダーと同じ語彙（`MustDo/Shared/RepeatRule.swift` と同じ値）。
export const REPEAT_KINDS = ["none", "daily", "weekly", "monthly", "yearly"] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

/// 毎月の鳴らし方（CloudKit `repeatMonthlyMode`）。
export const MONTHLY_MODES = ["dayOfMonth", "weekdayOrdinal"] as const;
export type MonthlyMode = (typeof MONTHLY_MODES)[number];

/// 繰り返しの終了（CloudKit `repeatEndKind`）。
export const REPEAT_END_KINDS = ["never", "until", "count"] as const;
export type RepeatEndKind = (typeof REPEAT_END_KINDS)[number];

/// `interval`（1 = 毎、2 = 隔、…）と `count`（開始からの発生回数）の範囲。Swift 側 `RepeatRule.intervalRange` / `countRange` と同じ。
export const REPEAT_INTERVAL_MIN = 1;
export const REPEAT_INTERVAL_MAX = 99;
export const REPEAT_COUNT_MIN = 1;
export const REPEAT_COUNT_MAX = 999;

export const TODO_STATUSES = ["pending", "done", "skipped"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_SOURCES = ["app", "mcp", "share", "org"] as const;
export type TodoSource = (typeof TODO_SOURCES)[number];

/// `AlarmSound.rawValue` の allowlist（`MustDo/Shared/AlarmSound.swift`）。
export const ALARM_SOUNDS = [
  "default",
  "chime",
  "marimba",
  "beep",
  "urgent",
  "vibrateOnly",
  "siren",
  "klaxon",
  "rapid",
  "redalert",
  "musicbox",
  "harp",
  "morning",
  "bowl",
  "droplet",
  "breeze",
  "horror",
  "dread",
  "ghost",
  "lament",
  "cello",
  "rainy",
  "fanfare",
  "skip",
  "sparkle",
] as const;
export type AlarmSound = (typeof ALARM_SOUNDS)[number];

/// 毎月の鳴らし方。`dayOfMonth` は `dueAt` の日（29〜31 日は、無い月は月末）。
/// `weekdayOrdinal` は第 n 曜日（`ordinal` 1...5、-1 = 最終。`weekday` 1=日 … 7=土）。無い月（第 5 など）は飛ばす。
export type MonthlyRule = { mode: "dayOfMonth" } | { mode: "weekdayOrdinal"; ordinal: number; weekday: number };

/// 繰り返しの終了。`until` はその日を含む。`count` は開始からの発生回数（done / skipped した回も 1 回）。
export type RepeatEnd = { kind: "never" } | { kind: "until"; until: Date } | { kind: "count"; count: number };

/// 繰り返しの規則。**展開はアプリ側**（`RepeatRule.days`）。MCP はテンプレートを読み書きするだけ。
export interface RepeatRule {
  kind: RepeatKind;
  /// 1 = 毎、2 = 隔、…（1...99）。
  interval: number;
  /// weekly の曜日。1 = 日 … 7 = 土。空なら `dueAt` の曜日。
  weekdays: number[];
  /// monthly の鳴らし方。他の kind では `dayOfMonth`。
  monthly: MonthlyRule;
  end: RepeatEnd;
}

export function clampInterval(v: number): number {
  return Math.min(Math.max(v, REPEAT_INTERVAL_MIN), REPEAT_INTERVAL_MAX);
}

export function clampCount(v: number): number {
  return Math.min(Math.max(v, REPEAT_COUNT_MIN), REPEAT_COUNT_MAX);
}

export function isValidOrdinal(v: number): boolean {
  return Number.isInteger(v) && ((v >= 1 && v <= 5) || v === -1);
}

export function isValidWeekday(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= 7;
}

/// 保存値（CloudKit）から `MonthlyRule` を組む。欠け・不正は `dayOfMonth`（Swift `RepeatRule.monthly(mode:ordinal:weekday:)` と同じ）。
export function monthlyRuleFrom(mode: string | null, ordinal: number | null, weekday: number | null): MonthlyRule {
  if (mode === "weekdayOrdinal" && ordinal !== null && weekday !== null && isValidOrdinal(ordinal) && isValidWeekday(weekday)) {
    return { mode: "weekdayOrdinal", ordinal, weekday };
  }
  return { mode: "dayOfMonth" };
}

/// 保存値から `RepeatEnd` を組む。`endKind` が無い旧データは `until` の有無で決める（Swift `RepeatRule.end(kind:until:count:)` と同じ）。
export function repeatEndFrom(kind: string | null, until: Date | null, count: number | null): RepeatEnd {
  switch (kind) {
    case "never":
      return { kind: "never" };
    case "until":
      return until ? { kind: "until", until } : { kind: "never" };
    case "count":
      return count !== null ? { kind: "count", count: clampCount(count) } : { kind: "never" };
    default:
      return until ? { kind: "until", until } : { kind: "never" };
  }
}

export interface Todo {
  id: string;
  title: string;
  notes: string | null;
  dueAt: Date;
  timeZone: string;
  repeatRule: RepeatRule | null;
  status: TodoStatus;
  snoozedUntil: Date | null;
  completedAt: Date | null;
  sound: AlarmSound;
  source: TodoSource;
  updatedAt: Date;
  deletedAt: Date | null;
  /// CloudKit の `recordChangeTag`。更新時に必要。
  changeTag: string | null;
}

export interface Occurrence {
  todoID: string;
  /// `YYYY-MM-DD`（TODO の `timeZone`）。
  key: string;
  status: TodoStatus;
  snoozedUntil: Date | null;
  changedAt: Date;
  changeTag: string | null;
}

export interface Account {
  trialStartedAt: Date | null;
  subscribedUntil: Date | null;
  timeZone: string | null;
  locale: string | null;
  /// 鳴らす時刻の既定 `HH:mm`（24 時間、timeZone の時計）。アプリの設定が書く。無ければ MCP 側で 09:00。
  defaultTime: string | null;
}

export const TRIAL_DAYS = 30;

export function isRepeating(todo: Pick<Todo, "repeatRule">): boolean {
  return todo.repeatRule !== null && todo.repeatRule.kind !== "none";
}

export function occurrenceRecordName(todoID: string, key: string): string {
  return `${todoID}|${key}`;
}

/// 試用（30 日）か購読のどちらかが生きていれば追加できる。Account が無ければ判定できないので通す。
export function canAddTodo(account: Account | null, now: Date): boolean {
  if (!account) return true;
  if (account.subscribedUntil && account.subscribedUntil.getTime() > now.getTime()) return true;
  if (!account.trialStartedAt) return true;
  const trialEnd = account.trialStartedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  return trialEnd > now.getTime();
}
