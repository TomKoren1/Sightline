/**
 * WCAG 2.1 A and AA, checked by axe-core in the real browser at each screen
 * the journey reaches. Fails with every violation named, its rule and where,
 * so a regression says what to fix. Colour contrast included: the dark theme
 * is where it is easiest to lose.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export async function expectAccessible(page: Page, screen: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const found = violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id} (${v.impact ?? "?"}): ${n.target.join(" ")} - ${v.help}`),
  );
  if (process.env["A11Y_REPORT"]) {
    // Report mode, for fixing a batch: every screen, with the colours axe saw.
    const detail = violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id} ${JSON.stringify(n.any[0]?.data ?? {})} ${n.html.slice(0, 90)}`),
    );
    console.log(`[a11y ${screen}]\n${detail.join("\n")}`);
    return;
  }
  expect(found, `accessibility violations on ${screen}`).toEqual([]);
}
