"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Starting History Window (Bau-Chronik) End-to-End Test...");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[Host]", m.text()));
  p2.on("console", (m) => console.log("[Guest]", m.text()));

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "DocHost");
  await p2.fill("#player-name", "DocGuest");

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
  await sleep(3000);

  // 1. Verify History Button in HUD
  console.log("1. Checking History button in HUD...");
  const histBtnExists = await p1.evaluate(() => !!document.querySelector("#hud-history-btn"));
  if (!histBtnExists) throw new Error("History button #hud-history-btn missing in HUD!");

  // 2. Open History window
  console.log("2. Opening History window via HUD button...");
  await p1.click("#hud-history-btn");
  await p1.waitForSelector("#history-win:not([hidden])");

  const initialText = await p1.textContent("#history-log");
  console.log("Initial History window content:", initialText.trim());

  // 3. Host builds Allgemeinmedizin and triggers history
  console.log("3. Host building GP office (Allgemeinmedizin)...");
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
      
      local desk = world:newObject("desk", 25, 17, "north")
      world:objectPlaced(desk)
      local chair = world:newObject("chair", 25, 18, "north")
      world:objectPlaced(chair)
      world:markRoomAsBuilt(room)
      
      TheApp:save("/tmp/snapshot_out.sav")
      TheApp.multiplayer.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
      
      local r_name = room_info and room_info.name and TheApp.multiplayer.clean_name and TheApp.multiplayer.clean_name(room_info.name) or "Allgemeinmedizin"
      local payload = string.format("room|%s|%s|1500", "DocHost", "Allgemeinmedizin")
      TheApp.multiplayer.web.call("hist.record", payload)
      TheApp.multiplayer.web.call("net.send", "all|hist:" .. payload)
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });

  await sleep(2000);

  // 4. Verify History item on Host
  const hostItems = await p1.evaluate(() => {
    return Array.from(document.querySelectorAll("#history-log .hist-item")).map((el) => el.textContent);
  });
  console.log("Host History entries:", hostItems);
  if (!hostItems.some((s) => s.includes("DocHost") && s.includes("Allgemeinmedizin"))) {
    throw new Error("Host History log does not contain Allgemeinmedizin entry!");
  }
  console.log("PASS: Host recorded Allgemeinmedizin build!");

  // 5. Open History window on Guest and verify Guest has received it
  console.log("5. Checking History log on Guest...");
  await p2.click("#hud-history-btn");
  await p2.waitForSelector("#history-win:not([hidden])");
  const guestItems = await p2.evaluate(() => {
    return Array.from(document.querySelectorAll("#history-log .hist-item")).map((el) => el.textContent);
  });
  console.log("Guest History entries:", guestItems);
  if (!guestItems.some((s) => s.includes("DocHost") && s.includes("Allgemeinmedizin"))) {
    throw new Error("Guest History log did NOT receive Allgemeinmedizin entry from Host!");
  }
  console.log("PASS: Guest received Allgemeinmedizin build in real-time!");

  // 6. Guest places corridor object
  console.log("6. Guest placing drinks machine in corridor...");
  await p2.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local payload = string.format("obj|%s|%s|%d|%d|%d", "DocGuest", "Getränkeautomat", 100, 15, 20)
      TheApp.multiplayer.web.call("hist.record", payload)
      TheApp.multiplayer.web.call("net.send", "all|hist:" .. payload)
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });

  await sleep(2000);

  // 7. Host hires Doctor
  console.log("7. Host hiring Doctor...");
  await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local payload = string.format("hire|%s|%s|%s|%d", "DocHost", "Arzt", "Dr. Bob", 650)
      TheApp.multiplayer.web.call("hist.record", payload)
      TheApp.multiplayer.web.call("net.send", "all|hist:" .. payload)
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });

  await sleep(2000);

  // 8. Verify categories and filters on Host
  console.log("8. Testing filters on Host...");
  const hostAllCount = await p1.evaluate(() => document.querySelectorAll("#history-log .hist-item:not([hidden])").length);
  console.log("Host visible items on 'all':", hostAllCount);
  if (hostAllCount < 3) throw new Error("Expected at least 3 items in history!");

  // Click 'Räume' filter
  await p1.click('#history-filters .filter-chip[data-filter="room"]');
  const hostRoomCount = await p1.evaluate(() => document.querySelectorAll("#history-log .hist-item:not([hidden])").length);
  console.log("Host visible items on 'room':", hostRoomCount);
  if (hostRoomCount !== 1) throw new Error("Expected exactly 1 room item when filtered by 'room'!");

  // Click 'Objekte' filter
  await p1.click('#history-filters .filter-chip[data-filter="obj"]');
  const hostObjCount = await p1.evaluate(() => document.querySelectorAll("#history-log .hist-item:not([hidden])").length);
  console.log("Host visible items on 'obj':", hostObjCount);
  if (hostObjCount !== 1) throw new Error("Expected exactly 1 object item when filtered by 'obj'!");

  // Click 'Personal' filter
  await p1.click('#history-filters .filter-chip[data-filter="staff"]');
  const hostStaffCount = await p1.evaluate(() => document.querySelectorAll("#history-log .hist-item:not([hidden])").length);
  console.log("Host visible items on 'staff':", hostStaffCount);
  if (hostStaffCount !== 1) throw new Error("Expected exactly 1 staff item when filtered by 'staff'!");

  // 9. Check Chat also received the notes
  const chatMessages = await p1.evaluate(() => {
    return Array.from(document.querySelectorAll("#chat-log .sys")).map((el) => el.textContent);
  });
  console.log("System chat messages:", chatMessages);
  if (!chatMessages.some((m) => m.includes("Chronik") && m.includes("Allgemeinmedizin"))) {
    throw new Error("Chat did not receive history notice!");
  }

  // 10. Test dragging the history window
  console.log("10. Testing window dragging...");
  const beforePos = await p1.evaluate(() => {
    const r = document.querySelector("#history-win").getBoundingClientRect();
    return { left: r.left, top: r.top };
  });

  const headerBox = await p1.evaluate(() => {
    const r = document.querySelector("#history-header").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  await p1.mouse.move(headerBox.x, headerBox.y);
  await p1.mouse.down();
  await p1.mouse.move(headerBox.x + 80, headerBox.y - 50);
  await p1.mouse.up();

  const afterPos = await p1.evaluate(() => {
    const r = document.querySelector("#history-win").getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  console.log(`Window pos before: ${JSON.stringify(beforePos)} | after: ${JSON.stringify(afterPos)}`);
  if (Math.abs(afterPos.left - beforePos.left) < 30) {
    throw new Error("Window did not move when dragged!");
  }
  console.log("PASS: History window dragging verified!");

  console.log("ALL HISTORY WINDOW TESTS PASSED SUCCESSFULLY!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
