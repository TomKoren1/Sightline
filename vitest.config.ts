import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  // The web app's JSX runtime, so its components render under test as in Vite.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/api/**/*.test.ts",
      // Component tests opt into jsdom per file with `@vitest-environment`.
      "apps/web/**/*.test.{ts,tsx}",
      "guards/**/*.test.ts",
      // Plain JavaScript, because the file it covers has to run before anything
      // that could compile TypeScript is installed.
      "scripts/**/*.test.mjs",
    ],
    environment: "node",
    testTimeout: 30_000,
    // `--mode unit` (npm run test:unit, which `verify` and CI's static job run)
    // skips every suite that needs the compose stack, on any OS without a
    // shell-specific `VAR=1` prefix.
    env: mode === "unit" ? { SKIP_INTEGRATION: "1" } : {},
  },
}));
