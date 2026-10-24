/**
 * The API as plain JavaScript, for the production image.
 *
 * esbuild, because that is what tsx runs on: the same transform, so the
 * compiled server cannot behave differently from the one developed against
 * (neither emits decorator metadata - see tsconfig.json). The workspace
 * packages are bundled in, since they ship TypeScript; everything from npm
 * stays external and is loaded from the image's production node_modules.
 *
 * Only the entry points a deployment runs. The developer CLIs - setup, evals,
 * gen:collectors - write into the repository and stay on tsx.
 */

import { build } from "esbuild";

const ENTRY_POINTS = {
  server: "src/server.ts",
  worker: "src/worker.ts",
  migrate: "src/cli/migrate.ts",
  "app-role": "src/cli/appRole.ts",
};

/**
 * npm packages bundled in after all, so the image need not install them -
 * which is why they are devDependencies. node-sql-parser is 89 MB installed for
 * the 300 KB PostgreSQL grammar the SQL guard uses.
 */
const BUNDLED = ["node-sql-parser", "big-integer"];

/** Bare imports are npm packages, except the workspace's own. */
/** @type {import("esbuild").Plugin} */
const npmExternal = {
  name: "npm-external",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@sightline/") ||
      BUNDLED.some((p) => args.path === p || args.path.startsWith(`${p}/`))
        ? undefined
        : { path: args.path, external: true },
    );
  },
};

await build({
  entryPoints: ENTRY_POINTS,
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  // Shared code between the entry points goes in chunks, not four copies.
  chunkNames: "chunks/[name]-[hash]",
  plugins: [npmExternal],
  // A bundled CommonJS module that requires an external one needs a real
  // `require`, which ESM does not have.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "info",
});
