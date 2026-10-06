import { beforeEach, describe, expect, it } from "vitest";

import { CloudKitClient } from "../src/cloudkit.js";
import { NotSignedInError, ToolError } from "../src/errors.js";
import { MustDoService } from "../src/service.js";
import { accountRecord, FakeCloudKit, todoRecord, tokyo } from "./fakeCloudKit.js";

const NOW = new Date(tokyo(2026, 10, 5, 8, 0)); // 2026-10-05 08:00 JST（月曜）

function makeService(fake: FakeCloudKit, token: string | null = "web-token") {
  const client = new CloudKitClient({
    container: "iCloud.jp.lightning.mustdo",
    environment: "development",
    apiToken: "api-token",
    zoneName: "MustDo",
    fetch: fake.fetch,
    getWebAuthToken: () => token,
  });
  return new MustDoService({ client, now: () => NOW, defaultTimeZone: "Asia/Tokyo" });
}

describe("MustDoService", () => {
  let fake: FakeCloudKit;

  beforeEach(() => {
    fake = new FakeCloudKit();
    fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "Asia/Tokyo" }));
  });

  describe("get_me", () => {
    it("Account と今日（Account の timeZone）を返す", async () => {
      const me = await makeService(fake).getMe();
      expect(me.today).toBe("2026-10-05");
      expect(me.timeZone).toBe("Asia/Tokyo");
      expect(me.weekday).toBe(2);
      expect(me.canAddTodo).toBe(true);
      expect(me.trialEndsAt).toBe(new Date(tokyo(2026, 10, 31)).toISOString());
    });

    it("Account に defaultTime が無ければ 09:00、defaultDueNext は明日の既定時刻", async () => {
      const me = await makeService(fake).getMe();
      expect(me.defaultTime).toBe("09:00");
      expect(me.defaultDueNext).toBe(new Date(tokyo(2026, 10, 6, 9)).toISOString());
    });

    it("Account の defaultTime を読み、defaultDueNext に反映する", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "Asia/Tokyo", defaultTime: "07:30" }));
      const me = await makeService(fake).getMe();
      expect(me.defaultTime).toBe("07:30");
      expect(me.defaultDueNext).toBe(new Date(tokyo(2026, 10, 6, 7, 30)).toISOString());
    });

    it("壊れた defaultTime は 09:00 に落ちる", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), defaultTime: "朝" }));
      const me = await makeService(fake).getMe();
      expect(me.defaultTime).toBe("09:00");
    });
  });

  describe("list_todos", () => {
    beforeEach(() => {
      fake.put(todoRecord("A", { title: "今日 9 時", dueAt: tokyo(2026, 10, 5, 9) }));
      fake.put(todoRecord("B", { title: "明日", dueAt: tokyo(2026, 10, 6, 9) }));
      fake.put(todoRecord("C", { title: "済み", dueAt: tokyo(2026, 10, 5, 7), status: "done", completedAt: tokyo(2026, 10, 5, 7, 5) }));
      fake.put(todoRecord("D", { title: "消えた", dueAt: tokyo(2026, 10, 5, 10), deletedAt: tokyo(2026, 10, 4) }));
      fake.put(todoRecord("E", { title: "毎日の薬", dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily" }));
      fake.put(todoRecord("F", { title: "火木", dueAt: tokyo(2026, 9, 1, 20), repeatKind: "weekly", repeatWeekdays: [3, 5] }));
      fake.put(todoRecord("G", { title: "終わった繰り返し", dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily", repeatUntil: tokyo(2026, 9, 30, 23, 59) }));
      fake.put(
        todoRecord("H", {
          title: "毎月 第 1 月曜",
          dueAt: tokyo(2026, 10, 5, 10),
          repeatKind: "monthly",
          repeatInterval: 1,
          repeatMonthlyMode: "weekdayOrdinal",
          repeatOrdinal: 1,
          repeatOrdinalWeekday: 2,
          repeatEndKind: "count",
          repeatCount: 6,
        }),
      );
      fake.put(todoRecord("I", { title: "まだ先の繰り返し", dueAt: tokyo(2026, 10, 7, 10), repeatKind: "yearly" }));
      fake.put({
        recordName: "E|2026-10-05",
        recordType: "Occurrence",
        fields: {
          todo: { value: { recordName: "E", action: "DELETE_SELF" }, type: "REFERENCE" },
          key: { value: "2026-10-05", type: "STRING" },
          status: { value: "done", type: "STRING" },
          changedAt: { value: tokyo(2026, 10, 5, 8, 1), type: "TIMESTAMP" },
        },
      });
    });

    it("date で 1 日に絞り、既定は pending、削除済みは出ない、繰り返しはテンプレのまま", async () => {
      const res = await makeService(fake).listTodos({ date: "2026-10-05" });
      const ids = (res.todos as any[]).map((t) => t.id);
      expect(ids).toEqual(["A"]);
      const rep = res.repeating as any[];
      expect(rep.map((t) => t.id)).toEqual(["E", "H"]); // F は月曜に鳴らない、G は until 切れ、I は初回が範囲より後
      expect(rep[0].occurrences).toEqual([
        expect.objectContaining({ date: "2026-10-05", status: "done" }),
      ]);
      // repeat はアプリ側の契約の形そのまま（展開しない）
      expect(rep[1].repeat).toEqual({
        kind: "monthly",
        interval: 1,
        weekdays: [],
        monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 },
        end: { kind: "count", count: 6 },
      });
      expect(rep[0].repeat).toEqual({ kind: "daily", interval: 1, weekdays: [], monthly: { mode: "dayOfMonth" }, end: { kind: "never" } });
      expect(String(res.note)).toContain("展開はアプリ側");
    });

    it("毎週以外（隔週・毎月・毎年）は曜日で落とさず、初回以後なら範囲に含める（厳密な展開はアプリ側）", async () => {
      fake.put(todoRecord("J", { title: "隔週 土", dueAt: tokyo(2026, 9, 5, 10), repeatKind: "weekly", repeatInterval: 2, repeatWeekdays: [7] }));
      const res = await makeService(fake).listTodos({ date: "2026-10-06" }); // 火曜
      expect((res.repeating as any[]).map((t) => t.id).sort()).toEqual(["E", "F", "H", "J"]);
      expect((res.repeating as any[]).map((t) => t.id)).not.toContain("I");
    });

    it("from/to の範囲（両端含む）と status=all", async () => {
      const res = await makeService(fake).listTodos({ from: "2026-10-05", to: "2026-10-06", status: "all" });
      expect((res.todos as any[]).map((t) => t.id)).toEqual(["C", "A", "B"]);
      expect((res.repeating as any[]).map((t) => t.id)).toEqual(["E", "F", "H"]); // 火曜が範囲に入る。I は初回 10/7 が範囲より後
    });

    it("status=done は単発だけ、includeRepeating=false でテンプレを省く", async () => {
      const done = await makeService(fake).listTodos({ date: "2026-10-05", status: "done" });
      expect((done.todos as any[]).map((t) => t.id)).toEqual(["C"]);
      expect(done.repeating).toEqual([]);

      const noRep = await makeService(fake).listTodos({ includeRepeating: false });
      expect(noRep.repeating).toEqual([]);
      expect((noRep.todos as any[]).map((t) => t.id)).toEqual(["A", "B"]);
    });

    it("日付の形式が違えば INVALID_ARGUMENT", async () => {
      await expect(makeService(fake).listTodos({ date: "10/5" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });
  });

  describe("add_todo", () => {
    it("試用切れ・購読なしは PAYMENT_REQUIRED", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 8, 1) })); // 30 日以上前
      const err = await makeService(fake)
        .addTodo({ title: "x", due: "2026-10-05T09:00" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe("PAYMENT_REQUIRED");
      expect(fake.calls.filter((c) => c.path === "records/modify")).toHaveLength(0);
    });

    it("購読があれば試用切れでも追加できる", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 8, 1), subscribedUntil: tokyo(2027, 1, 1) }));
      const res = await makeService(fake).addTodo({ title: "x", due: "2026-10-05T09:00" });
      expect(res.status).toBe("pending");
    });

    it("create 操作で source=mcp・dueAt は Account の時間帯・繰り返しも入る", async () => {
      const res = await makeService(fake).addTodo({
        title: "  ゴミ出し ",
        due: "2026-10-06T07:30",
        repeat: { kind: "weekly", weekdays: [3, 6, 3], until: "2026-12-31" },
        notes: "燃えるゴミ",
        sound: "chime",
      });
      const modify = fake.calls.find((c) => c.path === "records/modify")!;
      const op = modify.body.operations[0];
      expect(op.operationType).toBe("create");
      expect(op.record.recordType).toBe("Todo");
      expect(op.record.recordName).toMatch(/^[0-9A-F-]{36}$/);
      expect(op.record.fields.source).toEqual({ value: "mcp", type: "STRING" });
      expect(op.record.fields.title.value).toBe("ゴミ出し");
      expect(op.record.fields.dueAt.value).toBe(tokyo(2026, 10, 6, 7, 30));
      expect(op.record.fields.timeZone.value).toBe("Asia/Tokyo");
      expect(op.record.fields.repeatKind.value).toBe("weekly");
      expect(op.record.fields.repeatWeekdays.value).toEqual([3, 6]);
      expect(op.record.fields.repeatUntil.value).toBe(tokyo(2026, 12, 31, 23, 59) + 59_000);
      expect(op.record.fields.sound.value).toBe("chime");
      expect(op.record.fields).not.toHaveProperty("snoozedUntil");
      expect(res.id).toBe(op.record.recordName);
      expect(op.record.fields.repeatInterval.value).toBe(1);
      expect(op.record.fields.repeatEndKind.value).toBe("until");
      expect(op.record.fields).not.toHaveProperty("repeatCount");
      // 旧形 {kind, weekdays, until} は end: {kind: until} と読む
      expect(res.repeat).toEqual({
        kind: "weekly",
        interval: 1,
        weekdays: [3, 6],
        monthly: { mode: "dayOfMonth" },
        end: { kind: "until", until: new Date(tokyo(2026, 12, 31, 23, 59) + 59_000).toISOString() },
      });
    });

    describe("repeat（iOS カレンダーと同じ語彙）", () => {
      async function add(repeat: any) {
        const res = await makeService(fake).addTodo({ title: "x", due: "2026-10-05T09:00", repeat });
        const op = fake.calls.filter((c) => c.path === "records/modify").at(-1)!.body.operations[0];
        return { res, fields: op.record.fields as Record<string, { value: unknown }> };
      }

      it("毎月 5 日（monthly は既定 dayOfMonth）", async () => {
        const { res, fields } = await add({ kind: "monthly" });
        expect(fields.repeatKind.value).toBe("monthly");
        expect(fields.repeatInterval.value).toBe(1);
        expect(fields.repeatMonthlyMode.value).toBe("dayOfMonth");
        expect(fields).not.toHaveProperty("repeatOrdinal");
        expect(fields.repeatEndKind.value).toBe("never");
        expect(res.repeat).toEqual({ kind: "monthly", interval: 1, weekdays: [], monthly: { mode: "dayOfMonth" }, end: { kind: "never" } });
      });

      it("毎月 第 1 月曜（weekdayOrdinal）", async () => {
        const { res, fields } = await add({ kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 } });
        expect(fields.repeatMonthlyMode.value).toBe("weekdayOrdinal");
        expect(fields.repeatOrdinal.value).toBe(1);
        expect(fields.repeatOrdinalWeekday.value).toBe(2);
        expect((res.repeat as any).monthly).toEqual({ mode: "weekdayOrdinal", ordinal: 1, weekday: 2 });
      });

      it("最終金曜（ordinal -1）", async () => {
        const { fields } = await add({ kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: -1, weekday: 6 } });
        expect(fields.repeatOrdinal.value).toBe(-1);
        expect(fields.repeatOrdinalWeekday.value).toBe(6);
      });

      it("10 回で終了（end=count）", async () => {
        const { res, fields } = await add({ kind: "daily", end: { kind: "count", count: 10 } });
        expect(fields.repeatEndKind.value).toBe("count");
        expect(fields.repeatCount.value).toBe(10);
        expect(fields).not.toHaveProperty("repeatUntil");
        expect((res.repeat as any).end).toEqual({ kind: "count", count: 10 });
      });

      it("隔週・3 日ごと・毎年（interval）", async () => {
        const biweekly = await add({ kind: "weekly", interval: 2, weekdays: [6] });
        expect(biweekly.fields.repeatInterval.value).toBe(2);
        expect(biweekly.fields.repeatWeekdays.value).toEqual([6]);
        const every3 = await add({ kind: "daily", interval: 3 });
        expect(every3.fields.repeatInterval.value).toBe(3);
        const yearly = await add({ kind: "yearly" });
        expect(yearly.fields.repeatKind.value).toBe("yearly");
        expect(yearly.res.repeat).toEqual({ kind: "yearly", interval: 1, weekdays: [], monthly: { mode: "dayOfMonth" }, end: { kind: "never" } });
      });

      it("新形の end.until は YYYY-MM-DD をその日の終わりに。end があれば旧形の until は無視", async () => {
        const { fields } = await add({ kind: "weekly", weekdays: [2], end: { kind: "until", until: "2026-12-31" }, until: "2026-11-30" });
        expect(fields.repeatEndKind.value).toBe("until");
        expect(fields.repeatUntil.value).toBe(tokyo(2026, 12, 31, 23, 59) + 59_000);
      });

      it("weekly の weekdays は省略できる（due の曜日。アプリ側が補う）", async () => {
        const { fields } = await add({ kind: "weekly" });
        expect(fields.repeatWeekdays.value).toEqual([]);
      });

      it("weekdays / monthly は他の kind では捨てる", async () => {
        const { fields } = await add({ kind: "daily", weekdays: [2], monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 } });
        expect(fields.repeatWeekdays.value).toEqual([]);
        expect(fields.repeatMonthlyMode.value).toBe("dayOfMonth");
        expect(fields).not.toHaveProperty("repeatOrdinal");
      });

      it("kind: none は繰り返しなし", async () => {
        const { res, fields } = await add({ kind: "none", interval: 5 });
        expect(fields.repeatKind.value).toBe("none");
        expect(res.repeat).toBeNull();
      });

      it("範囲外は INVALID_ARGUMENT（書き込みしない）", async () => {
        const bad = [
          { kind: "daily", interval: 0 },
          { kind: "daily", interval: 100 },
          { kind: "daily", interval: 1.5 },
          { kind: "weekly", weekdays: [0] },
          { kind: "weekly", weekdays: [8] },
          { kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: 6, weekday: 2 } },
          { kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: 0, weekday: 2 } },
          { kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 8 } },
          { kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: 1 } },
          { kind: "monthly", monthly: { mode: "lunar" } },
          { kind: "daily", end: { kind: "count", count: 0 } },
          { kind: "daily", end: { kind: "count", count: 1000 } },
          { kind: "daily", end: { kind: "count" } },
          { kind: "daily", end: { kind: "until" } },
          { kind: "daily", end: { kind: "until", until: "年末" } },
          { kind: "daily", end: { kind: "someday" } },
        ];
        for (const repeat of bad) {
          await expect(add(repeat), JSON.stringify(repeat)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
        expect(fake.calls.filter((c) => c.path === "records/modify")).toHaveLength(0);
      });
    });

    it("due を省略すると明日の既定時刻（Account に defaultTime が無ければ 09:00）", async () => {
      const res = await makeService(fake).addTodo({ title: "牛乳を買う" });
      const op = fake.calls.find((c) => c.path === "records/modify")!.body.operations[0];
      expect(op.record.fields.dueAt.value).toBe(tokyo(2026, 10, 6, 9)); // NOW は 10/5 8:00 JST → 明日 10/6 9:00
      expect(op.record.fields.timeZone.value).toBe("Asia/Tokyo");
      expect(res.dueAt).toBe(new Date(tokyo(2026, 10, 6, 9)).toISOString());
      expect(res.repeat).toBeNull();
    });

    it("due を省略すると Account.defaultTime の時刻になる", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "Asia/Tokyo", defaultTime: "07:30" }));
      const res = await makeService(fake).addTodo({ title: "薬" });
      expect(res.dueAt).toBe(new Date(tokyo(2026, 10, 6, 7, 30)).toISOString());
    });

    it("due を省略したときの「明日」は Account の timeZone で決まる", async () => {
      // NOW = 2026-10-04T23:00Z。ロサンゼルスではまだ 10/4 16:00 → 明日は 10/5 9:00 PDT
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "America/Los_Angeles" }));
      const res = await makeService(fake).addTodo({ title: "call" });
      expect(res.timeZone).toBe("America/Los_Angeles");
      expect(res.dueAt).toBe("2026-10-05T16:00:00.000Z");
    });

    it("due に YYYY-MM-DD だけ渡すとその日の既定時刻", async () => {
      const res1 = await makeService(fake).addTodo({ title: "x", due: "2026-10-10" });
      expect(res1.dueAt).toBe(new Date(tokyo(2026, 10, 10, 9)).toISOString());

      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "Asia/Tokyo", defaultTime: "21:00" }));
      const res2 = await makeService(fake).addTodo({ title: "y", due: "2026-10-10" });
      expect(res2.dueAt).toBe(new Date(tokyo(2026, 10, 10, 21)).toISOString());
    });

    it("due に時刻を渡せば defaultTime は無視される", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "Asia/Tokyo", defaultTime: "21:00" }));
      const res = await makeService(fake).addTodo({ title: "x", due: "2026-10-05T15:00" });
      expect(res.dueAt).toBe(new Date(tokyo(2026, 10, 5, 15)).toISOString());
    });

    it("due が壊れていると INVALID_ARGUMENT", async () => {
      await expect(makeService(fake).addTodo({ title: "x", due: "そのうち" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });
  });

  describe("complete_todo", () => {
    it("単発は status=done・completedAt を recordChangeTag 付き update で書く", async () => {
      fake.put(todoRecord("A", { dueAt: tokyo(2026, 10, 5, 9), snoozedUntil: tokyo(2026, 10, 5, 9, 10) }));
      const res = await makeService(fake).completeTodo("A");
      const op = fake.calls.find((c) => c.path === "records/modify")!.body.operations[0];
      expect(op.operationType).toBe("update");
      expect(op.record.recordChangeTag).toBe("tag2"); // account が tag1、A が tag2
      expect(op.record.fields.status.value).toBe("done");
      expect(op.record.fields.completedAt.value).toBe(NOW.getTime());
      expect(op.record.fields.snoozedUntil).toEqual({ value: null });
      expect(res.status).toBe("done");
      expect(fake.get("A")!.fields.snoozedUntil).toBeUndefined();
    });

    it("繰り返しは Occurrence <id>|<YYYY-MM-DD> を create（既定は今日）", async () => {
      fake.put(todoRecord("E", { dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily" }));
      const res = await makeService(fake).completeTodo("E");
      const op = fake.calls.find((c) => c.path === "records/modify")!.body.operations[0];
      expect(op.operationType).toBe("create");
      expect(op.record.recordName).toBe("E|2026-10-05");
      expect(op.record.recordType).toBe("Occurrence");
      expect(op.record.fields.todo).toEqual({ value: { recordName: "E", action: "DELETE_SELF" }, type: "REFERENCE" });
      expect(op.record.fields.key.value).toBe("2026-10-05");
      expect(op.record.fields.status.value).toBe("done");
      expect(op.record.fields.changedAt.value).toBe(NOW.getTime());
      expect((res.occurrence as any).status).toBe("done");
      expect(fake.get("E")!.fields.status.value).toBe("pending"); // テンプレは触らない
    });

    it("既にある Occurrence は update（upsert）", async () => {
      fake.put(todoRecord("E", { dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily" }));
      fake.put({
        recordName: "E|2026-10-04",
        recordType: "Occurrence",
        fields: {
          todo: { value: { recordName: "E", action: "DELETE_SELF" }, type: "REFERENCE" },
          key: { value: "2026-10-04", type: "STRING" },
          status: { value: "pending", type: "STRING" },
          snoozedUntil: { value: tokyo(2026, 10, 4, 9), type: "TIMESTAMP" },
          changedAt: { value: tokyo(2026, 10, 4, 8), type: "TIMESTAMP" },
        },
      });
      await makeService(fake).completeTodo("E", "2026-10-04");
      const op = fake.calls.find((c) => c.path === "records/modify")!.body.operations[0];
      expect(op.operationType).toBe("update");
      expect(op.record.recordName).toBe("E|2026-10-04");
      expect(op.record.recordChangeTag).toBe("tag3");
      const saved = fake.get("E|2026-10-04")!;
      expect(saved.fields.status.value).toBe("done");
      expect(saved.fields.snoozedUntil).toBeUndefined();
    });

    it("無い id は NOT_FOUND、削除済みも NOT_FOUND", async () => {
      fake.put(todoRecord("D", { deletedAt: tokyo(2026, 10, 1) }));
      await expect(makeService(fake).completeTodo("ZZZ")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(makeService(fake).completeTodo("D")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("snooze_todo / delete_todo / update_todo", () => {
    it("単発のスヌーズは snoozedUntil（TODO の timeZone で解釈）", async () => {
      fake.put(todoRecord("A", { dueAt: tokyo(2026, 10, 5, 9) }));
      const res = await makeService(fake).snoozeTodo("A", "2026-10-05T10:00");
      expect(res.snoozedUntil).toBe(new Date(tokyo(2026, 10, 5, 10)).toISOString());
      expect(res.status).toBe("pending");
    });

    it("繰り返しのスヌーズは Occurrence に pending + snoozedUntil", async () => {
      fake.put(todoRecord("E", { dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily" }));
      await makeService(fake).snoozeTodo("E", "2026-10-05T10:00", "2026-10-05");
      const saved = fake.get("E|2026-10-05")!;
      expect(saved.fields.status.value).toBe("pending");
      expect(saved.fields.snoozedUntil.value).toBe(tokyo(2026, 10, 5, 10));
    });

    it("delete_todo は deletedAt を書くだけ（物理削除しない）", async () => {
      fake.put(todoRecord("A", { dueAt: tokyo(2026, 10, 5, 9) }));
      const res = await makeService(fake).deleteTodo("A");
      expect(res.deletedAt).toBe(NOW.toISOString());
      expect(fake.get("A")).toBeDefined();
      expect(fake.get("A")!.fields.deletedAt.value).toBe(NOW.getTime());
    });

    it("update_todo で繰り返しを毎月 第 1 月曜・10 回に置き換える（旧形 weekly からの移行）", async () => {
      fake.put(todoRecord("F", { title: "旧", dueAt: tokyo(2026, 9, 1, 20), repeatKind: "weekly", repeatWeekdays: [3, 5], repeatUntil: tokyo(2026, 12, 31) }));
      const res = await makeService(fake).updateTodo({
        id: "F",
        repeat: { kind: "monthly", monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 }, end: { kind: "count", count: 10 } },
      });
      expect(res.repeat).toEqual({
        kind: "monthly",
        interval: 1,
        weekdays: [],
        monthly: { mode: "weekdayOrdinal", ordinal: 1, weekday: 2 },
        end: { kind: "count", count: 10 },
      });
      const saved = fake.get("F")!.fields;
      expect(saved.repeatKind.value).toBe("monthly");
      expect(saved.repeatWeekdays.value).toEqual([]);
      expect(saved.repeatUntil).toBeUndefined(); // until は消える
      expect(saved.repeatCount.value).toBe(10);
    });

    it("update_todo の repeat が範囲外なら INVALID_ARGUMENT で何も書かない", async () => {
      fake.put(todoRecord("F", { dueAt: tokyo(2026, 9, 1, 20), repeatKind: "weekly", repeatWeekdays: [3, 5] }));
      await expect(makeService(fake).updateTodo({ id: "F", repeat: { kind: "daily", interval: 100 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(fake.calls.filter((c) => c.path === "records/modify")).toHaveLength(0);
    });

    it("complete_todo の occurrenceDate は形式だけ検査する（その日が発生日かはアプリ側の展開に任せる）", async () => {
      fake.put(
        todoRecord("H", { dueAt: tokyo(2026, 10, 5, 10), repeatKind: "monthly", repeatMonthlyMode: "weekdayOrdinal", repeatOrdinal: 1, repeatOrdinalWeekday: 2 }),
      );
      const res = await makeService(fake).completeTodo("H", "2026-11-02");
      expect((res.occurrence as any).date).toBe("2026-11-02");
      await expect(makeService(fake).completeTodo("H", "11/2")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("update_todo は渡した項目だけ変え、repeat: null で繰り返しを外す", async () => {
      fake.put(todoRecord("F", { title: "旧", dueAt: tokyo(2026, 9, 1, 20), repeatKind: "weekly", repeatWeekdays: [3, 5], notes: "memo" }));
      const res = await makeService(fake).updateTodo({ id: "F", title: "新", repeat: null });
      expect(res.title).toBe("新");
      expect(res.repeat).toBeNull();
      expect(res.notes).toBe("memo");
      expect(fake.get("F")!.fields.repeatKind.value).toBe("none");
    });

    it("update_todo の due に YYYY-MM-DD だけ渡すとその日の既定時刻（Account.defaultTime）", async () => {
      fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1), timeZone: "Asia/Tokyo", defaultTime: "07:30" }));
      fake.put(todoRecord("A", { dueAt: tokyo(2026, 10, 5, 9) }));
      const res = await makeService(fake).updateTodo({ id: "A", due: "2026-10-12" });
      expect(res.dueAt).toBe(new Date(tokyo(2026, 10, 12, 7, 30)).toISOString());
    });

    it("繰り返し TODO の status 変更は拒否", async () => {
      fake.put(todoRecord("E", { dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily" }));
      await expect(makeService(fake).updateTodo({ id: "E", status: "done" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });
  });

  describe("衝突", () => {
    it("CONFLICT は 1 回読み直して再試行し、2 回目で成功する", async () => {
      fake.put(todoRecord("A", { dueAt: tokyo(2026, 10, 5, 9) }));
      fake.options.conflictOnce = true;
      const res = await makeService(fake).completeTodo("A");
      expect(res.status).toBe("done");
      const modifies = fake.calls.filter((c) => c.path === "records/modify");
      expect(modifies).toHaveLength(2);
      expect(modifies[1]!.body.operations[0].record.recordChangeTag).not.toBe(modifies[0]!.body.operations[0].record.recordChangeTag);
    });
  });

  describe("認証", () => {
    it("ckWebAuthToken が無ければ通信せずに NOT_SIGNED_IN", async () => {
      const err = await makeService(fake, null).getMe().catch((e) => e);
      expect(err).toBeInstanceOf(NotSignedInError);
      expect(fake.calls).toHaveLength(0);
    });

    it("421 が返れば NOT_SIGNED_IN と redirectURL", async () => {
      fake.options.unauthenticated = true;
      const err = await makeService(fake).getMe().catch((e) => e);
      expect(err).toBeInstanceOf(NotSignedInError);
      expect(err.message).toContain("sign_in");
      expect(err.redirectURL).toContain("idmsa.apple.com");
    });

    it("API Token 未設定は NOT_CONFIGURED", async () => {
      const client = new CloudKitClient({
        container: "c",
        environment: "development",
        apiToken: "",
        zoneName: "MustDo",
        fetch: fake.fetch,
        getWebAuthToken: () => "t",
      });
      await expect(new MustDoService({ client, now: () => NOW }).getMe()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    });
  });
});
