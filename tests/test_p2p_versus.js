"use strict";
/* Test WebRTC P2P Multiplayer in Browser Theme Hospital */
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing WebRTC P2P Versus Mode (Serverless on Vercel) ===");
  const port = await listen();
  const browser = await launch();

  const hostPage = await newPage(browser, port, "Host");
  const guestPage = await newPage(browser, port, "Guest");

  // Force P2P mode in both pages
  await hostPage.evaluate(() => { localStorage.setItem("bth-net-mode", "p2p"); });
  await guestPage.evaluate(() => { localStorage.setItem("bth-net-mode", "p2p"); });

  // Load demo data into both
  await loadDemo(hostPage);
  await loadDemo(guestPage);

  // Set names
  await hostPage.fill("#player-name", "P2P_Host");
  await guestPage.fill("#player-name", "P2P_Guest");

  // Host creates room
  console.log("Host creating room in P2P mode...");
  await hostPage.click("#btn-create");
  await hostPage.waitForSelector("#card-lobby:not([hidden])", { timeout: 15000 });

  const roomCode = await hostPage.textContent("#room-code");
  console.log("Host created room with code:", roomCode);

  // Guest joins room
  console.log("Guest joining room:", roomCode);
  await guestPage.fill("#join-code", roomCode);
  await guestPage.click("#btn-join");
  await guestPage.waitForSelector("#card-lobby:not([hidden])", { timeout: 15000 });

  // Wait for both players to appear in lobby
  console.log("Waiting for player list synchronization...");
  await hostPage.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 15000 });
  await guestPage.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 15000 });

  const hostPlayers = await hostPage.evaluate(() => [...document.querySelectorAll("#player-list li span:first-child")].map(s => s.textContent));
  const guestPlayers = await guestPage.evaluate(() => [...document.querySelectorAll("#player-list li span:first-child")].map(s => s.textContent));
  console.log("Host sees players:", hostPlayers);
  console.log("Guest sees players:", guestPlayers);

  // Test lobby chat over P2P
  console.log("Testing P2P Lobby Chat...");
  await guestPage.fill("#lobby-chat-input", "Hallo vom P2P Gast!");
  await guestPage.click("#lobby-chat-form button");

  await hostPage.waitForFunction(() => document.querySelector("#lobby-chat-log").textContent.includes("Hallo vom P2P Gast!"), null, { timeout: 10000 });
  console.log("✓ Host received P2P chat message!");

  // Both ready up
  console.log("Marking both players as ready...");
  await hostPage.click("#btn-ready");
  await guestPage.click("#btn-ready");

  // Host starts match
  await hostPage.waitForFunction(() => !document.querySelector("#btn-start").disabled, null, { timeout: 10000 });
  console.log("Both ready! Host starting match...");
  await hostPage.click("#btn-start");

  // Wait for game canvas and HUD
  await hostPage.waitForSelector("#hud:not([hidden])", { timeout: 30000 });
  await guestPage.waitForSelector("#hud:not([hidden])", { timeout: 30000 });

  console.log("✓ In-game HUD visible on both Host and Guest!");

  const hostHudRoom = await hostPage.textContent("#hud-room");
  const guestHudRoom = await guestPage.textContent("#hud-room");
  console.log("Host HUD Room:", hostHudRoom);
  console.log("Guest HUD Room:", guestHudRoom);

  // Wait 3 seconds to let game run
  await sleep(3000);

  const fatalHost = await hostPage.evaluate(() => !document.querySelector("#fatal").hidden && document.querySelector("#fatal-text").textContent);
  const fatalGuest = await guestPage.evaluate(() => !document.querySelector("#fatal").hidden && document.querySelector("#fatal-text").textContent);

  if (fatalHost || fatalGuest) {
    throw new Error(`Match failed! Host fatal: ${fatalHost}, Guest fatal: ${fatalGuest}`);
  }

  console.log("✓ Match running stably over WebRTC P2P DataChannel!");
  await browser.close();
  console.log("=== ALL P2P VERSUS TESTS PASSED SUCCESSFULLY! ===");
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
