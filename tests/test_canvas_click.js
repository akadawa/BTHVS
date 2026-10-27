"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  const port = await listen();
  const browser = await launch();
  const page = await newPage(browser, port, "Single");

  page.on("console", (m) => console.log("[Console]", m.text()));
  await loadDemo(page);
  await sleep(1000);

  console.log("Clicking Single Player...");
  await page.click("#btn-single");
  await sleep(4000);

  // Check windows in Lua by printing
  await page.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local wins = {}
      for i, w in ipairs(TheApp.ui.windows or {}) do
        local name = w._NAME or "unknown"
        local x = w.x or 0
        local y = w.y or 0
        local w_w = w.width or 0
        local w_h = w.height or 0
        local modal = w.modal_class or "none"
        table.insert(wins, string.format("%s (x=%d, y=%d, w=%d, h=%d, modal=%s)", name, x, y, w_w, w_h, modal))
      end
      print("OPEN_WINDOWS:\\n" .. table.concat(wins, "\\n"))

      local info = TheApp.ui:getWindow(UIInformation)
      if info then
        local cx = info.x + info.width - 20
        local cy = info.y + info.height - 20
        print(string.format("CLOSE_BTN_COORDS: %d, %d", cx, cy))
      else
        print("NO_UI_INFORMATION_WINDOW")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  await sleep(500);

  await browser.close();
})();
