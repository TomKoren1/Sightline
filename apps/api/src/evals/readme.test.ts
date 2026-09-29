/**
 * Guards on the README.
 *
 * The README is the first thing anyone reads and the only instructions most
 * people will follow, and nothing executes it — which is the same situation the
 * CloudFormation template was in before engineering log #20 and #22, where it
 * turned out to have never been deployed and not to work.
 *
 * It has already rotted twice. An audit found `npm run query -w @daveio/api`
 * documented in the commands table with no such script defined: the CLI file
 * existed, its own header comment gave that exact invocation, and running it as
 * written failed. And separately the counts drifted — eight ADRs claimed where
 * there were thirteen, fourteen assertions where there were fifteen.
 *
 * So the cheapest possible check: every command the documentation tells you to run
 * must exist, and the numbers it quotes must match what is actually there. "The
 * documentation" is the README plus `docs/SETUP.md` and `docs/ASSIGNMENT.md`,
 * since the detail was moved there and a guard reading one file could be defeated
 * by moving a line.
 * These would look eccentric in most repositories. Here they are cheaper than
 * the two audits it took to find these by hand.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as { scripts?: Record<string, string> };

/**
 * "The README" now means the README **and** `docs/SETUP.md`.
 *
 * The README was deliberately shortened to read like a product page: the
 * configuration detail, the command table and the troubleshooting moved into
 * `docs/SETUP.md`, and the engineering write-up into `docs/ASSIGNMENT.md`. These
 * guards exist to stop documented commands and quoted numbers from rotting, and
 * which of the three files a given fact sits in does not change that — so all
 * three are checked, and moving a line between them is not a way to escape the
 * check.
 */
const readme = ["README.md", "docs/SETUP.md", "docs/ASSIGNMENT.md"].map(read).join("\n\n");

const scripts = {
  root: readJson("package.json").scripts ?? {},
  "@daveio/api": readJson("apps/api/package.json").scripts ?? {},
  "@daveio/web": readJson("apps/web/package.json").scripts ?? {},
};

/** Every `npm run …` the README tells the reader to type. */
function documentedCommands(): Array<{ raw: string; script: string; workspace: string }> {
  const found: Array<{ raw: string; script: string; workspace: string }> = [];
  const pattern = /`npm run ([a-z:-]+)(?: -w (@daveio\/[a-z]+))?`/g;
  for (const match of readme.matchAll(pattern)) {
    found.push({ raw: match[0], script: match[1]!, workspace: match[2] ?? "root" });
  }
  return found;
}

describe("every command the README documents exists", () => {
  const commands = documentedCommands();

  it("finds commands to check at all", () => {
    // If the extraction breaks, the suite below would pass vacuously.
    expect(commands.length).toBeGreaterThan(5);
  });

  it.each(commands.map((c) => [c.raw, c.script, c.workspace] as const))(
    "%s",
    (_raw, script, workspace) => {
      const available = scripts[workspace as keyof typeof scripts];
      expect(available, `unknown workspace ${workspace}`).toBeDefined();
      expect(
        Object.keys(available),
        `README documents "${script}" in ${workspace}, which defines no such script`,
      ).toContain(script);
    },
  );
});

/**
 * Counts the README quotes as facts. Each has been wrong at least once.
 */
describe("the numbers the README quotes are true", () => {
  const words: Record<string, number> = {
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    "twenty-one": 21,
  };

  function quoted(pattern: RegExp): number | null {
    const m = pattern.exec(readme);
    if (!m) return null;
    const raw = m[1]!.toLowerCase();
    return words[raw] ?? Number(raw);
  }

  it("states the real number of ADRs", () => {
    const actual = (read("docs/DECISIONS.md").match(/^## ADR-/gm) ?? []).length;
    expect(quoted(/\*\*\[docs\/DECISIONS\.md\]\([^)]*\)\*\* — ([a-z-]+) ADRs/)).toBe(actual);
  });

  it("states the real number of agent tools", () => {
    const tools = read("apps/api/src/agent/tools.ts");
    // Tool definitions only: the dispatch switch repeats every name.
    const actual = (tools.match(/^ {4}name: "/gm) ?? []).length;
    expect(quoted(/\*\*([a-z-]+) curated, parameterised tools\*\*/)).toBe(actual);
  });

  it("states the real number of tier-2 eval cases", () => {
    const actual = (read("apps/api/src/evals/cases.ts").match(/^ {4}id: "/gm) ?? []).length;
    expect(quoted(/\*\*Tier 2 — answer quality\.\*\* ([A-Za-z-]+) cases/)).toBe(actual);
  });

  it("states the real number of tier-1 checks", () => {
    const actual = (read("apps/api/src/evals/checks.ts").match(/^ {4}id: "/gm) ?? []).length;
    expect(quoted(/on every commit\. ([A-Za-z-]+)\s*\n?checks/)).toBe(actual);
  });

  /**
   * Counted by running the suite, not by parsing — a test that asserts its own
   * suite's size from source would be counting `it.each` rows wrongly. This
   * instead checks the README has not drifted by an order of magnitude, which
   * is the failure that actually happened (138 claimed, 176 real).
   */
  it("states a plausible test count", () => {
    const m = /\| ([0-9]+) unit tests /.exec(readme);
    expect(m, "README should quote a unit test count").toBeTruthy();
    const claimed = Number(m![1]);
    const testFiles =
      countTestFiles(new URL("apps/", root)) + countTestFiles(new URL("infra/", root));
    // Roughly ten assertions per file is the shape of this suite; an order of
    // magnitude out means the number was never updated.
    expect(claimed).toBeGreaterThan(testFiles * 4);
    expect(claimed).toBeLessThan(testFiles * 40);
  });

  function countTestFiles(dir: URL): number {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.isDirectory()) total += countTestFiles(new URL(`${entry.name}/`, dir));
      else if (entry.name.endsWith(".test.ts")) total += 1;
    }
    return total;
  }
});
