/// MCP の配線ごしに叩く。ツールの isError / code がクライアントに届くことを確かめる。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { accountRecord, FakeCloudKit, todoRecord, tokyo } from "./fakeCloudKit.js";

const NOW = new Date(tokyo(2026, 10, 5, 8, 0));

async function connect(fake: FakeCloudKit, homeDir: string, opened: string[] = []) {
  const config: Config = {
    apiToken: "api-token",
    environment: "development",
    container: "iCloud.jp.lightning.mustdo",
    zoneName: "MustDo",
    homeDir,
    callbackPort: 51299,
  };
  const server = createServer({ config, fetch: fake.fetch, now: () => NOW, openBrowser: (url) => opened.push(url) });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe("MCP サーバー", () => {
  let fake: FakeCloudKit;
  let homeDir: string;

  beforeEach(() => {
    fake = new FakeCloudKit();
    fake.put(accountRecord({ trialStartedAt: tokyo(2026, 10, 1) }));
    homeDir = mkdtempSync(join(tmpdir(), "mustdo-mcp-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("8 つのツールが登録されている", async () => {
    const { client } = await connect(fake, homeDir);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["add_todo", "complete_todo", "delete_todo", "get_me", "list_todos", "sign_in", "snooze_todo", "update_todo"]);
  });

  it("delete_todo は破壊的操作、get_me / list_todos は読み取り専用と注釈されている", async () => {
    const { client } = await connect(fake, homeDir);
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(tools.get("delete_todo")).toMatchObject({ destructiveHint: true });
    expect(tools.get("delete_todo")?.readOnlyHint).not.toBe(true);
    expect(tools.get("get_me")).toMatchObject({ readOnlyHint: true });
    expect(tools.get("list_todos")).toMatchObject({ readOnlyHint: true });
    for (const name of ["add_todo", "update_todo", "complete_todo", "snooze_todo", "sign_in"]) {
      expect(tools.get(name)?.readOnlyHint, name).not.toBe(true);
    }
  });

  it("auth.json が無いと isError + NOT_SIGNED_IN、ブラウザは開かない", async () => {
    const opened: string[] = [];
    const { client } = await connect(fake, homeDir, opened);
    const result = await client.callTool({ name: "get_me", arguments: {} });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ code: "NOT_SIGNED_IN" });
    expect(parse(result).message).toContain("sign_in");
    expect(opened).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("保存済みトークンが 421 で弾かれても NOT_SIGNED_IN を返す", async () => {
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "stale", environment: "development" }));
    fake.options.unauthenticated = true;
    const { client } = await connect(fake, homeDir);
    const result = await client.callTool({ name: "list_todos", arguments: {} });
    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe("NOT_SIGNED_IN");
  });

  it("別環境のトークンは使わない", async () => {
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "prod-token", environment: "production" }));
    const { client } = await connect(fake, homeDir);
    const result = await client.callTool({ name: "get_me", arguments: {} });
    expect(parse(result).code).toBe("NOT_SIGNED_IN");
  });

  it("sign_in はブラウザを開き、callback で auth.json を保存して以後のツールが通る", async () => {
    const opened: string[] = [];
    const { client } = await connect(fake, homeDir, opened);

    const signIn = client.callTool({ name: "sign_in", arguments: { waitSeconds: 10 } });
    // ブラウザが開くのを待ってから、Apple の戻りを真似て callback を叩く。
    for (let i = 0; i < 50 && opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(opened[0]).toContain("idmsa.apple.com");
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch("http://127.0.0.1:51299/callback?ckSession=" + encodeURIComponent("new+token/=="));
        expect(res.status).toBe(200);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const result = await signIn;
    expect(result.isError).toBeFalsy();
    expect(parse(result).signedIn).toBe(true);
    expect(JSON.parse(readFileSync(join(homeDir, "auth.json"), "utf8"))).toMatchObject({ ckWebAuthToken: "new+token/==", environment: "development" });

    const me = await client.callTool({ name: "get_me", arguments: {} });
    expect(me.isError).toBeFalsy();
    expect(parse(me).today).toBe("2026-10-05");
    const authed = fake.calls.find((c) => c.path === "records/lookup")!;
    expect(authed.query.get("ckWebAuthToken")).toBe("new+token/==");
  });

  it("add_todo の試用切れは isError + PAYMENT_REQUIRED", async () => {
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "ok", environment: "development" }));
    fake.put(accountRecord({ trialStartedAt: tokyo(2026, 8, 1) }));
    const { client } = await connect(fake, homeDir);
    const result = await client.callTool({ name: "add_todo", arguments: { title: "x", due: "2026-10-05T09:00" } });
    expect(result.isError).toBe(true);
    expect(parse(result).code).toBe("PAYMENT_REQUIRED");
  });

  it("complete_todo が Occurrence を返す", async () => {
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "ok", environment: "development" }));
    fake.put(todoRecord("E", { dueAt: tokyo(2026, 9, 1, 8), repeatKind: "daily" }));
    const { client } = await connect(fake, homeDir);
    const result = await client.callTool({ name: "complete_todo", arguments: { id: "E", occurrenceDate: "2026-10-04" } });
    expect(result.isError).toBeFalsy();
    expect(parse(result).occurrence).toMatchObject({ date: "2026-10-04", status: "done" });
    expect(fake.get("E|2026-10-04")).toBeDefined();
  });

  it("入力の型が違えば zod が弾く", async () => {
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "ok", environment: "development" }));
    const { client } = await connect(fake, homeDir);
    const result = await client.callTool({ name: "add_todo", arguments: { title: "x", due: "2026-10-05T09:00", sound: "kazoo" } });
    expect(result.isError).toBe(true);
  });
});
