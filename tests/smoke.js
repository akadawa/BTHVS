"use strict";
/* Smoke test: import demo zip, start single player, check that the engine reaches the main menu. */
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");
const fs = require("fs");
const path = require("path");

(async () => {
  const port = await listen();
  const browser = await launch();
  const page = await newPage(browser, port, "A");
  await loadDemo(page);
  fs.mkdirSync(path.join(root, "tests", "out"), { recursive: true });
  await page.click("#btn-single");
  await sleep(Number(process.env.WAIT || 15000));
  await page.screenshot({ path: path.join(root, "tests", "out", "smoke.png") });
  const fatal = await page.evaluate(() => !document.querySelector("#fatal").hidden && document.querySelector("#fatal-text").textContent);
  console.log("fatal:", fatal || "none");
  const logs = page.logs.filter((l) => /game\]/.test(l)).slice(-30);
  console.log(logs.join("\n"));
  await browser.close();
  process.exit(fatal ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
