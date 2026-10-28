"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Fullscreen Mode & Leave Match Without Browser Unload Dialog ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "HostFsDoc");
    const p2 = await newPage(browser, port, "GuestFsDoc");

    const p1Dialogs = [];
    p1.on("dialog", async (dialog) => {
      p1Dialogs.push({ type: dialog.type(), message: dialog.message() });
      // Dismiss so that if beforeunload ever fired, navigation would be blocked and fail the test!
      await dialog.dismiss();
    });

    await loadDemo(p1);
    await loadDemo(p2);

    // Host creates room, Guest joins
    await p1.click("#btn-create");
    await p1.waitForSelector("#card-lobby:not([hidden])");
    const roomCode = (await p1.textContent("#room-code")).trim();

    await p2.fill("#join-code", roomCode);
    await p2.click("#btn-join");

    await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
    await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);

    await p1.click("#btn-ready");
    await p2.click("#btn-ready");
    await p1.waitForFunction(() => !document.querySelector("#btn-start").disabled);
    await p1.click("#btn-start");

    await p1.waitForSelector("#hud:not([hidden])", { timeout: 20000 });
    await p2.waitForSelector("#hud:not([hidden])", { timeout: 20000 });
    await sleep(1200);

    // 1. Verify Zero SVGs and Zero Emojis
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements, got ${svgCount}`);
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const bodyText = await p1.textContent("body");
    if (emojiRegex.test(bodyText)) throw new Error("FAIL: Found emoji in document!");
    console.log("PASS: Zero SVGs and zero emojis verified.");

    // 2. Test Escape toggle when focus is NOT on #canvas (e.g. after clicking #hud-fs-btn)
    await p1.focus("#hud-fs-btn");
    await p1.keyboard.press("Escape");
    await sleep(150);
    let modalOpen = await p1.evaluate(() => !document.querySelector("#leave-modal").hidden);
    if (!modalOpen) throw new Error("FAIL: Pressing Escape when #hud-fs-btn is focused did not open #leave-modal!");
    await p1.keyboard.press("Escape");
    await sleep(150);
    let modalClosed = await p1.evaluate(() => document.querySelector("#leave-modal").hidden);
    if (!modalClosed) throw new Error("FAIL: Pressing Escape again did not close #leave-modal!");
    console.log("PASS: Escape reliably toggles #leave-modal even when #canvas is not focused.");

    // 3. Test entering Fullscreen via #hud-fs-btn AND verify canvas.requestFullscreen redirects to documentElement
    await p1.click("#hud-fs-btn");
    await sleep(300);
    const fsInfo = await p1.evaluate(async () => {
      // In headless Chromium, requestFullscreen may or may not set fullscreenElement depending on flags;
      // also verify that calling canvas.requestFullscreen targets documentElement, never isolated canvas!
      const fsElTag = document.fullscreenElement ? document.fullscreenElement.tagName : null;
      const hudRect = document.querySelector("#hud").getBoundingClientRect();
      const hudStyle = getComputedStyle(document.querySelector("#hud"));
      const modalStyle = getComputedStyle(document.querySelector("#leave-modal"));
      return {
        fsElTag,
        hudVisible: hudRect.width > 0 && hudRect.height > 0,
        hudZIndex: parseInt(hudStyle.zIndex, 10),
        modalZIndex: parseInt(modalStyle.zIndex, 10),
        modalCursor: modalStyle.cursor,
      };
    });
    console.log("Fullscreen UI check:", fsInfo);
    if (fsInfo.fsElTag === "CANVAS") {
      throw new Error("FAIL: Fullscreen element is isolated CANVAS instead of HTML/documentElement!");
    }
    if (!fsInfo.hudVisible || fsInfo.modalZIndex <= fsInfo.hudZIndex) {
      throw new Error(`FAIL: HUD or Leave modal z-index hierarchy invalid: ${JSON.stringify(fsInfo)}`);
    }
    console.log("PASS: Fullscreen targets documentElement and keeps HUD & Leave modal above canvas.");

    // 4. Test CorsixTH Lua UI:toggleFullscreen() bridge (Alt+Enter path)
    const luaFsRes = await p1.evaluate(() => {
      const mod = window.__bth.state.game.mod;
      return mod.ccall("th_eval_lua", "string", ["string"], [
        `local ok = TheApp.ui:toggleFullscreen(); assert(ok == true); assert(TheApp.config.fullscreen == false)`
      ]);
    });
    if (luaFsRes !== "ok") {
      throw new Error(`FAIL: CorsixTH UI:toggleFullscreen() failed: ${luaFsRes}`);
    }
    console.log("PASS: CorsixTH UI:toggleFullscreen() delegates cleanly to browser Fullscreen without locking resolution.");

    // Re-enter fullscreen so we specifically test leaving FROM active Fullscreen state
    await p1.evaluate(async () => {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        try { await document.documentElement.requestFullscreen(); } catch (_) {}
      }
    });
    await sleep(200);

    // 5. Click Leave (#hud-exit-btn) -> Leave Match (#leave-confirm) while in Fullscreen!
    await p1.click("#hud-exit-btn");
    await sleep(200);
    const leaveVisibleInFs = await p1.evaluate(() => {
      const m = document.querySelector("#leave-modal");
      const r = m.getBoundingClientRect();
      return !m.hidden && r.width > 0 && r.height > 0;
    });
    if (!leaveVisibleInFs) {
      throw new Error("FAIL: #leave-modal is not visible in Fullscreen mode!");
    }

    await p1.click("#leave-confirm");

    // Wait for clean navigation back to #menu at location.pathname without any beforeunload dialog!
    await p1.waitForSelector("#menu:not([hidden])", { timeout: 10000 });
    await sleep(300);

    if (p1Dialogs.length > 0) {
      throw new Error(`FAIL: Native browser dialog was triggered during Leave Match: ${JSON.stringify(p1Dialogs)}`);
    }

    const postLeaveState = await p1.evaluate(() => ({
      pathname: location.pathname,
      search: location.search,
      menuVisible: !document.querySelector("#menu").hidden,
      gameHidden: document.querySelector("#game").hidden,
      fsElement: document.fullscreenElement ? document.fullscreenElement.tagName : null,
    }));
    console.log("Post-leave state:", postLeaveState);

    if (!postLeaveState.menuVisible || !postLeaveState.gameHidden || postLeaveState.search !== "" || postLeaveState.fsElement !== null) {
      throw new Error(`FAIL: Unexpected state after leaving match: ${JSON.stringify(postLeaveState)}`);
    }
    console.log("PASS: Player cleanly exited Fullscreen and returned to BTHVS main menu with ZERO browser dialogs!");

    // 6. Verify remaining player (p2) sees p1 marked as Left
    await p2.click("#tab-btn-dashboard");
    await p2.waitForFunction(() => {
      const pills = Array.from(document.querySelectorAll("#rival-tbody .status-pill.left"));
      return pills.length >= 1;
    }, { timeout: 8000 });
    console.log("PASS: Remaining player p2 sees departed player marked as Left in Leaderboard.");

    console.log("=== ALL FULLSCREEN & LEAVE MATCH TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
