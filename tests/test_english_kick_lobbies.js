"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing English Translation, Public Lobbies, 5-Player Max, Kick, and Full-Version Requirement ===");
  const port = await listen();
  const browser = await launch();
  const pHost = await newPage(browser, port, "Host");
  const pGuest = await newPage(browser, port, "Guest");

  pHost.on("console", (m) => console.log("[HostConsole]", m.text()));
  pGuest.on("console", (m) => console.log("[GuestConsole]", m.text()));

  // 1. Verify Demo Rejection when __ALLOW_DEMO_FOR_TESTS is false
  console.log("1. Testing Demo Rejection prompt...");
  const demoRejected = await pHost.evaluate(async () => {
    window.__ALLOW_DEMO_FOR_TESTS = false;
    try {
      const mockEntries = [
        ["DATA/VSPR-0.TAB", new Uint8Array([1, 2, 3])],
        ["DATA/VBLK-0.DAT", new Uint8Array([1, 2, 3])],
        ["DATA/VSPR-0.DAT", new Uint8Array([1, 2, 3])],
        ["QDATA/FONT00V.DAT", new Uint8Array([1, 2, 3])],
        ["DATAM/DEMO.DAT", new Uint8Array([1, 2, 3])],
      ];
      window.__bth.normaliseEntries(mockEntries, "DEMO_TEST");
      return { rejected: false };
    } catch (e) {
      return { rejected: true, message: e.message };
    }
  });
  console.log("Demo rejection result:", demoRejected);
  if (!demoRejected.rejected || !demoRejected.message.includes("Demo version detected! Only the full version")) {
    throw new Error(`FAIL: Demo version was not properly rejected with prompt! Got: ${JSON.stringify(demoRejected)}`);
  }
  console.log("✓ Demo version is cleanly rejected with a prompt to acquire the full game.");

  // Allow for remaining tests
  await Promise.all([loadDemo(pHost), loadDemo(pGuest)]);
  await pHost.fill("#player-name", "HostPlayer");
  await pGuest.fill("#player-name", "GuestPlayer");

  // 2. Verify English UI elements & absence of Presets and Goal-Rooms
  console.log("2. Checking English UI & Removed Presets / Rooms Goal...");
  const presetBar = await pHost.$(".quest-preset-bar");
  if (presetBar !== null) throw new Error("FAIL: .quest-preset-bar (Schnellwahl) must be removed!");

  const goalRooms = await pHost.$("#goal-rooms");
  if (goalRooms !== null) throw new Error("FAIL: #goal-rooms (Räume & Personal) must be removed!");

  const hasCured = await pHost.$("#goal-cured");
  const hasMoney = await pHost.$("#goal-money");
  const hasTime = await pHost.$("#goal-time");
  if (!hasCured || !hasMoney || !hasTime) throw new Error("FAIL: Expected cured, money, and time goals!");

  // Verify Max Players selector supports 5
  const maxPlayersOptions = await pHost.$$eval("#max-players option", (opts) => opts.map((o) => o.value));
  console.log("Max players options:", maxPlayersOptions);
  if (!maxPlayersOptions.includes("5")) throw new Error("FAIL: Max players selector should support 5 players!");

  // 3. Verify Public Lobby Creation & Public Lobby Browser
  console.log("3. Testing Public Lobby listing in overview...");
  await pHost.selectOption("#max-players", "5");
  const isPublicCheckbox = await pHost.isChecked("#create-public");
  if (!isPublicCheckbox) throw new Error("FAIL: #create-public should be checked by default!");

  await pHost.click("#btn-create");
  await pHost.waitForSelector("#card-lobby:not([hidden])");
  const roomCode = (await pHost.textContent("#room-code")).trim();
  console.log("Created Room Code:", roomCode);

  // Check public lobby endpoint
  await sleep(400);
  const lobbiesRes = await pGuest.evaluate(async () => {
    const res = await fetch("/api/lobbies");
    return res.json();
  });
  console.log("Fetched lobbies from /api/lobbies:", lobbiesRes);
  const foundLobby = (lobbiesRes.lobbies || []).find((l) => l.code === roomCode);
  if (!foundLobby) throw new Error(`FAIL: Created public room ${roomCode} not found in /api/lobbies!`);
  if (foundLobby.max !== 5) throw new Error(`FAIL: Expected max 5 players, got ${foundLobby.max}`);
  console.log("✓ Public lobby registered with max 5 players on server.");

  // Test Refresh Public Lobbies UI on Guest
  await pGuest.click("#btn-refresh-lobbies");
  await pGuest.waitForFunction(() => {
    const badges = [...document.querySelectorAll(".room-code-badge")].map((el) => el.textContent.trim());
    return badges.length > 0;
  });
  const guestLobbyCodes = await pGuest.$$eval(".room-code-badge", (els) => els.map((e) => e.textContent.trim()));
  console.log("Lobbies listed in Guest UI:", guestLobbyCodes);
  if (!guestLobbyCodes.includes(roomCode)) {
    throw new Error(`FAIL: Guest public lobby list does not contain room ${roomCode}!`);
  }

  // Join via public lobbies table "Join" button
  console.log("Joining via Public Lobby list 'Join' button...");
  await pGuest.click(`.btn-join-lobby[data-code="${roomCode}"]`);
  await pHost.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await pGuest.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  console.log("✓ Guest successfully joined via public lobby list button!");

  // 4. Verify Lobby Action Buttons (order, text, no icons, equal size)
  console.log("4. Checking Lobby Action Buttons...");
  const btnOrderAndText = await pHost.evaluate(() => {
    const row = document.querySelector(".lobby-actions-row");
    const btns = [...row.querySelectorAll("button:not([hidden])")];
    return btns.map((b) => ({
      id: b.id,
      text: b.textContent.trim(),
      width: b.offsetWidth,
    }));
  });
  console.log("Host Action Buttons:", btnOrderAndText);

  // Order must be: #btn-start, #btn-ready, #btn-leave-lobby
  if (btnOrderAndText[0].id !== "btn-start" || btnOrderAndText[1].id !== "btn-ready" || btnOrderAndText[2].id !== "btn-leave-lobby") {
    throw new Error(`FAIL: Button order should be Start, Ready, Leave! Got: ${JSON.stringify(btnOrderAndText)}`);
  }

  // Check texts without symbols
  if (btnOrderAndText[0].text !== "Start Game") {
    throw new Error(`FAIL: Start button text should be 'Start Game', got: '${btnOrderAndText[0].text}'`);
  }
  if (btnOrderAndText[1].text !== "Ready") {
    throw new Error(`FAIL: Ready button text should be 'Ready', got: '${btnOrderAndText[1].text}'`);
  }
  if (btnOrderAndText[2].text !== "Leave Room") {
    throw new Error(`FAIL: Leave button text should be 'Leave Room', got: '${btnOrderAndText[2].text}'`);
  }

  // Check equal size (width diff within 2px)
  const w0 = btnOrderAndText[0].width;
  const w1 = btnOrderAndText[1].width;
  const w2 = btnOrderAndText[2].width;
  if (Math.abs(w0 - w1) > 2 || Math.abs(w1 - w2) > 2) {
    throw new Error(`FAIL: Lobby action buttons should have equal size! Got widths: ${w0}, ${w1}, ${w2}`);
  }
  console.log("✓ Action buttons order: Start Game (left), Ready (middle), Leave Room (right) with equal size and NO symbols.");

  // Check ready toggle text without symbols
  await pHost.click("#btn-ready");
  await pHost.waitForFunction(() => document.querySelector("#btn-ready")?.textContent?.includes("cancel"));
  const readyActiveText = (await pHost.textContent("#btn-ready")).trim();
  console.log("Host Ready active text:", readyActiveText);
  if (!readyActiveText.includes("Ready (Click to cancel)") || readyActiveText.includes("✓")) {
    throw new Error(`FAIL: Ready active text should be 'Ready (Click to cancel)' without symbols! Got: ${readyActiveText}`);
  }

  // 5. Verify Host Kick functionality
  console.log("5. Testing Host Kick feature...");
  // Host should see a kick button for Guest
  const kickBtn = await pHost.$(".btn-kick");
  if (!kickBtn) throw new Error("FAIL: Host should see a Kick button for Guest!");

  // Intercept confirm dialog to auto-accept
  await pHost.evaluate(() => { window.confirm = () => true; });

  // Click Kick
  await pHost.click(".btn-kick");
  await sleep(500);

  // Guest should have returned to setup view
  const guestSetupAfterKick = await pGuest.isVisible("#view-setup");
  const guestLobbyAfterKick = await pGuest.isVisible("#card-lobby");
  console.log(`Guest visibility after kick: Setup=${guestSetupAfterKick}, Lobby=${guestLobbyAfterKick}`);
  if (!guestSetupAfterKick || guestLobbyAfterKick) {
    throw new Error(`FAIL: Kicked guest should return to setup view! Setup=${guestSetupAfterKick}, Lobby=${guestLobbyAfterKick}`);
  }

  // Guest menu error message
  const guestErrorMsg = await pGuest.textContent("#menu-error");
  console.log("Guest error message after kick:", guestErrorMsg);
  if (!guestErrorMsg.includes("kicked")) {
    throw new Error(`FAIL: Guest should see a message indicating they were kicked! Got: ${guestErrorMsg}`);
  }

  // Host should now see 1 player
  const hostPlayerCount = await pHost.$$eval("#player-list li", (lis) => lis.length);
  console.log("Host player list count after kick:", hostPlayerCount);
  if (hostPlayerCount !== 1) {
    throw new Error(`FAIL: Host player list should have 1 player after kick, got ${hostPlayerCount}`);
  }
  console.log("✓ Host successfully kicked guest; guest returned to menu setup view with notification.");

  await browser.close();
  console.log("\n*** ALL ENGLISH, PUBLIC LOBBIES, KICK, AND 5-PLAYER TESTS PASSED! ***\n");
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
