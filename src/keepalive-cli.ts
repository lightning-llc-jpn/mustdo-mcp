#!/usr/bin/env node
/// `mustdo-keepalive`: サインインを 1 回だけ見回って終わる（launchd・cron から 5 分おきに呼ぶ）。
/// 結果を 1 行の JSON で stderr に出す。終了コード: 0 = 替えた・まだ新しい / 3 = サインインが切れている（`sign_in` が要る）/ 1 = 失敗。

import { AuthStore } from "./auth.js";
import { CloudKitClient } from "./cloudkit.js";
import { loadConfig } from "./config.js";
import { keepAliveOnce } from "./keepalive.js";
import { log } from "./log.js";

async function main(): Promise<number> {
  const config = loadConfig();
  const auth = new AuthStore(config.homeDir, config.environment);
  const client = new CloudKitClient({
    container: config.container,
    environment: config.environment,
    apiToken: config.apiToken,
    zoneName: config.zoneName,
    getWebAuthToken: () => auth.getToken(),
    onWebAuthTokenRotated: (token) => auth.saveToken(token),
    reloadWebAuthToken: () => auth.reload(),
  });
  const result = await keepAliveOnce(client, auth);
  log(result === "signedOut" ? "WARN" : "INFO", "keepalive.done", { result });
  return result === "signedOut" ? 3 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log("ERROR", "keepalive.failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
