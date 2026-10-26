"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Starting Bidirectional Demo/Full Map Restrictions Test...");
  const port = await listen();
  const browser = await launch();

  // =========================================================================
  // TEST CASE 1: Host has Demo version -> ALL maps except 'demo' MUST be greyed out
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

  for (const opt of demoHostOptions) {
    if (opt.value === "demo") {
      if (opt.disabled) throw new Error("FAIL: 'demo' map must be enabled for Demo Host!");
    } else {
      if (!opt.disabled) throw new Error(`FAIL: '${opt.value}' MUST be disabled/greyed out for Demo Host!`);
    }
  }
  console.log("PASS: Only 'demo' is enabled; all other maps are disabled/greyed-out for Demo Host!");
  await pDemoHost.close();

  // =========================================================================
  // TEST CASE 2: Host has Vollversion, selects Avatar or Level 1.
  // Then Demo Guest joins.
  // -> Host's non-demo map MUST be greyed out and reset to demo!
  // -> Guest must receive 'demo' in real time!
  // -> When game starts, both must load identical demo level!
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

  // While alone, Full Host CAN select avatar or level1
  await pFullHost.selectOption("#mp-level", "avatar");
  const hostValBefore = await pFullHost.inputValue("#mp-level");
  console.log("Full Host selected before guest joined:", hostValBefore);
  if (hostValBefore !== "avatar") throw new Error("Full Host should be able to pick avatar while alone!");

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
  const hostOptionsAfter = await pFullHost.evaluate(() => {
    const sel = document.querySelector("#mp-level");
    return Array.from(sel.options).map((o) => ({ value: o.value, disabled: o.disabled, text: o.textContent }));
  });
  console.log("Full Host map value after Demo Guest joined:", hostValAfter);
  console.log("Full Host options state after Demo Guest joined:", hostOptionsAfter);

  for (const opt of hostOptionsAfter) {
    if (opt.value === "demo") {
      if (opt.disabled) throw new Error("FAIL: 'demo' option must be enabled!");
    } else {
      if (!opt.disabled) throw new Error(`FAIL: '${opt.value}' MUST be disabled once Demo Guest joined!`);
    }
  }
  if (hostValAfter !== "demo") {
    throw new Error("FAIL: Host map selection was not automatically flipped to demo!");
  }
  console.log("PASS: Host dropdown automatically greyed out all full maps and flipped to: demo");

  // 4. Verify Guest received the compatible map in real time
  const guestLobbyLevel = await pDemoGuest.textContent("#guest-level-val");
  console.log("Guest lobby view shows map:", guestLobbyLevel);
  if (!guestLobbyLevel.includes("Demo-Level")) {
    throw new Error("FAIL: Guest should see Demo-Level in their lobby view!");
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

  if (hostSessionLevel !== guestSessionLevel || hostSessionLevel !== "demo") {
    throw new Error(`FAIL: Expected demo level on both! Host=${hostSessionLevel}, Guest=${guestSessionLevel}`);
  }

  console.log("ALL RESTRICTION TESTS PASSED PERFECTLY!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
