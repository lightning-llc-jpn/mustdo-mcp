#!/usr/bin/env node
/// エントリポイント。stdio トランスポートで MCP を配線する。
/// `claude mcp add mustdo -- node /path/to/mustdo-mcp/dist/index.js`

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.apiToken) {
    log("WARN", "config.noApiToken", { hint: "MUSTDO_CK_API_TOKEN か ~/.mustdo/config.json の apiToken を設定" });
  }
  const server = createServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("INFO", "server.started", { environment: config.environment, container: config.container, zone: config.zoneName });
}

main().catch((error: unknown) => {
  log("ERROR", "server.crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
