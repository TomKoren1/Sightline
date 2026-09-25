const puppeteer = require("puppeteer");
(async () => {
  const [src, out] = process.argv.slice(2);
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.goto("file://" + src, { waitUntil: "networkidle0" });
  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="width:100%;font:8pt -apple-system,Segoe UI,Arial;color:#8a949e;padding:0 16mm;display:flex;justify-content:space-between;">' +
      "<span>dave.io Engineering Assignment — Project Handover</span>" +
      '<span class="pageNumber"></span></div>',
    margin: { top: "16mm", bottom: "18mm", left: "16mm", right: "16mm" },
  });
  await browser.close();
  console.log("written:", out);
})();
