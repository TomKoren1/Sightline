/**
 * Every tool the model can call has user-facing copy.
 *
 * The chat header answers "what is the agent doing" by naming the running tool
 * in plain language, which the brief asks for and a spinner does not do. That
 * only holds if the label map keeps up with the tool library, and it had already
 * fallen behind: `find_unprotected_buckets` (ADR-012) and `suggest_remediation`
 * (ADR-014) were both added after the map was written, so both fell through to
 * `Running find_unprotected_buckets` — the raw tool name that the map's own
 * comment says is not user-facing copy.
 *
 * Nobody would notice, because the fallback works and the label flashes past in
 * under a second. That is exactly why it needs a test rather than vigilance: the
 * next tool added will have the same problem on the same day it ships.
 *
 * This reads the web component as text from the API's test suite because
 * `vitest.config.ts` does not include `apps/web`, and one cross-workspace read
 * is cheaper than a second test runner for a single assertion.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(root + path, "utf8");

/** Tool definitions only — the dispatch switch repeats every name. */
function definedTools(): string[] {
  const source = read("apps/api/src/agent/tools.ts");
  return [...source.matchAll(/^ {4}name: "([a-z_]+)"/gm)].map((m) => m[1]!);
}

function labelledTools(): string[] {
  const source = read("apps/web/src/components/Chat.tsx");
  const block = /const TOOL_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(source);
  expect(block, "TOOL_LABELS was renamed or restructured").toBeTruthy();
  return [...block![1]!.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]!);
}

describe("the chat's tool labels", () => {
  const tools = definedTools();
  const labels = labelledTools();

  it("finds tools and labels to compare at all", () => {
    // Either regex breaking would make the comparison below pass vacuously.
    expect(tools.length).toBeGreaterThan(10);
    expect(labels.length).toBeGreaterThan(10);
  });

  it("covers every tool the model can call", () => {
    const missing = tools.filter((name) => !labels.includes(name));
    expect(
      missing,
      "these tools would show the user their raw snake_case name - add a label " +
        "to TOOL_LABELS in apps/web/src/components/Chat.tsx",
    ).toEqual([]);
  });

  it("does not label tools that no longer exist", () => {
    // A stale label is dead copy, and usually means a tool was renamed.
    expect(labels.filter((name) => !tools.includes(name))).toEqual([]);
  });
});
