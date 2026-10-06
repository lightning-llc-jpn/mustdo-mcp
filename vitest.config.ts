import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // テスト中は構造化ログを黙らせる（ERROR だけ出す）。
    env: { MUSTDO_LOG_LEVEL: "ERROR" },
  },
});
