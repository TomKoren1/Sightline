import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "infra/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
