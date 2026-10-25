/**
 * Every colour the frontend names must exist in the theme.
 *
 * Tailwind emits **nothing** for a class whose token it cannot resolve. There
 * is no error, no warning and no build failure: the element simply inherits
 * whatever colour its parent had, and the only way to notice is to look at the
 * right screen in the right state. `text-ok` instead of `text-good`, and
 * `text-ink-500` and `hover:text-ink-200` for shades the palette does not
 * define, all shipped that way - two of them before this test existed.
 *
 * Lives in `guards/` with the other cross-artefact checks because it compares
 * two files that have to agree and nothing else connected them. It is a string
 * scan rather than a render, which is the point: it needs no browser, no DOM
 * and no component to be mounted in the right state.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Colour tokens the theme declares, as Tailwind would name them. */
function themeColours(): Set<string> {
  const css = readFileSync(`${root}apps/web/src/index.css`, "utf8");
  const block = css.slice(css.indexOf("@theme"), css.indexOf("}", css.indexOf("@theme")));
  return new Set([...block.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) sources(path, into);
    else if (/\.tsx?$/.test(entry)) into.push(path);
  }
  return into;
}

/**
 * Utilities whose last segment is a colour token.
 *
 * Deliberately narrow. `border`, `bg`, `text`, `ring`, `from`, `to` and `via`
 * are the ones used here, and a list that tried to be exhaustive would start
 * matching things like `text-[11px]` or `border-b` and report them as missing
 * colours - a guard that cries wolf is one that gets deleted.
 *
 * Opacity modifiers (`bg-accent/10`) and state prefixes (`hover:text-ink-300`)
 * are both stripped, because both have shipped broken.
 */
const COLOUR_UTILITIES = /(?:^|[\s"'`:])(?:border|bg|text|ring|from|to|via)-([a-z][a-z0-9-]*)/g;

/** Not colours: Tailwind's own keywords that share the prefixes above. */
const NOT_COLOURS = new Set([
  "transparent",
  "current",
  "inherit",
  "white",
  "black",
  "left",
  "right",
  "center",
  "justify",
  "start",
  "end",
  "top",
  "bottom",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  "ellipsis",
  "clip",
  "b",
  "t",
  "l",
  "r",
  "x",
  "y",
  "none",
  "solid",
  "dashed",
  "dotted",
  "inset",
  "offset",
]);

describe("the frontend's colours", () => {
  const defined = themeColours();
  const files = sources(`${root}apps/web/src`);

  it("found a theme and some components to check", () => {
    // Without this the suite passes vacuously if either path ever moves.
    expect(defined.size).toBeGreaterThan(5);
    expect(files.length).toBeGreaterThan(5);
    expect(defined.has("good")).toBe(true);
  });

  it("names only colours the theme defines", () => {
    const missing: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(COLOUR_UTILITIES)) {
        // `bg-accent/10` is the accent at ten percent; the token is `accent`.
        const token = match[1]!.split("/")[0]!;
        // Matched on the first segment, so `border-b-2` is recognised as a
        // directional width rather than reported as a missing colour called
        // `b-2`. A shade like `ink-700` keeps its whole name, because that is
        // what the theme declares.
        if (NOT_COLOURS.has(token.split("-")[0]!)) continue;
        if (!defined.has(token)) {
          missing.push(`${file.slice(root.length)}: ${match[0].trim()}`);
        }
      }
    }

    expect(
      [...new Set(missing)],
      "these classes name a colour the theme does not define, so Tailwind emits nothing for " +
        "them and the element silently inherits its parent's colour. Either add the token to " +
        "@theme in index.css, or use one that exists.",
    ).toEqual([]);
  });
});
