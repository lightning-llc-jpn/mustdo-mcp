/// `ckWebAuthToken` の保存と、ブラウザでのサインイン。
///
/// 流れ: `sign_in` → CloudKit の 421 から `redirectURL` を得る → `http://localhost:<port>/callback` を待ち受ける
/// → `open` でブラウザを開く → Apple が `?ckSession=<token>` を付けて戻す → `~/.mustdo/auth.json` に保存。
///
/// production では Apple の戻り先が ltng.jp の踏み台（`/api/mustdo/oauth/local-callback`）に固定で、Apple の URL に
/// state は載せられない。そこで乱数の state を作り、ltng.jp の `local-start` に預けて（Cookie）から Apple へ送ってもらう。
/// 踏み台は localhost への戻りに `state` を足すので、自分の state と一致した戻りだけを保存する。こうしないと、攻撃者の
/// ページが `http://localhost:<port>/callback?ckSession=<攻撃者のセッション>` を開かせるだけで、攻撃者の iCloud に
/// つながってしまう（ログイン CSRF）。development は Dashboard に localhost を直接登録していて踏み台を通らないので確かめない。

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
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

  /// 421 を受けたときに呼ぶ。手元の覚えを捨て、次の呼び出しで auth.json を読み直す。並行の呼び出しが新しいトークンを
  /// 保存し直していればそれを使い、本当に失効していれば CloudKit がまた 421 を返して `sign_in` を促す。
  invalidate(): void {
    this.cached = undefined;
  }
}

export interface SignInOptions {
  port: number;
  /// ブラウザが戻るまで待つ秒数。超えたらサーバーは残したまま一度返す。
  waitSeconds: number;
  /// テスト用。既定は macOS の `open`。
  openBrowser?: (url: string) => void;
  /// ltng.jp の踏み台 `local-start` の URL。渡すと（production）state を作ってここ経由で Apple を開き、戻りの state を確かめる。
  /// 渡さなければ（development）Apple の URL を直接開き、state は見ない。
  localStartURL?: string;
}

/// 進行中のサインイン（サーバーが待ち受け中）。同時に 1 つだけ。
/// `redirectURL` は Apple のサインイン URL（作り直さずに使い回す）、`browserURL` は実際にブラウザで開いた URL。
let pending: { server: Server; promise: Promise<string>; redirectURL: string; browserURL: string } | null = null;

export function pendingSignIn(): { redirectURL: string } | null {
  return pending ? { redirectURL: pending.redirectURL } : null;
}

export async function signIn(redirectURL: string, store: AuthStore, options: SignInOptions): Promise<{ signedIn: boolean; message: string }> {
  if (!pending) {
    let state: string | null = null;
    let browserURL = redirectURL;
    if (options.localStartURL) {
      state = randomBytes(32).toString("base64url");
      browserURL = localStartURLFor(options.localStartURL, state, redirectURL);
    }
    pending = { ...startCallbackServer(store, options.port, state), redirectURL, browserURL };
    (options.openBrowser ?? openWithSystem)(browserURL);
    log("INFO", "auth.signIn.started", { port: options.port, checksState: state !== null });
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
    message: `ブラウザで Apple ID のサインインを完了してください。「サインインしたままにする」を選ぶと 30 分で切れません（${options.waitSeconds} 秒待ちましたが戻ってきていません）。完了後にもう一度 sign_in を呼ぶか、他のツールをそのまま呼んでください。開いた URL: ${current.browserURL}`,
  };
}

/// `local-start?state=…&to=<Apple の URL>`。踏み台は state を Cookie に預けて `to` へ 302 する。
function localStartURLFor(localStartURL: string, state: string, redirectURL: string): string {
  const url = new URL(localStartURL);
  url.searchParams.set("state", state);
  url.searchParams.set("to", redirectURL);
  return url.toString();
}

/// 定数時間で比べる（長さの違いだけは先に分かってよい。state の長さは秘密ではない）。
function stateMatches(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/// `expectedState` が null でなければ、一致しない・無い戻りは 400 で断り、保存せずに待ち受けを続ける
/// （攻撃者の 1 本で正規のサインインを潰されないように）。
function startCallbackServer(store: AuthStore, port: number, expectedState: string | null): { server: Server; promise: Promise<string> } {
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
    if (expectedState !== null && !stateMatches(expectedState, url.searchParams.get("state"))) {
      log("WARN", "auth.callback.stateMismatch", { hasState: url.searchParams.has("state") });
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<p>このサインインは MustDo MCP が始めたものではありません。もう一度 sign_in からやり直してください。</p>");
      return;
    }
    // Apple は `ckSession` で返す。保険で `ckWebAuthToken` も見る。
    const token = url.searchParams.get("ckSession") ?? url.searchParams.get("ckWebAuthToken");
    if (!token) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<p>ckSession が付いていません。もう一度サインインしてください。</p>");
      return;
    }
    store.saveToken(token);
    // keep-alive の接続を残すと、閉じたはずの待ち受けにその接続から次の callback が届いてしまう。返したら切る。
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" }).end(
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

  return { server, promise };
}

function openWithSystem(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => log("ERROR", "auth.openFailed", { error: error.message }));
  child.unref();
}
