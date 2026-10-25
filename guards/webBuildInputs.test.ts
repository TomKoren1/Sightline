/**
 * Everything the frontend imports from outside its own workspace is in the image.
 *
 * Added after exactly this failed in CI and only in CI. `LegalPage.tsx` imports
 * `../../../../PRIVACY.md?raw` so that the privacy policy has one copy rather
 * than the same text in a `.tsx` - and `npm run build` locally has the whole
 * repository, so it resolved. The `webbuild` stage copies directories
 * deliberately rather than everything, did not copy the file, and the image
 * build failed with `Could not resolve`.
 *
 * Two artefacts that have to agree, with nothing connecting them, and a local
 * build that cannot see the disagreement. Which is the shape of problem this
 * directory exists for.
 *
 * Deliberately about *escaping* imports only. An import within `apps/web/` is
 * covered by the `COPY apps/web/` line and needs no checking; the interesting
 * ones are the handful that reach out of it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const dockerfile = readFileSync(`${root}Dockerfile`, "utf8");

/** Every source file in the web workspace, with its path from the root. */
function webSources(dir = `${root}apps/web/src/`, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) webSources(`${path}/`, into);
    else if (/\.tsx?$/.test(entry)) into.push(path.slice(root.length));
  }
  return into;
}

/** `import … from "…"` targets, including the `?raw` suffix form. */
const IMPORT = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

/** Resolve a relative import against the file containing it. */
function resolve(fromFile: string, target: string): string {
  const base = fromFile.slice(0, fromFile.lastIndexOf("/") + 1);
  const out: string[] = [];
  for (const part of (base + target).split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** The lines the `webbuild` stage copies into the image. */
function webBuildStage(): string {
  const start = dockerfile.indexOf("FROM deps AS webbuild");
  expect(start, "the Dockerfile no longer has a webbuild stage").toBeGreaterThan(-1);
  const rest = dockerfile.slice(start);
  const next = rest.indexOf("\nFROM ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Paths the stage makes available, as prefixes.
 *
 * `COPY a b ./` and `COPY dir/ dir/` both appear, so each source argument - all
 * but the last - is taken as a prefix. A directory prefix covers everything
 * under it, which is why `apps/web/` needs no enumeration.
 */
function copiedPaths(): string[] {
  const stage = webBuildStage();
  return [...stage.matchAll(/^COPY\s+(.+)$/gm)].flatMap((m) => {
    const args = m[1]!
      .trim()
      .split(/\s+/)
      .filter((a) => !a.startsWith("--"));
    // The last argument is the destination.
    return args.slice(0, -1);
  });
}

function isCopied(path: string, copied: string[]): boolean {
  return copied.some((prefix) => {
    const normalised = prefix.replace(/^\.\//, "");
    return normalised.endsWith("/") ? path.startsWith(normalised) : path === normalised;
  });
}

describe("the frontend's build inputs", () => {
  const sources = webSources();
  const copied = copiedPaths();

  it("were found, along with the Dockerfile stage that builds them", () => {
    // Without this the whole file passes vacuously if either path moves.
    expect(sources.length).toBeGreaterThan(10);
    expect(copied).toContain("apps/web/");
  });

  it("includes everything the frontend imports from outside its workspace", () => {
    const missing: string[] = [];

    for (const file of sources) {
      const text = readFileSync(root + file, "utf8");
      for (const match of text.matchAll(IMPORT)) {
        const target = match[1] ?? match[2];
        // Package imports resolve through node_modules, which `npm ci` provides.
        if (!target?.startsWith(".")) continue;

        // Strip Vite's query suffix: `?raw` is how the markdown is imported.
        const [path] = target.split("?");
        if (!path) continue;
        const resolved = resolve(file, path);

        // Inside the workspace, so covered by `COPY apps/web/`.
        if (resolved.startsWith("apps/web/")) continue;

        /**
         * A `.js` specifier that resolves to a `.ts` or `.tsx` on disk - the
         * ESM convention this project uses throughout. Checked as a prefix so
         * `../../packages/shared/src/x.js` is matched by `packages/`.
         */
        const exists =
          existsSync(root + resolved) ||
          existsSync(`${root}${resolved.replace(/\.js$/, ".ts")}`) ||
          existsSync(`${root}${resolved.replace(/\.js$/, ".tsx")}`);
        expect(exists, `${file} imports ${target}, which does not exist`).toBe(true);

        if (!isCopied(resolved, copied)) missing.push(`${file} -> ${target} (${resolved})`);
      }
    }

    expect(
      [...new Set(missing)],
      "the frontend imports these from outside `apps/web/`, and the Dockerfile's `webbuild` " +
        "stage does not copy them - so `npm run build` works locally, where the whole " +
        "repository is present, and the image build fails with `Could not resolve`. Add a COPY " +
        "line to that stage.",
    ).toEqual([]);
  });
});
