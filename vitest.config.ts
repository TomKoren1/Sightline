import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/api/**/*.test.ts",
      "infra/**/*.test.ts",
      // Plain JavaScript, because the file it covers has to run before anything
      // that could compile TypeScript is installed.
      "scripts/**/*.test.mjs",
    ],
    environment: "node",
    testTimeout: 30_000,
  },
});
