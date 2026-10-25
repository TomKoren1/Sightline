/**
 * Every link in the project's documents goes somewhere.
 *
 * Added after finding a dead one in `SECURITY.md`: it pointed at
 * `docs/ROADMAP.md` for what multi-tenancy would require, and `docs/` had been
 * removed. A broken link in a security document is worse than a broken link
 * anywhere else - it is a reader being told where the answer is and finding
 * nothing, in the file they went to *because* they wanted to be careful.
 *
 * Relative links only. Checking external URLs would need the network, would
 * fail for reasons that have nothing to do with this repository, and would
 * eventually be skipped - and a check that gets skipped is worse than none.
 *
 * Anchors are checked too, since `SECURITY.md#the-externalid` pointing at a
 * heading that was reworded is the same failure wearing a different hat.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Markdown files that are part of the project's documentation. */
function documents(dir = root, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "coverage"].includes(entry)) continue;
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) documents(`${path}/`, into);
    else if (entry.endsWith(".md")) into.push(path.slice(root.length));
  }
  return into;
}

/** `[text](target)` links, excluding images and external URLs. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isRelative(target: string): boolean {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//") && !target.startsWith("#")
  );
}

/**
 * GitHub's anchor slug for a heading.
 *
 * Lowercased, punctuation dropped, spaces to hyphens. Close enough for the
 * headings this repository has; a heading with an emoji or a footnote would
 * need more, and there are none.
 */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headingsIn(file: string): Set<string> {
  const text = readFileSync(root + file, "utf8");
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!.replace(/\s*#*\s*$/, ""))),
  );
}

/** Resolve a link relative to the document containing it. */
function resolve(fromFile: string, target: string): string {
  const base = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1) : "";
  const parts = (base + target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

describe("the documents", () => {
  const files = documents();

  it("were found, and have links to check", () => {
    // Without this the whole file passes on an empty list.
    expect(files).toContain("README.md");
    expect(files).toContain("SECURITY.md");
    const total = files.reduce(
      (n, f) => n + [...readFileSync(root + f, "utf8").matchAll(LINK)].length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });

  it("link only to files that exist", () => {
    const broken: string[] = [];

    for (const file of files) {
      const text = readFileSync(root + file, "utf8");
      for (const match of text.matchAll(LINK)) {
        const target = match[1]!;
        if (!isRelative(target)) continue;
        const [path] = target.split("#");
        if (!path) continue;
        const resolved = resolve(file, path);
        if (!existsSync(root + resolved)) broken.push(`${file} -> ${target}`);
      }
    }

    expect(
      [...new Set(broken)],
      "these links point at files that do not exist. A dead link in a document somebody opened " +
        "because they wanted to be careful is worse than no link at all.",
    ).toEqual([]);
  });

  it("link only to headings that exist", () => {
    const broken: string[] = [];

    for (const file of files) {
      const text = readFileSync(root + file, "utf8");
      for (const match of text.matchAll(LINK)) {
        const target = match[1]!;
        if (!isRelative(target) || !target.includes("#")) continue;
        const [path, anchor] = target.split("#");
        if (!anchor) continue;
        const resolved = path ? resolve(file, path) : file;
        if (!existsSync(root + resolved) || !resolved.endsWith(".md")) continue;
        if (!headingsIn(resolved).has(anchor)) broken.push(`${file} -> ${target}`);
      }
    }

    expect(
      [...new Set(broken)],
      "these links point at headings that are not there - usually because the heading was " +
        "reworded and the link was not.",
    ).toEqual([]);
  });
});
