/// CloudKit Web Services の `fetch` モック。メモリ上のレコードで query / lookup / modify を真似る。

import type { CKField, CKRecord } from "../src/cloudkit.js";

export interface FakeOptions {
  /// true なら全リクエストに 421 を返す（ckWebAuthToken 失効のふり）。
  unauthenticated?: boolean;
  /// 次の `update` を 1 回だけ CONFLICT にする。
  conflictOnce?: boolean;
}

export interface Call {
  path: string;
  method: string;
  query: URLSearchParams;
  body: any;
}

export class FakeCloudKit {
  readonly records = new Map<string, CKRecord>();
  readonly calls: Call[] = [];
  options: FakeOptions;
  private tagCounter = 0;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  put(record: Omit<CKRecord, "recordChangeTag"> & { recordChangeTag?: string }): CKRecord {
    const stored: CKRecord = { ...record, recordChangeTag: record.recordChangeTag ?? this.nextTag(), modified: { timestamp: Date.now() } };
    this.records.set(record.recordName, stored);
    return stored;
  }

  get(recordName: string): CKRecord | undefined {
    return this.records.get(recordName);
  }

  private nextTag(): string {
    this.tagCounter += 1;
    return `tag${this.tagCounter}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname.split("/private/")[1] ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({ path, method: init?.method ?? "GET", query: url.searchParams, body });

    if (this.options.unauthenticated || !url.searchParams.get("ckWebAuthToken")) {
      return json(421, {
        uuid: "u",
        serverErrorCode: "AUTHENTICATION_REQUIRED",
        reason: "no session",
        redirectURL: "https://idmsa.apple.com/appleauth/auth/signin?fake=1",
      });
    }

    switch (path) {
      case "records/query": {
        const type = body.query.recordType as string;
        const records = [...this.records.values()].filter((r) => r.recordType === type);
        return json(200, { records });
      }
      case "records/lookup": {
        const out = (body.records as { recordName: string }[]).map(({ recordName }) => {
          const r = this.records.get(recordName);
          return r ?? { recordName, serverErrorCode: "NOT_FOUND", reason: "Record not found" };
        });
        return json(200, { records: out });
      }
      case "records/modify": {
        const out = (body.operations as any[]).map((op) => this.applyOperation(op));
        return json(200, { records: out });
      }
      default:
        return json(404, { serverErrorCode: "BAD_REQUEST", reason: `unknown path ${path}` });
    }
  };

  private applyOperation(op: any): unknown {
    const { operationType, record } = op;
    const existing = this.records.get(record.recordName);
    if (operationType === "create") {
      if (existing) return { recordName: record.recordName, serverErrorCode: "CONFLICT", reason: "exists", serverRecord: existing };
      return this.put({ recordName: record.recordName, recordType: record.recordType, fields: { ...record.fields } });
    }
    if (operationType === "update" || operationType === "forceUpdate") {
      if (!existing) return { recordName: record.recordName, serverErrorCode: "NOT_FOUND", reason: "missing" };
      if (operationType === "update") {
        if (this.options.conflictOnce) {
          this.options.conflictOnce = false;
          // 別端末が触ったふり: タグを進めて返す。
          const bumped = this.put({ ...existing, recordChangeTag: this.nextTag() });
          return { recordName: record.recordName, serverErrorCode: "CONFLICT", reason: "changed", serverRecord: bumped };
        }
        if (record.recordChangeTag !== existing.recordChangeTag) {
          return { recordName: record.recordName, serverErrorCode: "CONFLICT", reason: "tag mismatch", serverRecord: existing };
        }
      }
      const merged: Record<string, CKField> = { ...existing.fields };
      for (const [k, f] of Object.entries(record.fields as Record<string, CKField>)) {
        if (f.value === null) delete merged[k];
        else merged[k] = f;
      }
      return this.put({ recordName: record.recordName, recordType: existing.recordType, fields: merged });
    }
    if (operationType === "delete" || operationType === "forceDelete") {
      this.records.delete(record.recordName);
      return { recordName: record.recordName, deleted: true };
    }
    return { recordName: record.recordName, serverErrorCode: "BAD_REQUEST", reason: `op ${operationType}` };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- レコードの組み立てヘルパ ---

export function todoRecord(
  recordName: string,
  fields: Partial<{
    title: string;
    notes: string;
    dueAt: number;
    timeZone: string;
    repeatKind: string;
    repeatInterval: number;
    repeatWeekdays: number[];
    repeatMonthlyMode: string;
    repeatOrdinal: number;
    repeatOrdinalWeekday: number;
    repeatEndKind: string;
    repeatUntil: number;
    repeatCount: number;
    status: string;
    snoozedUntil: number;
    completedAt: number;
    sound: string;
    source: string;
    updatedAt: number;
    deletedAt: number;
  }>,
): Omit<CKRecord, "recordChangeTag"> {
  const f: Record<string, CKField> = {};
  const put = (k: string, v: unknown, type: string) => {
    if (v !== undefined) f[k] = { value: v, type };
  };
  put("title", fields.title ?? "t", "STRING");
  put("notes", fields.notes, "STRING");
  put("dueAt", fields.dueAt ?? Date.UTC(2026, 9, 5, 0, 0), "TIMESTAMP");
  put("timeZone", fields.timeZone ?? "Asia/Tokyo", "STRING");
  put("repeatKind", fields.repeatKind ?? "none", "STRING");
  put("repeatInterval", fields.repeatInterval, "INT64"); // 省略 = 旧レコード（無ければ 1 と読む）
  put("repeatWeekdays", fields.repeatWeekdays ?? [], "INT64_LIST");
  put("repeatMonthlyMode", fields.repeatMonthlyMode, "STRING");
  put("repeatOrdinal", fields.repeatOrdinal, "INT64");
  put("repeatOrdinalWeekday", fields.repeatOrdinalWeekday, "INT64");
  put("repeatEndKind", fields.repeatEndKind, "STRING");
  put("repeatUntil", fields.repeatUntil, "TIMESTAMP");
  put("repeatCount", fields.repeatCount, "INT64");
  put("status", fields.status ?? "pending", "STRING");
  put("snoozedUntil", fields.snoozedUntil, "TIMESTAMP");
  put("completedAt", fields.completedAt, "TIMESTAMP");
  put("sound", fields.sound ?? "default", "STRING");
  put("source", fields.source ?? "app", "STRING");
  put("updatedAt", fields.updatedAt ?? Date.UTC(2026, 9, 1), "TIMESTAMP");
  put("deletedAt", fields.deletedAt, "TIMESTAMP");
  return { recordName, recordType: "Todo", fields: f };
}

export function accountRecord(fields: {
  trialStartedAt?: number;
  subscribedUntil?: number;
  timeZone?: string;
  defaultTime?: string;
}): Omit<CKRecord, "recordChangeTag"> {
  const f: Record<string, CKField> = {};
  if (fields.trialStartedAt !== undefined) f.trialStartedAt = { value: fields.trialStartedAt, type: "TIMESTAMP" };
  if (fields.subscribedUntil !== undefined) f.subscribedUntil = { value: fields.subscribedUntil, type: "TIMESTAMP" };
  if (fields.defaultTime !== undefined) f.defaultTime = { value: fields.defaultTime, type: "STRING" };
  f.timeZone = { value: fields.timeZone ?? "Asia/Tokyo", type: "STRING" };
  f.locale = { value: "ja_JP", type: "STRING" };
  return { recordName: "account", recordType: "Account", fields: f };
}

/// Asia/Tokyo の壁時計を ms epoch に（テストの読みやすさ用）。
export function tokyo(y: number, m: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, m - 1, d, h, mi) - 9 * 3_600_000;
}
