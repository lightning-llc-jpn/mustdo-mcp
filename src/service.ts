/// ツールの中身。CloudKit クライアントと時計を注入してテストする。

import { randomUUID } from "node:crypto";

import { CloudKitClient, ConflictError, type CKRecord } from "./cloudkit.js";
import {
  dayKey,
  endOfDayExclusive,
  isValidTimeZone,
  normalizeDefaultTime,
  parseDateTime,
  parseDue,
  parseUntil,
  startOfDay,
  tomorrowAt,
  weekday,
} from "./dates.js";
import { ToolError } from "./errors.js";
import { log } from "./log.js";
import {
  type Account,
  type AlarmSound,
  canAddTodo,
  isRepeating,
  isValidOrdinal,
  isValidWeekday,
  type MonthlyMode,
  type MonthlyRule,
  type Occurrence,
  occurrenceRecordName,
  REPEAT_COUNT_MAX,
  REPEAT_COUNT_MIN,
  REPEAT_INTERVAL_MAX,
  REPEAT_INTERVAL_MIN,
  type RepeatEnd,
  type RepeatEndKind,
  type RepeatKind,
  type RepeatRule,
  type Todo,
  type TodoStatus,
  TRIAL_DAYS,
} from "./model.js";
import {
  ACCOUNT_RECORD_NAME,
  accountFromRecord,
  occurrenceFields,
  occurrenceFromRecord,
  occurrenceToJSON,
  RECORD_TYPE_OCCURRENCE,
  RECORD_TYPE_TODO,
  stripNulls,
  todoFields,
  todoFromRecord,
  todoToJSON,
} from "./records.js";

export interface ServiceDeps {
  client: CloudKitClient;
  now?: () => Date;
  /// Account に timeZone が無いときの落ち先。既定は Mac の時間帯。
  defaultTimeZone?: string;
}

export type StatusFilter = TodoStatus | "all";

export interface ListTodosInput {
  date?: string;
  from?: string;
  to?: string;
  status?: StatusFilter;
  includeRepeating?: boolean;
}

/// `add_todo` / `update_todo` の `repeat`（アプリ側の CloudKit 契約と同じ形）。省略した項目は既定値。
/// 旧形 `{kind, weekdays, until}` も受け付ける（`until` があれば `end: {kind: "until"}`）。
export interface RepeatInput {
  /// `none` で繰り返しなし。
  kind: RepeatKind;
  /// 1 = 毎、2 = 隔、…（1...99）。省略で 1。
  interval?: number;
  /// weekly の曜日。1=日 … 7=土。空・省略なら due の曜日。
  weekdays?: number[];
  /// monthly の鳴らし方。省略で `dayOfMonth`。
  monthly?: { mode: MonthlyMode; ordinal?: number; weekday?: number };
  /// 終了。省略で `never`（旧形の `until` があればそれ）。
  end?: { kind: RepeatEndKind; until?: string; count?: number };
  /// 旧形。`end` があれば無視。
  until?: string;
}

export interface AddTodoInput {
  title: string;
  /// 省略で「明日の既定時刻」（Account の timeZone での今日の翌日、Account.defaultTime、既定 09:00）。
  /// `YYYY-MM-DD` だけなら「その日の既定時刻」。
  due?: string;
  repeat?: RepeatInput;
  notes?: string;
  sound?: AlarmSound;
}

export interface UpdateTodoInput {
  id: string;
  title?: string;
  due?: string;
  /// `null` で繰り返しを外す。
  repeat?: RepeatInput | null;
  notes?: string | null;
  sound?: AlarmSound;
  status?: TodoStatus;
}

export class MustDoService {
  private readonly client: CloudKitClient;
  private readonly now: () => Date;
  private readonly defaultTimeZone: string;

  constructor(deps: ServiceDeps) {
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
    this.defaultTimeZone = deps.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // --- Account ---

  async fetchAccount(): Promise<Account | null> {
    const record = await this.client.lookup(ACCOUNT_RECORD_NAME);
    return record ? accountFromRecord(record) : null;
  }

  private accountTimeZone(account: Account | null): string {
    const tz = account?.timeZone;
    return tz && isValidTimeZone(tz) ? tz : this.defaultTimeZone;
  }

  /// 鳴らす時刻の既定 `HH:mm`。Account に無い・壊れていれば 09:00。
  private accountDefaultTime(account: Account | null): string {
    return normalizeDefaultTime(account?.defaultTime);
  }

  async getMe(): Promise<Record<string, unknown>> {
    const account = await this.fetchAccount();
    const now = this.now();
    const timeZone = this.accountTimeZone(account);
    const defaultTime = this.accountDefaultTime(account);
    const trialEndsAt = account?.trialStartedAt ? new Date(account.trialStartedAt.getTime() + TRIAL_DAYS * 86_400_000) : null;
    return {
      accountRecordExists: account !== null,
      trialStartedAt: account?.trialStartedAt?.toISOString() ?? null,
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
      subscribedUntil: account?.subscribedUntil?.toISOString() ?? null,
      canAddTodo: canAddTodo(account, now),
      timeZone,
      locale: account?.locale ?? null,
      today: dayKey(now, timeZone),
      now: now.toISOString(),
      weekday: weekday(now, timeZone),
      defaultTime,
      defaultDueNext: tomorrowAt(defaultTime, timeZone, now).toISOString(),
    };
  }

  // --- 読み ---

  private async fetchAllTodos(): Promise<Todo[]> {
    const records = await this.client.queryAll(RECORD_TYPE_TODO);
    const todos: Todo[] = [];
    for (const r of records) {
      const t = todoFromRecord(r);
      if (t) todos.push(t);
      else log("WARN", "todo.skipUnreadable", { recordName: r.recordName });
    }
    return todos;
  }

  private async fetchAllOccurrences(): Promise<Occurrence[]> {
    const records = await this.client.queryAll(RECORD_TYPE_OCCURRENCE);
    return records.map(occurrenceFromRecord).filter((o): o is Occurrence => o !== null);
  }

  async listTodos(input: ListTodosInput): Promise<Record<string, unknown>> {
    const account = await this.fetchAccount();
    const timeZone = this.accountTimeZone(account);
    const status: StatusFilter = input.status ?? "pending";
    const includeRepeating = input.includeRepeating ?? true;

    const fromKey = input.date ?? input.from ?? null;
    const toKey = input.date ?? input.to ?? null;
    const rangeStart = fromKey ? startOfDay(fromKey, timeZone) : null;
    const rangeEnd = toKey ? endOfDayExclusive(toKey, timeZone) : null;
    if (fromKey && !rangeStart) throw new ToolError("INVALID_ARGUMENT", `日付の形式は YYYY-MM-DD: ${fromKey}`);
    if (toKey && !rangeEnd) throw new ToolError("INVALID_ARGUMENT", `日付の形式は YYYY-MM-DD: ${toKey}`);
    if (rangeStart && rangeEnd && rangeStart.getTime() >= rangeEnd.getTime()) {
      throw new ToolError("INVALID_ARGUMENT", "from は to 以前にしてください。");
    }

    const all = await this.fetchAllTodos();
    const live = all.filter((t) => t.deletedAt === null);

    const singles = live
      .filter((t) => !isRepeating(t))
      .filter((t) => status === "all" || t.status === status)
      .filter((t) => inRange(effectiveDue(t), rangeStart, rangeEnd));

    const repeating = includeRepeating
      ? live
          .filter((t) => isRepeating(t))
          // テンプレは常に pending。done / skipped の絞り込みでは回の状態（Occurrence）で判断するが、
          // 展開しない方針なので単純に pending と all のときだけ返す。
          .filter(() => status === "pending" || status === "all")
          .filter((t) => ruleIntersectsRange(t, rangeStart, rangeEnd))
      : [];

    let occurrences: Occurrence[] = [];
    if (repeating.length > 0) {
      const ids = new Set(repeating.map((t) => t.id));
      occurrences = (await this.fetchAllOccurrences()).filter((o) => ids.has(o.todoID)).filter((o) => occurrenceInRange(o, fromKey, toKey));
    }

    const sortByDue = (a: Todo, b: Todo) => effectiveDue(a).getTime() - effectiveDue(b).getTime();
    return {
      timeZone,
      range: { from: fromKey, to: toKey },
      status,
      todos: singles.sort(sortByDue).map((t) => todoToJSON(t)),
      repeating: repeating.sort(sortByDue).map((t) =>
        todoToJSON(t, {
          occurrences: occurrences.filter((o) => o.todoID === t.id).map(occurrenceToJSON),
        }),
      ),
      note:
        "repeating は展開していないテンプレート（展開はアプリ側）。初回は dueAt、各回の時刻は dueAt の時分（timeZone の時計）。" +
        "repeat.kind × interval（1=毎、2=隔、…）: daily は interval 日ごと、weekly は interval 週ごとの weekdays（1=日…7=土。空なら dueAt の曜日。週は日曜始まりで dueAt の週が 0 週目）、" +
        "monthly は interval か月ごとの monthly.mode（dayOfMonth = dueAt の日。29〜31 日は無い月は月末 / weekdayOrdinal = 第 ordinal 曜日 weekday。ordinal -1 は最終。無い月は飛ばす）、" +
        "yearly は interval 年ごとの dueAt の月日（2/29 は閏年以外 2/28）。終了は end.kind（never / until = その日を含む / count = 開始からの発生回数。done・skipped も数える）。" +
        "その日の状態は occurrences（無ければ pending）。",
    };
  }

  // --- 書き ---

  async addTodo(input: AddTodoInput): Promise<Record<string, unknown>> {
    const account = await this.fetchAccount();
    const now = this.now();
    if (!canAddTodo(account, now)) {
      throw new ToolError("PAYMENT_REQUIRED", "試用期間が終わっていて購読もありません。MustDo アプリで購読すると追加できます。", {
        trialStartedAt: account?.trialStartedAt?.toISOString() ?? null,
        subscribedUntil: account?.subscribedUntil?.toISOString() ?? null,
      });
    }
    const timeZone = this.accountTimeZone(account);
    const title = input.title.trim();
    if (!title) throw new ToolError("INVALID_ARGUMENT", "title が空です。");
    const defaultTime = this.accountDefaultTime(account);
    const dueAt = input.due === undefined ? tomorrowAt(defaultTime, timeZone, now) : parseDue(input.due, timeZone, defaultTime);
    if (!dueAt) throw new ToolError("INVALID_ARGUMENT", `due の形式は YYYY-MM-DD か YYYY-MM-DDTHH:mm か ISO8601: ${input.due}`);
    const repeatRule = input.repeat ? this.buildRepeatRule(input.repeat, timeZone) : null;

    const todo: Omit<Todo, "id" | "changeTag"> = {
      title,
      notes: input.notes?.trim() || null,
      dueAt,
      timeZone,
      repeatRule,
      status: "pending",
      snoozedUntil: null,
      completedAt: null,
      sound: input.sound ?? "default",
      source: "mcp",
      updatedAt: now,
      deletedAt: null,
    };
    const id = randomUUID().toUpperCase();
    const saved = await this.client.modify({
      operationType: "create",
      record: { recordName: id, recordType: RECORD_TYPE_TODO, fields: stripNulls(todoFields(todo)) },
    });
    log("INFO", "todo.added", { id, repeat: repeatRule?.kind ?? "none" });
    return todoToJSON(todoFromRecord(saved) ?? { ...todo, id, changeTag: saved.recordChangeTag ?? null });
  }

  async updateTodo(input: UpdateTodoInput): Promise<Record<string, unknown>> {
    // due に YYYY-MM-DD だけが来たら Account.defaultTime で時刻を補うので、due があるときだけ Account を読む。
    const defaultTime = input.due !== undefined ? this.accountDefaultTime(await this.fetchAccount()) : null;
    const saved = await this.saveTodoWithRetry(input.id, (current) => {
      const next: Todo = { ...current, updatedAt: this.now() };
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new ToolError("INVALID_ARGUMENT", "title が空です。");
        next.title = title;
      }
      if (input.due !== undefined) {
        const dueAt = parseDue(input.due, current.timeZone, defaultTime);
        if (!dueAt) throw new ToolError("INVALID_ARGUMENT", `due の形式は YYYY-MM-DD か YYYY-MM-DDTHH:mm か ISO8601: ${input.due}`);
        next.dueAt = dueAt;
      }
      if (input.repeat !== undefined) {
        next.repeatRule = input.repeat === null ? null : this.buildRepeatRule(input.repeat, current.timeZone);
      }
      if (input.notes !== undefined) next.notes = input.notes?.trim() || null;
      if (input.sound !== undefined) next.sound = input.sound;
      if (input.status !== undefined) {
        if (isRepeating(next)) {
          throw new ToolError("INVALID_ARGUMENT", "繰り返し TODO の状態は complete_todo / snooze_todo で日付を指定して変えてください。");
        }
        next.status = input.status;
        next.completedAt = input.status === "done" ? this.now() : null;
        if (input.status !== "pending") next.snoozedUntil = null;
      }
      return next;
    });
    log("INFO", "todo.updated", { id: input.id });
    return todoToJSON(saved);
  }

  async completeTodo(id: string, occurrenceDate?: string): Promise<Record<string, unknown>> {
    return this.applyState(id, occurrenceDate, { status: "done", snoozedUntil: null });
  }

  async snoozeTodo(id: string, until: string, occurrenceDate?: string): Promise<Record<string, unknown>> {
    return this.applyState(id, occurrenceDate, { status: "pending", snoozedUntil: until });
  }

  async deleteTodo(id: string): Promise<Record<string, unknown>> {
    const saved = await this.saveTodoWithRetry(id, (current) => ({ ...current, deletedAt: this.now(), updatedAt: this.now() }));
    log("INFO", "todo.deleted", { id });
    return { id: saved.id, deletedAt: saved.deletedAt?.toISOString() ?? null };
  }

  // --- 内部 ---

  /// `repeat` 入力 → `RepeatRule`。範囲外・組み合わせ違いは `INVALID_ARGUMENT`（アプリは知らない値を既定値に倒すが、MCP は書く前に検査する）。
  /// `kind: "none"` は `null`（繰り返しなし）。
  private buildRepeatRule(input: RepeatInput, timeZone: string): RepeatRule | null {
    if (input.kind === "none") return null;
    const kind = input.kind;

    const interval = input.interval ?? 1;
    if (!Number.isInteger(interval) || interval < REPEAT_INTERVAL_MIN || interval > REPEAT_INTERVAL_MAX) {
      throw new ToolError("INVALID_ARGUMENT", `repeat.interval は ${REPEAT_INTERVAL_MIN}〜${REPEAT_INTERVAL_MAX} の整数: ${interval}`);
    }

    let weekdays: number[] = [];
    if (kind === "weekly") {
      weekdays = [...new Set(input.weekdays ?? [])].sort((a, b) => a - b);
      if (weekdays.some((d) => !isValidWeekday(d))) {
        throw new ToolError("INVALID_ARGUMENT", "repeat.weekdays は 1〜7 の整数（1=日…7=土）。");
      }
    }

    let monthly: MonthlyRule = { mode: "dayOfMonth" };
    if (kind === "monthly" && input.monthly) {
      const m = input.monthly;
      if (m.mode === "weekdayOrdinal") {
        if (m.ordinal === undefined || !isValidOrdinal(m.ordinal)) {
          throw new ToolError("INVALID_ARGUMENT", `repeat.monthly.ordinal は 1〜5 か -1（最終）: ${m.ordinal}`);
        }
        if (m.weekday === undefined || !isValidWeekday(m.weekday)) {
          throw new ToolError("INVALID_ARGUMENT", `repeat.monthly.weekday は 1〜7（1=日…7=土）: ${m.weekday}`);
        }
        monthly = { mode: "weekdayOrdinal", ordinal: m.ordinal, weekday: m.weekday };
      } else if (m.mode !== "dayOfMonth") {
        throw new ToolError("INVALID_ARGUMENT", `repeat.monthly.mode は dayOfMonth か weekdayOrdinal: ${String(m.mode)}`);
      }
    }

    const endInput = input.end ?? (input.until !== undefined ? { kind: "until" as const, until: input.until } : { kind: "never" as const });
    let end: RepeatEnd;
    switch (endInput.kind) {
      case "never":
        end = { kind: "never" };
        break;
      case "until": {
        if (!endInput.until) throw new ToolError("INVALID_ARGUMENT", "repeat.end.kind=until には until（YYYY-MM-DD か ISO8601）が要ります。");
        const until = parseUntil(endInput.until, timeZone);
        if (!until) throw new ToolError("INVALID_ARGUMENT", `repeat.end.until の形式は YYYY-MM-DD か ISO8601: ${endInput.until}`);
        end = { kind: "until", until };
        break;
      }
      case "count": {
        const count = endInput.count;
        if (count === undefined || !Number.isInteger(count) || count < REPEAT_COUNT_MIN || count > REPEAT_COUNT_MAX) {
          throw new ToolError("INVALID_ARGUMENT", `repeat.end.count は ${REPEAT_COUNT_MIN}〜${REPEAT_COUNT_MAX} の整数: ${count}`);
        }
        end = { kind: "count", count };
        break;
      }
      default:
        throw new ToolError("INVALID_ARGUMENT", `repeat.end.kind は never / until / count: ${String((endInput as { kind: unknown }).kind)}`);
    }

    return { kind, interval, weekdays, monthly, end };
  }

  private async fetchTodo(id: string): Promise<Todo> {
    const record = await this.client.lookup(id);
    const todo = record ? todoFromRecord(record) : null;
    if (!todo) throw new ToolError("NOT_FOUND", `TODO が見つかりません: ${id}`);
    if (todo.deletedAt) throw new ToolError("NOT_FOUND", `TODO は削除済みです: ${id}`);
    return todo;
  }

  /// `recordChangeTag` 付きで update。CONFLICT なら 1 回だけ読み直して `mutate` をやり直す。
  private async saveTodoWithRetry(id: string, mutate: (current: Todo) => Todo): Promise<Todo> {
    let current = await this.fetchTodo(id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = mutate(current);
      try {
        const saved = await this.client.modify({
          operationType: "update",
          record: {
            recordName: id,
            recordType: RECORD_TYPE_TODO,
            ...(current.changeTag ? { recordChangeTag: current.changeTag } : {}),
            fields: todoFields(next),
          },
        });
        return todoFromRecord(saved) ?? { ...next, changeTag: saved.recordChangeTag ?? null };
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt === 1) throw error;
        log("WARN", "todo.conflictRetry", { id });
        const server = error.serverRecord ? todoFromRecord(error.serverRecord) : null;
        current = server ?? (await this.fetchTodo(id));
      }
    }
    throw new ToolError("CONFLICT", "更新が 2 回続けて衝突しました。もう一度やり直してください。");
  }

  private async applyState(
    id: string,
    occurrenceDate: string | undefined,
    change: { status: TodoStatus; snoozedUntil: string | null },
  ): Promise<Record<string, unknown>> {
    const todo = await this.fetchTodo(id);
    const now = this.now();
    const snoozedUntil = change.snoozedUntil !== null ? parseDateTime(change.snoozedUntil, todo.timeZone) : null;
    if (change.snoozedUntil !== null && !snoozedUntil) {
      throw new ToolError("INVALID_ARGUMENT", `until の形式は YYYY-MM-DDTHH:mm か ISO8601: ${change.snoozedUntil}`);
    }

    if (!isRepeating(todo)) {
      const saved = await this.saveTodoWithRetry(id, (current) => ({
        ...current,
        status: change.status,
        snoozedUntil,
        completedAt: change.status === "done" ? now : null,
        updatedAt: now,
      }));
      log("INFO", "todo.stateChanged", { id, status: change.status, snoozed: snoozedUntil !== null });
      return todoToJSON(saved);
    }

    const key = occurrenceDate ?? dayKey(now, todo.timeZone);
    if (!startOfDay(key, todo.timeZone)) throw new ToolError("INVALID_ARGUMENT", `occurrenceDate の形式は YYYY-MM-DD: ${key}`);
    const occurrence: Omit<Occurrence, "changeTag"> = { todoID: id, key, status: change.status, snoozedUntil, changedAt: now };
    const saved = await this.upsertOccurrence(occurrence);
    log("INFO", "occurrence.upserted", { id, key, status: change.status });
    return { ...todoToJSON(todo), occurrence: occurrenceToJSON(saved) };
  }

  /// Occurrence の upsert。既存なら `update`（changeTag 付き）、無ければ `create`。衝突は 1 回読み直す。
  private async upsertOccurrence(o: Omit<Occurrence, "changeTag">): Promise<Occurrence> {
    const recordName = occurrenceRecordName(o.todoID, o.key);
    let existing: CKRecord | null = await this.client.lookup(recordName);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const saved = existing
          ? await this.client.modify({
              operationType: "update",
              record: {
                recordName,
                recordType: RECORD_TYPE_OCCURRENCE,
                ...(existing.recordChangeTag ? { recordChangeTag: existing.recordChangeTag } : {}),
                fields: occurrenceFields(o),
              },
            })
          : await this.client.modify({
              operationType: "create",
              record: { recordName, recordType: RECORD_TYPE_OCCURRENCE, fields: stripNulls(occurrenceFields(o)) },
            });
        return occurrenceFromRecord(saved) ?? { ...o, changeTag: saved.recordChangeTag ?? null };
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt === 1) throw error;
        log("WARN", "occurrence.conflictRetry", { recordName });
        existing = error.serverRecord ?? (await this.client.lookup(recordName));
      }
    }
    throw new ToolError("CONFLICT", "Occurrence の更新が 2 回続けて衝突しました。");
  }
}

// --- 絞り込みの純粋関数（テスト対象） ---

/// 単発の「実質の時刻」。スヌーズ中はスヌーズ先。
export function effectiveDue(todo: Todo): Date {
  return todo.snoozedUntil && todo.status === "pending" ? todo.snoozedUntil : todo.dueAt;
}

export function inRange(date: Date, start: Date | null, end: Date | null): boolean {
  if (start && date.getTime() < start.getTime()) return false;
  if (end && date.getTime() >= end.getTime()) return false;
  return true;
}

/// 繰り返しテンプレが範囲内に鳴る**可能性**があるか。厳密な展開はアプリ側（`RepeatRule.days`）なので、
/// ここで確実に言えること（初回より前・`until` より後・毎週（interval 1）で曜日が合わない）だけで落とし、他は含める。
export function ruleIntersectsRange(todo: Todo, start: Date | null, end: Date | null): boolean {
  const rule = todo.repeatRule;
  if (!rule || rule.kind === "none") return false;
  if (end && todo.dueAt.getTime() >= end.getTime()) return false;
  if (start && rule.end.kind === "until" && rule.end.until.getTime() < start.getTime()) return false;
  if (rule.kind !== "weekly" || rule.interval !== 1) return true;
  if (!start || !end) return true;
  // 毎週: 範囲が 7 日未満なら曜日が合う日があるか見る。曜日が空なら dueAt の曜日。
  const weekdays = rule.weekdays.length > 0 ? rule.weekdays : [weekday(todo.dueAt, todo.timeZone)];
  const DAY = 86_400_000;
  const days = Math.ceil((end.getTime() - start.getTime()) / DAY);
  if (days >= 7) return true;
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * DAY + 12 * 3_600_000); // 正午で曜日を取る（DST の揺れ回避）
    if (d.getTime() >= end.getTime()) break;
    if (weekdays.includes(weekday(d, todo.timeZone))) return true;
  }
  return false;
}

/// Occurrence の `key`（YYYY-MM-DD）が from〜to（どちらも YYYY-MM-DD、含む）に入るか。文字列比較で足りる。
export function occurrenceInRange(o: Occurrence, fromKey: string | null, toKey: string | null): boolean {
  return (!fromKey || o.key >= fromKey) && (!toKey || o.key <= toKey);
}
