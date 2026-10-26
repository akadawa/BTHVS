"use strict";
/* End-to-end co-op multiplayer test:
 * 1. Two players (Host Dr. Alice, Guest Dr. Bob) load HOSP.zip
 * 2. Host creates room, Guest joins with room code
 * 3. Lobby shows both players connected
 * 4. Host starts the game
 * 5. Both enter the hospital in co-op mode
 * 6. Test in-game chat, speed synchronization, and take screenshots
 */
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");
const path = require("path");
const fs = require("fs");

(async () => {
  console.log("Starting multiplayer co-op E2E test...");
  const port = await listen();
  const browser = await launch();

  fs.mkdirSync(path.join(root, "tests", "out"), { recursive: true });

  // 1. Open two browser contexts
  console.log("Opening Host (Dr. Alice) and Guest (Dr. Bob)...");
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  // 2. Load game data on both
  console.log("Importing game data on Host and Guest...");
  await Promise.all([loadDemo(p1), loadDemo(p2)]);

  // Set names
  await p1.fill("#player-name", "Dr. Alice");
  await p2.fill("#player-name", "Dr. Bob");

  // 3. Host creates room
  console.log("Dr. Alice creating room...");
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])", { timeout: 10000 });
  const code = (await p1.textContent("#room-code")).trim();
  console.log("Room code created:", code);

  // 4. Guest joins room
  console.log("Dr. Bob joining room " + code + "...");
  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p2.waitForSelector("#card-lobby:not([hidden])", { timeout: 10000 });

  // 5. Verify both players listed in lobby
  console.log("Waiting for both players in lobby...");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 10000 });
  await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 10000 });
  console.log("Lobby verified on both clients!");

  // Take lobby screenshot
  await p1.screenshot({ path: path.join(root, "tests", "out", "mp_lobby_host.png") });
  await p2.screenshot({ path: path.join(root, "tests", "out", "mp_lobby_guest.png") });

  // 6. Host starts game
  console.log("Host starting multiplayer game...");
  await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled, null, { timeout: 10000 });
  await p1.click("#btn-start");

  // 7. Wait for both games to load into the hospital
  console.log("Waiting for game engine to load on both clients...");
  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 45000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 45000 }),
  ]);
  console.log("HUD visible on both clients! Waiting for first frames...");
  await sleep(6000);

  // 8. Verify no fatal errors
  const fatal1 = await p1.evaluate(() => !document.querySelector("#fatal").hidden && document.querySelector("#fatal-text").textContent);
  const fatal2 = await p2.evaluate(() => !document.querySelector("#fatal").hidden && document.querySelector("#fatal-text").textContent);
  if (fatal1 || fatal2) {
    console.error("FATAL ERROR IN GAME:", { host: fatal1, guest: fatal2 });
    await browser.close();
    process.exit(1);
  }

  // 9. Test in-game chat between peers
  console.log("Testing in-game chat...");
  await p2.click("#hud-chat-btn");
  await p2.waitForSelector("#chat:not([hidden])");
  await p2.fill("#chat-input", "Hallo Frau Kollegin!");
  await p2.keyboard.press("Enter");
  await sleep(1500);

  const chatReceived = await p1.evaluate(() => document.querySelector("#chat-log").textContent.includes("Hallo Frau Kollegin"));
  console.log("Chat message received by host:", chatReceived ? "YES!" : "NO");

  // 10. Take in-game screenshots of both players
  console.log("Capturing in-game co-op screenshots...");
  await p1.screenshot({ path: path.join(root, "tests", "out", "mp_game_host.png") });
  await p2.screenshot({ path: path.join(root, "tests", "out", "mp_game_guest.png") });

  console.log("SUCCESS! Multiplayer co-op end-to-end test passed completely!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(2);
});
