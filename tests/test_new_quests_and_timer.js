"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing New Quests (100, 200, 400 cured & 20, 30, 60 min cash) and Canvas Clicks ===");
  const port = await listen();
  const browser = await launch();
  const pHost = await newPage(browser, port, "Host");
  const pGuest = await newPage(browser, port, "Guest");

  pHost.on("console", (m) => console.log("[HostConsole]", m.text()));
  pGuest.on("console", (m) => console.log("[GuestConsole]", m.text()));

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

  // 1. Verify all new quests exist in the select dropdown
  const goals = await pHost.$$eval("#vs-goal option", (opts) => opts.map((o) => o.value));
  console.log("Available goals in dropdown:", goals);

  const requiredGoals = ["cured_100", "cured_200", "cured_400", "time_20m", "time_30m", "time_60m"];
  for (const g of requiredGoals) {
    if (!goals.includes(g)) {
      throw new Error(`FAIL: Goal ${g} is missing from #vs-goal!`);
    }
  }
  console.log("All 6 new goals are present in dropdown!");

  // 2. Test switching to cured_400
  await pHost.selectOption("#vs-goal", "cured_400");
  await pHost.evaluate(() => document.querySelector("#vs-goal").dispatchEvent(new Event("change")));
  await sleep(400);
  let guestGoal = await pGuest.textContent("#guest-goal-val");
  console.log("Guest goal for cured_400:", guestGoal);
  if (!guestGoal.includes("400 Patienten")) {
    throw new Error(`FAIL: Guest did not see 400 Patienten goal! Got: ${guestGoal}`);
  }

  // 3. Test switching to time_20m
  await pHost.selectOption("#vs-goal", "time_20m");
  await pHost.evaluate(() => document.querySelector("#vs-goal").dispatchEvent(new Event("change")));
  await sleep(400);
  guestGoal = await pGuest.textContent("#guest-goal-val");
  console.log("Guest goal for time_20m:", guestGoal);
  if (!guestGoal.includes("20-Minuten")) {
    throw new Error(`FAIL: Guest did not see 20-Minuten goal! Got: ${guestGoal}`);
  }

  // 4. Ready up and start match with time_20m
  await pHost.click("#btn-ready");
  await pGuest.click("#btn-ready");
  await sleep(400);
  await pHost.click("#btn-start");

  await Promise.all([
    pHost.waitForSelector("#canvas:not([hidden])", { timeout: 30000 }),
    pGuest.waitForSelector("#canvas:not([hidden])", { timeout: 30000 }),
  ]);
  await sleep(4000);

  // 5. Verify HUD timer is displayed and ticking on both clients
  const hostTimerVisible = await pHost.evaluate(() => !document.querySelector("#hud-timer").hidden);
  const hostTimerText = await pHost.textContent("#hud-timer");
  console.log("Host HUD Timer visible:", hostTimerVisible, "| Text:", hostTimerText);

  const guestTimerVisible = await pGuest.evaluate(() => !document.querySelector("#hud-timer").hidden);
  const guestTimerText = await pGuest.textContent("#hud-timer");
  console.log("Guest HUD Timer visible:", guestTimerVisible, "| Text:", guestTimerText);

  if (!hostTimerVisible || !hostTimerText.includes("19:") && !hostTimerText.includes("20:")) {
    throw new Error(`FAIL: Host timer not running correctly: ${hostTimerText}`);
  }
  if (!guestTimerVisible || !guestTimerText.includes("19:") && !guestTimerText.includes("20:")) {
    throw new Error(`FAIL: Guest timer not running correctly: ${guestTimerText}`);
  }

  // 6. Test Quest window with Cash comparison
  await pHost.click("#hud-quest-btn");
  await sleep(400);
  const questLeadText = await pHost.textContent("#quest-lead-text");
  console.log("Host Quest Lead Banner:", questLeadText);
  if (!questLeadText.includes("Restzeit")) {
    throw new Error(`FAIL: Lead banner does not show Restzeit! Got: ${questLeadText}`);
  }
  // Close quest window so canvas is fully unobstructed
  await pHost.click("#hud-quest-btn");
  await sleep(400);

  // 7. CRITICAL TEST: Real mouse clicks on Canvas for BOTH Host and Guest
  console.log("Testing REAL browser mouse click on Host canvas (Build Room button)...");
  await pHost.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local orig_down = UI.onMouseDown
      UI.onMouseDown = function(self, button, x, y)
        print(string.format("[Host Lua MouseDown] button=%s, x=%d, y=%d", tostring(button), x, y))
        return orig_down(self, button, x, y)
      end
      local orig_up = UI.onMouseUp
      UI.onMouseUp = function(self, button, x, y)
        print(string.format("[Host Lua MouseUp] button=%s, x=%d, y=%d", tostring(button), x, y))
        return orig_up(self, button, x, y)
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  // Ensure canvas is focused
  await pHost.click("#canvas", { position: { x: 50, y: 50 } });
  await sleep(200);

  // Find button coords on Host
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
  console.log("Host button coords:", hostBtn);
  const [hX, hY] = hostBtn.split(",").map(Number);
  const elAtPoint = await pHost.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}#${el.id}.${el.className}` : "null";
  }, [hX, hY]);
  console.log(`Element at (${hX}, ${hY}):`, elAtPoint);
  await pHost.mouse.move(hX, hY);
  await sleep(200);
  await pHost.mouse.down();
  await sleep(100);
  await pHost.mouse.up();
  await sleep(1000);

  const hostBuildRoomOpen = await pHost.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local br = TheApp.ui:getWindow(UIBuildRoom)
      TheApp.multiplayer.web.call("test.val", br and "OPEN" or "CLOSED")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Host UIBuildRoom after real mouse click:", hostBuildRoomOpen);
  if (hostBuildRoomOpen !== "OPEN") {
    throw new Error("FAIL: Host UIBuildRoom did not open from real canvas mouse click!");
  }

  console.log("Testing REAL browser mouse click on Guest canvas (Build Room button)...");
  await pGuest.click("#canvas", { position: { x: 50, y: 50 } });
  await sleep(200);

  const guestBtn = await pGuest.evaluate(() => {
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
  console.log("Guest button coords:", guestBtn);
  const [gX, gY] = guestBtn.split(",").map(Number);
  await pGuest.mouse.move(gX, gY);
  await sleep(200);
  await pGuest.mouse.down();
  await sleep(100);
  await pGuest.mouse.up();
  await sleep(1000);

  const guestBuildRoomOpen = await pGuest.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local br = TheApp.ui:getWindow(UIBuildRoom)
      TheApp.multiplayer.web.call("test.val", br and "OPEN" or "CLOSED")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Guest UIBuildRoom after real mouse click:", guestBuildRoomOpen);
  if (guestBuildRoomOpen !== "OPEN") {
    throw new Error("FAIL: Guest UIBuildRoom did not open from real canvas mouse click!");
  }

  // 8. Test timed win condition trigger
  console.log("Testing timed match win condition when time expires...");
  await pHost.evaluate(() => {
    // Fast-forward startTime by 21 minutes
    window.__bth.state.vs.startTime = Date.now() - (21 * 60 * 1000);
    // Give host more cash
    window.__bth.state.vs.myStats.bal = 75000;
    window.__bth.state.vs.oppStats.bal = 60000;
    window.__bth.checkWinConditions();
  });
  await sleep(600);

  const vicModalVisible = await pHost.evaluate(() => !document.querySelector("#victory-modal").hidden);
  const vicTitle = await pHost.textContent("#vic-title");
  const vicDesc = await pHost.textContent("#vic-desc");
  console.log("Victory Modal visible:", vicModalVisible, "| Title:", vicTitle);
  console.log("Victory Description:", vicDesc);

  if (!vicModalVisible || !vicDesc.includes("20 Minuten") || !vicDesc.includes("75.000")) {
    throw new Error(`FAIL: Timed victory modal not showing correct text: ${vicDesc}`);
  }

  await pHost.screenshot({ path: "tests/out/timed_match_win.png" });
  console.log("=== ALL TESTS PASSED SUCCESSFULLY! ===");

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
