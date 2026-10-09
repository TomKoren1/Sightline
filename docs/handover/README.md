# Handover documents

Two print documents, written to be read on their own by someone who has not seen
the codebase. They answer different questions and are deliberately not merged.

**`sightline-handover.pdf`** — the project: what was asked and built,
the architecture, the fifteen decisions, all fifty logged problems with
their lessons, the recurring failure patterns, the known limits, and likely
interview questions with answers grounded in the code.

**`sightline-codebase-tour.pdf`** — the code: what every source file is
for, the four request paths traced hop by hop with line numbers, the data model,
the test suite file by file, and an index from "what someone might ask" to "the
file to open". Written to be open on a second screen while answering questions.

## Regenerating

`handover.html` and `codebase-tour.html` are the sources. Both are authored as
print documents — A4, page breaks per section, print colour — and rendered with
headless Chrome. They share one stylesheet by copy, since neither is served.

```bash
npm install puppeteer            # in a scratch directory, not this repo
npx puppeteer browsers install chrome
node render.cjs handover.html sightline-handover.pdf
node render.cjs codebase-tour.html sightline-codebase-tour.pdf
```

The footer label defaults to each document's own `<title>`; pass a third
argument to override it.

The extension is `.cjs` deliberately: the script is CommonJS and the repository
root declares `"type": "module"`, so as `render.js` it fails with
`require is not defined in ES module scope` — which it did, the first time it was
run from inside the repo rather than from the scratch directory it was written in.

On a headless Linux box Chrome also needs the usual GUI shared libraries
(`libatk1.0-0t64`, `libnss3`, `libgbm1`, `libasound2t64` and friends), or it
exits with code 127 and `error while loading shared libraries`.

Page numbers come from the print job in `render.cjs`, not from a CSS
`@page { @bottom-center }` counter — declaring both renders the number twice.

## A note on the line numbers in the tour

The codebase tour cites file and line for every hop in its traces. Line numbers
drift; symbol names do not. If a number is stale, the function named beside it
is still the right thing to open.
