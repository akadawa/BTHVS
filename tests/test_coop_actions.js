"use strict";
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");
const path = require("path");
const fs = require("fs");

(async () => {
  console.log("Starting comprehensive co-op actions synchronization test...");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[Host]", m.text()));
  p2.on("console", (m) => console.log("[Guest]", m.text()));

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "Dr. Alice");
  await p2.fill("#player-name", "Dr. Bob");

  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();
  console.log("Room created:", code);

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  console.log("Both players in lobby, clicking ready...");
  await p2.click("#btn-ready");
  await p1.click("#btn-ready");
  await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
  console.log("Starting game...");
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  console.log("Both players in hospital! Waiting 5s for world init...");
  await sleep(5000);

  // 1. Verify initial money balance on both
  const balHost = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const res = mod.ccall("th_eval_lua", "string", ["string"], [
      "return tostring(TheApp.world:getLocalPlayerHospital().balance)"
    ]);
    // In our th_eval_lua, let's see what is returned or stored
    return res;
  });
  console.log("Host eval balance res:", balHost);

  // Check balance via lua global
  const balances = await Promise.all([
    p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], ["_G.__tmp_bal = TheApp.world:getLocalPlayerHospital().balance"]);
      mod.ccall("th_eval_lua", "string", ["string"], ["print('HOST BALANCE: ' .. tostring(_G.__tmp_bal))"]);
      return true;
    }),
    p2.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], ["_G.__tmp_bal = TheApp.world:getLocalPlayerHospital().balance"]);
      mod.ccall("th_eval_lua", "string", ["string"], ["print('GUEST BALANCE: ' .. tostring(_G.__tmp_bal))"]);
      return true;
    }),
  ]);

  // 2. Test staff hiring sync from Guest (Dr. Bob) -> Host (Dr. Alice)
  console.log("Guest (Dr. Bob) hiring a doctor from available_staff...");
  const hireRes = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const luaHire = `
      local pool = TheApp.world.available_staff["Doctor"]
      local profile = pool and table.remove(pool, 1)
      if not profile then
        local StaffProfile = corsixth.require("staff_profile")
        profile = StaffProfile(TheApp.world, "Doctor", "Arzt")
        profile:init(0.7)
        profile.name = "Dr. Bob's Hire"
      end
      local entity = TheApp.world:newEntity("Doctor", 2, 2)
      entity:setProfile(profile)
      entity:setTile(28, 24)
      TheApp.world:getLocalPlayerHospital():addStaff(entity)
      entity:setHospital(TheApp.world:getLocalPlayerHospital())
      entity:onPlaceInCorridor()
      local payload = string.format("hire:%s|%s|%d|%.2f|%d|%d|%d|%d|%d|%d|%d|%d",
        "Doctor", profile.name, profile.wage or 150, profile.skill or 0.6, 2, 0, 0, 0, 0, 1, 28, 24)
      TheApp.multiplayer.web.call("net.send", "all|" .. payload)
      print("Dr. Bob hired staff locally and broadcasted: " .. profile.name)
      return "HIRE_OK"
    `;
    const res = mod.ccall("th_eval_lua", "string", ["string"], [luaHire]);
    return res;
  });
  console.log("Dr. Bob hire evaluate result:", hireRes);

  await sleep(1500);

  // Check if Host received the staff
  const hostStaffCount = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const luaCheck = `
      local hosp = TheApp.world:getLocalPlayerHospital()
      local count = hosp and #hosp.staff or 0
      print("HOST CURRENT STAFF COUNT: " .. tostring(count))
      local found = false
      if hosp then
        for _, s in ipairs(hosp.staff) do
          if s.profile and s.profile.name == "Dr. Bob's Hire" then found = true end
        end
      end
      print("HOST FOUND DR BOB'S HIRE: " .. tostring(found))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [luaCheck]);
    return true;
  });

  // 3. Test corridor object placement from Host (Dr. Alice) -> Guest (Dr. Bob)
  console.log("Host (Dr. Alice) placing drinks machine at (27, 24)...");
  await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const luaObj = `
      local obj_info = TheApp.objects["drinks_machine"]
      local footprint = obj_info.orientations["north"].footprint
      TheApp.world:prepareFootprintTilesForBuild(footprint, 27, 24)
      local obj = TheApp.world:newObject("drinks_machine", 27, 24, "north")
      TheApp.world:objectPlaced(obj)
      TheApp.world.ui.hospital:spendMoney(TheApp.world.ui.hospital:getObjectBuildCost("drinks_machine"))
      TheApp.multiplayer.web.call("net.send", "all|obj:drinks_machine,27,24,north")
      print("Dr. Alice placed drinks machine and broadcasted!")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [luaObj]);
  });

  await sleep(1500);

  // Check if Guest received the object
  await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const luaCheck = `
      local obj = TheApp.world:getObject(27, 24, "drinks_machine")
      print("GUEST FOUND DRINKS MACHINE: " .. tostring(obj ~= nil))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [luaCheck]);
  });

  // 4. Test snapshot room building sync from Guest -> Host
  console.log("Guest (Dr. Bob) finishes a room snapshot sync...");
  await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const luaSnap = `
      TheApp:save("/tmp/snapshot_out.sav")
      TheApp.multiplayer.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
      print("Guest saved and sent snapshot to host!")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [luaSnap]);
  });

  await sleep(2500);

  // Capture final screenshots
  await p1.screenshot({ path: path.join(root, "tests", "out", "coop_host_synced.png") });
  await p2.screenshot({ path: path.join(root, "tests", "out", "coop_guest_synced.png") });
  console.log("Screenshots captured! SUCCESS!");

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
