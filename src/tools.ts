/// TODO を扱う 7 ツールの定義（zod スキーマ）と登録。stdio（`server.ts`）と中継（`https://ltng.jp/api/mustdo/mcp`）の両方がここを使う。
/// `sign_in` はローカル専用なので `server.ts` にある。ここに手元のファイルやブラウザに触るものを足さないこと。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { NotSignedInError, ToolError } from "./errors.js";
import { log } from "./log.js";
import { ALARM_SOUNDS, MONTHLY_MODES, REPEAT_END_KINDS, REPEAT_KINDS, TODO_STATUSES } from "./model.js";
import type { MustDoService } from "./service.js";

export const TODO_TOOL_NAMES = ["get_me", "list_todos", "add_todo", "update_todo", "complete_todo", "snooze_todo", "delete_todo"] as const;

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const dateTimeSchema = z.string().min(1).describe("YYYY-MM-DDTHH:mm（Account の timeZone の時計）か、オフセット付き ISO8601");
const dueSchema = z
  .string()
  .min(1)
  .describe(
    "鳴らす時刻。YYYY-MM-DDTHH:mm（Account の timeZone の時計）か、オフセット付き ISO8601。YYYY-MM-DD だけなら「その日の既定時刻（Account.defaultTime、既定 09:00）」。",
  );
const soundSchema = z.enum(ALARM_SOUNDS).describe(`アラーム音。${ALARM_SOUNDS.join(", ")}`);
const repeatMonthlySchema = z
  .object({
    mode: z.enum(MONTHLY_MODES).describe("dayOfMonth = due の日（29〜31 日は無い月は月末）/ weekdayOrdinal = 第 n 曜日"),
    ordinal: z.number().int().optional().describe("weekdayOrdinal のとき。1〜5、-1 = 最終"),
    weekday: z.number().int().optional().describe("weekdayOrdinal のとき。1=日 … 7=土"),
  })
  .describe("monthly の鳴らし方。省略で dayOfMonth");
const repeatEndSchema = z
  .object({
    kind: z.enum(REPEAT_END_KINDS).describe("never = 無期限 / until = この日まで / count = 回数"),
    until: z.string().optional().describe("until のとき。YYYY-MM-DD（Account の timeZone の日、その日を含む）か ISO8601"),
    count: z.number().int().optional().describe("count のとき。開始からの発生回数 1〜999（done / skipped も 1 回）"),
  })
  .describe("終了。省略で never");
const repeatSchema = z
  .object({
    kind: z.enum(REPEAT_KINDS).describe("none = 繰り返しなし / daily / weekly / monthly / yearly"),
    interval: z.number().int().optional().describe("1 = 毎、2 = 隔、…（1〜99）。省略で 1"),
    weekdays: z.array(z.number().int()).optional().describe("weekly の曜日。1=日 … 7=土。省略・空なら due の曜日"),
    monthly: repeatMonthlySchema.optional(),
    end: repeatEndSchema.optional(),
    until: z.string().optional().describe("旧形。end を省略したときだけ使う（end: {kind: until, until} と同じ）"),
  })
  .describe(
    "繰り返し（iOS カレンダーと同じ語彙）。省略した項目は既定値（interval 1・weekdays []・monthly.mode dayOfMonth・end.kind never）。範囲外は INVALID_ARGUMENT。例: " +
      "毎日 {kind:daily} / 毎週 月水 {kind:weekly, weekdays:[2,4]} / 隔週 {kind:weekly, interval:2} / 3 日ごと {kind:daily, interval:3} / " +
      "毎月 5 日 {kind:monthly}（due を 5 日に）/ 毎月 第 1 月曜 {kind:monthly, monthly:{mode:weekdayOrdinal, ordinal:1, weekday:2}} / " +
      "毎月 最終金曜 {kind:monthly, monthly:{mode:weekdayOrdinal, ordinal:-1, weekday:6}} / 毎年 {kind:yearly}（due の月日）/ " +
      "10 回で終了 {kind:daily, end:{kind:count, count:10}} / 12/31 まで {kind:weekly, weekdays:[2], end:{kind:until, until:\"2026-12-31\"}}",
  );

export interface ErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolRunHooks {
  /// `NotSignedInError` のとき（421）。stdio は auth.json のキャッシュを捨て、中継は保管トークンを消す。
  onNotSignedIn?: (error: NotSignedInError) => void | Promise<void>;
  /// エラー本文の差し替え（中継は「claude.ai で接続し直して」に変える）。
  mapError?: (payload: ErrorPayload, error: unknown) => ErrorPayload;
  /// 呼び出しごとの記録（ツール名・所要時間・結果コード）。本文は渡さない。
  onFinished?: (info: { tool: string; ms: number; ok: boolean; code?: string }) => void;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof NotSignedInError) {
    return { code: error.code, message: error.message, details: { hint: "sign_in ツールを実行してください。" } };
  }
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message };
}

/// ツール本体を包む。成功は JSON 文字列、失敗は `isError` ＋ `{code, message}`。
export function makeToolRunner(hooks: ToolRunHooks = {}) {
  return async (action: string, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const result = await fn();
      hooks.onFinished?.({ tool: action, ms: Date.now() - started, ok: true });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof NotSignedInError) await hooks.onNotSignedIn?.(error);
      let payload = toErrorPayload(error);
      if (hooks.mapError) payload = hooks.mapError(payload, error);
      log(payload.code === "NOT_SIGNED_IN" || payload.code === "PAYMENT_REQUIRED" ? "WARN" : "ERROR", `tool.${action}.failed`, { code: payload.code });
      hooks.onFinished?.({ tool: action, ms: Date.now() - started, ok: false, code: payload.code });
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  };
}

export type ToolRunner = ReturnType<typeof makeToolRunner>;

/// 7 ツールを `server` に登録する。
export function registerTodoTools(server: McpServer, service: MustDoService, run: ToolRunner): void {
  server.registerTool(
    "get_me",
    {
      title: "アカウント情報と今日",
      description:
        "Account レコード（trialStartedAt / subscribedUntil / timeZone / defaultTime）と、その時間帯での今日の日付・曜日、" +
        "due を省略したときに使われる「明日の既定時刻」（defaultDueNext、ISO8601）を返す。日付を扱う前に呼ぶ。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("get_me", () => service.getMe()),
  );

  server.registerTool(
    "list_todos",
    {
      title: "TODO 一覧",
      description:
        "TODO を一覧する。date（1 日）か from/to（両端含む、YYYY-MM-DD、Account の timeZone）で絞る。省略で全期間。status の既定は pending。" +
        "削除済み（deletedAt あり）は含めない。繰り返しは展開せず repeating にテンプレートとして返し、範囲内の Occurrence（回ごとの done / skipped / スヌーズ）を添える。" +
        "展開はアプリ側で MCP はしない。規則（repeat）: kind × interval（1=毎、2=隔）。daily は interval 日ごと、weekly は weekdays（1=日…7=土。空なら dueAt の曜日）の曜日、" +
        "monthly は dueAt の日（dayOfMonth。無い月は月末）か第 n 曜日（weekdayOrdinal、ordinal -1 = 最終）、yearly は dueAt の月日。終了は end（never / until = その日を含む / count = 開始からの回数）。" +
        "初回は dueAt、各回の時刻は dueAt の時分（timeZone の時計）。",
      inputSchema: {
        date: dayKeySchema.optional().describe("この 1 日だけ"),
        from: dayKeySchema.optional().describe("この日から（含む）"),
        to: dayKeySchema.optional().describe("この日まで（含む）"),
        status: z.enum([...TODO_STATUSES, "all"]).optional().describe("既定 pending。done / skipped は単発だけに効く"),
        includeRepeating: z.boolean().optional().describe("既定 true。false で繰り返しテンプレートを省く"),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => run("list_todos", () => service.listTodos(input)),
  );

  server.registerTool(
    "add_todo",
    {
      title: "TODO を追加",
      description:
        "TODO を追加する（source=mcp）。ひとことで TODO を言われたら title だけ渡す。" +
        "due を省略すると明日の既定時刻（Account の timeZone での今日の翌日、Account.defaultTime、既定 09:00）になる。" +
        "「明日 9 時」「今日 15 時」など利用者が時刻を言ったときだけ due を渡す（YYYY-MM-DDTHH:mm は Account の timeZone の時計、ISO8601 も可）。" +
        "日付だけ言われたら due に YYYY-MM-DD を渡すと「その日の既定時刻」になる。" +
        "繰り返しは repeat で（iOS カレンダーと同じ語彙: 毎日 / 毎週 月水 / 隔週 / 毎月 5 日 / 毎月 第 1 月曜 / 最終金曜 / 毎年 / 3 日ごと / 10 回で終了 / 12/31 まで）。" +
        "初回は due（毎月 5 日なら due を 5 日に、毎年なら due の月日）。" +
        "試用（30 日）も購読も切れていると isError + code=PAYMENT_REQUIRED。",
      inputSchema: {
        title: z.string().min(1).max(200),
        due: dueSchema.optional(),
        repeat: repeatSchema.optional(),
        notes: z.string().max(2000).optional(),
        sound: soundSchema.optional(),
      },
    },
    async (input) => run("add_todo", () => service.addTodo(input)),
  );

  server.registerTool(
    "update_todo",
    {
      title: "TODO を更新",
      description:
        "TODO の題名・時刻・繰り返し・メモ・音・状態を変える。渡した項目だけ変わる。repeat は丸ごと置き換え（省略した項目は既定値）。" +
        "repeat: null か {kind: none} で繰り返しを外す。notes: null でメモを消す。" +
        "繰り返し TODO の status は変えられない（complete_todo / snooze_todo を使う）。",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        due: dueSchema.optional(),
        repeat: repeatSchema.nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
        sound: soundSchema.optional(),
        status: z.enum(TODO_STATUSES).optional(),
      },
    },
    async (input) => run("update_todo", () => service.updateTodo(input)),
  );

  server.registerTool(
    "complete_todo",
    {
      title: "TODO を完了",
      description:
        "やった、にする。単発は status=done と completedAt。繰り返しは occurrenceDate（YYYY-MM-DD、省略で TODO の timeZone での今日）の回を Occurrence に done で記録する。",
      inputSchema: {
        id: z.string().min(1),
        occurrenceDate: dayKeySchema.optional().describe("繰り返しのどの回か。省略で今日"),
      },
    },
    async ({ id, occurrenceDate }) => run("complete_todo", () => service.completeTodo(id, occurrenceDate)),
  );

  server.registerTool(
    "snooze_todo",
    {
      title: "TODO をスヌーズ",
      description: "until（YYYY-MM-DDTHH:mm は TODO の timeZone、または ISO8601）まで鳴らさない。繰り返しは occurrenceDate の回だけ。",
      inputSchema: {
        id: z.string().min(1),
        until: dateTimeSchema,
        occurrenceDate: dayKeySchema.optional().describe("繰り返しのどの回か。省略で今日"),
      },
    },
    async ({ id, until, occurrenceDate }) => run("snooze_todo", () => service.snoozeTodo(id, until, occurrenceDate)),
  );

  server.registerTool(
    "delete_todo",
    {
      title: "TODO を削除",
      description: "deletedAt を書く soft delete。アプリ側で 14 日後に物理削除される。",
      inputSchema: { id: z.string().min(1) },
      // 破壊的操作。クライアントが実行前に確認を出せるようにする（14 日後に iCloud から消え、元に戻せない）。
      annotations: { destructiveHint: true },
    },
    async ({ id }) => run("delete_todo", () => service.deleteTodo(id)),
  );
}
