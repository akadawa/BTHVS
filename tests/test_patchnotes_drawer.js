"use strict";
const { listen, launch, newPage, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Patchnotes Drawer: Far Left Button, Slide-out Panel, GitHub Updates, Zero Icons & Zero Emojis ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "PatchnotesVisitor");
    await sleep(400);

    // 1. Verify ZERO SVG elements across the entire page
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) {
      throw new Error(`FAIL: Expected 0 SVG elements, found ${svgCount}!`);
    }
    console.log("✓ Verified 0 SVG elements across the entire document.");

    // 2. Verify Patchnotes button exists and is docked on far left (left: 0)
    const btn = await p1.$("#patchnotes-btn");
    if (!btn) {
      throw new Error("FAIL: #patchnotes-btn does not exist in DOM!");
    }
    const btnVisible = await btn.isVisible();
    if (!btnVisible) {
      throw new Error("FAIL: #patchnotes-btn should be visible!");
    }
    const btnText = (await btn.textContent()).trim();
    if (btnText !== "Patchnotes") {
      throw new Error(`FAIL: #patchnotes-btn text should be 'Patchnotes', got '${btnText}'`);
    }
    const btnBox = await btn.boundingBox();
    console.log("Patchnotes button bounding box:", btnBox);
    if (btnBox.x > 5) {
      throw new Error(`FAIL: #patchnotes-btn should be on the far left edge (x <= 5), got x=${btnBox.x}`);
    }
    console.log("✓ #patchnotes-btn is docked to the far left (x:", btnBox.x, ")");

    // 3. Verify drawer is initially closed (not having class 'open')
    let isDrawerOpen = await p1.evaluate(() => {
      const drawer = document.querySelector("#patchnotes-drawer");
      return drawer && drawer.classList.contains("open");
    });
    if (isDrawerOpen) {
      throw new Error("FAIL: #patchnotes-drawer should not be open on page load!");
    }
    console.log("✓ #patchnotes-drawer is initially closed.");

    // 4. Click the Patchnotes button to expand drawer
    await p1.click("#patchnotes-btn");
    await sleep(350);

    isDrawerOpen = await p1.evaluate(() => {
      const drawer = document.querySelector("#patchnotes-drawer");
      return drawer && drawer.classList.contains("open");
    });
    if (!isDrawerOpen) {
      throw new Error("FAIL: #patchnotes-drawer should have class 'open' after clicking #patchnotes-btn!");
    }
    console.log("✓ Clicking #patchnotes-btn opens #patchnotes-drawer.");

    // 5. Verify Patchnotes entries are rendered (from live GitHub or cached/fallback)
    await sleep(500); // allow async fetch / fallback rendering
    const patchItemsCount = await p1.$$eval(".patchnotes-item", (els) => els.length);
    console.log("Rendered patch items count:", patchItemsCount);
    if (patchItemsCount < 3) {
      throw new Error(`FAIL: Expected at least 3 patch notes entries, found ${patchItemsCount}!`);
    }

    // Verify first patch item structure: date, commit sha link, message
    const firstItem = await p1.evaluate(() => {
      const item = document.querySelector(".patchnotes-item");
      const dateEl = item.querySelector(".patchnotes-date");
      const shaEl = item.querySelector(".patchnotes-sha");
      const msgEl = item.querySelector(".patchnotes-item-msg");
      return {
        date: dateEl ? dateEl.textContent.trim() : "",
        sha: shaEl ? shaEl.textContent.trim() : "",
        href: shaEl ? shaEl.href : "",
        msg: msgEl ? msgEl.textContent.trim() : ""
      };
    });
    console.log("First patch note entry:", firstItem);
    if (!firstItem.sha || firstItem.sha.length < 6) {
      throw new Error(`FAIL: Invalid commit SHA in first patch note: '${firstItem.sha}'`);
    }
    if (!firstItem.href.includes("github.com/akadawa/BTHVS/commit/")) {
      throw new Error(`FAIL: Commit link should point to GitHub commit, got: '${firstItem.href}'`);
    }
    if (!firstItem.date || !firstItem.msg) {
      throw new Error("FAIL: Patch note date or message is empty!");
    }
    console.log("✓ Patch note item verified with valid date, sha link, and commit message.");

    // 6. Verify strictly ZERO emojis in all patch notes text
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const allDrawerText = await p1.evaluate(() => document.querySelector("#patchnotes-drawer").innerText);
    if (emojiRegex.test(allDrawerText)) {
      throw new Error("FAIL: Found emoji inside patchnotes drawer!");
    }
    console.log("✓ Strict verification passed: Zero emojis found in patchnotes drawer.");

    // 7. Click refresh button
    await p1.click("#patchnotes-refresh");
    await sleep(400);
    const postRefreshCount = await p1.$$eval(".patchnotes-item", (els) => els.length);
    if (postRefreshCount < 3) {
      throw new Error(`FAIL: After refresh, items count dropped to ${postRefreshCount}!`);
    }
    console.log("✓ Refresh button successfully re-fetched/re-rendered patch notes.");

    // 8. Close drawer via close button (X)
    await p1.click("#patchnotes-close");
    await sleep(300);
    isDrawerOpen = await p1.evaluate(() => {
      const drawer = document.querySelector("#patchnotes-drawer");
      return drawer && drawer.classList.contains("open");
    });
    if (isDrawerOpen) {
      throw new Error("FAIL: Drawer should be closed after clicking #patchnotes-close!");
    }
    console.log("✓ Clicking #patchnotes-close successfully closes the drawer.");

    // 9. Re-open and close via Escape key
    await p1.click("#patchnotes-btn");
    await sleep(250);
    await p1.keyboard.press("Escape");
    await sleep(250);
    isDrawerOpen = await p1.evaluate(() => {
      const drawer = document.querySelector("#patchnotes-drawer");
      return drawer && drawer.classList.contains("open");
    });
    if (isDrawerOpen) {
      throw new Error("FAIL: Drawer should be closed after pressing Escape!");
    }
    console.log("✓ Pressing Escape successfully closes the drawer.");

    // 10. Re-open and close via clicking backdrop
    await p1.click("#patchnotes-btn");
    await sleep(250);
    // Click on the backdrop (e.g. at (600, 300) outside the 440px wide drawer)
    await p1.mouse.click(600, 300);
    await sleep(250);
    isDrawerOpen = await p1.evaluate(() => {
      const drawer = document.querySelector("#patchnotes-drawer");
      return drawer && drawer.classList.contains("open");
    });
    if (isDrawerOpen) {
      throw new Error("FAIL: Drawer should be closed after clicking backdrop!");
    }
    console.log("✓ Clicking backdrop successfully closes the drawer.");

    console.log("=== ALL PATCHNOTES DRAWER TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
