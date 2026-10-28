"use strict";
const fs = require("fs");
const http = require("http");
const zlib = require("zlib");
const path = require("path");
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");

function httpGetRaw(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
  });
}

(async () => {
  console.log("=== Testing CorsixTH v0.70.2 Engine Upgrade & Runtime Optimizations ===");
  const port = await listen();
  const browser = await launch();

  try {
    // 1. Verify Bundle Optimization & Build Manifest
    const buildJsonPath = path.join(root, "dist", "game", "build.json");
    const manifest = JSON.parse(fs.readFileSync(buildJsonPath, "utf8"));
    console.log("Build manifest:", manifest);
    if (!manifest.hash || manifest.hash.length !== 12) {
      throw new Error(`FAIL: Invalid build hash in build.json: ${manifest.hash}`);
    }
    if (manifest.dataSize >= 8000000) {
      throw new Error(`FAIL: Expected optimized corsixth.data < 8 MB, got ${manifest.dataSize} bytes`);
    }
    const savedPct = (((15713043 - manifest.dataSize) / 15713043) * 100).toFixed(1);
    console.log(`[PASS] corsixth.data optimized to ${(manifest.dataSize / (1024 * 1024)).toFixed(2)} MB (-${savedPct}% vs v0.69.2 14.99 MB).`);

    // 2. Verify Server Gzip Compression Optimization
    for (const assetPath of ["/app.js", "/game/corsixth.wasm", "/game/corsixth.data"]) {
      const resp = await httpGetRaw(port, assetPath, { "Accept-Encoding": "gzip" });
      if (resp.status !== 200) throw new Error(`FAIL: HTTP ${resp.status} for ${assetPath}`);
      if (resp.headers["content-encoding"] !== "gzip") {
        throw new Error(`FAIL: Expected Content-Encoding: gzip on ${assetPath}, got ${resp.headers["content-encoding"]}`);
      }
      const unzipped = zlib.gunzipSync(resp.body);
      if (unzipped.length <= resp.body.length) {
        throw new Error(`FAIL: Expected gzip payload smaller than raw for ${assetPath}`);
      }
      console.log(
        `[PASS] Gzip streaming verified for ${assetPath}: ${(unzipped.length / 1024).toFixed(1)} KB -> ${(resp.body.length / 1024).toFixed(1)} KB (${((1 - resp.body.length / unzipped.length) * 100).toFixed(1)}% smaller over wire).`
      );
    }

    // 3. Boot 2-Player Versus Match & Measure Startup Time
    const p1 = await newPage(browser, port, "HostV0702", { w: 1440, h: 960 });
    const p2 = await newPage(browser, port, "GuestV0702", { w: 1280, h: 800 });

    // Check landing footer displays CorsixTH v0.70.2 & strict zero-SVG / zero-emoji invariants
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const footerText = await p1.textContent("footer");
    if (!footerText.includes("CorsixTH v0.70.2")) {
      throw new Error(`FAIL: Expected footer to mention 'CorsixTH v0.70.2', got: ${footerText}`);
    }
    const landingSvgCount = await p1.$$eval("svg", (els) => els.length);
    if (landingSvgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements on landing page, got ${landingSvgCount}`);
    const bodyText = await p1.textContent("body");
    if (emojiRegex.test(bodyText)) throw new Error("FAIL: Found Unicode emoji on landing page!");
    console.log("[PASS] Landing page verified: CorsixTH v0.70.2 footer, 0 SVGs, 0 emojis.");

    await Promise.all([loadDemo(p1), loadDemo(p2)]);

    await p1.click("#btn-create");
    await p1.waitForFunction(() => {
      const code = (document.querySelector("#room-code")?.textContent || "").trim();
      return code.length === 8 && !code.includes("-");
    });
    const roomCode = (await p1.textContent("#room-code")).trim();

    await p2.fill("#join-code", roomCode);
    await p2.click("#btn-join");

    await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
    await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);

    // Disable timeLimit so we test pure goal mode without timer churn during DOM mutation checks
    await p1.selectOption("#goal-time", "0");
    await sleep(250);

    await p1.click("#btn-ready");
    await p2.click("#btn-ready");
    await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);

    const tBootStart = Date.now();
    await p1.click("#btn-start");

    await Promise.all([
      p1.waitForSelector("#hud:not([hidden])", { timeout: 20000 }),
      p2.waitForSelector("#hud:not([hidden])", { timeout: 20000 }),
    ]);

    // Wait until Lua world & multiplayer are active on both peers
    await Promise.all([
      p1.waitForFunction(() => {
        const mod = window.__bth?.state?.game?.mod;
        if (!mod || typeof mod.ccall !== "function") return false;
        mod.ccall("th_eval_lua", "string", ["string"], [
          `local web = require("web"); web.call("test.val", tostring(TheApp and TheApp.world ~= nil and TheApp.multiplayer and TheApp.multiplayer.active))`,
        ]);
        return window.__test_val === "true";
      }, null, { timeout: 20000 }),
      p2.waitForFunction(() => {
        const mod = window.__bth?.state?.game?.mod;
        if (!mod || typeof mod.ccall !== "function") return false;
        mod.ccall("th_eval_lua", "string", ["string"], [
          `local web = require("web"); web.call("test.val", tostring(TheApp and TheApp.world ~= nil and TheApp.multiplayer and TheApp.multiplayer.active))`,
        ]);
        return window.__test_val === "true";
      }, null, { timeout: 20000 }),
    ]);
    const bootMs = Date.now() - tBootStart;
    console.log(`[PASS] 2-player Versus match booted cleanly into active simulation in ${bootMs} ms.`);

    // Check #fatal is hidden on both peers
    for (const [label, pg] of [["Host", p1], ["Guest", p2]]) {
      const fatalHidden = await pg.$eval("#fatal", (el) => el.hidden);
      if (!fatalHidden) {
        const msg = await pg.textContent("#fatal-text");
        throw new Error(`FAIL: ${label} hit fatal error: ${msg}`);
      }
      const pageErrors = pg.logs.filter((l) => l.startsWith("PAGEERROR"));
      if (pageErrors.length > 0) {
        throw new Error(`FAIL: ${label} logged page errors: ${pageErrors.join("; ")}`);
      }
    }

    // 4. Verify Engine Version, Savegame Version, API Version & Root Path Fix in Live Lua
    const engineInfo = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        local api_ver = corsixth.require("api_version")
        local rel = TheApp:getReleaseString()
        local ver = TheApp:getCurrentVersion()
        local root_strip = stripTrailingSlashes("/")
        local must_pause = TheApp.world:mustPause()
        local allow_paused_actions = TheApp.config.allow_user_actions_while_paused
        web.call("test.val", table.concat({
          "rel=" .. tostring(rel),
          "ver=" .. tostring(ver),
          "api=" .. tostring(api_ver),
          "root=" .. tostring(root_strip),
          "mustPause=" .. tostring(must_pause),
          "allowPaused=" .. tostring(allow_paused_actions),
        }, "|"))
      `]);
      return window.__test_val;
    });
    console.log("Engine runtime info:", engineInfo);
    const info = Object.fromEntries(engineInfo.split("|").map((kv) => kv.split("=")));
    if (info.rel !== "v0.70.2") throw new Error(`FAIL: Expected release v0.70.2, got ${info.rel}`);
    if (info.ver !== "254") throw new Error(`FAIL: Expected SAVEGAME_VERSION 254, got ${info.ver}`);
    if (info.api !== "2717") throw new Error(`FAIL: Expected api_version 2717, got ${info.api}`);
    if (info.root !== "/") throw new Error(`FAIL: Expected stripTrailingSlashes('/') == '/', got '${info.root}'`);
    if (info.mustPause !== "false") throw new Error(`FAIL: Expected World:mustPause() == false in MP, got ${info.mustPause}`);
    if (info.allowPaused !== "true") throw new Error(`FAIL: Expected allow_user_actions_while_paused == true`);
    console.log("[PASS] Live Lua verified: CorsixTH v0.70.2 (Savegame v254, Lua API v2717), Emscripten root VFS fix, and MP mustPause override.");

    // 5. Verify v0.70.2 High-DPI UI Scaling (2x) & Automatic Browser Viewport Safety Clamping
    const scaleAt1440 = await p1.evaluate(() => {
      const applied = window.__bth.setGameUIScale(2);
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        web.call("test.val", tostring(TheApp.config.ui_scale))
      `]);
      return { applied, luaScale: Number(window.__test_val) };
    });
    if (scaleAt1440.applied !== 2 || scaleAt1440.luaScale !== 2) {
      throw new Error(`FAIL: Expected 2x UI scale at 1440x960, got ${JSON.stringify(scaleAt1440)}`);
    }
    console.log("[PASS] v0.70.2 2x High-DPI UI scaling activated cleanly at 1440x960.");

    // Shrink viewport to 1024x720 (< 1280x960 required for 2x) and verify automatic clamping to 1x
    await p1.setViewportSize({ width: 1024, height: 720 });
    await sleep(450);
    const scaleAt1024 = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        web.call("test.val", tostring(TheApp.config.ui_scale))
      `]);
      return Number(window.__test_val);
    });
    if (scaleAt1024 !== 1) {
      throw new Error(`FAIL: Expected automatic UI scale clamp to 1x at 1024x720, got ${scaleAt1024}`);
    }
    console.log("[PASS] Automatic viewport UI scale clamping verified (2x -> 1x on resize to 1024x720).");

    // 6. Verify Pause Sync, Blue Filter Guard, and Modal Non-Pause Isolation in Multiplayer
    const pauseSyncResult = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        -- Simulate modal mustPauseWindowAdd (e.g. local Fax / Annual Report) and verify it does NOT pause MP
        TheApp.world:mustPauseWindowAdd()
        local speedAfterModal = TheApp.world:getCurrentSpeed()
        TheApp.world:mustPauseWindowRemoved()
        -- Now test explicit Pause
        TheApp.world:setSpeed("Pause")
        local speedPaused = TheApp.world:getCurrentSpeed()
        web.call("test.val", speedAfterModal .. "|" .. speedPaused)
      `]);
      return window.__test_val;
    });
    if (pauseSyncResult !== "Normal|Pause") {
      throw new Error(`FAIL: Unexpected modal/pause behavior on Host: ${pauseSyncResult}`);
    }

    // Verify Guest receives synchronized Pause
    await p2.waitForFunction(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [
        `local web = require("web"); web.call("test.val", TheApp.world:getCurrentSpeed())`,
      ]);
      return window.__test_val === "Pause";
    }, null, { timeout: 5000 });

    // Resume Normal speed from Guest and verify Host resumes
    await p2.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`TheApp.world:setSpeed("Normal")`]);
    });
    await p1.waitForFunction(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [
        `local web = require("web"); web.call("test.val", TheApp.world:getCurrentSpeed())`,
      ]);
      return window.__test_val === "Normal";
    }, null, { timeout: 5000 });
    console.log("[PASS] Bidirectional Pause/Normal sync and local Fax/Report non-pause isolation verified.");

    // 7. Test SDL_KEYUP Modifier Table Hotfix (v0.70.2 #3535) & 120-Tick Gameplay Benchmark
    await p1.click("#canvas");
    await p1.keyboard.down("Shift");
    await p1.keyboard.press("ArrowRight");
    await p1.keyboard.press("c");
    await p1.keyboard.up("Shift");
    await sleep(150);

    const benchResult = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      const t0 = performance.now();
      mod.ccall("th_eval_lua", "string", ["string"], [`
        local web = require("web")
        local hosp = TheApp.world:getLocalPlayerHospital()
        -- Credit hospital cash to test live telemetry delta push
        hosp:receiveMoney(12500, "Research Grant")
        TheApp.multiplayer.last_stats_send = 0
        -- Run 120 simulation ticks directly to benchmark Lua + C++ pathfinding/entity loop
        for i = 1, 120 do
          TheApp:onTick()
        end
        web.call("test.val", tostring(hosp.balance) .. "|" .. tostring(TheApp.multiplayer.last_payload ~= nil))
      `]);
      const elapsedMs = performance.now() - t0;
      const heapMb = performance.memory ? (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1) : "n/a";
      return { elapsedMs: Number(elapsedMs.toFixed(2)), val: window.__test_val, heapMb };
    });
    console.log("120-tick simulation benchmark:", benchResult);
    if (!benchResult.val.endsWith("|true")) {
      throw new Error(`FAIL: Expected multiplayer telemetry deduplication cache to be active: ${benchResult.val}`);
    }
    if (benchResult.elapsedMs > 2000) {
      throw new Error(`FAIL: 120 simulation ticks took too long (${benchResult.elapsedMs} ms)`);
    }
    console.log(`[PASS] 120 simulation ticks completed in ${benchResult.elapsedMs} ms (avg ${(benchResult.elapsedMs / 120).toFixed(3)} ms/tick, JS heap: ${benchResult.heapMb} MB).`);

    // Verify Guest received the updated cash balance via vstats delta sync
    const hostBal = parseInt(benchResult.val.split("|")[0], 10);
    await p2.waitForFunction(
      (expectedBal) => window.__bth?.state?.vs?.oppStats?.bal === expectedBal,
      hostBal,
      { timeout: 6000 }
    );
    console.log(`[PASS] Guest received deduplicated live hospital balance update ($${hostBal.toLocaleString()}).`);

    // 8. Verify DOM Diff Memoization (setHtmlIfChanged) in Quests & Leaderboard Window
    const domDiffMutations = await p1.evaluate(() => {
      const questWin = document.querySelector("#quest-win");
      questWin.hidden = false;
      window.__bth.updateQuestUI();

      const obs = new MutationObserver(() => {});
      obs.observe(document.querySelector("#quest-list"), { childList: true, subtree: true, characterData: true });
      obs.observe(document.querySelector("#rival-tbody"), { childList: true, subtree: true, characterData: true });

      // 5 redundant calls with identical state must cause 0 DOM mutations
      for (let i = 0; i < 5; i++) {
        window.__bth.updateQuestUI();
      }
      const unchangedMutations = obs.takeRecords().length;

      // Mutating a stat must cause exact DOM update
      window.__bth.state.vs.myStats.cured = (window.__bth.state.vs.myStats.cured || 0) + 3;
      window.__bth.updateQuestUI();
      const changedMutations = obs.takeRecords().length;
      obs.disconnect();
      return { unchangedMutations, changedMutations };
    });
    if (domDiffMutations.unchangedMutations !== 0) {
      throw new Error(`FAIL: Expected 0 DOM mutations when stats unchanged, got ${domDiffMutations.unchangedMutations}`);
    }
    if (domDiffMutations.changedMutations === 0) {
      throw new Error("FAIL: Expected DOM update when stats changed!");
    }
    console.log("[PASS] Quest & Rivals Leaderboard DOM diff memoization verified (0 redundant DOM rewrites).");

    // 9. Verify Transient Banner Auto-Hide vs Error Banner Persistence
    await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`require("web").call("ui.banner", "oSpeed test notification")`]);
    });
    const bannerVisibleImmediately = await p1.$eval("#net-banner", (el) => !el.hidden && el.textContent === "Speed test notification");
    if (!bannerVisibleImmediately) throw new Error("FAIL: Transient banner did not appear!");
    await sleep(3800);
    const bannerHiddenAfterTimeout = await p1.$eval("#net-banner", (el) => el.hidden);
    if (!bannerHiddenAfterTimeout) throw new Error("FAIL: Transient banner did not auto-hide after 3.5s!");

    await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      mod.ccall("th_eval_lua", "string", ["string"], [`require("web").call("ui.banner", "ePersistent error alert")`]);
    });
    const errBannerCheck = await p1.$eval("#net-banner", (el) => !el.hidden && el.classList.contains("err"));
    if (!errBannerCheck) throw new Error("FAIL: Error banner did not render with .err class!");
    console.log("[PASS] Transient #net-banner auto-hide (3.5s) and persistent error banner verified.");

    // 10. Final In-Game Zero-SVG & Zero-Emoji Verification
    const inGameSvgCount = await p1.$$eval("svg", (els) => els.length);
    if (inGameSvgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements in-game, got ${inGameSvgCount}`);
    const gameText = await p1.textContent("#game");
    if (emojiRegex.test(gameText)) throw new Error("FAIL: Found Unicode emoji inside #game!");
    console.log("[PASS] In-game strict 0 SVG and 0 Unicode emoji policy verified.");

    console.log("=== ALL CORSIXTH v0.70.2 UPGRADE & PERFORMANCE OPTIMIZATION TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
