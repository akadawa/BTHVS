"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Starting Cross-Version (Demo + Full) Room Build & Sync Test...");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[Host]", m.text()));
  p2.on("console", (m) => console.log("[Guest]", m.text()));

  // Host loads Demo
  console.log("Loading Demo on Host...");
  await loadDemo(p1);

  // Guest loads Full version (simulate by stripping datam/demo.dat)
  console.log("Loading Full version on Guest...");
  await loadDemo(p2);
  await p2.evaluate(() => {
    const s = window.__bth.state;
    s.data.demo = false;
    s.data.files = s.data.files.filter(([p]) => !p.toLowerCase().includes("demo.dat"));
    console.log("Guest set to Full version! Demo flag:", s.data.demo);
  });

  await p1.fill("#player-name", "DemoHost");
  await p2.fill("#player-name", "FullGuest");

  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);

  // Check tags in lobby
  const hostTags = await p1.evaluate(() =>
    Array.from(document.querySelectorAll("#player-list li")).map((li) => li.textContent)
  );
  console.log("Lobby tags seen by Host:", hostTags);

  // Host starts game
  await p1.click("#btn-start");

  await Promise.all([
    p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
    p2.waitForSelector("#hud:not([hidden])", { timeout: 35000 }),
  ]);
  await sleep(4000);

  // Verify using_demo_files via print
  await p1.evaluate(() => {
    window.__bth.state.game.mod.ccall("th_eval_lua", "string", ["string"], [
      'print("CHECK_HOST_DEMO: " .. tostring(TheApp.using_demo_files))'
    ]);
  });
  await p2.evaluate(() => {
    window.__bth.state.game.mod.ccall("th_eval_lua", "string", ["string"], [
      'print("CHECK_GUEST_DEMO: " .. tostring(TheApp.using_demo_files))'
    ]);
  });

  // Host creates GP office (Allgemeinmedizin) and syncs snapshot
  console.log("Host building GP office (Allgemeinmedizin)...");
  await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local world = TheApp.world
      local hosp = world:getLocalPlayerHospital()
      
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
      
      TheApp:save("/tmp/snapshot_out.sav")
      TheApp.multiplayer.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
      TheApp.multiplayer.web.call("ui.banner", "oNeuer Raum fertiggestellt & geteilt!")
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });

  // Wait for Guest to receive and apply snapshot
  await sleep(5000);

  // Check Guest status: verify Guest is STILL in-game and has the room!
  await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      if not TheApp.world then
        print("CHECK_GUEST_RESULT: WORLD_NIL_KICKED_OUT")
        return
      end
      local count = #TheApp.world.rooms
      local gp_found = false
      for _, r in ipairs(TheApp.world.rooms) do
        if r.room_info and r.room_info.id == "gp" then
          gp_found = true
        end
      end
      print("CHECK_GUEST_RESULT: count=" .. tostring(count) .. " gp_found=" .. tostring(gp_found))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });

  await sleep(1000);

  const guestLogs = p2.logs.join("\n");
  if (guestLogs.includes("WORLD_NIL_KICKED_OUT") || guestLogs.includes("compatibility_error") || guestLogs.includes("Entschuldigung")) {
    throw new Error("Guest was kicked out to main menu! Compatibility error occurred.");
  }
  if (!guestLogs.includes("gp_found=true")) {
    throw new Error("GP office was not found on Guest!");
  }

  console.log("SUCCESS! Demo host built Allgemeinmedizin, Full guest received and loaded it cleanly without any error!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
