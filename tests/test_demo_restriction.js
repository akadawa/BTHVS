"use strict";
/* Test Demo vs Full Version Map Restrictions */
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Demo vs Full Map Restrictions in Lobby ===");
  const port = await listen();
  const browser = await launch();

  const hostPage = await newPage(browser, port, "Host");
  const guestPage = await newPage(browser, port, "Guest");

  // Load demo into host, then simulate full version by setting demo: false
  await loadDemo(hostPage);
  await hostPage.evaluate(() => {
    window.__bth.state.data.demo = false;
  });

  // Load standard demo into guest (demo: true)
  await loadDemo(guestPage);

  await hostPage.fill("#player-name", "FullHost");
  await guestPage.fill("#player-name", "DemoGuest");

  // Host creates room
  await hostPage.click("#btn-create");
  await hostPage.waitForSelector("#card-lobby:not([hidden])", { timeout: 15000 });

  const roomCode = (await hostPage.textContent("#room-code")).trim();
  console.log("Room created:", roomCode);

  // Before guest joins, host (who has full version) should see other maps enabled
  const hostInitialOptions = await hostPage.evaluate(() => {
    return [...document.querySelectorAll("#mp-level option")].map(o => ({ value: o.value, disabled: o.disabled }));
  });
  console.log("Host initial level options (before guest joins):", hostInitialOptions);

  const nonDemoOptionsBefore = hostInitialOptions.filter(o => o.value !== "demo");
  if (nonDemoOptionsBefore.some(o => o.disabled)) {
    throw new Error("Full host should have all maps enabled when alone!");
  }

  // Host selects a non-demo map, e.g. avatar
  console.log("Host selecting 'avatar'...");
  await hostPage.selectOption("#mp-level", "avatar");
  const selectedBeforeGuest = await hostPage.inputValue("#mp-level");
  console.log("Selected level before guest:", selectedBeforeGuest);
  if (selectedBeforeGuest !== "avatar") {
    throw new Error("Host failed to select 'avatar'!");
  }

  // Now Demo guest joins!
  console.log("Demo guest joining room...");
  await guestPage.fill("#join-code", roomCode);
  await guestPage.click("#btn-join");
  await guestPage.waitForSelector("#card-lobby:not([hidden])", { timeout: 15000 });

  // Wait for player list sync
  await hostPage.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 15000 });
  await sleep(1000);

  // Verify that host's dropdown was automatically clamped back to "demo"!
  const hostLevelAfterGuest = await hostPage.inputValue("#mp-level");
  console.log("Host selected level after demo guest joined:", hostLevelAfterGuest);
  if (hostLevelAfterGuest !== "demo") {
    throw new Error(`Host level should have reset to 'demo', but was '${hostLevelAfterGuest}'!`);
  }

  // Verify that all non-demo options are now disabled in the dropdown
  const hostOptionsAfterGuest = await hostPage.evaluate(() => {
    return [...document.querySelectorAll("#mp-level option")].map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled }));
  });
  console.log("Host level options after demo guest joined:", hostOptionsAfterGuest);

  const nonDemoOptionsAfter = hostOptionsAfterGuest.filter(o => o.value !== "demo");
  if (!nonDemoOptionsAfter.every(o => o.disabled)) {
    throw new Error("All non-demo options must be disabled when a demo player is in the lobby!");
  }

  // Verify warning hint is displayed
  const hintText = await hostPage.textContent("#level-compat-hint");
  const isHintVisible = await hostPage.isVisible("#level-compat-hint");
  console.log("Level compat hint visible:", isHintVisible, "Text:", hintText);
  if (!isHintVisible || !hintText.includes("Demo-Version")) {
    throw new Error("Level compatibility hint was not displayed!");
  }

  // Verify guest sees Demo-Level in their view
  const guestLevelText = await guestPage.textContent("#guest-level-val");
  console.log("Guest sees level name:", guestLevelText);
  if (!guestLevelText.toLowerCase().includes("demo")) {
    throw new Error(`Guest should see demo level, but sees: ${guestLevelText}`);
  }

  console.log("✓ MAP RESTRICTIONS VERIFIED: Only Demo level is selectable when a demo player is present!");
  await browser.close();
  console.log("=== ALL DEMO RESTRICTION TESTS PASSED! ===");
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
