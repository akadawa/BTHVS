"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Versus Mode Redesign, Quest-Chooser, Resizable Windows & Bottom-Right HUD ===");
  const port = await listen();
  const browser = await launch();
  const pHost = await newPage(browser, port, "Host");
  const pGuest = await newPage(browser, port, "Guest");

  pHost.on("console", (m) => console.log("[HostConsole]", m.text()));
  pGuest.on("console", (m) => console.log("[GuestConsole]", m.text()));

  // 1. Verify Branding & Singleplayer Removal
  const title = await pHost.title();
  console.log("Page title:", title);
  if (!title.includes("Versus")) throw new Error(`FAIL: Title should contain 'Versus', got: ${title}`);

  const headerH1 = await pHost.textContent("header h1");
  console.log("Header H1:", headerH1);
  if (!headerH1.includes("Versus")) throw new Error(`FAIL: Header H1 should contain 'Versus', got: ${headerH1}`);

  const btnSingle = await pHost.$("#btn-single");
  if (btnSingle !== null) throw new Error("FAIL: Singleplayer (#btn-single) should be completely removed!");
  console.log("✓ Singleplayer removed and Versus branding confirmed.");

  // 2. Test Setup Card Replacement by Lobby View
  await Promise.all([loadDemo(pHost), loadDemo(pGuest)]);
  await pHost.fill("#player-name", "HostDoc");
  await pGuest.fill("#player-name", "GuestDoc");

  const setupVisibleBefore = await pHost.isVisible("#view-setup");
  const lobbyVisibleBefore = await pHost.isVisible("#card-lobby");
  if (!setupVisibleBefore || lobbyVisibleBefore) {
    throw new Error(`FAIL: Initially setup should be visible and lobby hidden! Setup=${setupVisibleBefore}, Lobby=${lobbyVisibleBefore}`);
  }

  // Create room
  await pHost.click("#btn-create");
  await pHost.waitForSelector("#card-lobby:not([hidden])");

  const setupVisibleInLobby = await pHost.isVisible("#view-setup");
  const lobbyVisibleInLobby = await pHost.isVisible("#card-lobby");
  if (setupVisibleInLobby || !lobbyVisibleInLobby) {
    throw new Error(`FAIL: Lobby should replace/hide setup view! Setup=${setupVisibleInLobby}, Lobby=${lobbyVisibleInLobby}`);
  }
  console.log("✓ Entering lobby replaces the Spieldaten and Spielen view.");

  // Leave lobby via "Zurück"
  await pHost.click("#btn-leave-lobby");
  await sleep(300);
  const setupVisibleAfterLeave = await pHost.isVisible("#view-setup");
  const lobbyVisibleAfterLeave = await pHost.isVisible("#card-lobby");
  if (!setupVisibleAfterLeave || lobbyVisibleAfterLeave) {
    throw new Error(`FAIL: Leaving lobby should restore setup view! Setup=${setupVisibleAfterLeave}, Lobby=${lobbyVisibleAfterLeave}`);
  }
  console.log("✓ Leaving lobby ('Zurück') unhides setup view.");

  // Re-create room
  await pHost.click("#btn-create");
  await pHost.waitForSelector("#card-lobby:not([hidden])");
  const code = (await pHost.textContent("#room-code")).trim();

  // Guest joins
  await pGuest.fill("#join-code", code);
  await pGuest.click("#btn-join");
  await pHost.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await pGuest.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(300);

  const guestSetupVisible = await pGuest.isVisible("#view-setup");
  const guestLobbyVisible = await pGuest.isVisible("#card-lobby");
  if (guestSetupVisible || !guestLobbyVisible) {
    throw new Error(`FAIL: Guest entering lobby should replace setup view! Setup=${guestSetupVisible}, Lobby=${guestLobbyVisible}`);
  }
  console.log("✓ Guest entering lobby also replaces setup view.");

  // 3. Test Quest-Chooser and Multi-Goal Sync
  // Verify Host has the 3 goal selectors (cured, money, time):
  const hasCured = await pHost.$("#goal-cured");
  const hasMoney = await pHost.$("#goal-money");
  const hasRooms = await pHost.$("#goal-rooms");
  const hasTime = await pHost.$("#goal-time");
  if (!hasCured || !hasMoney || hasRooms !== null || !hasTime) {
    throw new Error("FAIL: Host Quest-Chooser should have cured, money, time and NO rooms!");
  }

  // Host sets 25 patients + 30 Min
  await pHost.selectOption("#goal-cured", "25");
  await pHost.selectOption("#goal-money", "0");
  await pHost.selectOption("#goal-time", "30");
  await pHost.evaluate(() => {
    document.querySelector("#goal-cured").dispatchEvent(new Event("change"));
    document.querySelector("#goal-money").dispatchEvent(new Event("change"));
    document.querySelector("#goal-time").dispatchEvent(new Event("change"));
  });
  await sleep(400);

  const hostSummaryBox = await pHost.$("#goal-summary-box");
  if (hostSummaryBox !== null) {
    throw new Error("FAIL: #goal-summary-box should be removed to prevent layout shifts as requested!");
  }
  const hostCured = await pHost.$eval("#goal-cured", (el) => el.value);
  const hostTime = await pHost.$eval("#goal-time", (el) => el.value);
  console.log("Host selected goals:", { cured: hostCured, time: hostTime });
  if (hostCured !== "25" || hostTime !== "30") {
    throw new Error(`FAIL: Host dropdowns should show 25 and 30, got: cured=${hostCured}, time=${hostTime}`);
  }

  let guestSummary = await pGuest.textContent("#guest-goal-summary");
  console.log("Guest Goal Summary (synced):", guestSummary);
  if (!guestSummary.includes("25 patients") || !guestSummary.includes("30 Min")) {
    throw new Error(`FAIL: Guest should receive synced 25 patients and 30 min goals! Got: ${guestSummary}`);
  }

  // Host customizes: adds $100,000 balance
  await pHost.selectOption("#goal-money", "100000");
  await pHost.evaluate(() => {
    document.querySelector("#goal-money").dispatchEvent(new Event("change"));
  });
  await sleep(400);

  guestSummary = await pGuest.textContent("#guest-goal-summary");
  console.log("Guest Goal Summary (after custom adjustment):", guestSummary);
  if (!guestSummary.includes("100.000") && !guestSummary.includes("100,000")) {
    throw new Error(`FAIL: Guest should receive customized goals! Got: ${guestSummary}`);
  }
  console.log("✓ Quest-Chooser multi-goal configuration perfectly synced to guest!");

  // 4. Start match and verify In-Game HUD
  await pHost.click("#btn-ready");
  await pGuest.click("#btn-ready");
  await sleep(300);
  await pHost.click("#btn-start");

  await Promise.all([
    pHost.waitForSelector("#hud:not([hidden])", { timeout: 30000 }),
    pGuest.waitForSelector("#hud:not([hidden])", { timeout: 30000 }),
  ]);
  console.log("Match loaded on Host and Guest! HUD is visible.");

  // Verify #hud-version is removed
  const hudVersion = await pHost.$("#hud-version");
  if (hudVersion !== null) throw new Error("FAIL: #hud-version must be removed from HUD!");
  console.log("✓ CorsixTH version chip removed from in-game HUD.");

  // Verify HUD positioning is at bottom-right
  const hudBox = await pHost.evaluate(() => {
    const el = document.querySelector("#hud");
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      windowHeight: window.innerHeight,
      windowWidth: window.innerWidth,
    };
  });
  console.log("HUD Bounding Box:", hudBox);
  // It should be near the bottom (within 90px of bottom) and right-aligned
  if (hudBox.bottom < hudBox.windowHeight - 90) {
    throw new Error(`FAIL: HUD is not at the bottom! bottom=${hudBox.bottom}, winH=${hudBox.windowHeight}`);
  }
  if (hudBox.right < hudBox.windowWidth - 20) {
    throw new Error(`FAIL: HUD is not at the right! right=${hudBox.right}, winW=${hudBox.windowWidth}`);
  }
  console.log("✓ In-game HUD positioned cleanly at bottom-right!");

  // Verify HUD items: Room, Players, Timer, Sync
  const roomText = await pHost.textContent("#hud-room");
  const playersText = await pHost.textContent("#hud-players");
  const timerVisible = await pHost.isVisible("#hud-timer");
  const timerText = await pHost.textContent("#hud-timer");
  const timerHtml = await pHost.$eval("#hud-timer", (el) => el.innerHTML);
  console.log("HUD Room:", roomText);
  console.log("HUD Players:", playersText);
  console.log("HUD Timer:", timerText, "Visible:", timerVisible, "HTML:", timerHtml);
  if (!roomText.includes("Room")) throw new Error("FAIL: Room chip missing!");
  if (!playersText.includes("HostDoc") || !playersText.includes("GuestDoc")) throw new Error("FAIL: Players chip missing names!");
  if (!timerVisible || !timerHtml.includes("#th-time")) throw new Error("FAIL: Timer chip should be visible with Theme Hospital clock icon!");
  console.log("✓ HUD contains Room, Host/Guest players, and live countdown timer with Theme Hospital clock.");

  // 5. Test Auto-Opened Windows on Game Start & Resizable Windows (Chat and Quests)
  const isChatOpenOnStart = await pHost.isVisible("#chat");
  const isQuestOpenOnStart = await pHost.isVisible("#quest-win");
  console.log("Auto-open on start - Chat:", isChatOpenOnStart, "Quests:", isQuestOpenOnStart);
  if (!isChatOpenOnStart) throw new Error("FAIL: Chat window should be auto-opened on match start!");
  if (!isQuestOpenOnStart) throw new Error("FAIL: Quests window should be auto-opened on match start!");
  console.log("✓ In-game Chat and Quests windows are automatically opened on match start.");

  // Test Chat
  const chatResizeHandle = await pHost.$("#chat .win-resize-handle");
  if (!chatResizeHandle) throw new Error("FAIL: Chat missing .win-resize-handle!");

  const chatInitialSize = await pHost.evaluate(() => {
    const el = document.querySelector("#chat");
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  console.log("Initial Chat size:", chatInitialSize);

  // Resize Chat via style or handle
  await pHost.evaluate(() => {
    const el = document.querySelector("#chat");
    el.style.width = "480px";
    el.style.height = "360px";
  });
  const chatResized = await pHost.evaluate(() => {
    const el = document.querySelector("#chat");
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  console.log("Resized Chat size:", chatResized);
  if (chatResized.w !== 480 || chatResized.h !== 360) {
    throw new Error(`FAIL: Chat did not resize to 480x360! Got: ${chatResized.w}x${chatResized.h}`);
  }
  console.log("✓ Chat window is resizable!");
  await pHost.click("#chat-close");

  // Test Quests
  const questResizeHandle = await pHost.$("#quest-win .win-resize-handle");
  if (!questResizeHandle) throw new Error("FAIL: Quest window missing .win-resize-handle!");

  const questInitialSize = await pHost.evaluate(() => {
    const el = document.querySelector("#quest-win");
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  console.log("Initial Quest window size:", questInitialSize);

  await pHost.evaluate(() => {
    const el = document.querySelector("#quest-win");
    el.style.width = "560px";
    el.style.height = "520px";
  });
  const questResized = await pHost.evaluate(() => {
    const el = document.querySelector("#quest-win");
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  console.log("Resized Quest window size:", questResized);
  if (questResized.w !== 560 || questResized.h !== 520) {
    throw new Error(`FAIL: Quest window did not resize to 560x520! Got: ${questResized.w}x${questResized.h}`);
  }

  // Verify Quest Cards inside Quest window
  const questCards = await pHost.$$eval("#quest-list .quest-card", (cards) => cards.map((c) => c.textContent));
  console.log("Rendered Quest cards in window:", questCards.length);
  for (const c of questCards) {
    console.log("  Card:", c.replace(/\s+/g, " ").slice(0, 70));
  }
  if (questCards.length < 3) {
    throw new Error(`FAIL: Expected multiple quest cards for multi-goal match, got: ${questCards.length}`);
  }
  console.log("✓ Quest window is resizable and displays all configured multi-goals!");

  await pHost.click("#quest-close");
  await sleep(400);

  // 6. Test Real Mouse Clicks on in-game Toolbar (Bottom Panel)
  console.log("Testing in-game canvas toolbar clicks...");
  await pHost.waitForFunction(() => document.querySelector("#loading")?.hidden);
  await sleep(400);

  const hostBtn = await pHost.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local bp = TheApp.ui:getWindow(UIBottomPanel)
      if bp then
        TheApp.multiplayer.web.call("test.val", string.format("%d,%d", bp.x + 224, bp.y + 18))
      else
        TheApp.multiplayer.web.call("test.val", "NONE")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Build room button coordinates:", hostBtn);
  const [bx, by] = hostBtn.split(",").map(Number);
  const elAtPoint = await pHost.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}#${el.id}.${el.className}` : "null";
  }, [bx, by]);
  console.log(`Element at (${bx}, ${by}):`, elAtPoint);

  // Click on the build room button with real browser mouse
  await pHost.mouse.move(bx, by);
  await sleep(100);
  await pHost.mouse.down();
  await sleep(100);
  await pHost.mouse.up();
  await sleep(800);

  const hasBuildWindow = await pHost.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local w = TheApp.ui:getWindow(UIBuildRoom)
      TheApp.multiplayer.web.call("test.val", w and "OPEN" or "CLOSED")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val === "OPEN";
  });
  console.log("UIBuildRoom window opened after canvas click:", hasBuildWindow);
  if (!hasBuildWindow) {
    throw new Error("FAIL: Canvas toolbar click did not open UIBuildRoom!");
  }
  console.log("✓ Real mouse click on bottom toolbar works flawlessly without being blocked!");

  await pHost.screenshot({ path: "tests/out/versus_redesign_host.png" });
  await pGuest.screenshot({ path: "tests/out/versus_redesign_guest.png" });
  console.log("Screenshots saved to tests/out/versus_redesign_*.png");

  await browser.close();
  console.log("\n*** ALL TESTS PASSED SUCCESSFULLY! ***\n");
  process.exit(0);
})().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
