/**
 * The privacy policy and the terms are reachable, and there is one copy of each.
 *
 * Three artefacts have to agree and nothing else connects them: the markdown
 * files, the component that renders them, and the application that routes to
 * them. The failure this guards is specific and quiet - the policy gets edited
 * in the markdown, the page keeps rendering a copy somebody pasted into a
 * `.tsx`, and the version a customer reads is the stale one. Nobody notices,
 * because both files look right on their own.
 *
 * A string scan rather than a render, because `apps/web` is not in the vitest
 * `include` - the same reason `infra/webTheme.test.ts` is a scan. It needs no
 * browser and no DOM, which is also why it runs in CI's fast job.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const PAGES = [
  { path: "/privacy", file: "PRIVACY.md" },
  { path: "/terms", file: "TERMS.md" },
] as const;

const legalPage = read("apps/web/src/components/LegalPage.tsx");
const signIn = read("apps/web/src/components/SignIn.tsx");
const app = read("apps/web/src/App.tsx");

describe("the legal pages", () => {
  it("exist as documents", () => {
    for (const { file } of PAGES) {
      expect(existsSync(root + file), `${file} is missing`).toBe(true);
      // Long enough to be a policy rather than a stub. A placeholder that said
      // "TODO" would satisfy every other assertion here.
      expect(read(file).length, `${file} is too short to be a real policy`).toBeGreaterThan(1500);
    }
  });

  it("are rendered from those documents rather than a copy", () => {
    /**
     * The whole point. `?raw` means the component holds no prose of its own,
     * so editing the markdown edits the page - and GitHub and the application
     * show the same words because they are the same bytes.
     */
    for (const { file } of PAGES) {
      expect(legalPage, `${file} should be imported with ?raw`).toContain(`${file}?raw`);
    }

    /**
     * And the component really does not contain a second copy. Checked by
     * looking for sentences that are in the documents: a component that had
     * been "temporarily" filled in with the text would pass the import check
     * above if the import were left in place and unused.
     */
    const duplicated = PAGES.flatMap(({ file }) =>
      read(file)
        .split("\n")
        .map((line) => line.trim())
        // Long prose lines only - a short line like a heading could coincide.
        .filter((line) => line.length > 60 && !line.startsWith("|") && !line.startsWith("#"))
        .filter((line) => legalPage.includes(line))
        .map((line) => `${file}: ${line.slice(0, 50)}…`),
    );
    expect(
      duplicated,
      "these lines appear in both the document and the component, so there are two copies and " +
        "one of them will go stale.",
    ).toEqual([]);
  });

  it("are routed before a visitor is asked to sign in", () => {
    /**
     * Order matters and is the easy thing to get wrong. Being asked to sign in
     * before you can read what a service does with your data is the wrong way
     * round - and Google's consent screen fetches the privacy URL itself, with
     * no session at all, so a policy behind the sign-in check is a policy
     * Google cannot verify.
     */
    const legalAt = app.indexOf("legalPathFor");
    const signInAt = app.indexOf("<SignIn");
    expect(legalAt, "App.tsx does not route the legal pages").toBeGreaterThan(-1);
    expect(signInAt, "App.tsx no longer renders SignIn").toBeGreaterThan(-1);
    expect(
      legalAt,
      "the legal pages must be matched before the signed-out check, or they cannot be read " +
        "without an account",
    ).toBeLessThan(signInAt);
  });

  it("are linked from the screen a signed-out visitor sees", () => {
    // A policy nobody can find is a policy nobody reads, and the sign-in screen
    // is the only thing a signed-out visitor sees.
    for (const { path } of PAGES) {
      expect(signIn, `SignIn.tsx should link to ${path}`).toContain(`href="${path}"`);
    }
  });

  it("say the things a reader actually came for", () => {
    /**
     * Not a word count. Each of these is a question somebody connecting a
     * production AWS account will have, and a policy that does not answer it is
     * the kind that gets written to satisfy a consent screen rather than a
     * reader.
     *
     * Phrased as "mentions the subject" rather than matching exact sentences,
     * so the documents can be reworded without this failing for no reason.
     */
    const privacy = read("PRIVACY.md");
    for (const [subject, pattern] of [
      ["what it does not hold", /does not hold/i],
      ["the data-plane Deny", /explicit \*\*Deny\*\*|explicit Deny/],
      ["who it is shared with", /shared with/i],
      ["that the assistant sends inventory to Anthropic", /Anthropic/],
      ["how to delete it", /DELETE \/api\/me/],
      ["that backups still hold it for a while", /backup/i],
      ["that it is a personal project with no SLA", /no SLA|personal project/i],
    ] as const) {
      expect(privacy, `PRIVACY.md does not cover ${subject}`).toMatch(pattern);
    }

    const terms = read("TERMS.md");
    for (const [subject, pattern] of [
      ["only connecting accounts you may", /entitled to connect/i],
      ["that it is not a security control", /not a security control|security control/i],
      ["no warranty", /as is/i],
      ["the limits, and why they exist", /limit/i],
      ["self-hosting as the alternative", /self-host/i],
    ] as const) {
      expect(terms, `TERMS.md does not cover ${subject}`).toMatch(pattern);
    }
  });
});
