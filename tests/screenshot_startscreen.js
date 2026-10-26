"use strict";
const { launch, newPage, root } = require("./lib");
const path = require("path");

(async () => {
  const browser = await launch();
  const page = await newPage(browser, 8085, "MenuScreenshot");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://127.0.0.1:8085/");
  await page.waitForSelector("#menu");

  const outPath = path.join(root, "tests", "out", "startscreen_background.png");
  await page.screenshot({ path: outPath, fullPage: true });
  console.log("Start screen screenshot saved to:", outPath);

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("SCREENSHOT FAILED:", e);
  process.exit(1);
});
