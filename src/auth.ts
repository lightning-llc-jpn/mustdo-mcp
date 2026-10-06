/// `ckWebAuthToken` の保存と、ブラウザでのサインイン。
///
/// 流れ: `sign_in` → CloudKit の 421 から `redirectURL` を得る → `http://localhost:<port>/callback` を待ち受ける
/// → `open` でブラウザを開く → Apple が `?ckSession=<token>` を付けて戻す → `~/.mustdo/auth.json` に保存。

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";

import { ToolError } from "./errors.js";
import { log } from "./log.js";

interface AuthFile {
  ckWebAuthToken: string;
  environment: string;
  savedAt: string;
}

export class AuthStore {
  private cached: string | null | undefined;
  readonly path: string;

  constructor(
    private readonly homeDir: string,
    private readonly environment: string,
  ) {
    this.path = join(homeDir, "auth.json");
  }

  getToken(): string | null {
    if (this.cached !== undefined) return this.cached;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<AuthFile>;
      // 環境が違うトークンは使えない（development と production は別のセッション）。
      this.cached =
        typeof parsed.ckWebAuthToken === "string" && (parsed.environment ?? this.environment) === this.environment
          ? parsed.ckWebAuthToken
          : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", "auth.readFailed", { path: this.path, error: (error as Error).message });
      }
      this.cached = null;
    }
    return this.cached;
  }

  saveToken(token: string): void {
    mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    const file: AuthFile = { ckWebAuthToken: token, environment: this.environment, savedAt: new Date().toISOString() };
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.cached = token;
    log("INFO", "auth.saved", { path: this.path, environment: this.environment });
  }

  /// 421 を受けたときに呼ぶ。次の呼び出しで `sign_in` を促す。
  invalidate(): void {
    this.cached = null;
  }
}

export interface SignInOptions {
  port: number;
  /// ブラウザが戻るまで待つ秒数。超えたらサーバーは残したまま一度返す。
  waitSeconds: number;
  /// テスト用。既定は macOS の `open`。
  openBrowser?: (url: string) => void;
}

/// 進行中のサインイン（サーバーが待ち受け中）。同時に 1 つだけ。
let pending: { server: Server; promise: Promise<string>; redirectURL: string } | null = null;

export function pendingSignIn(): { redirectURL: string } | null {
  return pending ? { redirectURL: pending.redirectURL } : null;
}

export async function signIn(redirectURL: string, store: AuthStore, options: SignInOptions): Promise<{ signedIn: boolean; message: string }> {
  if (!pending) {
    pending = startCallbackServer(redirectURL, store, options.port);
    (options.openBrowser ?? openWithSystem)(redirectURL);
    log("INFO", "auth.signIn.started", { port: options.port });
  }
  const current = pending;
  const result = await Promise.race([
    current.promise.then(() => "done" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), options.waitSeconds * 1000)),
  ]);
  if (result === "done") {
    return { signedIn: true, message: "iCloud にサインインしました。ckWebAuthToken を保存したので他のツールが使えます。" };
  }
  return {
    signedIn: false,
    message: `ブラウザで Apple ID のサインインを完了してください（${options.waitSeconds} 秒待ちましたが戻ってきていません）。完了後にもう一度 sign_in を呼ぶか、他のツールをそのまま呼んでください。開いた URL: ${redirectURL}`,
  };
}

function startCallbackServer(redirectURL: string, store: AuthStore, port: number): NonNullable<typeof pending> {
  let resolveToken: (token: string) => void = () => {};
  let rejectToken: (error: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("not found");
      return;
    }
    // Apple は `ckSession` で返す。保険で `ckWebAuthToken` も見る。
    const token = url.searchParams.get("ckSession") ?? url.searchParams.get("ckWebAuthToken");
    if (!token) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<p>ckSession が付いていません。もう一度サインインしてください。</p>");
      return;
    }
    store.saveToken(token);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      "<!doctype html><meta charset='utf-8'><title>MustDo MCP</title><p style='font-family:sans-serif'>MustDo MCP のサインインが完了しました。このタブは閉じて構いません。</p>",
    );
    resolveToken(token);
    finish();
  };
  const server = createServer(handler);
  // Dashboard の URL Redirect は「localhost」固定。Chrome は ::1 を先に引くことがあるので IPv6 でも受ける（無ければ黙って諦める）。
  const server6 = createServer(handler);
  server6.on("error", () => {});

  const timer = setTimeout(() => {
    rejectToken(new ToolError("SIGN_IN_TIMEOUT", "サインインの待ち受けが 10 分で終了しました。sign_in をやり直してください。"));
    finish();
  }, 10 * 60 * 1000);
  timer.unref();

  function finish(): void {
    clearTimeout(timer);
    server.close();
    server6.close();
    if (pending?.server === server) pending = null;
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    const message =
      error.code === "EADDRINUSE"
        ? `ポート ${port} が使われています。別の MCP プロセスがサインイン待ちか、MUSTDO_CALLBACK_PORT を変えてください（Dashboard の callback URL も合わせる）。`
        : `待ち受けサーバーの起動に失敗: ${error.message}`;
    rejectToken(new ToolError("CLOUDKIT_ERROR", message));
    finish();
  });
  server.listen(port, "127.0.0.1");
  server6.listen(port, "::1");
  // 未処理 rejection で落ちないように握っておく（呼び出し側は race で読む）。
  promise.catch(() => {});

  return { server, promise, redirectURL };
}

function openWithSystem(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => log("ERROR", "auth.openFailed", { error: error.message }));
  child.unref();
}
