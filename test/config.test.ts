import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_LOCAL_START_URL, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "mustdo-config-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("local-start の URL は既定で ltng.jp", () => {
    expect(DEFAULT_LOCAL_START_URL).toBe("https://ltng.jp/api/mustdo/oauth/local-start");
    expect(loadConfig({ MUSTDO_HOME: homeDir }).localStartURL).toBe(DEFAULT_LOCAL_START_URL);
  });

  it("local-start の URL は env が config.json より優先", () => {
    writeFileSync(join(homeDir, "config.json"), JSON.stringify({ localStartURL: "https://file.example/start" }));
    expect(loadConfig({ MUSTDO_HOME: homeDir }).localStartURL).toBe("https://file.example/start");
    expect(loadConfig({ MUSTDO_HOME: homeDir, MUSTDO_LOCAL_START_URL: "https://env.example/start" }).localStartURL).toBe("https://env.example/start");
  });

  it("https 以外の local-start の URL は弾く", () => {
    expect(() => loadConfig({ MUSTDO_HOME: homeDir, MUSTDO_LOCAL_START_URL: "http://ltng.jp/api/mustdo/oauth/local-start" })).toThrow(/https/);
    expect(() => loadConfig({ MUSTDO_HOME: homeDir, MUSTDO_LOCAL_START_URL: "not a url" })).toThrow(/https/);
  });
});
