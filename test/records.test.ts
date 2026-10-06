import { describe, expect, it } from "vitest";

import type { CKRecord } from "../src/cloudkit.js";
import type { Todo } from "../src/model.js";
import { occurrenceFields, occurrenceFromRecord, repeatToJSON, stripNulls, todoFields, todoFromRecord } from "../src/records.js";

describe("records 変換", () => {
  const todo: Todo = {
    id: "ABC",
    title: "薬を飲む",
    notes: "食後",
    dueAt: new Date("2026-10-05T00:00:00Z"),
    timeZone: "Asia/Tokyo",
    repeatRule: {
      kind: "weekly",
      interval: 1,
      weekdays: [2, 4, 6],
      monthly: { mode: "dayOfMonth" },
      end: { kind: "until", until: new Date("2026-12-31T14:59:59Z") },
    },
    status: "pending",
    snoozedUntil: null,
    completedAt: null,
    sound: "marimba",
    source: "mcp",
    updatedAt: new Date("2026-10-04T12:00:00Z"),
    deletedAt: null,
    changeTag: "t1",
  };

  it("Todo → fields → Todo で往復する", () => {
    const fields = todoFields(todo);
    expect(fields.dueAt).toEqual({ value: Date.UTC(2026, 9, 5), type: "TIMESTAMP" });
    expect(fields.repeatWeekdays).toEqual({ value: [2, 4, 6], type: "INT64_LIST" });
    expect(fields.repeatInterval).toEqual({ value: 1, type: "INT64" });
    expect(fields.repeatMonthlyMode).toEqual({ value: "dayOfMonth", type: "STRING" });
    expect(fields.repeatOrdinal).toEqual({ value: null });
    expect(fields.repeatEndKind).toEqual({ value: "until", type: "STRING" });
    expect(fields.repeatUntil).toEqual({ value: Date.UTC(2026, 11, 31, 14, 59, 59), type: "TIMESTAMP" });
    expect(fields.repeatCount).toEqual({ value: null });
    expect(fields.snoozedUntil).toEqual({ value: null });

    const record: CKRecord = { recordName: "ABC", recordType: "Todo", recordChangeTag: "t1", fields: stripNulls(fields) };
    expect(todoFromRecord(record)).toEqual(todo);
  });

  it("create 用の stripNulls は null を落とす", () => {
    const stripped = stripNulls(todoFields(todo));
    expect(Object.keys(stripped)).not.toContain("snoozedUntil");
    expect(Object.keys(stripped)).not.toContain("deletedAt");
    expect(Object.keys(stripped)).toContain("notes");
  });

  it("知らない enum 値は既定値に落ちる（配列ごと捨てない）", () => {
    const record: CKRecord = {
      recordName: "X",
      recordType: "Todo",
      fields: {
        title: { value: "t" },
        dueAt: { value: 1_000 },
        status: { value: "weird" },
        sound: { value: "kazoo" },
        source: { value: "alien" },
        repeatKind: { value: "fortnightly" },
      },
    };
    const t = todoFromRecord(record)!;
    expect(t.status).toBe("pending");
    expect(t.sound).toBe("default");
    expect(t.source).toBe("app");
    expect(t.repeatRule).toBeNull();
  });

  describe("繰り返し（iOS カレンダーと同じ語彙）", () => {
    const base = (fields: Record<string, unknown>): CKRecord => ({
      recordName: "R",
      recordType: "Todo",
      fields: Object.fromEntries(Object.entries({ title: "t", dueAt: 1_000, ...fields }).map(([k, v]) => [k, { value: v }])),
    });

    it("毎月 第 1 月曜（weekdayOrdinal）が往復する", () => {
      const rule: Todo["repeatRule"] = {
        kind: "monthly",
        interval: 1,
        weekdays: [],
        monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 },
        end: { kind: "never" },
      };
      const fields = todoFields({ ...todo, repeatRule: rule });
      expect(fields.repeatKind).toEqual({ value: "monthly", type: "STRING" });
      expect(fields.repeatMonthlyMode).toEqual({ value: "weekdayOrdinal", type: "STRING" });
      expect(fields.repeatOrdinal).toEqual({ value: 1, type: "INT64" });
      expect(fields.repeatOrdinalWeekday).toEqual({ value: 2, type: "INT64" });
      expect(fields.repeatEndKind).toEqual({ value: "never", type: "STRING" });
      expect(fields.repeatUntil).toEqual({ value: null });
      const back = todoFromRecord({ recordName: "ABC", recordType: "Todo", recordChangeTag: "t1", fields: stripNulls(fields) })!;
      expect(back.repeatRule).toEqual(rule);
      expect(repeatToJSON(back.repeatRule!)).toEqual({
        kind: "monthly",
        interval: 1,
        weekdays: [],
        monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 },
        end: { kind: "never" },
      });
    });

    it("最終金曜（ordinal -1）・隔週・終了=回数が往復する", () => {
      const lastFriday: Todo["repeatRule"] = {
        kind: "monthly",
        interval: 2,
        weekdays: [],
        monthly: { mode: "weekdayOrdinal", ordinal: -1, weekday: 6 },
        end: { kind: "count", count: 10 },
      };
      const fields = todoFields({ ...todo, repeatRule: lastFriday });
      expect(fields.repeatInterval).toEqual({ value: 2, type: "INT64" });
      expect(fields.repeatOrdinal).toEqual({ value: -1, type: "INT64" });
      expect(fields.repeatEndKind).toEqual({ value: "count", type: "STRING" });
      expect(fields.repeatCount).toEqual({ value: 10, type: "INT64" });
      expect(fields.repeatUntil).toEqual({ value: null });
      const back = todoFromRecord({ recordName: "ABC", recordType: "Todo", fields: stripNulls(fields) })!;
      expect(back.repeatRule).toEqual(lastFriday);
      expect(repeatToJSON(back.repeatRule!).end).toEqual({ kind: "count", count: 10 });
    });

    it("毎年・3 日ごとが往復する", () => {
      for (const rule of [
        { kind: "yearly", interval: 1, weekdays: [], monthly: { mode: "dayOfMonth" }, end: { kind: "never" } },
        { kind: "daily", interval: 3, weekdays: [], monthly: { mode: "dayOfMonth" }, end: { kind: "never" } },
      ] as const) {
        const fields = todoFields({ ...todo, repeatRule: rule });
        expect(todoFromRecord({ recordName: "ABC", recordType: "Todo", fields: stripNulls(fields) })!.repeatRule).toEqual(rule);
      }
    });

    it("旧レコード（repeatKind + repeatWeekdays + repeatUntil だけ）は interval 1・end=until で読む", () => {
      const t = todoFromRecord(base({ repeatKind: "weekly", repeatWeekdays: [3, 5], repeatUntil: 5_000 }))!;
      expect(t.repeatRule).toEqual({
        kind: "weekly",
        interval: 1,
        weekdays: [3, 5],
        monthly: { mode: "dayOfMonth" },
        end: { kind: "until", until: new Date(5_000) },
      });
      const noUntil = todoFromRecord(base({ repeatKind: "daily" }))!;
      expect(noUntil.repeatRule).toEqual({ kind: "daily", interval: 1, weekdays: [], monthly: { mode: "dayOfMonth" }, end: { kind: "never" } });
    });

    it("endKind=until なのに repeatUntil が無い・count なのに repeatCount が無いときは never、endKind=never なら repeatUntil があっても never", () => {
      expect(todoFromRecord(base({ repeatKind: "daily", repeatEndKind: "until" }))!.repeatRule!.end).toEqual({ kind: "never" });
      expect(todoFromRecord(base({ repeatKind: "daily", repeatEndKind: "count" }))!.repeatRule!.end).toEqual({ kind: "never" });
      expect(todoFromRecord(base({ repeatKind: "daily", repeatEndKind: "never", repeatUntil: 5_000 }))!.repeatRule!.end).toEqual({ kind: "never" });
    });

    it("壊れた値は既定値に倒す（interval は 1〜99 に丸め、不正な weekdayOrdinal は dayOfMonth、count は 1〜999 に丸め、曜日は 1〜7 だけ）", () => {
      const t = todoFromRecord(
        base({
          repeatKind: "monthly",
          repeatInterval: 500,
          repeatMonthlyMode: "weekdayOrdinal",
          repeatOrdinal: 9,
          repeatOrdinalWeekday: 2,
          repeatEndKind: "count",
          repeatCount: 5_000,
          repeatWeekdays: [0, 3, 8],
        }),
      )!;
      expect(t.repeatRule).toEqual({
        kind: "monthly",
        interval: 99,
        weekdays: [3],
        monthly: { mode: "dayOfMonth" },
        end: { kind: "count", count: 999 },
      });
      expect(todoFromRecord(base({ repeatKind: "weekly", repeatInterval: 0 }))!.repeatRule!.interval).toBe(1);
      expect(todoFromRecord(base({ repeatKind: "monthly", repeatMonthlyMode: "lunar" }))!.repeatRule!.monthly).toEqual({ mode: "dayOfMonth" });
    });

    it("繰り返しなしは Swift の RepeatRule(kind: .none) と同じフィールドを書く", () => {
      const fields = todoFields({ ...todo, repeatRule: null });
      expect(fields.repeatKind).toEqual({ value: "none", type: "STRING" });
      expect(fields.repeatInterval).toEqual({ value: 1, type: "INT64" });
      expect(fields.repeatWeekdays).toEqual({ value: [], type: "INT64_LIST" });
      expect(fields.repeatMonthlyMode).toEqual({ value: "dayOfMonth", type: "STRING" });
      expect(fields.repeatEndKind).toEqual({ value: "never", type: "STRING" });
      expect(fields.repeatOrdinal).toEqual({ value: null });
      expect(fields.repeatOrdinalWeekday).toEqual({ value: null });
      expect(fields.repeatUntil).toEqual({ value: null });
      expect(fields.repeatCount).toEqual({ value: null });
    });
  });

  it("title か dueAt が無ければ null", () => {
    expect(todoFromRecord({ recordName: "X", recordType: "Todo", fields: { title: { value: "t" } } })).toBeNull();
    expect(todoFromRecord({ recordName: "X", recordType: "Occurrence", fields: {} })).toBeNull();
  });

  it("Occurrence の往復。Reference は {recordName, action}", () => {
    const fields = occurrenceFields({ todoID: "ABC", key: "2026-10-05", status: "done", snoozedUntil: null, changedAt: new Date(5_000) });
    expect(fields.todo).toEqual({ value: { recordName: "ABC", action: "DELETE_SELF" }, type: "REFERENCE" });
    const record: CKRecord = { recordName: "ABC|2026-10-05", recordType: "Occurrence", recordChangeTag: "o1", fields: stripNulls(fields) };
    expect(occurrenceFromRecord(record)).toEqual({
      todoID: "ABC",
      key: "2026-10-05",
      status: "done",
      snoozedUntil: null,
      changedAt: new Date(5_000),
      changeTag: "o1",
    });
  });
});
