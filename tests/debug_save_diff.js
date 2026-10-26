"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[P1]", m.text()));
  p2.on("console", (m) => console.log("[P2]", m.text()));

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

  // 1. P1 saves
  console.log("P1 saving state...");
  const saveRes = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      TheApp:save("/tmp/state_p1.sav")
      print("P1 saved ok, size: " .. #io.open('/tmp/state_p1.sav', 'rb'):read('*a'))
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  console.log("P1 save res:", saveRes);

  // 2. Read bytes from P1
  const bytes = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    return Array.from(mod.FS.readFile("/tmp/state_p1.sav"));
  });
  console.log("P1 save bytes length:", bytes.length);

  // 3. Write to P2 and test LoadGameFile
  const loadRes = await p2.evaluate((u8) => {
    const mod = window.__bth.state.game.mod;
    mod.FS.writeFile("/tmp/state_p2.sav", new Uint8Array(u8));
    const lua = `
      local ok, err = pcall(function()
        LoadGameFile("/tmp/state_p2.sav")
      end)
      if not ok then
        print("P2 LOAD ERROR: " .. tostring(err))
        return "ERROR: " .. tostring(err)
      end
      print("P2 LOAD SUCCESS! Room count: " .. tostring(#TheApp.world.rooms))
      return "SUCCESS"
    `;
    return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  }, bytes);
  console.log("P2 load result:", loadRes);

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("DEBUG ERROR:", e);
  process.exit(1);
});
