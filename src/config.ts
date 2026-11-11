import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CloudKitEnvironment = "development" | "production";

export interface Config {
  /// CloudKit Dashboard で発行した API Token。
  apiToken: string;
  environment: CloudKitEnvironment;
  container: string;
  zoneName: string;
  /// `~/.mustdo` 相当。auth.json の置き場所。
  homeDir: string;
  /// サインインの戻り先 `http://127.0.0.1:<port>/callback` のポート。
  callbackPort: number;
  /// production の `sign_in` がブラウザで開く ltng.jp の踏み台。state を Cookie に預けてから Apple へ送る（https だけ）。
  localStartURL: string;
}

export const DEFAULT_CONTAINER = "iCloud.jp.lightning.mustdo";
export const DEFAULT_ZONE = "MustDo";
export const DEFAULT_CALLBACK_PORT = 51234;
export const DEFAULT_LOCAL_START_URL = "https://ltng.jp/api/mustdo/oauth/local-start";

interface FileConfig {
  apiToken?: string;
  environment?: string;
  container?: string;
  zoneName?: string;
  callbackPort?: number;
  localStartURL?: string;
}

function readFileConfig(path: string): FileConfig {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as FileConfig) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`設定ファイルを読めません: ${path} (${(error as Error).message})`);
  }
}

/// env が最優先、次に `~/.mustdo/config.json`、最後に既定値。
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env.MUSTDO_HOME ?? join(homedir(), ".mustdo");
  const file = readFileConfig(join(homeDir, "config.json"));

  const apiToken = env.MUSTDO_CK_API_TOKEN ?? file.apiToken ?? "";
  const environment = (env.MUSTDO_CK_ENV ?? file.environment ?? "development") as CloudKitEnvironment;
  if (environment !== "development" && environment !== "production") {
    throw new Error(`MUSTDO_CK_ENV は development か production: ${environment}`);
  }
  const callbackPort = Number(env.MUSTDO_CALLBACK_PORT ?? file.callbackPort ?? DEFAULT_CALLBACK_PORT);
  const localStartURL = env.MUSTDO_LOCAL_START_URL ?? file.localStartURL ?? DEFAULT_LOCAL_START_URL;
  if (URL.parse(localStartURL)?.protocol !== "https:") {
    throw new Error(`MUSTDO_LOCAL_START_URL は https の URL: ${localStartURL}`);
  }

  return {
    apiToken,
    environment,
    container: env.MUSTDO_CK_CONTAINER ?? file.container ?? DEFAULT_CONTAINER,
    zoneName: env.MUSTDO_CK_ZONE ?? file.zoneName ?? DEFAULT_ZONE,
    homeDir,
    callbackPort,
    localStartURL,
  };
}
