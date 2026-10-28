"use strict";
const path = require("path");
const { listen, launch, newPage, sleep } = require("../tests/lib");

(async () => {
  const port = await listen();
  const browser = await launch();

  try {
    const page = await newPage(browser, port, "LandingPage", { w: 1280, h: 800 });
    await sleep(400);

    const artifactDir = "C:\\Users\\danie\\.gemini\\antigravity\\brain\\adf36333-d3fc-40bd-ad67-79a83cf46c11";
    const landingArtifact = path.join(artifactDir, "landing_page.png");
    await page.screenshot({ path: landingArtifact, fullPage: false });
    console.log("✓ Landing page screenshot saved to:", landingArtifact);
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error("Screenshot failed:", err);
  process.exit(1);
});
