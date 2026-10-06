/// MCP サーバーの組み立て（stdio 用）。TODO の 7 ツールは `tools.ts`、中身は `service.ts`。ここにあるのはローカル専用の `sign_in` と配線だけ。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AuthStore, pendingSignIn, signIn } from "./auth.js";
import { CloudKitClient } from "./cloudkit.js";
import type { Config } from "./config.js";
import { MustDoService } from "./service.js";
import { makeToolRunner, registerTodoTools } from "./tools.js";

export { toErrorPayload, type ErrorPayload } from "./tools.js";

export interface ServerDeps {
  config: Config;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  now?: () => Date;
}

export function createServer(deps: ServerDeps): McpServer {
  const { config } = deps;
  const auth = new AuthStore(config.homeDir, config.environment);
  const client = new CloudKitClient({
    container: config.container,
    environment: config.environment,
    apiToken: config.apiToken,
    zoneName: config.zoneName,
    getWebAuthToken: () => auth.getToken(),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const service = new MustDoService({ client, ...(deps.now ? { now: deps.now } : {}) });

  const server = new McpServer(
    { name: "mustdo", version: "0.1.0" },
    {
      instructions: [
        "MustDo（やるまで鳴る TODO アラーム）の iCloud データを読み書きします。",
        "日付や「今日」は get_me の timeZone / today を基準にしてください。",
        "未サインイン（NOT_SIGNED_IN）のときは sign_in を実行するようユーザーに伝えてください。sign_in はブラウザを開くので、ユーザーの了解を得てから呼ぶこと。",
        `環境: ${config.environment} / container: ${config.container}`,
      ].join("\n"),
    },
  );

  const run = makeToolRunner({ onNotSignedIn: () => auth.invalidate() });

  server.registerTool(
    "sign_in",
    {
      title: "iCloud にサインイン",
      description:
        "Apple のサインイン画面をブラウザで開き、戻ってきた ckWebAuthToken を ~/.mustdo/auth.json に保存する。他のツールが NOT_SIGNED_IN を返したときに使う。ユーザーがブラウザ操作できるときだけ呼ぶこと。",
      inputSchema: {
        waitSeconds: z.number().int().min(5).max(300).optional().describe("ブラウザが戻るまで待つ秒数（既定 90）"),
      },
    },
    async ({ waitSeconds }) =>
      run("sign_in", async () => {
        const redirectURL = pendingSignIn()?.redirectURL ?? (await client.fetchSignInURL());
        return signIn(redirectURL, auth, {
          port: config.callbackPort,
          waitSeconds: waitSeconds ?? 90,
          ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
        });
      }),
  );

  registerTodoTools(server, service, run);

  return server;
}

