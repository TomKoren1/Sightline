/**
 * Guards on the documentation: every command it tells the reader to type must
 * exist, and every number the README quotes must match what is there.
 *
 * Both have rotted: `npm run query -w @sightline/api` was documented with no
 * such script, and fourteen assertions were claimed where there were fifteen.
 * Commands are checked in every document a reader is sent to, so moving a
 * section out of the README does not move it out of reach.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as { scripts?: Record<string, string> };

const readme = read("README.md");

/** Every Markdown document a reader is pointed at, keyed by path. */
const DOCUMENTS = [
  "README.md",
  ...readdirSync(new URL("docs/", root))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  "deploy/k8s/README.md",
  "helm/monitoring/README.md",
];

const scripts = {
  root: readJson("package.json").scripts ?? {},
  "@sightline/api": readJson("apps/api/package.json").scripts ?? {},
  "@sightline/web": readJson("apps/web/package.json").scripts ?? {},
};

/**
 * Every `npm run …` the README tells the reader to type, wherever it appears.
 *
 * Deliberately not anchored to backticks. Requiring a closing backtick right
 * after the script name skipped two whole categories: compound spans like
 * `npm run drift && npm run scan`, where neither command is followed by one,
 * and every command inside a fenced block - which is most of them, including
 * the four in "Working on the code". A command is a claim about a script
 * existing no matter how it is typeset.
 */
function documentedCommands(): { raw: string; script: string; workspace: string }[] {
  const found: { raw: string; script: string; workspace: string }[] = [];
  const pattern = /\bnpm run ([a-z0-9:-]+)(?:\s+-w\s+(@sightline\/[a-z]+))?/g;
  for (const doc of DOCUMENTS) {
    for (const match of read(doc).matchAll(pattern)) {
      found.push({ raw: `${doc}: ${match[0]}`, script: match[1]!, workspace: match[2] ?? "root" });
    }
  }
  return found;
}

describe("every command the documentation gives exists", () => {
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
        `the docs give "${script}" in ${workspace}, which defines no such script`,
      ).toContain(script);
    },
  );
});

/**
 * Counts the README quotes as facts. Each has been wrong at least once.
 */
describe("the documentation does not send anyone down a dead end", () => {
  /**
   * "Try it" asks the reader to chat with the agent, which needs a key. The list
   * originally offered that as step 2 and mentioned the key only afterwards, with
   * no way to set one — so the reader's second action failed. And the sentence that
   * followed claimed "everything above works without one", which was false of two
   * of the five items.
   */
  it("tells the reader how to supply an LLM key before asking them to chat", () => {
    const flowed = readme.replace(/\s+/g, " ");
    const keyAt = flowed.indexOf("--anthropic-key");
    expect(keyAt, "no way to supply an Anthropic key is documented").toBeGreaterThan(-1);

    // The chat prompts must come after it, or the reader hits a wall.
    const chatAt = flowed.indexOf("What can reach the production database");
    expect(chatAt, "the reachability question is no longer in the docs").toBeGreaterThan(-1);
    expect(keyAt, "the key instruction must come before the chat steps").toBeLessThan(chatAt);
  });

  it("does not claim the chat steps work without a key", () => {
    const flowed = readme.replace(/\s+/g, " ");
    expect(flowed).not.toContain("everything above works without one");
  });
});

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
    "twenty-two": 22,
    "twenty-three": 23,
    "twenty-four": 24,
    "twenty-five": 25,
    "twenty-six": 26,
    "twenty-seven": 27,
    "twenty-eight": 28,
    "twenty-nine": 29,
    thirty: 30,
  };

  function quoted(pattern: RegExp): number | null {
    const m = pattern.exec(readme);
    if (!m) return null;
    const raw = m[1]!.toLowerCase();
    return words[raw] ?? Number(raw);
  }

  it("states the real number of agent tools", () => {
    const tools = read("apps/api/src/agent/toolDefinitions.ts");
    // Tool definitions only: the dispatch switch repeats every name.
    const actual = (tools.match(/^ {4}name: "/gm) ?? []).length;
    // The README's wording, since this claim used to live in a file that is gone.
    expect(quoted(/free-form SQL\.\*\* ([A-Za-z-]+) tools/)).toBe(actual);
  });

  it("states the real number of tier-2 eval cases", () => {
    const actual = (read("apps/api/src/evals/cases.ts").match(/^ {4}id: "/gm) ?? []).length;
    expect(quoted(/\*\*([a-z-]+) cases\*\* against the live agent/)).toBe(actual);
  });

  it("states the real number of tier-1 checks", () => {
    const actual = (read("apps/api/src/evals/checks.ts").match(/^ {4}id: "/gm) ?? []).length;
    expect(quoted(/\*\*([a-z-]+) ground-truth checks\*\*/)).toBe(actual);
  });
});
