/// ツールが返すエラー。`code` は MCP の呼び出し側（AI）が分岐に使う。

export type ErrorCode =
  | "NOT_SIGNED_IN"
  | "NOT_CONFIGURED"
  | "PAYMENT_REQUIRED"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "CLOUDKIT_ERROR"
  | "SIGN_IN_TIMEOUT";

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

/// CloudKit が 421 を返した（ckWebAuthToken が無い／失効）。`redirectURL` はサインイン画面。
export class NotSignedInError extends ToolError {
  readonly redirectURL: string | undefined;

  constructor(redirectURL?: string) {
    super("NOT_SIGNED_IN", "iCloud にサインインしていません。`sign_in` ツールを実行してください。");
    this.name = "NotSignedInError";
    this.redirectURL = redirectURL;
  }
}
