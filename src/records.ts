/// CloudKit のレコード ⇄ モデルの変換。フィールド名は MustDo アプリ側の CloudKit 契約（cloudkit.md）が正本。

import type { CKField, CKRecord } from "./cloudkit.js";
import {
  ALARM_SOUNDS,
  type Account,
  type AlarmSound,
  clampInterval,
  monthlyRuleFrom,
  type Occurrence,
  type RepeatKind,
  REPEAT_KINDS,
  type RepeatRule,
  repeatEndFrom,
  type Todo,
  TODO_SOURCES,
  TODO_STATUSES,
  type TodoSource,
  type TodoStatus,
} from "./model.js";

export const RECORD_TYPE_TODO = "Todo";
export const RECORD_TYPE_OCCURRENCE = "Occurrence";
export const RECORD_TYPE_ACCOUNT = "Account";
export const ACCOUNT_RECORD_NAME = "account";

// --- 読む ---

function str(f: CKField | undefined): string | null {
  return typeof f?.value === "string" ? f.value : null;
}

function date(f: CKField | undefined): Date | null {
  return typeof f?.value === "number" && Number.isFinite(f.value) ? new Date(f.value) : null;
}

function int64(f: CKField | undefined): number | null {
  const v = typeof f?.value === "string" ? Number(f.value) : f?.value;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function int64List(f: CKField | undefined): number[] {
  if (!Array.isArray(f?.value)) return [];
  return f.value.map((v) => Number(v)).filter((n) => Number.isInteger(n));
}

function enumValue<T extends string>(f: CKField | undefined, allowed: readonly T[], fallback: T): T {
  const v = str(f);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/// `Todo` レコード → モデル。必須は title / dueAt だけ（Swift 側と同じ寛容さ）。
export function todoFromRecord(r: CKRecord): Todo | null {
  if (r.recordType !== RECORD_TYPE_TODO) return null;
  const title = str(r.fields.title);
  const dueAt = date(r.fields.dueAt);
  if (title === null || dueAt === null) return null;
  const kind = enumValue<RepeatKind>(r.fields.repeatKind, REPEAT_KINDS, "none");
  return {
    id: r.recordName,
    title,
    notes: str(r.fields.notes),
    dueAt,
    timeZone: str(r.fields.timeZone) ?? "UTC",
    repeatRule: kind === "none" ? null : repeatRuleFromFields(kind, r.fields),
    status: enumValue<TodoStatus>(r.fields.status, TODO_STATUSES, "pending"),
    snoozedUntil: date(r.fields.snoozedUntil),
    completedAt: date(r.fields.completedAt),
    sound: enumValue<AlarmSound>(r.fields.sound, ALARM_SOUNDS, "default"),
    source: enumValue<TodoSource>(r.fields.source, TODO_SOURCES, "app"),
    updatedAt: date(r.fields.updatedAt) ?? (r.modified ? new Date(r.modified.timestamp) : new Date(0)),
    deletedAt: date(r.fields.deletedAt),
    changeTag: r.recordChangeTag ?? null,
  };
}

/// `Todo` レコードの repeat* フィールド → `RepeatRule`。無いフィールド（旧アプリ・旧 MCP が書いたレコード）は既定値に倒す。
/// `repeatInterval` 無し = 1、`repeatEndKind` 無しで `repeatUntil` があれば `until`。知らない値は既定値（Swift 側と同じ寛容さ）。
export function repeatRuleFromFields(kind: Exclude<RepeatKind, "none">, fields: Record<string, CKField>): RepeatRule {
  return {
    kind,
    interval: clampInterval(int64(fields.repeatInterval) ?? 1),
    weekdays: int64List(fields.repeatWeekdays).filter((d) => d >= 1 && d <= 7),
    monthly: monthlyRuleFrom(str(fields.repeatMonthlyMode), int64(fields.repeatOrdinal), int64(fields.repeatOrdinalWeekday)),
    end: repeatEndFrom(str(fields.repeatEndKind), date(fields.repeatUntil), int64(fields.repeatCount)),
  };
}

export function occurrenceFromRecord(r: CKRecord): Occurrence | null {
  if (r.recordType !== RECORD_TYPE_OCCURRENCE) return null;
  const key = str(r.fields.key);
  const ref = r.fields.todo?.value as { recordName?: string } | undefined;
  const todoID = typeof ref?.recordName === "string" ? ref.recordName : r.recordName.split("|")[0];
  if (key === null || !todoID) return null;
  return {
    todoID,
    key,
    status: enumValue<TodoStatus>(r.fields.status, TODO_STATUSES, "pending"),
    snoozedUntil: date(r.fields.snoozedUntil),
    changedAt: date(r.fields.changedAt) ?? (r.modified ? new Date(r.modified.timestamp) : new Date(0)),
    changeTag: r.recordChangeTag ?? null,
  };
}

export function accountFromRecord(r: CKRecord): Account {
  return {
    trialStartedAt: date(r.fields.trialStartedAt),
    subscribedUntil: date(r.fields.subscribedUntil),
    timeZone: str(r.fields.timeZone),
    locale: str(r.fields.locale),
    defaultTime: str(r.fields.defaultTime),
  };
}

// --- 書く ---

export function fString(v: string): CKField {
  return { value: v, type: "STRING" };
}

export function fDate(d: Date): CKField {
  return { value: d.getTime(), type: "TIMESTAMP" };
}

export function fInt64(v: number): CKField {
  return { value: v, type: "INT64" };
}

export function fInt64List(list: number[]): CKField {
  return { value: list, type: "INT64_LIST" };
}

export function fReference(recordName: string, action: "DELETE_SELF" | "NONE" = "DELETE_SELF"): CKField {
  return { value: { recordName, action }, type: "REFERENCE" };
}

/// 値を消す。CloudKit Web Services では `{"value": null}` でフィールドを空にする。
export const fNull: CKField = { value: null };

/// モデル → `Todo` レコードの全フィールド（create と replace 用。update でも全部送って差分はサーバーに任せる）。
/// `null` の項目は `fNull` で明示的に消す（スヌーズ解除・完了取り消しのため）。
export function todoFields(todo: Omit<Todo, "id" | "changeTag">): Record<string, CKField> {
  const rule = todo.repeatRule;
  return {
    title: fString(todo.title),
    notes: todo.notes !== null && todo.notes !== "" ? fString(todo.notes) : fNull,
    dueAt: fDate(todo.dueAt),
    timeZone: fString(todo.timeZone),
    ...repeatFields(rule),
    status: fString(todo.status),
    snoozedUntil: todo.snoozedUntil ? fDate(todo.snoozedUntil) : fNull,
    completedAt: todo.completedAt ? fDate(todo.completedAt) : fNull,
    sound: fString(todo.sound),
    source: fString(todo.source),
    updatedAt: fDate(todo.updatedAt),
    deletedAt: todo.deletedAt ? fDate(todo.deletedAt) : fNull,
  };
}

/// `RepeatRule` → repeat* フィールド。無し（`null`）は Swift 側 `RepeatRule(kind: .none)` と同じ値を書く。
/// 使わない項目（dayOfMonth の ordinal、until 以外の repeatUntil など）は `fNull` で消す。
export function repeatFields(rule: RepeatRule | null): Record<string, CKField> {
  const monthly = rule?.monthly ?? { mode: "dayOfMonth" };
  const end = rule?.end ?? { kind: "never" };
  return {
    repeatKind: fString(rule?.kind ?? "none"),
    repeatInterval: fInt64(rule?.interval ?? 1),
    repeatWeekdays: fInt64List(rule?.weekdays ?? []),
    repeatMonthlyMode: fString(monthly.mode),
    repeatOrdinal: monthly.mode === "weekdayOrdinal" ? fInt64(monthly.ordinal) : fNull,
    repeatOrdinalWeekday: monthly.mode === "weekdayOrdinal" ? fInt64(monthly.weekday) : fNull,
    repeatEndKind: fString(end.kind),
    repeatUntil: end.kind === "until" ? fDate(end.until) : fNull,
    repeatCount: end.kind === "count" ? fInt64(end.count) : fNull,
  };
}

/// 新規作成では `null` を送らない（まだ無いフィールドを消す意味が無い）。
export function stripNulls(fields: Record<string, CKField>): Record<string, CKField> {
  return Object.fromEntries(Object.entries(fields).filter(([, f]) => f.value !== null));
}

export function occurrenceFields(o: Omit<Occurrence, "changeTag">): Record<string, CKField> {
  return {
    todo: fReference(o.todoID),
    key: fString(o.key),
    status: fString(o.status),
    snoozedUntil: o.snoozedUntil ? fDate(o.snoozedUntil) : fNull,
    changedAt: fDate(o.changedAt),
  };
}

// --- 出力（ツールの戻り値。日付は ISO8601 文字列） ---

export function todoToJSON(todo: Todo, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: todo.id,
    title: todo.title,
    notes: todo.notes,
    dueAt: todo.dueAt.toISOString(),
    timeZone: todo.timeZone,
    repeat: todo.repeatRule ? repeatToJSON(todo.repeatRule) : null,
    status: todo.status,
    snoozedUntil: todo.snoozedUntil?.toISOString() ?? null,
    completedAt: todo.completedAt?.toISOString() ?? null,
    sound: todo.sound,
    source: todo.source,
    updatedAt: todo.updatedAt.toISOString(),
    ...extra,
  };
}

/// `RepeatRule` → ツールの `repeat`（アプリ側の契約と同じ形。`add_todo` / `update_todo` の入力と同じ）。
export function repeatToJSON(rule: RepeatRule): Record<string, unknown> {
  const monthly: Record<string, unknown> =
    rule.monthly.mode === "weekdayOrdinal"
      ? { mode: "weekdayOrdinal", ordinal: rule.monthly.ordinal, weekday: rule.monthly.weekday }
      : { mode: "dayOfMonth" };
  const end: Record<string, unknown> =
    rule.end.kind === "until"
      ? { kind: "until", until: rule.end.until.toISOString() }
      : rule.end.kind === "count"
        ? { kind: "count", count: rule.end.count }
        : { kind: "never" };
  return { kind: rule.kind, interval: rule.interval, weekdays: rule.weekdays, monthly, end };
}

export function occurrenceToJSON(o: Occurrence): Record<string, unknown> {
  return {
    todoID: o.todoID,
    date: o.key,
    status: o.status,
    snoozedUntil: o.snoozedUntil?.toISOString() ?? null,
    changedAt: o.changedAt.toISOString(),
  };
}
