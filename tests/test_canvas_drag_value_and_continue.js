"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

function evalLua(page, code) {
  return page.evaluate((luaCode) => {
    const mod = window.__bth?.state?.game?.mod;
    if (!mod || typeof mod.ccall !== "function") return null;
    window.__test_val = null;
    const wrapped = `
      local web = require("web")
      local fn, err = load(${JSON.stringify(luaCode)})
      if not fn then
        web.call("test.val", "ERR:" .. tostring(err))
      else
        local ok, res = pcall(fn)
        if not ok then
          web.call("test.val", "ERR:" .. tostring(res))
        else
          web.call("test.val", tostring(res == nil and "ok" or res))
        end
      end
    `;
    mod.ccall("th_eval_lua", "string", ["string"], [wrapped]);
    return window.__test_val;
  }, code);
}

(async () => {
  console.log("=== Testing Canvas Left-Drag Protection, Hospital Value Victory & Multi-Player Continue Barrier ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "ActiveBuilder");
    const p2 = await newPage(browser, port, "IdleCashOne");
    const p3 = await newPage(browser, port, "IdleCashTwo");

    for (const p of [p1, p2, p3]) {
      p.on("dialog", async (dialog) => {
        throw new Error(`FAIL: Unexpected browser dialog (${dialog.type()}): ${dialog.message()}`);
      });
    }

    await Promise.all([loadDemo(p1), loadDemo(p2), loadDemo(p3)]);

    await p1.fill("#player-name", "ActiveBuilder");
    await p2.fill("#player-name", "IdleCashOne");
    await p3.fill("#player-name", "IdleCashTwo");

    // Host creates room
    await p1.click("#btn-create");
    await p1.waitForSelector("#card-lobby:not([hidden])");
    const roomCode = (await p1.textContent("#room-code")).trim();

    // Verify lobby text mentions Hospital Value when time runs out
    const hostHintText = await p1.textContent("#host-options");
    if (!hostHintText.includes("Hospital Value")) {
      throw new Error(`FAIL: Expected #host-options to mention Hospital Value, got: ${hostHintText}`);
    }

    // p2 and p3 join
    for (const guest of [p2, p3]) {
      await guest.fill("#join-code", roomCode);
      await guest.click("#btn-join");
    }

    await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length === 3);
    await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length === 3);
    await p3.waitForFunction(() => document.querySelectorAll("#player-list li").length === 3);

    const guestHintText = await p2.textContent("#guest-options");
    if (!guestHintText.includes("Hospital Value")) {
      throw new Error(`FAIL: Expected #guest-options to mention Hospital Value, got: ${guestHintText}`);
    }
    console.log("✓ Lobby host and guest descriptions clearly state highest Hospital Value wins on time limit.");

    // Ready up all 3 players and start match
    await p1.click("#btn-ready");
    await p2.click("#btn-ready");
    await p3.click("#btn-ready");
    await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
    await p1.click("#btn-start");

    // Wait for all 3 CorsixTH engines to start simulation and hide #loading
    for (const p of [p1, p2, p3]) {
      await p.waitForSelector("#hud:not([hidden])", { timeout: 25000 });
      await p.waitForSelector("#loading", { state: "hidden", timeout: 10000 });
      await p.waitForFunction(() => {
        const mod = window.__bth?.state?.game?.mod;
        if (!mod || typeof mod.ccall !== "function") return false;
        window.__test_val = null;
        mod.ccall(
          "th_eval_lua",
          "string",
          ["string"],
          ['require("web").call("test.val", (TheApp and TheApp.world and TheApp.multiplayer and TheApp.multiplayer.sim_started) and "1" or "0")']
        );
        return window.__test_val === "1";
      }, null, { timeout: 25000 });
    }
    await sleep(500);
    console.log("✓ 3-player Versus match started and synchronized.");

    // =========================================================================
    // 1. TEST LEFT-MOUSE-BUTTON HOLD & DRAG PROTECTION (NO SNAPSHOT / PHOTO DRAG)
    // =========================================================================
    const dragProtection = await p1.evaluate(() => {
      const gameEl = document.querySelector("#game");
      const canvasEl = document.querySelector("#canvas");
      const csGame = getComputedStyle(gameEl);
      const csCanvas = getComputedStyle(canvasEl);

      // Select text inside #quest-win to reproduce accidental DOM selection before canvas drag
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#quest-win"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const hadSelectionBefore = sel.toString().length > 0;

      // Attempt native HTML5 dragstart & selectstart on #canvas
      const dragEvt = new Event("dragstart", { bubbles: true, cancelable: true });
      canvasEl.dispatchEvent(dragEvt);

      const selectEvt = new Event("selectstart", { bubbles: true, cancelable: true });
      canvasEl.dispatchEvent(selectEvt);

      // Ensure #chat-input still allows text selection
      const chatInput = document.querySelector("#chat-input");
      const chatSelectEvt = new Event("selectstart", { bubbles: true, cancelable: true });
      chatInput.dispatchEvent(chatSelectEvt);

      return {
        canvasDraggable: canvasEl.draggable,
        gameDraggable: gameEl.draggable,
        gameUserSelect: csGame.userSelect || csGame.webkitUserSelect,
        canvasUserSelect: csCanvas.userSelect || csCanvas.webkitUserSelect,
        canvasUserDrag: csCanvas.webkitUserDrag,
        canvasTouchAction: csCanvas.touchAction,
        hadSelectionBefore,
        dragDefaultPrevented: dragEvt.defaultPrevented,
        selectDefaultPrevented: selectEvt.defaultPrevented,
        chatInputSelectAllowed: !chatSelectEvt.defaultPrevented,
      };
    });
    console.log("Canvas Drag Protection:", dragProtection);

    if (dragProtection.canvasDraggable !== false || dragProtection.gameDraggable !== false) {
      throw new Error(`FAIL: Expected draggable=false on #canvas and #game! Got: ${JSON.stringify(dragProtection)}`);
    }
    if (dragProtection.canvasUserSelect !== "none" || dragProtection.gameUserSelect !== "none") {
      throw new Error(`FAIL: Expected user-select: none on #canvas and #game! Got: ${JSON.stringify(dragProtection)}`);
    }
    if (!dragProtection.dragDefaultPrevented || !dragProtection.selectDefaultPrevented) {
      throw new Error(`FAIL: Expected dragstart and selectstart on #canvas to be defaultPrevented! Got: ${JSON.stringify(dragProtection)}`);
    }
    if (!dragProtection.chatInputSelectAllowed) {
      throw new Error("FAIL: #chat-input text selection should still be allowed!");
    }

    // Real Playwright left-button press, hold, drag (including crossing #quest-win), and release
    const camBefore = await evalLua(p1, "return TheApp.ui.screen_offset_x .. ',' .. TheApp.ui.screen_offset_y");
    const questRect = await p1.evaluate(() => {
      const r = document.querySelector("#quest-win").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });

    // Start left-button hold on open canvas area (verified elementFromPoint === #canvas)
    const startPt = { x: 540, y: 560 };
    const hitId = await p1.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, startPt);
    if (hitId !== "canvas") {
      throw new Error(`FAIL: Expected elementFromPoint(${startPt.x}, ${startPt.y}) to be 'canvas', got '${hitId}'`);
    }
    await p1.mouse.move(startPt.x, startPt.y);
    await p1.mouse.down({ button: "left" });
    await sleep(80);

    const duringHoldStart = await p1.evaluate(() => ({
      selectionText: window.getSelection().toString(),
      selectionRanges: window.getSelection().rangeCount,
      activeId: document.activeElement?.id,
    }));
    const luaMouseLeftDown = await evalLua(p1, "return TheApp.ui.buttons_down.mouse_left and '1' or '0'");
    if (duringHoldStart.selectionText !== "" || duringHoldStart.selectionRanges !== 0) {
      throw new Error(`FAIL: Mousedown on #canvas did not clear DOM selection! Got: ${JSON.stringify(duringHoldStart)}`);
    }
    if (luaMouseLeftDown !== "1") {
      throw new Error(`FAIL: CorsixTH did not register mouse_left down! Got: ${luaMouseLeftDown}`);
    }

    // Drag across canvas AND across #quest-win overlay while holding left mouse button
    await p1.mouse.move(620, 520, { steps: 5 });
    await p1.mouse.move(questRect.x, questRect.y, { steps: 5 });
    await sleep(80);

    const luaDuringOverlayDrag = await evalLua(
      p1,
      "return (TheApp.ui.buttons_down.mouse_left and '1' or '0') .. '|' .. tostring(TheApp.ui.cursor_x) .. ',' .. tostring(TheApp.ui.cursor_y)"
    );
    const camAfterLeftDrag = await evalLua(p1, "return TheApp.ui.screen_offset_x .. ',' .. TheApp.ui.screen_offset_y");
    console.log("During Left-Button Drag over overlay:", { luaDuringOverlayDrag, camBefore, camAfterLeftDrag });
    if (!luaDuringOverlayDrag.startsWith("1|")) {
      throw new Error(`FAIL: Lost mouse_left hold while dragging across overlay! Got: ${luaDuringOverlayDrag}`);
    }
    if (camBefore !== camAfterLeftDrag) {
      throw new Error(`FAIL: Left-button drag unexpectedly moved camera from ${camBefore} to ${camAfterLeftDrag}!`);
    }

    // Release left mouse button while over #quest-win (pointer capture ensures #canvas receives mouseup!)
    await p1.mouse.up({ button: "left" });
    await sleep(80);
    const luaAfterRelease = await evalLua(
      p1,
      "return (TheApp.ui.buttons_down.mouse_left and '1' or '0') .. '|' .. tostring(TheApp.ui.down_count)"
    );
    if (luaAfterRelease !== "0|0") {
      throw new Error(`FAIL: Left mouse button stuck after release over overlay! Got: ${luaAfterRelease}`);
    }
    console.log("✓ Left-click hold & drag works cleanly with pointer capture, zero snapshot ghost drag, and zero stuck buttons.");

    // =========================================================================
    // 2. TEST HIGHEST HOSPITAL VALUE ("KRANKENHAUSWERT") WINS ON TIME LIMIT
    // =========================================================================
    // ActiveBuilder spent cash ($12,000 left) to build a valuable hospital ($95,000 value, 4 cured).
    // IdleCashOne & IdleCashTwo never built anything ($60,000 unspent cash, only $45,000 hospital value).
    await evalLua(p1, `
      local h = TheApp.world:getLocalPlayerHospital()
      h.balance = 12000
      h.value = 95000
      h.num_cured = 4
    `);
    await evalLua(p2, `
      local h = TheApp.world:getLocalPlayerHospital()
      h.balance = 60000
      h.value = 45000
      h.num_cured = 0
    `);
    await evalLua(p3, `
      local h = TheApp.world:getLocalPlayerHospital()
      h.balance = 60000
      h.value = 40000
      h.num_cured = 0
    `);

    // Wait for real vstats packets to sync across all 3 players
    await p1.waitForFunction(() => {
      const r = Array.from(window.__bth.state.vs.rivalStats.values());
      return window.__bth.state.vs.myStats.val === 95000 && r.length >= 2 && r.some((s) => s.val === 45000);
    }, null, { timeout: 8000 });
    await p2.waitForFunction(() => {
      const r = Array.from(window.__bth.state.vs.rivalStats.values());
      return window.__bth.state.vs.myStats.val === 45000 && r.some((s) => s.val === 95000);
    }, null, { timeout: 8000 });
    await p3.waitForFunction(() => {
      const r = Array.from(window.__bth.state.vs.rivalStats.values());
      return window.__bth.state.vs.myStats.val === 40000 && r.some((s) => s.val === 95000);
    }, null, { timeout: 8000 });

    // Check Quest Lead Banner & Leaderboard Tab on p1
    await p1.click("#tab-btn-dashboard");
    await sleep(150);
    const lbData = await p1.evaluate(() => {
      const headers = Array.from(document.querySelectorAll(".rival-table th")).map((th) => th.textContent.trim());
      const firstRowPlayer = document.querySelector("#rival-tbody tr:first-child .td-player")?.textContent.trim();
      const firstRowVal = document.querySelector("#rival-tbody tr:first-child .td-val")?.textContent.trim();
      const leadBanner = document.querySelector("#quest-lead-text")?.textContent.trim();
      return { headers, firstRowPlayer, firstRowVal, leadBanner };
    });
    console.log("Live Leaderboard & Lead Banner:", lbData);
    if (!lbData.headers.includes("Value")) {
      throw new Error(`FAIL: Leaderboard missing 'Value' column! Got: ${JSON.stringify(lbData.headers)}`);
    }
    if (!lbData.firstRowPlayer.includes("ActiveBuilder")) {
      throw new Error(`FAIL: ActiveBuilder ($95k value, $12k cash) should rank #1 ahead of AFK $60k cash players! Got: ${lbData.firstRowPlayer}`);
    }
    if (!lbData.leadBanner.includes("You lead in Value")) {
      throw new Error(`FAIL: Lead banner should show Hospital Value lead! Got: ${lbData.leadBanner}`);
    }
    console.log("✓ Live Leaderboard and Lead Banner rank players by Hospital Value rather than unspent starting cash.");

    // Expire the 30-minute match timer so checkWinConditions triggers
    for (const p of [p1, p2, p3]) {
      await p.evaluate(() => {
        window.__bth.state.vs.startTime = Date.now() - (31 * 60 * 1000);
      });
    }
    await p1.evaluate(() => window.__bth.checkWinConditions());

    // Wait for #victory-modal on all 3 players
    for (const p of [p1, p2, p3]) {
      await p.waitForSelector("#victory-modal:not([hidden])", { timeout: 5000 });
    }

    const vicP1 = await p1.evaluate(() => ({
      title: document.querySelector("#vic-title")?.textContent.trim(),
      desc: document.querySelector("#vic-desc")?.textContent.trim(),
    }));
    const vicP2 = await p2.evaluate(() => ({
      title: document.querySelector("#vic-title")?.textContent.trim(),
      desc: document.querySelector("#vic-desc")?.textContent.trim(),
    }));
    console.log("Victory Modal Results:", { vicP1, vicP2 });

    if (vicP1.title !== "Victory! You won the match!" || !vicP1.desc.includes("Hospital Value")) {
      throw new Error(`FAIL: ActiveBuilder should have won by Hospital Value! Got: ${JSON.stringify(vicP1)}`);
    }
    if (!vicP2.title.includes("ActiveBuilder won") || !vicP2.desc.includes("Hospital Value")) {
      throw new Error(`FAIL: IdleCashOne should see ActiveBuilder won by Hospital Value! Got: ${JSON.stringify(vicP2)}`);
    }
    console.log("✓ Timed match victory awarded to highest Hospital Value (ActiveBuilder) over AFK high-cash rivals!");

    // =========================================================================
    // 3. TEST MATCH-END PAUSE & SYNCHRONIZED MULTI-PLAYER CONTINUE BARRIER
    // =========================================================================
    // 3a. Verify all 3 engines paused immediately when time expired, and manual unpause is locked
    for (const [idx, p] of [[1, p1], [2, p2], [3, p3]]) {
      const speedState = await evalLua(
        p,
        `
          -- Attempt rogue unpause while awaiting Continue
          TheApp.world:setSpeed("Normal")
          return TheApp.world:getCurrentSpeed() .. '|' .. tostring(TheApp.multiplayer.match_end_paused)
        `
      );
      if (speedState !== "Pause|true") {
        throw new Error(`FAIL: Player ${idx} simulation is not locked in Pause at match end! Got: ${speedState}`);
      }
    }
    const initialCountP1 = await p1.textContent("#vic-continue-status .vic-continue-count");
    if (initialCountP1.trim() !== "0 / 3 Continue") {
      throw new Error(`FAIL: Expected '0 / 3 Continue' initially, got: ${initialCountP1}`);
    }
    console.log("✓ All 3 simulations automatically paused and locked on match end (0 / 3 Continue).");

    // 3b. Player 1 clicks "Continue Playing" -> stays paused, p1 waits (1/3), p2 & p3 see "Waiting for your Continue!"
    await p1.click("#vic-continue");
    await p2.waitForFunction(() =>
      document.querySelector("#vic-continue-status")?.textContent.includes("1 / 3 Continue")
    );
    await p3.waitForFunction(() =>
      document.querySelector("#vic-continue-status")?.textContent.includes("1 / 3 Continue")
    );

    const stateAfterP1Continue = {
      p1BtnDisabled: await p1.$eval("#vic-continue", (b) => b.disabled),
      p1BtnText: await p1.textContent("#vic-continue"),
      p2Headline: await p2.textContent("#vic-continue-status .vic-continue-headline"),
      p2ModalHidden: await p2.$eval("#victory-modal", (el) => el.hidden),
      p1Speed: await evalLua(p1, "return TheApp.world:getCurrentSpeed()"),
      p2Speed: await evalLua(p2, "return TheApp.world:getCurrentSpeed()"),
    };
    console.log("After Player 1 clicked Continue:", stateAfterP1Continue);
    if (!stateAfterP1Continue.p1BtnDisabled || !stateAfterP1Continue.p1BtnText.includes("Waiting for Continue (1/3)")) {
      throw new Error(`FAIL: p1 Continue button did not switch to disabled waiting state! Got: ${JSON.stringify(stateAfterP1Continue)}`);
    }
    if (!stateAfterP1Continue.p2Headline.includes("Waiting for your Continue")) {
      throw new Error(`FAIL: p2 did not show 'Waiting for your Continue' message! Got: ${stateAfterP1Continue.p2Headline}`);
    }
    if (stateAfterP1Continue.p2ModalHidden || stateAfterP1Continue.p1Speed !== "Pause" || stateAfterP1Continue.p2Speed !== "Pause") {
      throw new Error("FAIL: Game unpaused prematurely before other players clicked Continue!");
    }
    console.log("✓ After p1 clicked Continue: game stays paused, p1 shows Waiting (1/3), p2 & p3 show 'Waiting for your Continue!'.");

    // 3c. Player 3 chooses "Return to Menu" ("oder halt raus") instead of Continue
    await p3.click("#vic-exit");
    await p3.waitForSelector("#menu:not([hidden])", { timeout: 10000 });

    // p1 and p2 should dynamically update to "1 / 2 Continue" (still paused because p2 hasn't clicked Continue yet!)
    await p1.waitForFunction(() =>
      document.querySelector("#vic-continue-status")?.textContent.includes("1 / 2 Continue")
    );
    await p2.waitForFunction(() =>
      document.querySelector("#vic-continue-status")?.textContent.includes("1 / 2 Continue")
    );
    const p1SpeedAfterP3Left = await evalLua(p1, "return TheApp.world:getCurrentSpeed()");
    if (p1SpeedAfterP3Left !== "Pause") {
      throw new Error(`FAIL: Simulation should still be Paused at 1/2 Continue! Got: ${p1SpeedAfterP3Left}`);
    }
    console.log("✓ Player 3 exited cleanly via Return to Menu; remaining players updated to 1 / 2 Continue and stayed Paused.");

    // 3d. Player 2 now clicks "Continue Playing" -> 2 / 2 active players ready -> modal closes & game unpauses to Normal!
    await p2.click("#vic-continue");

    await p1.waitForFunction(() => document.querySelector("#victory-modal").hidden === true, null, { timeout: 5000 });
    await p2.waitForFunction(() => document.querySelector("#victory-modal").hidden === true, null, { timeout: 5000 });

    const resumedState = {
      p1Speed: await evalLua(p1, "return TheApp.world:getCurrentSpeed() .. '|' .. tostring(TheApp.multiplayer.match_end_paused)"),
      p2Speed: await evalLua(p2, "return TheApp.world:getCurrentSpeed() .. '|' .. tostring(TheApp.multiplayer.match_end_paused)"),
      p1Timer: (await p1.textContent("#hud-timer")).trim(),
      p2Timer: (await p2.textContent("#hud-timer")).trim(),
    };
    console.log("After all remaining players clicked Continue:", resumedState);

    if (resumedState.p1Speed !== "Normal|false" || resumedState.p2Speed !== "Normal|false") {
      throw new Error(`FAIL: Expected both remaining players to unpause to Normal|false! Got: ${JSON.stringify(resumedState)}`);
    }
    if (resumedState.p1Timer !== "Free Play" || resumedState.p2Timer !== "Free Play") {
      throw new Error(`FAIL: Expected HUD timer to display 'Free Play'! Got: ${JSON.stringify(resumedState)}`);
    }
    console.log("✓ Barrier passed (2 / 2): Victory modal closed and simulation resumed to Normal speed (Free Play) on all remaining peers!");

    // 4. Strict Zero-SVG and Zero-Emoji Policy Verification
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements, got ${svgCount}`);
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const bodyText = await p1.evaluate(() => document.body.innerText);
    if (emojiRegex.test(bodyText)) {
      throw new Error("FAIL: Detected forbidden emoji character in page text!");
    }
    console.log("✓ Zero SVG icons and zero emojis verified across the entire page.");

    console.log("=== ALL CANVAS DRAG, HOSPITAL VALUE & MULTI-PLAYER CONTINUE TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
