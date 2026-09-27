/**
 * The onboarding guide has to stay consistent with the template it deploys.
 *
 * Three of these guard mistakes that were actually present, and every one of
 * them is invisible in review because the page renders perfectly either way:
 *
 *  - The intro promised "four steps" while five were rendered. Nothing
 *    connects the sentence to the `<Step>` elements, so it drifted the moment a
 *    fifth step was added, and two handover documents copied the wrong number.
 *  - The deploy command carried no `--region`, so it failed outright for any
 *    reader whose CLI had no default region configured - with an error that
 *    says nothing about this page.
 *  - `ExternalId=` interpolated a loading string, so a reader who copied before
 *    the fetch resolved deployed a stack whose shared secret was the literal
 *    text `generating…`, and put the same text in `.env`. That connection tests
 *    *green*, against a secret neither side meant.
 *
 * And one that would be a silent break rather than a regression: the command
 * passes CloudFormation parameters by name, so renaming a parameter in the
 * template leaves the guide handing out a command AWS rejects.
 *
 * Lives in `infra/` because that is where the template contract belongs and
 * because `vitest.config.ts` does not include `apps/web`. Same cross-workspace
 * read as `agent/toolLabels.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(root + path, "utf8");

const guide = read("apps/web/src/components/ConnectionGuide.tsx");
const template = read("infra/readonly-role.yaml");

/** The `Name=value` overrides the rendered deploy command passes. */
function passedParameters(): string[] {
  const block = /const deployCommand = \[([\s\S]*?)\]\.join/.exec(guide);
  expect(block, "deployCommand was renamed or restructured").toBeTruthy();
  return [...block![1]!.matchAll(/([A-Za-z][A-Za-z0-9]*)=\$?\{?/g)]
    .map((m) => m[1]!)
    .filter((name) => /^[A-Z]/.test(name));
}

/** Parameter names the template declares, from its `Parameters:` block. */
function declaredParameters(): string[] {
  const block = /\nParameters:\n([\s\S]*?)\n[A-Z][A-Za-z]*:/.exec(template);
  expect(block, "the template's Parameters block was restructured").toBeTruthy();
  return [...block![1]!.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):$/gm)].map((m) => m[1]!);
}

describe("connection guide and role template agree", () => {
  it("passes only parameters the template declares", () => {
    const declared = declaredParameters();
    expect(declared.length, "no parameters were parsed out of the template").toBeGreaterThan(2);
    for (const name of passedParameters()) {
      expect(
        declared,
        `the deploy command passes ${name}, which the template does not declare`,
      ).toContain(name);
    }
  });

  it("names the role the guide tells the reader to configure", () => {
    // Step 4's placeholder ARN ends in the role name, which is the template's
    // RoleName default. If one changes, the reader configures a role that does
    // not exist and step 5 reports NoSuchEntity.
    const placeholder = /const ROLE_ARN_TEMPLATE = "([^"]+)"/.exec(guide);
    expect(placeholder, "ROLE_ARN_TEMPLATE was renamed").toBeTruthy();
    const roleName = placeholder![1]!.split(":role/")[1];
    expect(roleName, "ROLE_ARN_TEMPLATE is not shaped like a role ARN").toBeTruthy();
    expect(template).toContain(`Default: "${roleName}"`);
  });
});

describe("the guide's own claims about itself", () => {
  it("promises as many steps as it renders", () => {
    const rendered = [...guide.matchAll(/<Step\s+n=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(rendered.length, "no <Step> elements found").toBeGreaterThan(0);

    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const claim = /takes (\w+) steps/.exec(guide);
    expect(claim, "the intro no longer states a step count").toBeTruthy();
    const promised = words[claim![1]!.toLowerCase()];
    expect(promised, `"${claim![1]}" is not a number word this test knows`).toBeDefined();

    expect(promised, "the intro's step count disagrees with the rendered steps").toBe(
      rendered.length,
    );
    // Numbered 1..n with no gaps, so "step 4" in the docs means what it says.
    expect(rendered).toEqual(rendered.map((_, i) => i + 1));
  });

  it("marks every command block with which values the reader supplies", () => {
    // Each Copyable holding a multi-line command is followed by a <Fields>
    // legend. Handing over a command without saying which parts are the
    // reader's is the defect this page was reported for.
    for (const name of ["deployCommand", "envSnippet"]) {
      const at = guide.indexOf(`<Copyable value={${name}}`);
      expect(at, `${name} is no longer rendered in a Copyable`).toBeGreaterThan(-1);
      const after = guide.slice(at, at + 400);
      expect(after, `${name} has no <Fields> legend`).toContain("<Fields");
    }
    // And exactly one field is the reader's, so "you replace" means something.
    expect((guide.match(/kind: "replace"/g) ?? []).length).toBe(1);
  });
});

describe("no command block can carry a non-value", () => {
  it("falls back to an unmistakable token, never a status word", () => {
    const fallback = /const suggestedId = [^;]+\?\?\s*([A-Za-z_]+);/.exec(guide);
    expect(fallback, "the ExternalId fallback was restructured").toBeTruthy();
    expect(fallback![1], "the fallback must be the shared token constant").toBe(
      "EXTERNAL_ID_PENDING",
    );

    const token = /const EXTERNAL_ID_PENDING = "([^"]+)"/.exec(guide);
    expect(token, "EXTERNAL_ID_PENDING was renamed").toBeTruthy();
    // Upper snake case cannot be mistaken for a generated secret, which a
    // lowercase word with an ellipsis very much can.
    expect(token![1]).toMatch(/^[A-Z][A-Z0-9_]+$/);

    /**
     * Scoped to the command-building region, not the whole file. The status
     * panel legitimately renders `c.accountId ?? "unknown"`, and an assertion
     * broad enough to catch that is an assertion nobody can keep green.
     */
    const from = guide.indexOf("const suggestedId =");
    const to = guide.indexOf("].join", guide.indexOf("const envSnippet ="));
    expect(from, "the command-building region could not be located").toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const commandRegion = guide.slice(from, to);

    /**
     * Upper-snake constants are removed first: `EXTERNAL_ID_PENDING` is the
     * *fix*, and a check that flags the fix by substring is a check that gets
     * deleted. What must not appear is a lowercase status word or an ellipsis,
     * which is what a reader mistakes for a generated value. The ASCII "..."
     * is not checked: doc comments here elide real ARNs with it.
     */
    const withoutTokens = commandRegion.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, "");
    for (const word of ["generating", "loading", "pending", "unknown", "\u2026"]) {
      expect(
        withoutTokens.toLowerCase().includes(word),
        `a command block can render "${word}"`,
      ).toBe(false);
    }
  });

  it("pins a region, so the command runs without CLI defaults", () => {
    const block = /const deployCommand = \[([\s\S]*?)\]\.join/.exec(guide)![1]!;
    expect(block, "the deploy command relies on the CLI's default region").toContain("--region");
    // From the server's reported home region, not hardcoded.
    expect(block).toMatch(/--region \$\{c\.homeRegion\}/);
  });
});
