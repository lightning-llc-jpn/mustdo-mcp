/// CloudKit Web Services の薄いクライアント。
/// https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/
///
/// - 未認証（ckWebAuthToken 無し／失効）は HTTP 421 ＋ `redirectURL` → `NotSignedInError`
/// - レコード単位のエラーは HTTP 200 の中に `serverErrorCode` で混ざる（CONFLICT / NOT_FOUND など）

import { NotSignedInError, ToolError } from "./errors.js";
import { log } from "./log.js";

export const CLOUDKIT_BASE = "https://api.apple-cloudkit.com/database/1";
export const DEFAULT_OWNER = "_defaultOwner";

export interface ZoneID {
  zoneName: string;
  ownerRecordName: string;
}

/// フィールド値。日付は ms epoch、Reference は `{recordName, action}`、Int64 list は配列。
export interface CKField {
  value: unknown;
  type?: string;
}

export interface CKRecord {
  recordName: string;
  recordType: string;
  recordChangeTag?: string;
  fields: Record<string, CKField>;
  created?: { timestamp: number };
  modified?: { timestamp: number };
  deleted?: boolean;
}

/// `records[]` の 1 件がエラーのときの形。
export interface CKRecordError {
  recordName?: string;
  serverErrorCode: string;
  reason?: string;
  serverRecord?: CKRecord;
}

export type CKRecordResult = CKRecord | CKRecordError;

export function isRecordError(r: CKRecordResult): r is CKRecordError {
  return typeof (r as CKRecordError).serverErrorCode === "string";
}

export type OperationType = "create" | "update" | "forceUpdate" | "replace" | "forceReplace" | "delete" | "forceDelete";

export interface ModifyOperation {
  operationType: OperationType;
  record: {
    recordName: string;
    recordType?: string;
    recordChangeTag?: string;
    fields?: Record<string, CKField>;
  };
}

export interface CloudKitClientOptions {
  container: string;
  environment: "development" | "production";
  apiToken: string;
  zoneName: string;
  /// テストで差し替える。
  fetch?: typeof fetch;
  /// 保存済みの ckWebAuthToken を返す。無ければ null。
  getWebAuthToken: () => string | null;
  /// CloudKit が応答ヘッダーで新しい ckWebAuthToken を返したときに呼ぶ。呼び出し側は保存し直し、次から
  /// `getWebAuthToken` でそれを返す。最初のトークンを使い続けると発行から 30 分（「サインインしたままにする」なら
  /// 2 週間）で 421 になる。
  onWebAuthTokenRotated?: (token: string) => void;
  /// 421 を受けたときに呼ぶ。保存先を読み直して、いまのトークンを返す（無ければ null）。送ったものと違えば、
  /// ほかのプロセスが先に使って替えた（トークンは 1 往復ごとの使い捨て）ということなので、それで 1 回だけやり直す。
  /// 渡さなければやり直さない（中継は自前の仕組みで見分ける）。
  reloadWebAuthToken?: () => string | null;
}

/// 新しい ckWebAuthToken を運ぶ応答ヘッダー。Apple の CloudKit JS と同じく前者を先に見る。
const ROTATED_TOKEN_HEADERS = ["x-apple-cloudkit-web-auth-token", "x-apple-cloudkit-session"] as const;

interface CKErrorBody {
  uuid?: string;
  serverErrorCode?: string;
  reason?: string;
  redirectURL?: string;
}

/// ckWebAuthToken が無い／失効／ほかの往復で使われたあと。
function isAuthError(status: number, body: CKErrorBody | null): boolean {
  return status === 421 || body?.serverErrorCode === "AUTHENTICATION_REQUIRED" || body?.serverErrorCode === "AUTHENTICATION_FAILED";
}

export class CloudKitClient {
  private readonly fetchImpl: typeof fetch;
  readonly zoneID: ZoneID;
  readonly baseURL: string;
  /// `users/caller` は public database にしか無い（private に投げると BAD_REQUEST）。
  private readonly publicBaseURL: string;

  constructor(private readonly options: CloudKitClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.zoneID = { zoneName: options.zoneName, ownerRecordName: DEFAULT_OWNER };
    const environmentURL = `${CLOUDKIT_BASE}/${options.container}/${options.environment}`;
    this.baseURL = `${environmentURL}/private`;
    this.publicBaseURL = `${environmentURL}/public`;
  }

  /// サインインを生かし続けるための 1 往復。`users/caller`（利用者 ID を返すだけ。TODO は読まない）を呼び、
  /// 返ってきた新しい ckWebAuthToken を `onWebAuthTokenRotated` に渡す。トークンの寿命は作られてから 30 分
  /// （「サインインしたままにする」で 2 週間）で、新しいものは呼んだときにしか返らない。
  async keepAlive(): Promise<void> {
    await this.send("users/caller", { method: "GET" }, this.publicBaseURL);
  }

  /// zone 内の `recordType` を全件。`continuationMarker` を辿る。
  async queryAll(recordType: string, pageSize = 200): Promise<CKRecord[]> {
    const out: CKRecord[] = [];
    let continuationMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const body: Record<string, unknown> = {
        zoneID: this.zoneID,
        query: { recordType },
        resultsLimit: pageSize,
      };
      if (continuationMarker) body.continuationMarker = continuationMarker;
      const res = (await this.post("records/query", body)) as { records?: CKRecordResult[]; continuationMarker?: string };
      for (const r of res.records ?? []) {
        if (isRecordError(r)) {
          log("WARN", "cloudkit.query.recordError", { recordType, recordName: r.recordName, code: r.serverErrorCode });
          continue;
        }
        out.push(r);
      }
      if (!res.continuationMarker) break;
      continuationMarker = res.continuationMarker;
    }
    return out;
  }

  /// 1 件取得。無ければ null。
  async lookup(recordName: string): Promise<CKRecord | null> {
    const res = (await this.post("records/lookup", {
      zoneID: this.zoneID,
      records: [{ recordName }],
    })) as { records?: CKRecordResult[] };
    const first = res.records?.[0];
    if (!first) return null;
    if (isRecordError(first)) {
      if (first.serverErrorCode === "NOT_FOUND") return null;
      throw this.recordError(first);
    }
    return first;
  }

  /// 1 操作だけの modify。CONFLICT は `ConflictError` にして呼び出し側が読み直す。
  async modify(operation: ModifyOperation): Promise<CKRecord> {
    const res = (await this.post("records/modify", {
      zoneID: this.zoneID,
      operations: [operation],
    })) as { records?: CKRecordResult[] };
    const first = res.records?.[0];
    if (!first) throw new ToolError("CLOUDKIT_ERROR", "CloudKit の modify が空の結果を返しました。");
    if (isRecordError(first)) {
      if (first.serverErrorCode === "CONFLICT") throw new ConflictError(first.serverRecord ?? null);
      throw this.recordError(first);
    }
    return first;
  }

  /// サインイン画面の URL を取る。ckWebAuthToken 無しで叩いて 421 の `redirectURL` を拾う。
  async fetchSignInURL(): Promise<string> {
    const url = this.buildURL("users/caller", null);
    const response = await this.fetchImpl(url, { method: "GET" });
    const body = (await safeJSON(response)) as CKErrorBody | null;
    if (response.status === 421 && body?.redirectURL) return body.redirectURL;
    if (response.ok) {
      throw new ToolError("CLOUDKIT_ERROR", "ckWebAuthToken 無しで認証済みと判定されました。API Token の設定を確認してください。");
    }
    throw this.httpError(response.status, body);
  }

  private buildURL(path: string, webAuthToken: string | null, baseURL = this.baseURL): string {
    const params = new URLSearchParams({ ckAPIToken: this.options.apiToken });
    if (webAuthToken) params.set("ckWebAuthToken", webAuthToken);
    return `${baseURL}/${path}?${params.toString()}`;
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /// サインイン済みの 1 往復。新しいトークンを受け取り、421 は（保存先のトークンが替わっていれば）1 回だけやり直す。
  private async send(path: string, init: RequestInit, baseURL = this.baseURL): Promise<unknown> {
    if (!this.options.apiToken) {
      throw new ToolError("NOT_CONFIGURED", "MUSTDO_CK_API_TOKEN（または ~/.mustdo/config.json の apiToken）が未設定です。README を見て CloudKit Dashboard で API Token を作ってください。");
    }
    let sentToken = this.options.getWebAuthToken();
    if (!sentToken) throw new NotSignedInError();
    for (let retried = false; ; retried = true) {
      const started = Date.now();
      const response = await this.fetchImpl(this.buildURL(path, sentToken, baseURL), init);
      this.takeRotatedToken(response, sentToken);
      const json = (await safeJSON(response)) as CKErrorBody | null;
      log("DEBUG", "cloudkit.request", { path, status: response.status, ms: Date.now() - started });
      if (response.ok) return json;
      if (!retried && isAuthError(response.status, json)) {
        const reloaded = this.options.reloadWebAuthToken?.() ?? null;
        if (reloaded && reloaded !== sentToken) {
          log("INFO", "cloudkit.retryWithReloadedToken", { path });
          sentToken = reloaded;
          continue;
        }
      }
      throw this.httpError(response.status, json);
    }
  }

  private takeRotatedToken(response: Response, sentToken: string): void {
    if (!this.options.onWebAuthTokenRotated || response.status === 421) return;
    for (const name of ROTATED_TOKEN_HEADERS) {
      const token = response.headers.get(name);
      if (!token) continue;
      if (token !== sentToken) {
        this.options.onWebAuthTokenRotated(token);
        log("DEBUG", "cloudkit.tokenRotated", { header: name });
      }
      return;
    }
  }

  private httpError(status: number, body: CKErrorBody | null): ToolError {
    if (isAuthError(status, body)) {
      log("WARN", "cloudkit.notSignedIn", { status, code: body?.serverErrorCode });
      return new NotSignedInError(body?.redirectURL);
    }
    log("ERROR", "cloudkit.httpError", { status, code: body?.serverErrorCode, reason: body?.reason, uuid: body?.uuid });
    if (status === 401 || status === 403) {
      return new ToolError("NOT_CONFIGURED", `CloudKit が ${status} を返しました。API Token（ckAPIToken）か環境（${this.options.environment}）が合っていない可能性があります。`, {
        status,
        serverErrorCode: body?.serverErrorCode,
        reason: body?.reason,
      });
    }
    if (body?.serverErrorCode === "ZONE_NOT_FOUND") {
      // query 系は HTTP 404 で返る（record 系の recordError と同じ意味）。
      return new ToolError("CLOUDKIT_ERROR", `zone「${this.zoneID.zoneName}」が ${this.options.environment} に無い。MustDo アプリを一度起動して iCloud に同期させてください。`, {
        status,
        serverErrorCode: body.serverErrorCode,
      });
    }
    return new ToolError("CLOUDKIT_ERROR", `CloudKit が HTTP ${status} を返しました: ${body?.serverErrorCode ?? ""} ${body?.reason ?? ""}`.trim(), {
      status,
      serverErrorCode: body?.serverErrorCode,
      reason: body?.reason,
      uuid: body?.uuid,
    });
  }

  private recordError(r: CKRecordError): ToolError {
    log("ERROR", "cloudkit.recordError", { recordName: r.recordName, code: r.serverErrorCode, reason: r.reason });
    if (r.serverErrorCode === "ZONE_NOT_FOUND") {
      return new ToolError("CLOUDKIT_ERROR", `zone「${this.zoneID.zoneName}」が ${this.options.environment} に無い。MustDo アプリを一度起動して iCloud に同期させてください。`, {
        serverErrorCode: r.serverErrorCode,
      });
    }
    return new ToolError("CLOUDKIT_ERROR", `CloudKit のレコード操作に失敗: ${r.serverErrorCode} ${r.reason ?? ""}`.trim(), {
      recordName: r.recordName,
      serverErrorCode: r.serverErrorCode,
      reason: r.reason,
    });
  }
}

/// `update` が `recordChangeTag` 不一致で弾かれた。`serverRecord` にサーバーの現在値が入る（無いこともある）。
export class ConflictError extends ToolError {
  constructor(readonly serverRecord: CKRecord | null) {
    super("CONFLICT", "CloudKit のレコードが別の端末で更新されていました。");
    this.name = "ConflictError";
  }
}

async function safeJSON(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { reason: text.slice(0, 500) };
  }
}
