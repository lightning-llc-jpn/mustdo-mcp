/// MCP の配線ごしに叩く。ツールの isError / code がクライアントに届くことを確かめる。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { accountRecord, FakeCloudKit, todoRecord, tokyo } from "./fakeCloudKit.js";

const NOW = new Date(tokyo(2026, 10, 5, 8, 0));

const CALLBACK_PORT = 51299;
const APPLE_SIGN_IN_URL = "https://idmsa.apple.com/appleauth/auth/signin?fake=1";
const LOCAL_START_URL = "https://ltng.jp/api/mustdo/oauth/local-start";

async function connect(fake: FakeCloudKit, homeDir: string, opened: string[] = [], overrides: Partial<Config> = {}) {
  const config: Config = {
    apiToken: "api-token",
    environment: "development",
    container: "iCloud.jp.lightning.mustdo",
    zoneName: "MustDo",
    homeDir,
    callbackPort: CALLBACK_PORT,
    localStartURL: LOCAL_START_URL,
    ...overrides,
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

async function waitForBrowser(opened: string[]): Promise<string> {
  for (let i = 0; i < 50 && opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  expect(opened).toHaveLength(1);
  return opened[0]!;
}

/// Apple（production では ltng.jp の踏み台）の戻りを真似て callback を叩く。待ち受けが立つまでは接続エラーなので少し待ってやり直す。
async function hitCallback(query: Record<string, string>): Promise<Response> {
  const url = `http://127.0.0.1:${CALLBACK_PORT}/callback?${new URLSearchParams(query).toString()}`;
  for (let i = 0; ; i += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      if (i >= 50) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
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

  it("development の sign_in は Apple の画面を直接開き、state 無しの callback で auth.json を保存して以後のツールが通る", async () => {
    const opened: string[] = [];
    const { client } = await connect(fake, homeDir, opened);

    const signIn = client.callTool({ name: "sign_in", arguments: { waitSeconds: 10 } });
    expect(await waitForBrowser(opened)).toBe(APPLE_SIGN_IN_URL);
    expect((await hitCallback({ ckSession: "new+token/==" })).status).toBe(200);
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

  it("production の sign_in は ltng.jp の local-start を開き、自分の state が戻ったときだけ保存する（ログイン CSRF 対策）", async () => {
    const opened: string[] = [];
    const { client } = await connect(fake, homeDir, opened, { environment: "production" });

    const signIn = client.callTool({ name: "sign_in", arguments: { waitSeconds: 10 } });
    const startURL = new URL(await waitForBrowser(opened));
    expect(startURL.origin + startURL.pathname).toBe(LOCAL_START_URL);
    expect(startURL.searchParams.get("to")).toBe(APPLE_SIGN_IN_URL);
    const state = startURL.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43,128}$/); // 32 バイト以上の base64url

    // 攻撃者のページが開かせた callback: state 無し・違う state は 400 で、保存しない
    for (const query of [{ ckSession: "attacker" }, { ckSession: "attacker", state: "x".repeat(state.length) }, { ckSession: "attacker", state: state + "x" }]) {
      const res = await hitCallback(query);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(existsSync(join(homeDir, "auth.json"))).toBe(false);
    }

    // 待ち受けは続いていて、本物の戻りで保存される
    expect((await hitCallback({ ckSession: "real-token", state })).status).toBe(200);
    const result = await signIn;
    expect(parse(result).signedIn).toBe(true);
    expect(JSON.parse(readFileSync(join(homeDir, "auth.json"), "utf8"))).toMatchObject({ ckWebAuthToken: "real-token", environment: "production" });
  });

  it("CloudKit が返した新しいトークンを auth.json に保存し、次の呼び出しで使う", async () => {
    fake.options.rotateTokens = true;
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "first", environment: "development" }));
    const { client } = await connect(fake, homeDir);

    expect((await client.callTool({ name: "get_me", arguments: {} })).isError).toBeFalsy();
    expect(JSON.parse(readFileSync(join(homeDir, "auth.json"), "utf8"))).toMatchObject({ ckWebAuthToken: fake.currentToken });

    // 古いトークンは fake が 421 にするので、通れば差し替えたものを送っている
    expect((await client.callTool({ name: "list_todos", arguments: {} })).isError).toBeFalsy();
    expect(fake.calls.at(-1)!.query.get("ckWebAuthToken")).not.toBe("first");
    expect(JSON.parse(readFileSync(join(homeDir, "auth.json"), "utf8"))).toMatchObject({ ckWebAuthToken: fake.currentToken });
  });

  it("古いトークンで 421 になっても、保存し直された新しいトークンは捨てない", async () => {
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "old", environment: "development" }));
    const { client } = await connect(fake, homeDir);
    expect((await client.callTool({ name: "get_me", arguments: {} })).isError).toBeFalsy(); // "old" を覚える
    // 並行の呼び出しが先に新しいトークンを保存した、の再現: 古い方は 421 になり、auth.json は新しい方に書き換わっている
    fake.options.unauthenticated = true;
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: "new", environment: "development" }));
    expect(parse(await client.callTool({ name: "get_me", arguments: {} })).code).toBe("NOT_SIGNED_IN");
    fake.options.unauthenticated = false;
    expect((await client.callTool({ name: "get_me", arguments: {} })).isError).toBeFalsy();
    expect(fake.calls.at(-1)!.query.get("ckWebAuthToken")).toBe("new");
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
