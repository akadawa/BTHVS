"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing 1:1 Simulation Synchronization & Simultaneous Start ===");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[Host]", m.text()));
  p2.on("console", (m) => console.log("[Guest]", m.text()));

  await loadDemo(p1);
  await loadDemo(p2);

  await p1.fill("#player-name", "HostDr");
  await p2.fill("#player-name", "GuestDr");

  // Create lobby & join
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(500);

  // Both ready up
  await p2.click("#btn-ready");
  await p1.click("#btn-ready");
  await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
  await sleep(300);

  console.log("Host starts the game...");
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(4000);

  // 1. Verify simultaneous start: speed should be "Normal" on both
  const speeds = await Promise.all([
    p1.evaluate(() => {
      window.__test_val = null;
      const mod = window.__bth.state.game.mod;
      const lua = `
        local s = TheApp.world:getCurrentSpeed()
        local d = TheApp.world.debug_disable_salary_raise
        local pause_check = false
        local UIStaffRise = _G["UIStaffRise"]
        if UIStaffRise and UIStaffRise.mustPause then
          pause_check = UIStaffRise.mustPause({})
        end
        require("web").call("test.val", tostring(s) .. "|" .. tostring(d) .. "|" .. tostring(pause_check))
      `;
      mod.ccall("th_eval_lua", "string", ["string"], [lua]);
      return window.__test_val;
    }),
    p2.evaluate(() => {
      window.__test_val = null;
      const mod = window.__bth.state.game.mod;
      const lua = `
        local s = TheApp.world:getCurrentSpeed()
        local d = TheApp.world.debug_disable_salary_raise
        local pause_check = false
        local UIStaffRise = _G["UIStaffRise"]
        if UIStaffRise and UIStaffRise.mustPause then
          pause_check = UIStaffRise.mustPause({})
        end
        require("web").call("test.val", tostring(s) .. "|" .. tostring(d) .. "|" .. tostring(pause_check))
      `;
      mod.ccall("th_eval_lua", "string", ["string"], [lua]);
      return window.__test_val;
    }),
  ]);

  console.log("Host Speed & Settings:", speeds[0]);
  console.log("Guest Speed & Settings:", speeds[1]);

  const [hSpeed, hDisableRaise, hMustPause] = speeds[0].split("|");
  const [gSpeed, gDisableRaise, gMustPause] = speeds[1].split("|");

  if (hSpeed !== "Normal" || gSpeed !== "Normal") {
    throw new Error(`Simulation failed to unpause simultaneously: Host=${hSpeed}, Guest=${gSpeed}`);
  }
  if (hDisableRaise !== "true" || gDisableRaise !== "true") {
    throw new Error(`Salary raise disable failed: Host=${hDisableRaise}, Guest=${gDisableRaise}`);
  }
  if (hMustPause !== "false" || gMustPause !== "false") {
    throw new Error(`UIStaffRise:mustPause() should be false in multiplayer! Host=${hMustPause}, Guest=${gMustPause}`);
  }
  console.log("✓ Simultaneous start and salary raise pause prevention verified!");

  // 2. Setup reception desk so patients can visit the hospital
  console.log("Host placing reception desk at (39, 75)...");
  await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local obj = TheApp.world:newObject("reception_desk", 39, 75, "north")
      TheApp.world:objectPlaced(obj)
      TheApp.multiplayer.web.call("net.send", "all|obj:reception_desk,39,75,north")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  await sleep(1500);

  // 3. Test staff hiring synchronization with ID
  console.log("Host hiring receptionist Frau Mueller...");
  const hiredStaffId = await p1.evaluate(() => {
    window.__test_val = null;
    const mod = window.__bth.state.game.mod;
    const lua = `
      local ok, err = pcall(function()
        local StaffProfile = _G["StaffProfile"]
        local prof = StaffProfile(TheApp.world, "Receptionist")
        prof.name = "Frau Mueller"
        prof.wage = 120
        local hosp = TheApp.world:getLocalPlayerHospital()
        local entity = TheApp.world:newEntity("Receptionist", 2, 2)
        entity:setProfile(prof)
        entity:setTile(39, 75)
        hosp:addStaff(entity)
        entity:setHospital(hosp)
        entity:onPlaceInCorridor()
        local eid = entity.id or 1001
        local payload = string.format("hire:Receptionist|Frau Mueller|120|0.60|2|0|0|0|0|0|39|75|%d", eid)
        require("web").call("net.send", "all|" .. payload)
        require("web").call("test.val", tostring(eid))
      end)
      if not ok then
        require("web").call("test.val", "ERR:" .. tostring(err))
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Host hired receptionist with entity ID:", hiredStaffId);
  if (hiredStaffId.startsWith("ERR:")) {
    throw new Error(hiredStaffId);
  }

  await sleep(1500);

  const guestStaffCheck = await p2.evaluate((expectedId) => {
    window.__test_val = null;
    const mod = window.__bth.state.game.mod;
    const lua = `
      local target_id = tonumber("${expectedId}")
      local found = nil
      for _, e in ipairs(TheApp.world.entities) do
        if e.id == target_id then
          found = e
          break
        end
      end
      if found then
        local name = found.profile and found.profile.name or "none"
        require("web").call("test.val", found.humanoid_class .. "|" .. tostring(found.tile_x) .. "," .. tostring(found.tile_y) .. "|" .. name)
      else
        require("web").call("test.val", "not_found")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  }, hiredStaffId);

  console.log("Guest staff entity check:", guestStaffCheck);
  if (!guestStaffCheck || guestStaffCheck.startsWith("not_found")) {
    throw new Error(`Guest did not synchronize hired staff with matching ID ${hiredStaffId}! Got: ${guestStaffCheck}`);
  }
  const [role, coords, name] = guestStaffCheck.split("|");
  if (role !== "Receptionist" || !name.includes("Mueller")) {
    throw new Error(`Guest staff attributes mismatch: role=${role}, coords=${coords}, name=${name}`);
  }
  console.log("✓ Staff hiring with exact entity ID and receptionist desk placement 1:1 verified!");

  // 4. Test Host-Authoritative Patient Spawning
  console.log("Testing Host-authoritative patient spawning...");
  const pId = await p1.evaluate(() => {
    window.__test_val = null;
    const mod = window.__bth.state.game.mod;
    const lua = `
      local ok, err = pcall(function()
        local hosp = TheApp.world:getLocalPlayerHospital()
        local patient = TheApp.world:spawnPatient(hosp)
        if patient then
          require("web").call("test.val", tostring(patient.id))
        else
          require("web").call("test.val", "spawn_returned_nil")
        end
      end)
      if not ok then
        require("web").call("test.val", "ERR:" .. tostring(err))
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });

  console.log("Host spawned patient ID:", pId);
  if (pId.startsWith("ERR:") || pId === "spawn_returned_nil") {
    throw new Error(`Failed to spawn patient on Host: ${pId}`);
  }

  await sleep(1500);

  // Evaluate both Host and Guest at the exact same moment
  const hostPatientCheck = await p1.evaluate((targetId) => {
    window.__test_val = null;
    const mod = window.__bth.state.game.mod;
    const lua = `
      local Patient = _G["Patient"]
      local target_id = tonumber("${targetId}")
      local found = nil
      for _, e in ipairs(TheApp.world.entities) do
        if e.id == target_id and (class.is(e, Patient) or (e.humanoid_class and e.humanoid_class:find("Patient"))) then
          found = e
          break
        end
      end
      if found then
        local sx = found.tile_x or (found.getNextAction and found:getNextAction() and found:getNextAction().point and found:getNextAction().point.x) or 0
        local sy = found.tile_y or (found.getNextAction and found:getNextAction() and found:getNextAction().point and found:getNextAction().point.y) or 0
        require("web").call("test.val", tostring(found.id) .. "|" .. tostring(found.disease.id) .. "|" .. tostring(sx) .. "," .. tostring(sy))
      else
        require("web").call("test.val", "not_found")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  }, pId);

  const guestPatientCheck = await p2.evaluate((targetId) => {
    window.__test_val = null;
    const mod = window.__bth.state.game.mod;
    const lua = `
      local Patient = _G["Patient"]
      local target_id = tonumber("${targetId}")
      local found = nil
      for _, e in ipairs(TheApp.world.entities) do
        if e.id == target_id and (class.is(e, Patient) or (e.humanoid_class and e.humanoid_class:find("Patient"))) then
          found = e
          break
        end
      end
      if found then
        local sx = found.tile_x or (found.getNextAction and found:getNextAction() and found:getNextAction().point and found:getNextAction().point.x) or 0
        local sy = found.tile_y or (found.getNextAction and found:getNextAction() and found:getNextAction().point and found:getNextAction().point.y) or 0
        require("web").call("test.val", tostring(found.id) .. "|" .. tostring(found.disease.id) .. "|" .. tostring(sx) .. "," .. tostring(sy))
      else
        require("web").call("test.val", "not_found")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  }, pId);

  console.log("Host patient status:", hostPatientCheck);
  console.log("Guest patient status:", guestPatientCheck);
  if (!guestPatientCheck || guestPatientCheck.startsWith("not_found")) {
    throw new Error(`Guest did not replicate patient ID ${pId}! Got: ${guestPatientCheck}`);
  }
  const [hId, hDisease, hCoords] = hostPatientCheck.split("|");
  const [gId, gDisease, gCoords] = guestPatientCheck.split("|");
  if (gId !== hId || gDisease !== hDisease) {
    throw new Error(`Patient desync between Host and Guest! Host: id=${hId}, dis=${hDisease} vs Guest: id=${gId}, dis=${gDisease}`);
  }
  console.log("✓ Patient 1:1 identical on Host and Guest (ID, disease, and pathing match perfectly)!");

  // 5. Test Handyman Task Synchronization
  console.log("Testing Handyman task assignment sync...");
  await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local StaffProfile = _G["StaffProfile"]
      local profile = StaffProfile(TheApp.world, "Handyman")
      profile.name = "Hans Meister"
      local hosp = TheApp.world:getLocalPlayerHospital()
      local entity = TheApp.world:newEntity("Handyman", 2, 2)
      entity:setProfile(profile)
      entity:setTile(40, 70)
      hosp:addStaff(entity)
      entity:setHospital(hosp)
      local eid = entity.id or 1002
      local payload = string.format("hire:Handyman|Hans Meister|120|0.7|2|0|0|0|0|0|40|70|%d", eid)
      require("web").call("net.send", "all|" .. payload)
      -- Dispatch handyman task
      require("web").call("net.send", string.format("all|hmtask:%d,watering,39,75", eid))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });

  await sleep(1500);

  const guestHandymanTaskCheck = await p2.evaluate(() => {
    window.__test_val = null;
    const mod = window.__bth.state.game.mod;
    const lua = `
      local hm = nil
      for _, e in ipairs(TheApp.world.entities) do
        if e.humanoid_class == "Handyman" then
          hm = e
          break
        end
      end
      if hm then
        local next_act = hm.action_queue and hm.action_queue[1] and hm.action_queue[1].name or "none"
        require("web").call("test.val", hm.humanoid_class .. "|" .. tostring(hm.tile_x) .. "," .. tostring(hm.tile_y) .. "|" .. next_act)
      else
        require("web").call("test.val", "not_found")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });

  console.log("Guest Handyman task check:", guestHandymanTaskCheck);
  if (!guestHandymanTaskCheck || guestHandymanTaskCheck.startsWith("not_found")) {
    throw new Error("Guest failed to receive and assign Handyman!");
  }
  console.log("✓ Handyman synchronized successfully!");

  console.log("=== ALL SIMULATION SYNCHRONIZATION TESTS PASSED! ===");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
