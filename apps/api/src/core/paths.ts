/**
 * Where the API package is on disk, found rather than counted.
 *
 * Run from source a module sits in `src/` or `src/db/`; compiled, everything
 * is in `dist/`. A path written as so many `../` from `import.meta.url` is
 * right for one layout and wrong for the other, so walk up to the package's
 * own manifest instead. `fileURLToPath`, never `URL.pathname` - see config.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findApiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name === "@sightline/api") return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot find the @sightline/api package directory");
    dir = parent;
  }
}

export const API_ROOT = findApiRoot();
/** The repository root, where `.env` lives - two levels above the package. */
export const REPO_ROOT = resolve(API_ROOT, "..", "..");
