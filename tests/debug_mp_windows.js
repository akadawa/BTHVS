"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  await loadDemo(p1);
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  await p1.click("#btn-ready");
  // mock 2nd player to start alone
  await p1.evaluate(() => {
    window.__bth.state.lobby.players.push({ id: 1, name: "Guest", ready: true, demo: true, connected: true });
    window.__bth.hostStart();
  });
  await p1.waitForSelector("#canvas:not([hidden])", { timeout: 30000 });
  await sleep(4000);
  const info = await p1.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local wins = {}
      for i, w in ipairs(TheApp.ui.windows or {}) do
        local name = w._NAME or tostring(w.modal_class) or "win"
        table.insert(wins, string.format("%s (x=%d, y=%d, w=%d, h=%d, modal=%s, visible=%s, on_top=%s)",
          name, w.x or 0, w.y or 0, w.width or 0, w.height or 0, tostring(w.modal_class), tostring(w.visible), tostring(w.on_top)))
      end
      TheApp.multiplayer.web.call("test.val", table.concat(wins, "\\n"))
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Open windows on Host:\n" + info);
  await browser.close();
  process.exit(0);
})();
