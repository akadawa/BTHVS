"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Testing loading of all 5 maps with demo data...");
  const port = await listen();
  const b = await launch();
  const p1 = await newPage(b, port, "Host");
  const p2 = await newPage(b, port, "Guest");

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
  await p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 });
  await sleep(2000);

  const maps = ["demo", "avatar", "confined_v5", "finisham", "st.peter's"];
  for (const m of maps) {
    const res = await p1.evaluate((mapId) => {
      const mod = window.__bth.state.game.mod;
      const lua = `
        local lp = TheApp:getFullPath({"Levels", "${mapId}.level"})
        local mp = TheApp:getFullPath({"Levels", "${mapId}.map"})
        local lfs = require("lfs")
        local ok_f = lfs.attributes(lp, "mode") == "file" and lfs.attributes(mp, "mode") == "file"
        local ok, err = pcall(function()
          TheApp:loadLevel(lp, nil, "${mapId}", mp, nil, nil, "Err: ", nil)
        end)
        return tostring(ok_f) .. "|" .. tostring(ok) .. "|" .. tostring(err) .. "|" .. tostring(TheApp.map.width) .. "x" .. tostring(TheApp.map.height)
      `;
      return mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    }, m);
    console.log(`Map '${m}' load result:`, res);
  }

  await b.close();
  console.log("ALL MAPS TEST COMPLETE!");
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
