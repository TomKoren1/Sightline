/**
 * The privacy policy and the terms, at their own URLs.
 *
 * Google's OAuth consent screen requires a privacy-policy URL on the
 * application's own domain, so a link to GitHub does not satisfy it - and a
 * policy somebody has to go and find is a policy nobody reads.
 *
 * Imported with Vite's `?raw` so there is exactly one copy of each document;
 * the same text in a `.tsx` is two copies, and the stale one is the one nobody
 * is looking at. `guards/legalPages.test.ts` holds the halves together.
 *
 * `dangerouslySetInnerHTML` is safe *here specifically*: two files from this
 * repository, resolved at build time, with no user content near it.
 */

import { useMemo } from "react";
import { marked } from "marked";

import privacySource from "../../../../PRIVACY.md?raw";
import termsSource from "../../../../TERMS.md?raw";

/** The paths these pages answer on, and what each one is. */
export const LEGAL_PAGES = {
  "/privacy": { title: "Privacy", source: privacySource },
  "/terms": { title: "Terms of use", source: termsSource },
} as const;

export type LegalPath = keyof typeof LEGAL_PAGES;

/** Whether a pathname is one of these pages. */
export function legalPathFor(pathname: string): LegalPath | null {
  // Trailing slash tolerated, because a link somebody types will have one.
  const normalised = pathname.replace(/\/+$/, "") || "/";
  return normalised in LEGAL_PAGES ? (normalised as LegalPath) : null;
}

export function LegalPage({ path }: { path: LegalPath }) {
  const { title, source } = LEGAL_PAGES[path];
  const html = useMemo(() => marked.parse(source, { async: false }), [source]);

  return (
    <div className="min-h-screen bg-ink-950 px-6 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <a
          /**
           * A plain link rather than history navigation. These pages are
           * reached from the sign-in screen and from a provider's consent
           * screen, and in the second case there is no history to go back
           * through - the tab started here.
           */
          href="/"
          className="text-[11px] text-ink-400 transition hover:text-ink-100"
        >
          ← Sightline
        </a>

        <h1 className="mt-4 text-[18px] font-semibold text-ink-100">{title}</h1>

        {/*
          The prose styles are applied here rather than inside the markdown,
          because the markdown has to stay readable as a file on GitHub - it is
          the same document in both places.
        */}
        <article
          className="legal mt-6 text-[12px] leading-relaxed text-ink-300"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
