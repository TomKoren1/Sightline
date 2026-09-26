# Handover document

`dave-io-assignment-handover.pdf` — a knowledge-transfer document covering the
whole project: what was asked and built, the architecture, the fourteen
decisions, all thirty-eight logged problems with their lessons, the recurring
failure patterns, the known limits, and a set of likely interview questions with
answers grounded in the code.

It is written to be read on its own, by someone who has not seen the codebase.

## Regenerating

`handover.html` is the source. It is authored as a print document — A4, page
breaks per section, print colour — and rendered with headless Chrome.

```bash
npm install puppeteer            # in a scratch directory, not this repo
npx puppeteer browsers install chrome
node render.cjs handover.html dave-io-assignment-handover.pdf
```

The extension is `.cjs` deliberately: the script is CommonJS and the repository
root declares `"type": "module"`, so as `render.js` it fails with
`require is not defined in ES module scope` — which it did, the first time it was
run from inside the repo rather than from the scratch directory it was written in.

On a headless Linux box Chrome also needs the usual GUI shared libraries
(`libatk1.0-0t64`, `libnss3`, `libgbm1`, `libasound2t64` and friends), or it
exits with code 127 and `error while loading shared libraries`.

Page numbers come from the print job in `render.cjs`, not from a CSS
`@page { @bottom-center }` counter — declaring both renders the number twice.
