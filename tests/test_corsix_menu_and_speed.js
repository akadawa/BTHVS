"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing CorsixTH Menu & Speed Customizations for BTHVS ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "HostDoctor");
    await loadDemo(p1);

    // Create room
    await p1.click("#btn-create");
    await sleep(400);

    // Join with second player
    const p2 = await newPage(browser, port, "GuestDoctor");
    await loadDemo(p2);
    const roomCode = (await p1.textContent("#room-code")).trim();
    await p2.fill("#join-code", roomCode);
    await p2.click("#btn-join");

    await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
    await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);

    await p1.click("#btn-ready");
    await p2.click("#btn-ready");
    await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
    await p1.click("#btn-start");

    // Wait for in-game canvas and HUD
    await p1.waitForSelector("#hud:not([hidden])", { timeout: 15000 });
    await sleep(1500);

    // 1. Strict Zero SVG check
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements, got ${svgCount}`);
    console.log("✓ Zero SVG elements found across document.");

    // 2. Query Lua state via th_eval_lua and test.val bridge
    const menuStructure = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        local app = TheApp
        local ui = app and app.ui
        local mb = ui and ui.menu_bar

        local menus = {}
        if mb and mb.menus then
          for _, m in ipairs(mb.menus) do
            table.insert(menus, tostring(m.title))
          end
        end

        local optBarItem = mb.menus and mb.menus[1]
        local optMenu = optBarItem and optBarItem.menu

        local optItems = {}
        local speedItems = {}
        local hasLockWindows = false

        if optMenu then
          for _, it in ipairs(optMenu.items or {}) do
            local t = tostring(it.title or "")
            table.insert(optItems, t .. (it.submenu and "[sub]" or ""))
            if t:find("FENSTER") or t:find("LOCK WINDOWS") then
              hasLockWindows = true
            end
            if it.submenu and (t:find("SPEED") or t:find("GESCHWINDIGKEIT")) then
              for _, sit in ipairs(it.submenu.items or {}) do
                local st = tostring(sit.title or "")
                table.insert(speedItems, st)
              end
            end
          end
        end

        local currentSpeed = app.world:getCurrentSpeed()

        -- Test speed lock
        app.world:setSpeed("Slowest")
        local speedAfterSlowest = app.world:getCurrentSpeed()

        app.world:setSpeed("Max speed")
        local speedAfterMax = app.world:getCurrentSpeed()

        app.world:setSpeed("Pause")
        local speedAfterPause = app.world:getCurrentSpeed()

        app.world:setSpeed("Normal")
        local speedAfterNormal = app.world:getCurrentSpeed()

        local res = table.concat({
          "menus=" .. table.concat(menus, ";"),
          "optItems=" .. table.concat(optItems, "#"),
          "hasLockWindows=" .. tostring(hasLockWindows),
          "speedItems=" .. table.concat(speedItems, ";"),
          "speedCount=" .. #speedItems,
          "speedAfterSlowest=" .. speedAfterSlowest,
          "speedAfterMax=" .. speedAfterMax,
          "speedAfterPause=" .. speedAfterPause,
          "speedAfterNormal=" .. speedAfterNormal,
        }, "|")

        web.call("test.val", res)
      `]);

      return window.__test_val;
    });

    console.log("Menu Structure & Speed Eval Result:", menuStructure);

    const parsed = Object.fromEntries(menuStructure.split("|").map((kv) => kv.split("=")));

    // Verify File Menu is absent
    const menuTitles = (parsed.menus || "").split(";");
    console.log("Top Menu Bar Menus:", menuTitles);
    if (menuTitles.some((t) => t.includes("FILE") || t.includes("DATEI"))) {
      throw new Error("FAIL: File menu should be absent from UIMenuBar!");
    }
    console.log("✓ File menu (Laden, Speichern, Neustart, Verlassen) is removed from in-game menu bar.");

    // Verify lock_windows is absent
    if (parsed.hasLockWindows === "true") {
      throw new Error("FAIL: lock_windows ('Fenster festhalten') should be removed!");
    }
    console.log("✓ 'Fenster festhalten' (lock_windows) is removed from options.");

    // Verify game_speed items: exactly 2 (Pause and Normal)
    console.log("Game Speed Submenu Items:", parsed.speedItems);
    if (parseInt(parsed.speedCount, 10) !== 2) {
      throw new Error(`FAIL: Expected exactly 2 game speed items (Pause and Normal), got ${parsed.speedCount}: ${parsed.speedItems}`);
    }
    console.log("✓ Game speed menu strictly reduced to Pause and Normal only.");

    // Verify speed enforcement in simulation
    if (parsed.speedAfterSlowest !== "Normal" || parsed.speedAfterMax !== "Normal") {
      throw new Error(`FAIL: Game speed must not accept Slowest or Max! got Slowest->${parsed.speedAfterSlowest}, Max->${parsed.speedAfterMax}`);
    }
    if (parsed.speedAfterPause !== "Pause" || parsed.speedAfterNormal !== "Normal") {
      throw new Error(`FAIL: Game speed must accept Pause and Normal! got Pause->${parsed.speedAfterPause}, Normal->${parsed.speedAfterNormal}`);
    }
    console.log("✓ Game speed strictly locked to Normal and Pause; faster/slower rates blocked.");

    // 3. Verify quit / main menu behavior: never show DOS UIMainMenu, always exit
    const exitBehavior = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        TheApp:loadMainMenu()
        web.call("test.val", "running=" .. tostring(TheApp.running))
      `]);
      return window.__test_val;
    });
    console.log("Exit Behavior Eval Result:", exitBehavior);
    if (!exitBehavior.includes("running=false")) {
      throw new Error(`FAIL: loadMainMenu must terminate running loop to exit to browser, got: ${exitBehavior}`);
    }
    console.log("✓ App:loadMainMenu cleanly terminates engine to return directly to browser web app.");

    // 4. Strict Zero Emoji check
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const hudText = await p1.textContent("#hud");
    if (emojiRegex.test(hudText)) {
      throw new Error("FAIL: Found emoji inside #hud!");
    }
    console.log("✓ Strict verification passed: Zero emojis found.");

    console.log("=== ALL CORSIX MENU & SPEED CUSTOMIZATION TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
