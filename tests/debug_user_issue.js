"use strict";
const { chromium } = require("./node_modules/playwright");
const { loadDemo, sleep } = require("./lib");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on("console", (m) => console.log("[Console]", m.text()));
  page.on("pageerror", (err) => console.log("[PageError]", err));

  await page.goto("http://localhost:8085");
  await loadDemo(page);
  await sleep(1000);

  console.log("Clicking Single Player...");
  await page.click("#btn-single");
  await sleep(6000);

  await page.screenshot({ path: "tests/out/debug_single_player.png" });
  console.log("Screenshot saved to tests/out/debug_single_player.png");
  await browser.close();
})();
