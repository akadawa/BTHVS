"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Reproducing Receptionist Placement / Hang ===");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[Host]", m.text()));
  p2.on("console", (m) => console.log("[Guest]", m.text()));

  p1.on("pageerror", (err) => console.log("[Host Error]", err));
  p2.on("pageerror", (err) => console.log("[Guest Error]", err));

  await loadDemo(p1);
  await loadDemo(p2);

  await p1.fill("#player-name", "Host");
  await p2.fill("#player-name", "Guest");

  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p2.click("#btn-ready");
  await p1.click("#btn-ready");
  await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(3000);

  console.log("Both players in game. Verifying HUD player role indicators...");
  const hud1 = await p1.textContent("#hud-players");
  const hud2 = await p2.textContent("#hud-players");
  console.log("Host HUD players display:", hud1);
  console.log("Guest HUD players display:", hud2);

  console.log("Now let Guest build reception desk...");
  const guestBuildDesk = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local world = TheApp.world
      local hosp = world:getLocalPlayerHospital()
      -- Try using UIFurnishCorridor or direct placeObject
      local dlg = UIFurnishCorridor(TheApp.ui)
      TheApp.ui:addWindow(dlg)
      -- Find reception desk in dlg.objects
      local desk_idx = nil
      for idx, o in ipairs(dlg.objects) do
        if o.object.id == "reception_desk" then
          desk_idx = idx
          break
        end
      end
      print("Desk index in UIFurnishCorridor:", desk_idx)
      if desk_idx then
        dlg:purchaseItem(desk_idx, 1)
        dlg:confirm()
        -- Now UIPlaceObjects is open on Guest
        local po = TheApp.ui:getWindow(UIPlaceObjects)
        print("UIPlaceObjects open:", tostring(po ~= nil))
        if po then
          po.object_cell_x = 39
          po.object_cell_y = 75
          po:setOrientation("north")
          po:placeObject()
          print("Guest placed desk via UIPlaceObjects!")
          return "DESK_PLACED_UI"
        end
      end
      return "DESK_FAILED"
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Guest desk build result:", guestBuildDesk);
  await sleep(2000);

  // Check if Host has desk
  const hostHasDesk = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local obj = TheApp.world:getObject(39, 75, "reception_desk")
      print("Host has desk at 39,75:", tostring(obj ~= nil))
      return tostring(obj ~= nil)
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Host has desk?", hostHasDesk);

  // Now let Guest hire Receptionist using UIHireStaff -> UIPlaceStaff!
  console.log("Now Guest hiring Receptionist via UIHireStaff...");
  const guestHireRec = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local dlg = UIHireStaff(TheApp.ui)
      TheApp.ui:addWindow(dlg)
      dlg:setCategory("Receptionist")
      print("Available receptionists:", #TheApp.world.available_staff["Receptionist"])
      dlg:hire()
      local ps = TheApp.ui:getWindow(UIPlaceStaff)
      print("UIPlaceStaff open for receptionist:", tostring(ps ~= nil))
      if ps then
        ps.tile_x = 39
        ps.tile_y = 75
        local valid = ps:_isValidStaffPlacement()
        print("Placement valid at (39, 75):", tostring(valid))
        -- Trigger onMouseUp left click
        local res = ps:onMouseUp("left", 0, 0)
        print("Guest ps:onMouseUp result:", tostring(res))
        return "HIRE_DONE"
      end
      return "HIRE_FAILED"
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Guest hire receptionist result:", guestHireRec);

  await sleep(3000);

  // Now check dates and entity counts on both Host and Guest
  const stats = await Promise.all([
    p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      return mod.ccall("th_eval_lua", "string", ["string"], [
        "local d = TheApp.world.game_date; return d:dayOfMonth() .. '.' .. d:monthOfYear() .. ' staff=' .. #TheApp.world:getLocalPlayerHospital().staff"
      ]);
    }),
    p2.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      return mod.ccall("th_eval_lua", "string", ["string"], [
        "local d = TheApp.world.game_date; return d:dayOfMonth() .. '.' .. d:monthOfYear() .. ' staff=' .. #TheApp.world:getLocalPlayerHospital().staff"
      ]);
    }),
  ]);
  console.log("Host date & staff:", stats[0]);
  console.log("Guest date & staff:", stats[1]);

  // Let simulation run for 5 seconds to see if dates advance on both or if one hangs!
  console.log("Running simulation for 5 seconds...");
  await sleep(5000);

  const statsAfter = await Promise.all([
    p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      return mod.ccall("th_eval_lua", "string", ["string"], [
        "local d = TheApp.world.game_date; return d:dayOfMonth() .. '.' .. d:monthOfYear()"
      ]);
    }),
    p2.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      return mod.ccall("th_eval_lua", "string", ["string"], [
        "local d = TheApp.world.game_date; return d:dayOfMonth() .. '.' .. d:monthOfYear()"
      ]);
    }),
  ]);
  console.log("Host date after 5s:", statsAfter[0]);
  console.log("Guest date after 5s:", statsAfter[1]);

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
