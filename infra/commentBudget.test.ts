/**
 * Comments stay short, measurably.
 *
 * This repository has drifted into essay-length comments twice - to 22% of all
 * lines with blocks up to 32, then to 27.6% with a block of 45. Both times the
 * prose was accurate and buried the code. A standard nobody measures comes back.
 *
 * So the README's house rule is enforced here. The budgets below are ratchets:
 * set at what is true today so CI is green, and the only legitimate edit is
 * downward. Lowering one is how the backlog gets paid down.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The target every block should be under. Not yet enforced; see `OVER_TARGET`. */
const TARGET_BLOCK = 12;

/** No block anywhere may exceed this. Today's worst. */
const MAX_BLOCK = 19;

/** Files still holding a block over `TARGET_BLOCK`. Only ever fewer. */
const OVER_TARGET = 113;

/** Share of all non-blank lines that may be comment. */
const MAX_RATIO = 0.275;

const SOURCE = /\.(ts|tsx|mjs)$/;

/**
 * Where source lives. `evals/` holds only gitignored run output, so on a fresh
 * checkout it does not exist at all - which is why `sources` tolerates a
 * missing directory rather than throwing. The floor assertion below is what
 * stops that tolerance from quietly measuring nothing.
 */
const DIRS = ["apps", "packages", "infra", "evals", "scripts"];

function sources(dir: string, into: string[] = []): string[] {
  if (!existsSync(dir)) return into;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) sources(path, into);
    else if (SOURCE.test(entry)) into.push(path);
  }
  return into;
}

interface Measured {
  file: string;
  comment: number;
  code: number;
  longest: number;
}

/**
 * Comment lines, code lines, and the longest unbroken run of comment.
 *
 * A line scan, not a parse: it will call a `//` inside a string a comment,
 * which is fine for a budget and easier to reason about than a tokeniser whose
 * own behaviour would need testing.
 */
function measure(file: string): Measured {
  let comment = 0;
  let code = 0;
  let longest = 0;
  let run = 0;
  let inBlock = false;

  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    let isComment = false;
    if (inBlock) {
      isComment = true;
      if (line.includes("*/")) inBlock = false;
    } else if (line.startsWith("/*")) {
      isComment = true;
      if (!line.includes("*/")) inBlock = true;
    } else if (line.startsWith("//")) {
      isComment = true;
    }

    if (isComment) {
      comment += 1;
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
      // Blank lines count as neither, so reformatting does not move the ratio.
      if (line) code += 1;
    }
  }
  return { file: file.slice(root.length), comment, code, longest };
}

describe("the comment budget", () => {
  const measured = DIRS.flatMap((d) => sources(`${root}${d}`)).map(measure);

  it("found the source tree", () => {
    // Without this every budget below passes on an empty list.
    expect(measured.length).toBeGreaterThan(150);
    expect(measured.some((m) => m.file === "apps/api/src/config.ts")).toBe(true);
  });

  it("has no block longer than the ceiling", () => {
    const over = measured
      .filter((m) => m.longest > MAX_BLOCK)
      .map((m) => `${m.file} (${m.longest} lines)`);
    expect(
      over,
      `a comment block over ${MAX_BLOCK} lines. Keep the bug it prevents, the rejected ` +
        "alternative, the undocumented AWS behaviour; cut the rest. If this is genuinely the " +
        "shortest it can be, something below it wants extracting instead.",
    ).toEqual([]);
  });

  it("is not accumulating files with over-long blocks", () => {
    const over = measured.filter((m) => m.longest > TARGET_BLOCK);
    expect(
      over.length,
      `${over.length} files hold a block over ${TARGET_BLOCK} lines, up from ${OVER_TARGET}. ` +
        "This budget is a ratchet: compress a block rather than raising it.",
    ).toBeLessThanOrEqual(OVER_TARGET);
  });

  it("keeps comment under its share of the codebase", () => {
    const comment = measured.reduce((n, m) => n + m.comment, 0);
    const total = measured.reduce((n, m) => n + m.comment + m.code, 0);
    const ratio = comment / total;
    expect(
      ratio,
      `${(ratio * 100).toFixed(1)}% of lines are comment (${comment} of ${total}), over the ` +
        `${(MAX_RATIO * 100).toFixed(1)}% budget. The fix is compression, not deletion: the ` +
        "facts that are load-bearing are the ones to keep.",
    ).toBeLessThanOrEqual(MAX_RATIO);
  });
});
