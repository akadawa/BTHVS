"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Real Browser Mouse Clicks on Canvas ===");
  const port = await listen();
  const browser = await launch();
  const page = await newPage(browser, port, "Single");

  page.on("console", (m) => console.log("[Console]", m.text()));
  await loadDemo(page);
  await sleep(1000);

  // Set up DOM event listener on #canvas to trace browser events
  await page.evaluate(() => {
    const canvas = document.querySelector("#canvas");
    window._domEvents = [];
    ["pointerdown", "pointerup", "mousedown", "mouseup", "click"].forEach((type) => {
      canvas.addEventListener(type, (e) => {
        window._domEvents.push({
          type,
          x: e.clientX,
          y: e.clientY,
          button: e.button,
          target: e.target.id
        });
        console.log(`[DOM Event] ${type} at (${e.clientX}, ${e.clientY}) button=${e.button}`);
      });
    });
  });

  console.log("Clicking Single Player...");
  await page.click("#btn-single");
  await sleep(4000);

  // In Single Player, click "Neues Spiel" in Main Menu
  // Or start a game directly
  console.log("Starting a custom game / level 1 directly to inspect bottom panel...");
  await page.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      -- Hook UI:onMouseDown and UI:onMouseUp to see what Lua receives
      local orig_down = UI.onMouseDown
      UI.onMouseDown = function(self, button, x, y)
        print(string.format("[Lua MouseDown] button=%s, x=%d, y=%d", tostring(button), x, y))
        return orig_down(self, button, x, y)
      end

      local orig_up = UI.onMouseUp
      UI.onMouseUp = function(self, button, x, y)
        print(string.format("[Lua MouseUp] button=%s, x=%d, y=%d", tostring(button), x, y))
        return orig_up(self, button, x, y)
      end

      -- If in main menu, start game
      local mm = TheApp.ui:getWindow(UIMainMenu)
      if mm then
        mm:buttonNewGame()
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
  });
  await sleep(3000);

  // Now the game is in the hospital with the bottom toolbar!
  // Find the exact screen coordinates of the Build Room button on bottom panel:
  const btnCoords = await page.evaluate(() => {
    const mod = window.__bth.state.game.mod;
    const lua = `
      local bp = TheApp.ui:getWindow(UIBottomPanel)
      if bp then
        -- Panel 4 is Build Room button at bp.x + 206 + 20, bp.y + 20
        local bx = bp.x + 206 + 18
        local by = bp.y + 18
        TheApp.multiplayer.web.call("test.val", string.format("%d,%d,%d,%d", bp.x, bp.y, bx, by))
      else
        TheApp.multiplayer.web.call("test.val", "NO_BOTTOM_PANEL")
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [lua]);
    return window.__test_val;
  });
  console.log("Bottom panel coords:", btnCoords);

  if (btnCoords && btnCoords !== "NO_BOTTOM_PANEL") {
    const [bpX, bpY, bx, by] = btnCoords.split(",").map(Number);
    console.log(`Calculated Build Room button is at canvas pixel (${bx}, ${by}).`);

    // Check canvas element rect in browser DOM
    const canvasRect = await page.evaluate(() => {
      const c = document.querySelector("#canvas");
      const r = c.getBoundingClientRect();
      return {
        width: c.width,
        height: c.height,
        rectLeft: r.left,
        rectTop: r.top,
        rectWidth: r.width,
        rectHeight: r.height,
        windowW: window.innerWidth,
        windowH: window.innerHeight,
        dpr: window.devicePixelRatio,
      };
    });
    console.log("Canvas layout info:", JSON.stringify(canvasRect, null, 2));

    // Calculate DOM clientX/clientY for clicking (bx, by)
    const clientX = canvasRect.rectLeft + (bx / canvasRect.width) * canvasRect.rectWidth;
    const clientY = canvasRect.rectTop + (by / canvasRect.height) * canvasRect.rectHeight;
    console.log(`Playwright mouse clicking at DOM client coordinates (${clientX}, ${clientY})...`);

    // Click using Playwright
    await page.mouse.move(clientX, clientY);
    await sleep(200);
    await page.mouse.down();
    await sleep(100);
    await page.mouse.up();
    await sleep(1000);

    // Check if UIBuildRoom opened
    const checkResult = await page.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      const lua = `
        local br = TheApp.ui:getWindow(UIBuildRoom)
        TheApp.multiplayer.web.call("test.val", br and "BUILD_ROOM_OPEN" or "BUILD_ROOM_CLOSED")
      `;
      mod.ccall("th_eval_lua", "string", ["string"], [lua]);
      return window.__test_val;
    });
    console.log("Result after mouse click:", checkResult);

    await page.screenshot({ path: "tests/out/mouse_click_test.png" });
  }

  await browser.close();
})();
