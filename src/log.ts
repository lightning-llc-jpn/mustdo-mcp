/// 構造化ログ。stdio トランスポートでは stdout が MCP の配線なので、ログは必ず stderr に出す。

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function threshold(): number {
  const env = (process.env.MUSTDO_LOG_LEVEL ?? "INFO").toUpperCase() as LogLevel;
  return LEVELS[env] ?? LEVELS.INFO;
}

export type LogSink = (level: LogLevel, action: string, extra: Record<string, unknown>) => void;

let sink: LogSink | null = null;

/// 出力先の差し替え。中継（ltng.jp）は stdout の構造化ログ（CloudWatch）に流す。null で既定（stderr）に戻す。
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

export function log(level: LogLevel, action: string, extra: Record<string, unknown> = {}): void {
  if (sink) {
    sink(level, action, extra);
    return;
  }
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    actor: "bot:mustdo-mcp",
    action,
    ...extra,
  });
  process.stderr.write(line + "\n");
}
