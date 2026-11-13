import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthStore } from "../src/auth.js";
import { CloudKitClient } from "../src/cloudkit.js";
import { KEEPALIVE_AFTER_MS, keepAliveOnce } from "../src/keepalive.js";
import { FakeCloudKit } from "./fakeCloudKit.js";

const NOW = Date.parse("2026-11-13T00:00:00Z");

describe("サインインを生かし続ける（Issue #7）", () => {
  let homeDir: string;
  let fake: FakeCloudKit;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "mustdo-keepalive-"));
    fake = new FakeCloudKit({ rotateTokens: true });
  });
  afterEach(() => rmSync(homeDir, { recursive: true, force: true }));

  const authFile = () => JSON.parse(readFileSync(join(homeDir, "auth.json"), "utf8")) as { ckWebAuthToken: string; savedAt: string };
  const saveAuth = (token: string, ageMs: number) =>
    writeFileSync(join(homeDir, "auth.json"), JSON.stringify({ ckWebAuthToken: token, environment: "development", savedAt: new Date(NOW - ageMs).toISOString() }));

  /// 1 つのプロセスのぶん（auth.json は共有、トークンの覚えは別々）。
  function process_() {
    const auth = new AuthStore(homeDir, "development");
    const client = new CloudKitClient({
      container: "iCloud.test",
      environment: "development",
      apiToken: "api-token",
      zoneName: "MustDo",
      fetch: fake.fetch,
      getWebAuthToken: () => auth.getToken(),
      onWebAuthTokenRotated: (token) => auth.saveToken(token, new Date(NOW)),
      reloadWebAuthToken: () => auth.reload(),
    });
    return { auth, client, keepAlive: () => keepAliveOnce(client, auth, () => new Date(NOW)) };
  }

  it("15 分たっていたら users/caller（public）を 1 回呼び、新しいトークンを保存する", async () => {
    saveAuth("first", KEEPALIVE_AFTER_MS);
    expect(await process_().keepAlive()).toBe("rotated");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ path: "users/caller", method: "GET" });
    expect(authFile()).toMatchObject({ ckWebAuthToken: "rotated-1", savedAt: new Date(NOW).toISOString() });
  });

  it("まだ新しければ呼ばない", async () => {
    saveAuth("first", KEEPALIVE_AFTER_MS - 1);
    expect(await process_().keepAlive()).toBe("fresh");
    expect(fake.calls).toHaveLength(0);
  });

  it("サインインが無い・切れているときは signedOut（保存は変えない）", async () => {
    expect(await process_().keepAlive()).toBe("signedOut");
    saveAuth("dead", KEEPALIVE_AFTER_MS);
    fake.options.unauthenticated = true;
    expect(await process_().keepAlive()).toBe("signedOut");
    expect(authFile().ckWebAuthToken).toBe("dead");
  });

  it("新しいトークンが返らなくても、保存の時刻は進める（毎回呼び続けない）", async () => {
    fake.options.rotateTokens = false;
    saveAuth("same", KEEPALIVE_AFTER_MS);
    const p = process_();
    expect(await p.keepAlive()).toBe("rotated");
    expect(authFile()).toMatchObject({ ckWebAuthToken: "same", savedAt: new Date(NOW).toISOString() });
    expect(await p.keepAlive()).toBe("fresh");
  });

  it("ほかのプロセスが先に使って替えたトークンは、421 のあと読み直して 1 回だけやり直す", async () => {
    saveAuth("first", 0);
    const a = process_();
    const b = process_();
    expect(a.auth.getToken()).toBe("first");
    expect(b.auth.getToken()).toBe("first"); // b は古いトークンを覚えたまま
    await a.client.queryAll("Todo"); // a が使って rotated-1 に替わる
    await b.client.queryAll("Todo"); // b の "first" は 421 → 読み直して rotated-1 で通る
    expect(fake.calls.map((c) => c.query.get("ckWebAuthToken"))).toEqual(["first", "first", "rotated-1"]);
    expect(authFile().ckWebAuthToken).toBe("rotated-2");
  });

  it("読み直しても同じトークンなら、やり直さずに NOT_SIGNED_IN", async () => {
    saveAuth("dead", 0);
    fake.options.unauthenticated = true;
    await expect(process_().client.queryAll("Todo")).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
    expect(fake.calls).toHaveLength(1);
  });
});
