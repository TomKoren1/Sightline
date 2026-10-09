/**
 * Render a print-authored HTML document to PDF with headless Chrome.
 *
 *   node render.cjs <source.html> <out.pdf> [footer label]
 *
 * CommonJS, and named `.cjs` deliberately: the repository root declares
 * `"type": "module"`, so as `render.js` this fails with `require is not defined
 * in ES module scope`.
 *
 * The footer label defaults to the document's own <title>, which is how both
 * documents in this directory get their own footer from one script. Page
 * numbers come from here rather than a CSS `@page { @bottom-center }` counter —
 * declaring both renders the number twice.
 */

const path = require("node:path");
const puppeteer = require("puppeteer");

(async () => {
  const [src, out, label] = process.argv.slice(2);
  if (!src || !out) {
    console.error("usage: node render.cjs <source.html> <out.pdf> [footer label]");
    process.exit(1);
  }
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  /**
   * Resolved to an absolute path first.
   *
   * `"file://" + src` with the relative argument this script's own README
   * documents produces `file://handover.html`, which Chrome rejects outright
   * with `net::ERR_INVALID_URL` - so the documented command had never worked
   * from the directory it tells you to run it in.
   */
  await page.goto(`file://${path.resolve(src)}`, { waitUntil: "networkidle0" });

  const footer = label ?? (await page.title());
  const escaped = footer.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="width:100%;font:8pt -apple-system,Segoe UI,Arial;color:#8a949e;padding:0 16mm;display:flex;justify-content:space-between;">' +
      `<span>${escaped}</span>` +
      '<span class="pageNumber"></span></div>',
    margin: { top: "16mm", bottom: "18mm", left: "16mm", right: "16mm" },
  });
  await browser.close();
  console.log("written:", out);
})();
