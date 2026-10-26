"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Starting Bidirectional Demo/Full Map Restrictions Test...");
  const port = await listen();
  const browser = await launch();

  // =========================================================================
  // TEST CASE 1: Host has Demo version -> Vollversion maps MUST be greyed out
  // =========================================================================
  console.log("\n--- TEST CASE 1: Demo Host ---");
  const pDemoHost = await newPage(browser, port, "DemoHost");
  await loadDemo(pDemoHost);
  await pDemoHost.fill("#player-name", "DemoHost");
  await pDemoHost.click("#btn-create");
  await pDemoHost.waitForSelector("#card-lobby:not([hidden])");

  const demoHostOptions = await pDemoHost.evaluate(() => {
    const sel = document.querySelector("#mp-level");
    return Array.from(sel.options).map((o) => ({
      value: o.value,
      text: o.textContent,
      disabled: o.disabled,
    }));
  });
  console.log("Demo Host dropdown options:", demoHostOptions);

  const level1OnDemoHost = demoHostOptions.find((o) => o.value === "level1");
  if (!level1OnDemoHost || !level1OnDemoHost.disabled) {
    throw new Error("FAIL: level1 should be disabled for Demo Host!");
  }
  console.log("PASS: level1 is disabled/greyed-out for Demo Host!");
  await pDemoHost.close();

  // =========================================================================
  // TEST CASE 2: Host has Vollversion, selects Level 1.
  // Then Demo Guest joins.
  // -> Host's Level 1 MUST be greyed out and reset to compatible map!
  // -> Guest must receive compatible map in real time!
  // -> When game starts, both must load identical compatible map!
  // =========================================================================
  console.log("\n--- TEST CASE 2: Full Host + Demo Guest ---");
  const pFullHost = await newPage(browser, port, "FullHost");
  const pDemoGuest = await newPage(browser, port, "DemoGuest");

  pFullHost.on("console", (m) => console.log("[FullHost]", m.text()));
  pDemoGuest.on("console", (m) => console.log("[DemoGuest]", m.text()));

  // 1. Setup Full Host
  await loadDemo(pFullHost);
  await pFullHost.evaluate(() => {
    const s = window.__bth.state;
    s.data.demo = false;
    s.data.files = s.data.files.filter(([p]) => !p.toLowerCase().includes("demo.dat"));
  });
  await pFullHost.fill("#player-name", "FullHost");
  await pFullHost.click("#btn-create");
  await pFullHost.waitForSelector("#card-lobby:not([hidden])");

  // While alone, Full Host CAN select level1
  await pFullHost.selectOption("#mp-level", "level1");
  const hostValBefore = await pFullHost.inputValue("#mp-level");
  console.log("Full Host selected before guest joined:", hostValBefore);
  if (hostValBefore !== "level1") throw new Error("Full Host should be able to pick level1 while alone!");

  // 2. Setup Demo Guest and join
  await loadDemo(pDemoGuest);
  await pDemoGuest.fill("#player-name", "DemoGuest");
  const roomCode = (await pFullHost.textContent("#room-code")).trim();
  await pDemoGuest.fill("#join-code", roomCode);
  await pDemoGuest.click("#btn-join");

  // Wait for guest to be listed
  await pFullHost.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(1000);

  // 3. Inspect Host's dropdown now that Demo Guest joined!
  const hostValAfter = await pFullHost.inputValue("#mp-level");
  const hostLevel1Opt = await pFullHost.evaluate(() => {
    const sel = document.querySelector("#mp-level");
    const opt = Array.from(sel.options).find((o) => o.value === "level1");
    return { value: opt.value, disabled: opt.disabled, text: opt.textContent };
  });
  console.log("Full Host map value after Demo Guest joined:", hostValAfter);
  console.log("Full Host level1 option state after Demo Guest joined:", hostLevel1Opt);

  if (!hostLevel1Opt.disabled) {
    throw new Error("FAIL: level1 MUST be disabled/greyed out once Demo Guest joined!");
  }
  if (hostValAfter === "level1") {
    throw new Error("FAIL: Host map selection was not automatically flipped away from level1!");
  }
  console.log("PASS: Host dropdown automatically greyed out level1 and flipped to:", hostValAfter);

  // 4. Verify Guest received the compatible map in real time
  const guestLobbyLevel = await pDemoGuest.textContent("#guest-level-val");
  console.log("Guest lobby view shows map:", guestLobbyLevel);
  if (guestLobbyLevel.includes("Originalkampagne") || guestLobbyLevel.includes("Level 1")) {
    throw new Error("FAIL: Guest should NOT see Level 1 in their lobby view!");
  }
  console.log("PASS: Guest view correctly shows compatible map:", guestLobbyLevel);

  // 5. Host starts game
  await pFullHost.click("#btn-start");
  await Promise.all([
    pFullHost.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    pDemoGuest.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(3000);

  // 6. Verify active level on both sides
  const hostSessionLevel = await pFullHost.evaluate(() => window.__bth.state.session.mp.level);
  const guestSessionLevel = await pDemoGuest.evaluate(() => window.__bth.state.session.mp.level);
  console.log(`Active levels in game -> Host: ${hostSessionLevel} | Guest: ${guestSessionLevel}`);

  if (hostSessionLevel !== guestSessionLevel) {
    throw new Error(`FAIL: Level mismatch! Host=${hostSessionLevel}, Guest=${guestSessionLevel}`);
  }
  if (hostSessionLevel === "level1") {
    throw new Error("FAIL: Game should NOT have started on level1!");
  }

  console.log("ALL RESTRICTION TESTS PASSED PERFECTLY!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
