"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing UI Improvements: Zero Icons, 'Game Files Needed' Notice, Bottom-Right HUD & Window Persistence ===");
  const port = await listen();
  const browser = await launch();

  try {
    // 1. Fresh visitor without data loaded -> test 'Game Files Needed' notice & zero icons
    const p1 = await newPage(browser, port, "FreshVisitor");
    await sleep(400);

    // Verify ZERO SVG elements
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) {
      throw new Error(`FAIL: Expected 0 SVG elements, found ${svgCount}!`);
    }
    console.log("✓ Zero SVG elements found on landing page.");

    // Verify "Game Files Needed" notice is displayed when game data is absent
    const cardModeDisabled = await p1.$eval("#card-mode", (el) => el.getAttribute("aria-disabled"));
    const noticeVisible = await p1.isVisible("#play-disabled-notice");
    const noticeText = (await p1.textContent("#play-disabled-notice")).trim();
    console.log("Play card aria-disabled:", cardModeDisabled, "Notice visible:", noticeVisible, "Notice text:", noticeText);

    if (cardModeDisabled !== "true") {
      throw new Error("FAIL: #card-mode must have aria-disabled='true' when data is missing!");
    }
    if (!noticeVisible || noticeText !== "Game Files Needed") {
      throw new Error(`FAIL: #play-disabled-notice should be visible with text 'Game Files Needed', got visible=${noticeVisible}, text='${noticeText}'`);
    }

    // Check notice positioning: centered inside #card-mode
    const noticeBox = await p1.evaluate(() => {
      const card = document.querySelector("#card-mode").getBoundingClientRect();
      const n = document.querySelector("#play-disabled-notice").getBoundingClientRect();
      const cardCenterY = card.top + card.height / 2;
      const noticeCenterY = n.top + n.height / 2;
      const cardCenterX = card.left + card.width / 2;
      const noticeCenterX = n.left + n.width / 2;
      return {
        distY: Math.abs(cardCenterY - noticeCenterY),
        distX: Math.abs(cardCenterX - noticeCenterX),
      };
    });
    console.log("Notice center offset relative to card:", noticeBox);
    if (noticeBox.distY > 20 || noticeBox.distX > 20) {
      throw new Error(`FAIL: Notice is not centered inside #card-mode! offset=${JSON.stringify(noticeBox)}`);
    }
    console.log("✓ 'Game Files Needed' notice is clearly and squarely centered in the Play card.");

    // Now load data
    await loadDemo(p1);
    await sleep(300);

    // Verify notice is hidden and card enabled
    const cardModeEnabled = await p1.$eval("#card-mode", (el) => el.getAttribute("aria-disabled"));
    const noticeVisibleAfterData = await p1.isVisible("#play-disabled-notice");
    if (cardModeEnabled !== "false" || noticeVisibleAfterData) {
      throw new Error(`FAIL: Notice should be hidden and card enabled after loading data! disabled=${cardModeEnabled}, visible=${noticeVisibleAfterData}`);
    }
    console.log("✓ 'Game Files Needed' notice cleanly disappears when game data is ready.");

    // Enter Lobby and verify zero icons in Lobby Chat, Cured Patients, Cash Balance, Time Limit
    await p1.click("#btn-create");
    await p1.waitForSelector("#card-lobby:not([hidden])", { timeout: 10000 });

    const lobbySvgCount = await p1.$$eval("svg", (els) => els.length);
    if (lobbySvgCount !== 0) {
      throw new Error(`FAIL: Expected 0 SVG elements in lobby, found ${lobbySvgCount}!`);
    }
    const lobbyChatHeader = await p1.textContent(".lobby-chat-header");
    const curedTitle = await p1.textContent("label[for='goal-cured'], .field-title");
    console.log("Lobby Chat Header text:", lobbyChatHeader.trim());
    if (lobbyChatHeader.includes("<svg") || lobbyChatHeader.includes("th-chat")) {
      throw new Error("FAIL: Lobby chat header must not contain icons!");
    }
    console.log("✓ Lobby chat and goal labels are completely icon-free and emoji-free.");

    // 2. Start game with second player to verify in-game HUD bottom-right positioning and window persistence
    const p2 = await newPage(browser, port, "Player2");
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
    await sleep(1000);

    // Verify HUD position: bottom: 8px, right: 8px
    const hudBox = await p1.evaluate(() => {
      const el = document.querySelector("#hud");
      const r = el.getBoundingClientRect();
      return {
        bottomOffset: window.innerHeight - r.bottom,
        rightOffset: window.innerWidth - r.right,
        height: r.height,
        bottom: r.bottom,
        windowHeight: window.innerHeight,
      };
    });
    console.log("In-Game HUD Position:", hudBox);
    if (hudBox.bottomOffset > 15) {
      throw new Error(`FAIL: HUD is not at the very bottom! bottomOffset=${hudBox.bottomOffset}px (must be <= 15px)`);
    }
    if (hudBox.rightOffset > 15) {
      throw new Error(`FAIL: HUD is not at the very right! rightOffset=${hudBox.rightOffset}px (must be <= 15px)`);
    }
    console.log("✓ In-Game HUD is docked right down at the bottom-right corner, on level with the menu bar!");

    // 3. Test Window Size & Position Persistence in localStorage
    console.log("\nTesting window resizing, dragging, and persistence...");
    // Open chat and quests windows
    await p1.waitForSelector("#chat:not([hidden])");
    await p1.waitForSelector("#quest-win:not([hidden])");

    // Simulate custom resizing and dragging for Quests
    await p1.evaluate(() => {
      const qWin = document.querySelector("#quest-win");
      qWin.style.left = "80px";
      qWin.style.top = "65px";
      qWin.style.width = "500px";
      qWin.style.height = "520px";
      window.__bth.saveWindowState("quests", qWin);

      const cWin = document.querySelector("#chat");
      cWin.style.left = "420px";
      cWin.style.top = "90px";
      cWin.style.width = "460px";
      cWin.style.height = "340px";
      window.__bth.saveWindowState("chat", cWin);
    });

    // Check localStorage content
    const savedQuests = await p1.evaluate(() => JSON.parse(localStorage.getItem("bth_win_quests")));
    const savedChat = await p1.evaluate(() => JSON.parse(localStorage.getItem("bth_win_chat")));
    console.log("Stored Quests Window State in localStorage:", savedQuests);
    console.log("Stored Chat Window State in localStorage:", savedChat);

    if (savedQuests.w !== 500 || savedQuests.h !== 520 || savedQuests.x !== 80 || savedQuests.y !== 65) {
      throw new Error(`FAIL: Quests window state not properly saved in localStorage! ${JSON.stringify(savedQuests)}`);
    }
    if (savedChat.w !== 460 || savedChat.h !== 340 || savedChat.x !== 420 || savedChat.y !== 90) {
      throw new Error(`FAIL: Chat window state not properly saved in localStorage! ${JSON.stringify(savedChat)}`);
    }

    // Now test restoreWindowState
    await p1.evaluate(() => {
      const qWin = document.querySelector("#quest-win");
      qWin.style.left = "0px";
      qWin.style.top = "0px";
      qWin.style.width = "100px";
      qWin.style.height = "100px";
      window.__bth.restoreWindowState("quests", qWin);

      const cWin = document.querySelector("#chat");
      cWin.style.left = "0px";
      cWin.style.top = "0px";
      cWin.style.width = "100px";
      cWin.style.height = "100px";
      window.__bth.restoreWindowState("chat", cWin);
    });

    const restoredQuests = await p1.evaluate(() => {
      const el = document.querySelector("#quest-win");
      return { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
    });
    const restoredChat = await p1.evaluate(() => {
      const el = document.querySelector("#chat");
      return { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
    });
    console.log("Restored Quests style:", restoredQuests);
    console.log("Restored Chat style:", restoredChat);

    if (restoredQuests.width !== "500px" || restoredQuests.height !== "520px" || restoredQuests.left !== "80px" || restoredQuests.top !== "65px") {
      throw new Error(`FAIL: Quests window not restored accurately: ${JSON.stringify(restoredQuests)}`);
    }
    if (restoredChat.width !== "460px" || restoredChat.height !== "340px" || restoredChat.left !== "420px" || restoredChat.top !== "90px") {
      throw new Error(`FAIL: Chat window not restored accurately: ${JSON.stringify(restoredChat)}`);
    }
    console.log("✓ In-game window size and position are reliably remembered and restored from localStorage!");

    console.log("\n*** ALL UI IMPROVEMENT TESTS PASSED! ***\n");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
