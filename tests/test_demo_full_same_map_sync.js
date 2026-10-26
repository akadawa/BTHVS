"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Demo + Full Map Identity and Room Synchronization ===");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "FullHost");
  const p2 = await newPage(browser, port, "DemoGuest");

  p1.on("console", (m) => console.log("[FullHost]", m.text()));
  p2.on("console", (m) => console.log("[DemoGuest]", m.text()));

  // 1. FullHost loads files (simulate full game by removing demo.dat marker)
  await loadDemo(p1);
  await p1.evaluate(() => {
    const s = window.__bth.state;
    s.data.demo = false;
    s.data.files = s.data.files.filter(([p]) => !p.toLowerCase().includes("demo.dat"));
    // Add dummy level2 file so CorsixTH sees full installation
    s.data.files.push(["LEVELS/LEVEL.L2", new Uint8Array([0, 1, 2])]);
  });

  // 2. DemoGuest loads standard Demo files
  await loadDemo(p2);

  await p1.fill("#player-name", "FullHostDoc");
  await p2.fill("#player-name", "DemoGuestDoc");

  // 3. Create room and join
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(600);

  // 4. Verify mode & level in lobby
  console.log("Setting mode to Endlos-Krankenhaus (freebuild) and level to demo...");
  await p1.selectOption("#mp-mode", "freebuild");
  await sleep(400);

  // Both ready up
  await p2.click("#btn-ready");
  await p1.click("#btn-ready");
  await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
  await sleep(400);

  // 5. Host starts game
  console.log("Starting game...");
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(4000);

  // 6. Check Map Identity on both
  const p1MapInfo = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local m = TheApp.map
      local w = m and m.width or 0
      local h = m and m.height or 0
      local name = m and m.level_name or "none"
      local is_demo = tostring(TheApp.using_demo_files)
      require("web").call("test.val", w .. "x" .. h .. "|" .. name .. "|" .. is_demo)
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });

  const p2MapInfo = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local m = TheApp.map
      local w = m and m.width or 0
      local h = m and m.height or 0
      local name = m and m.level_name or "none"
      local is_demo = tostring(TheApp.using_demo_files)
      require("web").call("test.val", w .. "x" .. h .. "|" .. name .. "|" .. is_demo)
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });

  console.log("FullHost Map Info:", p1MapInfo);
  console.log("DemoGuest Map Info:", p2MapInfo);

  const [p1Size, p1Name, p1IsDemo] = p1MapInfo.split("|");
  const [p2Size, p2Name, p2IsDemo] = p2MapInfo.split("|");

  if (p1Size !== p2Size || p1Size !== "128x128") {
    throw new Error(`Map size mismatch! Host=${p1Size}, Guest=${p2Size}`);
  }
  if (p1Name !== p2Name) {
    throw new Error(`Map name mismatch! Host=${p1Name}, Guest=${p2Name}`);
  }
  console.log("MAP SIZE AND NAME ARE 100% IDENTICAL ACROSS FULL AND DEMO!");

  // 7. DemoGuest builds a reception desk in the corridor
  console.log("DemoGuest placing reception desk...");
  await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local m = TheApp.map
      local cam_x, cam_y = m.th:getCameraTile(1)
      local tx, ty
      for x = cam_x - 10, cam_x + 10 do
        for y = cam_y - 10, cam_y + 10 do
          local flags = m.th:getCellFlags(x, y)
          if flags.hospital and flags.buildable and flags.passable and flags.roomId == 0 then
            tx, ty = x, y
            break
          end
        end
        if tx then break end
      end
      if not tx then tx, ty = 48, 85 end
      
      local obj_info = TheApp.objects["reception_desk"]
      local footprint = obj_info.orientations["north"].footprint
      TheApp.world:prepareFootprintTilesForBuild(footprint, tx, ty)
      local obj = TheApp.world:newObject("reception_desk", tx, ty, "north")
      TheApp.world:objectPlaced(obj)
      TheApp.world.ui.hospital:spendMoney(TheApp.world.ui.hospital:getObjectBuildCost("reception_desk"))
      TheApp.multiplayer.web.call("net.send", string.format("all|obj:reception_desk,%d,%d,north", tx, ty))
      print(string.format("DemoGuest placed reception desk at (%d,%d)", tx, ty))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  await sleep(2000);

  // Verify FullHost received the reception desk
  const p1HasDesk = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local obj = TheApp.world:getObject(39, 75, "reception_desk")
      require("web").call("test.val", tostring(obj ~= nil))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("FullHost desk found at (39, 75):", p1HasDesk);
  if (p1HasDesk !== "true") {
    throw new Error("FullHost did not receive the reception desk placed by DemoGuest!");
  }

  // 8. DemoGuest hires a receptionist
  console.log("DemoGuest hiring receptionist...");
  await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local prof = StaffProfile(TheApp.world, "Receptionist")
      prof.name = "Frau Mueller"
      prof.wage = 120
      local entity = TheApp.world:newEntity("Receptionist", 2, 2)
      entity:setProfile(prof)
      entity:setTile(39, 75)
      local hosp = TheApp.world:getLocalPlayerHospital()
      hosp:addStaff(entity)
      entity:setHospital(hosp)
      entity:onPlaceInCorridor()
      local payload = string.format("hire:%s|%s|%d|%.2f|%d|%d|%d|%d|%d|%d|%d|%d",
        "Receptionist", prof.name, prof.wage, 0.6, 2, 0, 0, 0, 0, 0, 39, 75)
      TheApp.multiplayer.web.call("net.send", "all|" .. payload)
      print("DemoGuest hired receptionist Frau Mueller at (39, 75)")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  await sleep(2000);

  // Verify FullHost has receptionist
  const p1Staff = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local hosp = TheApp.world:getLocalPlayerHospital()
      local count = hosp and #hosp.staff or 0
      local s = hosp and hosp.staff[1]
      local out = count .. "|" .. (s and s.humanoid_class or "none") .. "|" .. (s and s.profile and s.profile.name or "none")
      require("web").call("test.val", out)
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("FullHost staff info:", p1Staff);
  if (!p1Staff.startsWith("1|Receptionist|Frau Mueller")) {
    throw new Error("Receptionist was not replicated properly to FullHost: " + p1Staff);
  }

  // 9. DemoGuest builds a room (General Diagnosis / Allgemeinmedizin)
  console.log("DemoGuest building GP Office (Allgemeinmedizin)...");
  const guestBuildRes = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local world = TheApp.world
      local hosp = world:getLocalPlayerHospital()
      
      local room_info = TheApp.rooms["gp"]
      local door = world:newObject("door", 44, 82, "north")
      local room = world:newRoom(42, 80, 4, 4, room_info, door)
      world:objectPlaced(door)
      hosp:spendMoney(1500, "GP Room")
      print("DemoGuest created room: " .. tostring(room) .. " (total rooms: " .. tostring(#world.rooms) .. ")")
      
      local desk = world:newObject("desk", 43, 81, "north")
      world:objectPlaced(desk)
      
      local chair = world:newObject("chair", 43, 82, "north")
      world:objectPlaced(chair)
      world:markRoomAsBuilt(room)
      
      TheApp:save("/tmp/snapshot_out.sav")
      TheApp.multiplayer.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
      TheApp.multiplayer.web.call("ui.banner", "oNeuer Raum fertiggestellt & geteilt!")
      return "BUILD_OK"
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("DemoGuest build res:", guestBuildRes);
  await sleep(3500);

  // Check FullHost for the synchronized room and verify NO errors
  const p1RoomCheck = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local world = TheApp.world
      local count = 0
      local r_name = "none"
      if world and world.rooms then
        for _, r in pairs(world.rooms) do
          count = count + 1
          if r.room_info and r.room_info.name then r_name = r.room_info.name end
        end
      end
      local err_win = TheApp.ui:getWindow(UIInformation)
      local is_real_error = false
      local err_msg = "none"
      if err_win and err_win.text then
        local parts = {}
        for _, t in ipairs(err_win.text) do
          local s = tostring(t)
          table.insert(parts, s)
          local low = s:lower()
          if low:find("fehler") or low:find("error") or low:find("spielstand") or low:find("entschuldigung") then
            is_real_error = true
          end
        end
        err_msg = table.concat(parts, " ")
      end
      local out = count .. "|" .. tostring(r_name) .. "|" .. tostring(is_real_error) .. "|" .. err_msg
      require("web").call("test.val", out)
    `;
    const res = mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return { res, val: window.__test_val };
  });
  console.log("FullHost room sync check:", p1RoomCheck);

  const [roomCount, roomName, hasError] = (p1RoomCheck.val || "").split("|");
  if (hasError === "true") {
    throw new Error("FullHost displayed an error window during snapshot sync!");
  }
  if (parseInt(roomCount, 10) < 1) {
    throw new Error("Room was not synchronized to FullHost: " + JSON.stringify(p1RoomCheck));
  }

  console.log("SUCCESS! Demo + Full identical map, staff hiring, and room sync fully verified!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
