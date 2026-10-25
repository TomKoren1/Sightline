/**
 * Every GitHub Action is pinned to a commit, and every workflow starts from
 * read-only permissions.
 *
 * A tag can be moved to different code by whoever controls the action's
 * repository, and a workflow's default token can write to this one; a pinned
 * SHA and `contents: read` close both. The version stays as a comment so a
 * reader, and dependabot, can see what the SHA is.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ name: f, text: readFileSync(dir + f, "utf8") }));

describe("GitHub workflows", () => {
  it("were found", () => {
    expect(workflows.length).toBeGreaterThan(3);
  });

  it("pin every action to a full commit SHA, with its version beside it", () => {
    const loose = workflows.flatMap((w) =>
      [...w.text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)]
        // A reusable workflow in this repository is versioned with the commit itself.
        .filter(([, ref]) => !ref!.startsWith("./"))
        .filter(([, ref, rest]) => !/@[0-9a-f]{40}$/.test(ref!) || !/#\s*v\d/.test(rest!))
        .map(([, ref]) => `${w.name}: ${ref}`),
    );
    expect(loose).toEqual([]);
  });

  it("default every workflow's token to read-only", () => {
    const open = workflows.filter((w) => !/^permissions:\n\s+contents: read/m.test(w.text));
    expect(open.map((w) => w.name)).toEqual([]);
  });
});
