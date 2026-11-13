/// 使っていない間も iCloud のサインインを生かし続ける（ローカル専用。中継には別の仕組みがある）。
///
/// ckWebAuthToken は 1 往復ごとの使い捨てで、寿命は作られてから 30 分（サインイン画面で「サインインしたままにする」を
/// 選んだときだけ 2 週間）。新しいトークンは CloudKit を呼んだときにしか返らないので、30 分使わないだけで切れる。
/// 最後に保存してから `KEEPALIVE_AFTER_MS` たっていたら `users/caller` を 1 回呼んで替える。
///
/// 動かす場所は 2 つ: MCP のプロセスの中（`startKeepAlive`。Claude が起動している間）と、単発のコマンド
/// `mustdo-keepalive`（`keepalive-cli.ts`。launchd・cron から 5 分おきに呼べば、Claude を閉じていても切れない）。
/// 同時に動いてもよい: 先に替えた方が auth.json を書き、後の方は 421 → 読み直してやり直す（cloudkit.ts）。

import type { AuthStore } from "./auth.js";
import type { CloudKitClient } from "./cloudkit.js";
import { NotSignedInError } from "./errors.js";
import { log } from "./log.js";

/// 30 分の寿命に対して、見回り（5 分おき）の遅れと一時的な失敗 2 回を挟んでも間に合う間隔（中継と同じ）。
export const KEEPALIVE_AFTER_MS = 15 * 60 * 1000;
export const KEEPALIVE_TICK_MS = 5 * 60 * 1000;

/// rotated … 呼んで替えた / fresh … まだ新しいので呼ばなかった / signedOut … サインインが無い・切れている
export type KeepAliveResult = "rotated" | "fresh" | "signedOut";

export async function keepAliveOnce(client: Pick<CloudKitClient, "keepAlive">, auth: AuthStore, now: () => Date = () => new Date()): Promise<KeepAliveResult> {
  const savedAt = auth.savedAt();
  if (savedAt === null) return "signedOut";
  if (now().getTime() - savedAt < KEEPALIVE_AFTER_MS) return "fresh";
  try {
    await client.keepAlive();
  } catch (error) {
    if (!(error instanceof NotSignedInError)) throw error;
    auth.invalidate();
    return "signedOut";
  }
  // 新しいトークンが返らなかったときも時刻は進める（毎回の見回りで呼び続けない）。
  const token = auth.getToken();
  if (token !== null && auth.savedAt() === savedAt) auth.saveToken(token, now());
  return "rotated";
}

/// MCP のプロセスの中で見回る。プロセスの終了は待たせない。止める関数を返す。
export function startKeepAlive(client: Pick<CloudKitClient, "keepAlive">, auth: AuthStore, intervalMs = KEEPALIVE_TICK_MS): () => void {
  const timer = setInterval(() => {
    keepAliveOnce(client, auth).then(
      (result) => {
        if (result !== "fresh") log(result === "signedOut" ? "WARN" : "INFO", "keepalive.done", { result });
      },
      (error: unknown) => log("WARN", "keepalive.failed", { error: error instanceof Error ? error.message : String(error) }),
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
