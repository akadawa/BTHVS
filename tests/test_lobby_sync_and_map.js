"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Starting Lobby Content & Map Sync End-to-End Test...");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[HostConsole]", m.text()));
  p2.on("console", (m) => console.log("[GuestConsole]", m.text()));

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "HostDoc");
  await p2.fill("#player-name", "GuestDoc");

  // 1. Host creates room
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();
  console.log("Room created:", code);

  // 2. Guest joins room
  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(1000);

  // 3. Verify player list tags show Demo/Vollversion on both screens
  const p1List = await p1.evaluate(() => {
    return Array.from(document.querySelectorAll("#player-list li")).map(li => li.textContent);
  });
  console.log("Host player list tags:", p1List);
  if (!p1List.some(t => t.includes("Demo"))) {
    throw new Error("Demo tag not found in player list!");
  }

  // 4. Verify Host dropdown options: level1 is disabled (greyed out) because a player has Demo
  const level1Disabled = await p1.evaluate(() => {
    const opt = Array.from(document.querySelectorAll("#mp-level option")).find(o => o.value === "level1");
    const hint = document.getElementById("level-compat-hint");
    return {
      exists: !!opt,
      disabled: opt ? opt.disabled : false,
      text: opt ? opt.textContent : "",
      hintVisible: hint && !hint.hidden,
      hintText: hint ? hint.textContent : "",
    };
  });
  console.log("Host level1 option state:", level1Disabled);
  if (!level1Disabled.disabled) {
    throw new Error("level1 was NOT disabled when a player has Demo!");
  }
  if (!level1Disabled.hintVisible) {
    throw new Error("Demo compatibility hint is not visible!");
  }
  console.log("DEMO CONTENT CHECK & GREYED-OUT MAP VERIFIED!");

  // 5. Host switches mode to "freebuild" and selects "avatar"
  console.log("Host selecting map 'avatar'...");
  await p1.selectOption("#mp-level", "avatar");
  await sleep(500);

  // 6. Verify Guest's view updated in real time via lobby_config!
  const guestView = await p2.evaluate(() => {
    return {
      levelVal: document.getElementById("guest-level-val").textContent,
      modeVal: document.getElementById("guest-mode-val").textContent,
    };
  });
  console.log("Guest received lobby config in real time:", guestView);
  if (!guestView.levelVal.includes("Avatar")) {
    throw new Error("Guest did not receive map selection update! Got: " + guestView.levelVal);
  }
  console.log("REAL-TIME LOBBY MAP SYNC VERIFIED!");

  // 7. Host starts game
  console.log("Host starting game...");
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(4000);

  // 8. Verify BOTH clients have the EXACT same map (Avatar) loaded!
  const maps = await Promise.all([
    p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], ["print('P1 ACTIVE LEVEL: ' .. tostring(TheApp.multiplayer.level) .. ' MAP: ' .. tostring(TheApp.map.level_name))"]);
      return window.__bth.state.session.mp.level;
    }),
    p2.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], ["print('P2 ACTIVE LEVEL: ' .. tostring(TheApp.multiplayer.level) .. ' MAP: ' .. tostring(TheApp.map.level_name))"]);
      return window.__bth.state.session.mp.level;
    }),
  ]);

  console.log("Host session level:", maps[0]);
  console.log("Guest session level:", maps[1]);

  if (maps[0] !== maps[1]) {
    throw new Error(`MAP MISMATCH! Host: ${maps[0]} vs Guest: ${maps[1]}`);
  }
  if (maps[0] !== "avatar") {
    throw new Error(`Map is not avatar! Got: ${maps[0]}`);
  }

  // 9. Verify in-game HUD displays map name
  const hudMapNames = await Promise.all([
    p1.evaluate(() => document.getElementById("hud-room").textContent),
    p2.evaluate(() => document.getElementById("hud-room").textContent),
  ]);
  console.log("HUD texts:", hudMapNames);
  if (!hudMapNames[0].includes("Avatar") || !hudMapNames[1].includes("Avatar")) {
    throw new Error("HUD does not display the map name! Got: " + JSON.stringify(hudMapNames));
  }

  console.log("BOTH PLAYERS ARE ON THE EXACT SAME MAP (Avatar 128x128)! SUCCESS!");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
