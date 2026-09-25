# Handover document

`dave-io-assignment-handover.pdf` — a 32-page knowledge-transfer document
covering the whole project: what was asked and built, the architecture, the
thirteen decisions, all thirty-two logged problems with their lessons, the
recurring failure patterns, the known limits, and a set of likely interview
questions with answers grounded in the code.

It is written to be read on its own, by someone who has not seen the codebase.

## Regenerating

`handover.html` is the source. It is authored as a print document — A4, page
breaks per section, print colour — and rendered with headless Chrome.

```bash
npm install puppeteer            # in a scratch directory, not this repo
npx puppeteer browsers install chrome
node render.js handover.html dave-io-assignment-handover.pdf
```

On a headless Linux box Chrome also needs the usual GUI shared libraries
(`libatk1.0-0t64`, `libnss3`, `libgbm1`, `libasound2t64` and friends), or it
exits with code 127 and `error while loading shared libraries`.

Page numbers come from the print job in `render.js`, not from a CSS
`@page { @bottom-center }` counter — declaring both renders the number twice.
