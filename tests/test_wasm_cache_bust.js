"use strict";
const fs = require("fs");
const path = require("path");
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");

(async () => {
  console.log("=== Testing Wasm & Data Package Cache-Busting & Size Verification ===");
  const port = await listen();
  const browser = await launch();

  try {
    const buildManifest = JSON.parse(fs.readFileSync(path.join(root, "dist", "game", "build.json"), "utf8"));
    console.log("Loaded build.json:", buildManifest);
    if (!buildManifest.hash || !buildManifest.dataSize) {
      throw new Error("FAIL: dist/game/build.json missing hash or dataSize!");
    }

    const p1 = await newPage(browser, port, "HostCacheTest");
    const requestedUrls = [];

    // Poison unversioned /game/corsixth.data and first stale response to prove cache-busting & size check work
    let injectedStaleOnce = false;
    await p1.route("**/game/**", async (route) => {
      const reqUrl = route.request().url();
      requestedUrls.push(reqUrl);
      const u = new URL(reqUrl);

      // If any code ever requests /game/corsixth.data WITHOUT ?v=, return garbage so it would fail immediately
      if (u.pathname.endsWith("/corsixth.data") && !u.searchParams.get("v")) {
        return route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.from("nd an index for screenshot which is not already used"),
        });
      }

      // Also simulate a stale proxy returning wrong-sized data on first attempt (without &r=)
      if (u.pathname.endsWith("/corsixth.data") && !u.searchParams.get("r") && !injectedStaleOnce) {
        injectedStaleOnce = true;
        return route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.alloc(12345, 0x61),
        });
      }

      return route.continue();
    });

    await loadDemo(p1);
    await p1.click("#btn-create");
    await sleep(400);

    const p2 = await newPage(browser, port, "GuestCacheTest");
    await loadDemo(p2);
    const roomCode = (await p1.textContent("#room-code")).trim();
    await p2.fill("#join-code", roomCode);
    await p2.click("#btn-join");

    await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
    await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);

    await p1.click("#btn-ready");
    await p2.click("#btn-ready");
    await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
    await p1.click("#btn-start");

    await p1.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
    await sleep(1200);

    // Check that fatal overlay is hidden (no utility.lua syntax error!)
    const fatalHidden = await p1.$eval("#fatal", (el) => el.hidden);
    if (!fatalHidden) {
      const fatalMsg = await p1.textContent("#fatal-msg");
      throw new Error(`FAIL: Engine hit fatal error: ${fatalMsg}`);
    }
    console.log("✓ Engine booted cleanly with #fatal hidden (zero utility.lua syntax errors).");

    // Verify requested URLs all carried ?v=<hash> and retried with &r= on size mismatch
    const jsReq = requestedUrls.find((u) => u.includes("/game/corsixth.js"));
    const wasmReq = requestedUrls.find((u) => u.includes("/game/corsixth.wasm"));
    const dataReqs = requestedUrls.filter((u) => u.includes("/game/corsixth.data"));

    console.log("Intercepted game asset requests:", { jsReq, wasmReq, dataReqs });

    if (!jsReq || !jsReq.includes(`?v=${buildManifest.hash}`)) {
      throw new Error(`FAIL: corsixth.js was not requested with ?v=${buildManifest.hash}: ${jsReq}`);
    }
    if (!wasmReq || !wasmReq.includes(`?v=${buildManifest.hash}`)) {
      throw new Error(`FAIL: corsixth.wasm was not requested with ?v=${buildManifest.hash}: ${wasmReq}`);
    }
    if (!dataReqs.some((u) => u.includes(`?v=${buildManifest.hash}`) && u.includes("&r="))) {
      throw new Error(`FAIL: Expected automatic cache-bypass retry (&r=) on size mismatch: ${JSON.stringify(dataReqs)}`);
    }
    console.log("✓ Verified ?v=<hash> on corsixth.js, corsixth.wasm, corsixth.data and automatic size-mismatch recovery.");

    console.log("=== ALL WASM CACHE-BUSTING & INTEGRITY TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
