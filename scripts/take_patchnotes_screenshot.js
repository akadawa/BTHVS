"use strict";
const path = require("path");
const fs = require("fs");
const { listen, launch, newPage, sleep } = require("../tests/lib");

(async () => {
  console.log("=== Taking Screenshot of Patchnotes Drawer ===");
  const port = await listen();
  const browser = await launch();

  try {
    const page = await newPage(browser, port, "ScreenshotPage", { w: 1280, h: 800 });
    await sleep(400);

    // Click patchnotes button
    await page.click("#patchnotes-btn");
    await sleep(600); // allow drawer transition and commit fetch

    const artifactDir = "C:\\Users\\danie\\.gemini\\antigravity\\brain\\adf36333-d3fc-40bd-ad67-79a83cf46c11";
    const artifactPath = path.join(artifactDir, "patchnotes.png");
    const localPath = path.resolve(__dirname, "..", "patchnotes.png");

    await page.screenshot({ path: artifactPath, fullPage: false });
    await page.screenshot({ path: localPath, fullPage: false });
    console.log("✓ Screenshot saved to:", artifactPath);
    console.log("✓ Screenshot saved to:", localPath);
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error("Screenshot failed:", err);
  process.exit(1);
});
