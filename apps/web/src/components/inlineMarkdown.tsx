/**
 * The Markdown the agent writes in nearly every answer - **bold**, `code`
 * for resource names, and # headings, shown bold - as React elements.
 *
 * Not a Markdown renderer, on purpose. An answer quotes resource names and
 * tags, which whoever controls the AWS account can set, so it is never turned
 * into HTML: every piece stays a text node, and only these two wrappers exist.
 * Line breaks and list markers are kept by the container's pre-wrap.
 */

import { Fragment, type ReactNode } from "react";

const BOLD = /(\*\*[^*\n]+\*\*)/g;
const CODE = /(`[^`\n]+`)/g;

/** Code spans, which the model also writes inside bold: **`prod-web-1`**. */
function codeSpans(text: string, keyPrefix: string): ReactNode[] {
  return text.split(CODE).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code
        key={`${keyPrefix}${i}`}
        className="rounded bg-ink-800 px-1 font-mono text-[11px] text-ink-100"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={`${keyPrefix}${i}`}>{part}</Fragment>
    ),
  );
}

/** A heading line, which the chat shows as a bold one. */
const HEADING = /^#{1,6} +(.+?) *$/gm;

export function inlineMarkdown(text: string): ReactNode[] {
  return text
    .replace(HEADING, (_, title: string) => `**${title.replace(/\*\*/g, "")}**`)
    .split(BOLD)
    .map((part, i) =>
      part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i} className="font-semibold">
          {codeSpans(part.slice(2, -2), `${i}.`)}
        </strong>
      ) : (
        <Fragment key={i}>{codeSpans(part, `${i}.`)}</Fragment>
      ),
    );
}
