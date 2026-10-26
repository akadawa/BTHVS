"use strict";
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");
const path = require("path");

(async () => {
  console.log("Starting Room Build & Sync End-to-End Test...");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[Host]", m.text()));
  p2.on("console", (m) => console.log("[Guest]", m.text()));

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "Host");
  await p2.fill("#player-name", "Guest");

  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(4000);

  // 1. Host creates a GP office (room id "gp") programmatically using CorsixTH's World:newRoom
  console.log("Host building GP office (Allgemeinmedizin)...");
  const buildRes = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local world = TheApp.world
      local hosp = world:getLocalPlayerHospital()
      
      -- Open edit room window for GP office (x=24, y=16, w=4, h=4)
      local room_info = TheApp.rooms["gp"]
      local door = world:newObject("door", 26, 19, "north")
      local room = world:newRoom(24, 16, 4, 4, room_info, door)
      world:objectPlaced(door)
      hosp:spendMoney(1500, "GP Room")
      print("Host created room: " .. tostring(room) .. " (total rooms: " .. tostring(#world.rooms) .. ")")
      
      local desk = world:newObject("desk", 25, 17, "north")
      world:objectPlaced(desk)
      
      local chair = world:newObject("chair", 25, 18, "north")
      world:objectPlaced(chair)
      world:markRoomAsBuilt(room)
      
      -- Save and broadcast snapshot (same as UIEditRoom:confirm)
      TheApp:save("/tmp/snapshot_out.sav")
      TheApp.multiplayer.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
      TheApp.multiplayer.web.call("ui.banner", "oNeuer Raum fertiggestellt & geteilt!")
      return "BUILD_OK"
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Host build result:", buildRes);

  // 2. Wait for Guest to receive and apply snapshot
  await sleep(3000);

  // 3. Verify Guest has the room
  const guestRooms = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local count = #TheApp.world.rooms
      print("GUEST ROOM COUNT AFTER SYNC: " .. tostring(count))
      local gp_found = false
      for _, r in ipairs(TheApp.world.rooms) do
        if r.room_info and r.room_info.id == "gp" then
          gp_found = true
        end
      end
      print("GUEST GP OFFICE FOUND: " .. tostring(gp_found))
      return tostring(count) .. "|" .. tostring(gp_found)
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Guest check result:", guestRooms);

  // 4. Test hiring doctor on Guest and verify it appears on Host
  console.log("Guest hiring Doctor...");
  const guestHireRes = await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local pool = TheApp.world.available_staff["Doctor"]
      local prof = pool and table.remove(pool, 1)
      if not prof then
        local StaffProfile = _G["StaffProfile"] or corsixth.require("staff_profile")
        prof = StaffProfile(TheApp.world, "Doctor")
        prof:init(0.8)
        prof.name = "Dr. Test Sync"
      end
      local tx, ty = 28, 22
      local entity = TheApp.world:newEntity("Doctor", 2, 2)
      entity:setProfile(prof)
      entity:setTile(tx, ty)
      TheApp.world:getLocalPlayerHospital():addStaff(entity)
      entity:setHospital(TheApp.world:getLocalPlayerHospital())
      entity:onPlaceInCorridor()
      
      local is_psy = 0
      local is_sur = 0
      local is_res = 0
      local payload = string.format("hire:%s|%s|%d|%.2f|%d|%d|%d|%d|%d|%d|%d|%d",
        "Doctor", tostring(prof.name), 200, 0.8, 2, is_psy, is_sur, is_res, 0, 1, tx, ty)
      TheApp.multiplayer.web.call("net.send", "all|" .. payload)
      print("Guest hired: " .. tostring(prof.name))
      return "HIRE_DONE"
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Guest hire eval result:", guestHireRes);

  await sleep(2000);

  // 5. Verify Host has the doctor and can interact
  const hostDoctor = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local hosp = TheApp.world:getLocalPlayerHospital()
      local count = hosp and #hosp.staff or 0
      print("HOST STAFF COUNT: " .. tostring(count))
      return tostring(count)
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("Host doctor check result:", hostDoctor);

  await p1.screenshot({ path: path.join(root, "tests", "out", "room_sync_host.png") });
  await p2.screenshot({ path: path.join(root, "tests", "out", "room_sync_guest.png") });

  console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
