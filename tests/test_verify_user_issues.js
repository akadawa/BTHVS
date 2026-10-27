"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Verifying Fixes for User Reported Issues ===");
  const port = await listen();
  const browser = await launch();
  const pHost = await newPage(browser, port, "Host");
  const pGuest = await newPage(browser, port, "Guest");

  await Promise.all([loadDemo(pHost), loadDemo(pGuest)]);
  await pHost.fill("#player-name", "Doc-Host");
  await pGuest.fill("#player-name", "Doc-Guest");

  // Host creates room
  await pHost.click("#btn-create");
  await pHost.waitForSelector("#card-lobby:not([hidden])");
  const code = (await pHost.textContent("#room-code")).trim();

  // Guest joins
  await pGuest.fill("#join-code", code);
  await pGuest.click("#btn-join");
  await pHost.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await pGuest.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(400);

  // 1. Verify Issue 2: Level Selection
  console.log("1. Checking level selection in lobby...");
  const levelOptions = await pHost.$$eval("#mp-level option", (opts) =>
    opts.map((o) => ({ id: o.value, text: o.textContent, disabled: o.disabled }))
  );
  console.log("Found levels:", levelOptions.map(l => `${l.id} (disabled: ${l.disabled})`).join(", "));
  const anyDisabled = levelOptions.some((l) => l.disabled);
  if (anyDisabled) {
    throw new Error("FAIL: Custom levels are still disabled in lobby!");
  }
  const hasAvatar = levelOptions.some((l) => l.id === "avatar");
  if (!hasAvatar) {
    throw new Error("FAIL: Avatar level not found in list!");
  }

  // Host selects custom level 'avatar'
  console.log("Host selecting 'avatar' map...");
  await pHost.selectOption("#mp-level", "avatar");
  await pHost.evaluate(() => document.querySelector("#mp-level").dispatchEvent(new Event("change")));
  await sleep(400);

  const guestLevelText = await pGuest.textContent("#guest-level-val");
  console.log("Guest sees selected map:", guestLevelText);
  if (!guestLevelText.includes("Avatar")) {
    throw new Error(`FAIL: Guest did not receive avatar level update: ${guestLevelText}`);
  }

  // Ready up and start
  console.log("2. Starting match with 'avatar' map...");
  await pHost.click("#btn-ready");
  await pGuest.click("#btn-ready");
  await sleep(400);
  await pHost.click("#btn-start");

  // Wait for game engines to load
  await Promise.all([
    pHost.waitForSelector("#canvas:not([hidden])", { timeout: 30000 }),
    pGuest.waitForSelector("#canvas:not([hidden])", { timeout: 30000 }),
  ]);
  await sleep(4000);

  // 2. Verify Issue 1: No blocking modal UIInformation window
  console.log("3. Checking modal UIInformation windows...");
  const hostWindows = await pHost.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local info = TheApp.ui:getWindow(UIInformation)
      TheApp.multiplayer.web.call("test.val", info and "MODAL_INFO_PRESENT" or "NO_MODAL_INFO")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  const guestWindows = await pGuest.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local info = TheApp.ui:getWindow(UIInformation)
      TheApp.multiplayer.web.call("test.val", info and "MODAL_INFO_PRESENT" or "NO_MODAL_INFO")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Host info window:", hostWindows, "| Guest info window:", guestWindows);

  if (hostWindows === "MODAL_INFO_PRESENT" || guestWindows === "MODAL_INFO_PRESENT") {
    throw new Error("FAIL: Modal information window is still present on start!");
  }

  // 3. Verify Issue 3: user_actions_allowed and Raum bauen (Build Room)
  console.log("4. Checking user_actions_allowed and Build Room functionality...");
  const hostActionsAllowed = await pHost.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local allowed = TheApp.world and TheApp.world.user_actions_allowed
      -- Try opening build room dialog
      local bottom = TheApp.ui:getWindow(UIBottomPanel)
      if bottom then
        bottom:dialogBuildRoom()
      end
      local buildRoom = TheApp.ui:getWindow(UIBuildRoom)
      TheApp.multiplayer.web.call("test.val", string.format("allowed=%s,buildRoomOpen=%s", tostring(allowed), tostring(buildRoom ~= nil)))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Host check:", hostActionsAllowed);

  const guestActionsAllowed = await pGuest.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local allowed = TheApp.world and TheApp.world.user_actions_allowed
      -- Try opening build room dialog
      local bottom = TheApp.ui:getWindow(UIBottomPanel)
      if bottom then
        bottom:dialogBuildRoom()
      end
      local buildRoom = TheApp.ui:getWindow(UIBuildRoom)
      TheApp.multiplayer.web.call("test.val", string.format("allowed=%s,buildRoomOpen=%s", tostring(allowed), tostring(buildRoom ~= nil)))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Guest check:", guestActionsAllowed);

  if (!hostActionsAllowed.includes("allowed=true,buildRoomOpen=true")) {
    throw new Error(`FAIL on Host: ${hostActionsAllowed}`);
  }
  if (!guestActionsAllowed.includes("allowed=true,buildRoomOpen=true")) {
    throw new Error(`FAIL on Guest: ${guestActionsAllowed}`);
  }

  await pHost.screenshot({ path: "tests/out/user_fix_host.png" });
  await pGuest.screenshot({ path: "tests/out/user_fix_guest.png" });
  console.log("=== ALL USER ISSUES VERIFIED FIXED SUCCESSFULLY! ===");

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
