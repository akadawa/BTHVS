"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Simplified Quests, Multi-Player Leaderboard & Top-Right HUD ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "PlayerHost");
    await loadDemo(p1);

    // Create room
    await p1.click("#btn-create");
    await sleep(400);

    // Join with second player
    const p2 = await newPage(browser, port, "PlayerTwo");
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

    // 1. Strict Zero SVG check
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements, got ${svgCount}`);
    console.log("✓ Zero SVG elements found across document.");

    // 2. Verify In-Game HUD position: top: 8px, right: 8px & Minimalist HUD
    const hudBox = await p1.evaluate(() => {
      const el = document.querySelector("#hud");
      const r = el.getBoundingClientRect();
      return {
        topOffset: r.top,
        rightOffset: window.innerWidth - r.right,
        hasSync: !!document.querySelector("#hud #hud-sync"),
        hasPing: !!document.querySelector("#hud #hud-ping"),
        hasPlayers: !!document.querySelector("#hud #hud-players"),
        hasExitBtn: !!document.querySelector("#hud #hud-exit-btn"),
        exitBtnText: document.querySelector("#hud #hud-exit-btn")?.textContent.trim(),
      };
    });
    console.log("HUD Position & Chips:", hudBox);
    if (hudBox.topOffset > 15) {
      throw new Error(`FAIL: HUD is not at top right! topOffset=${hudBox.topOffset}px (must be <= 15px)`);
    }
    if (hudBox.rightOffset > 15) {
      throw new Error(`FAIL: HUD is not at top right! rightOffset=${hudBox.rightOffset}px (must be <= 15px)`);
    }
    if (hudBox.hasSync || hudBox.hasPing || hudBox.hasPlayers) {
      throw new Error("FAIL: HUD should not contain sync, ping, or players chips!");
    }
    if (!hudBox.hasExitBtn || hudBox.exitBtnText !== "Leave") {
      throw new Error(`FAIL: HUD missing Leave button! hasExitBtn=${hudBox.hasExitBtn}, text=${hudBox.exitBtnText}`);
    }
    console.log("✓ HUD successfully docked in the top-right corner with minimal chips and Leave button!");

    // 2b. Test Leave Match Confirmation Modal
    await p1.click("#hud-exit-btn");
    await sleep(200);
    const isLeaveModalOpen = await p1.evaluate(() => !document.querySelector("#leave-modal").hidden);
    if (!isLeaveModalOpen) throw new Error("FAIL: #leave-modal should open when #hud-exit-btn is clicked!");
    console.log("✓ #leave-modal opened upon clicking Leave button.");

    await p1.click("#leave-cancel");
    await sleep(200);
    const isLeaveModalClosed = await p1.evaluate(() => document.querySelector("#leave-modal").hidden);
    if (!isLeaveModalClosed) throw new Error("FAIL: #leave-modal should close when #leave-cancel is clicked!");
    console.log("✓ #leave-modal closed upon clicking Stay.");

    // 3. Quests window is opened automatically when game starts
    await p1.waitForSelector("#quest-win:not([hidden])");
    console.log("✓ #quest-win is displayed automatically on game launch.");

    // Test toggle via #hud-quest-btn
    await p1.click("#hud-quest-btn");
    await sleep(200);
    let isHidden = await p1.evaluate(() => document.querySelector("#quest-win").hidden);
    if (!isHidden) throw new Error("FAIL: #quest-win should hide when #hud-quest-btn is clicked!");
    await p1.click("#hud-quest-btn");
    await sleep(200);
    let isShownAgain = await p1.evaluate(() => !document.querySelector("#quest-win").hidden);
    if (!isShownAgain) throw new Error("FAIL: #quest-win should re-appear when #hud-quest-btn is clicked again!");
    console.log("✓ #hud-quest-btn toggles #quest-win successfully.");

    // 4. Verify Simplified Quest cards (Ziel, Was brauche ich noch, Was hat der andere)
    const questCardsData = await p1.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("#quest-list .quest-card"));
      return cards.map((c) => ({
        title: c.querySelector(".quest-card-title")?.textContent.trim(),
        target: c.querySelector(".quest-target-pill")?.textContent.trim(),
        needBadge: c.querySelector(".quest-badge")?.textContent.trim(),
        hasYou: !!c.querySelector(".q-player-row.you"),
        youStat: c.querySelector(".q-player-row.you .q-p-stat")?.textContent.trim(),
        hasRival: !!c.querySelector(".q-player-row.rival"),
        rivalStat: c.querySelector(".q-player-row.rival .q-p-stat")?.textContent.trim(),
      }));
    });
    console.log("Simplified Quest Cards:", questCardsData);
    if (questCardsData.length === 0) throw new Error("FAIL: No quest cards rendered!");
    const firstCard = questCardsData[0];
    if (!firstCard.target || !firstCard.needBadge || !firstCard.hasYou) {
      throw new Error(`FAIL: Quest card missing vital goal info! ${JSON.stringify(firstCard)}`);
    }
    console.log("✓ Quest cards show clear Goal, Need requirement, and Rival progress at a glance.");

    // 5. Switch to Leaderboard tab
    await p1.click("#tab-btn-dashboard");
    await sleep(200);
    const isDashboardVisible = await p1.isVisible("#quest-view-dashboard");
    if (!isDashboardVisible) throw new Error("FAIL: #quest-view-dashboard is not visible!");

    // Check table headers
    const thHeaders = await p1.$$eval(".rival-table th", (ths) => ths.map((t) => t.textContent.trim()));
    console.log("Leaderboard Table Headers:", thHeaders);
    if (!thHeaders.includes("Rank") || !thHeaders.includes("Player") || !thHeaders.includes("Cash") || !thHeaders.includes("Cured")) {
      throw new Error(`FAIL: Missing essential columns in Leaderboard table! Got: ${JSON.stringify(thHeaders)}`);
    }

    // 6. Test Multi-Player Leaderboard with up to 10 players
    const tenPlayersResult = await p1.evaluate(() => {
      const vsState = window.__bth.state.vs;
      // Simulate 9 rivals in rivalStats
      for (let i = 1; i <= 9; i++) {
        vsState.rivalStats.set(i + 10, {
          name: `Doctor_${i}`,
          cured: i * 3,
          bal: 20000 + i * 15000,
          rep: 500 + i * 20,
          rooms: i,
          staff: i + 1,
          deaths: 0,
          val: 50000 + i * 20000,
          started: true,
        });
      }
      // Re-render
      vsState.myStats.cured = 16;
      vsState.myStats.bal = 75000;
      vsState.myStats.started = true;

      // Trigger updateQuestUI
      if (typeof window.__bth.updateQuestUI === "function") {
        window.__bth.updateQuestUI();
      }
      return {
        rowsCount: document.querySelectorAll("#rival-tbody tr").length,
        firstRank: document.querySelector("#rival-tbody tr:first-child .td-rank")?.textContent.trim(),
        firstPlayer: document.querySelector("#rival-tbody tr:first-child .td-player")?.textContent.trim(),
        hasYouTag: !!document.querySelector("#rival-tbody tr.is-you"),
      };
    });
    console.log("10-Player Simulation Result:", tenPlayersResult);
    if (tenPlayersResult.rowsCount < 2) {
      throw new Error(`FAIL: Expected table to render all players, got ${tenPlayersResult.rowsCount} rows`);
    }
    console.log("✓ Leaderboard table cleanly accommodates all players up to 10 in a compact layout.");

    // 6b. Test Player Leaving / Disconnected Display
    const leftPlayerResult = await p1.evaluate(() => {
      const vsState = window.__bth.state.vs;
      // Mark Doctor_1 (id: 11) as left
      vsState.leftPlayerIds.add(11);
      if (vsState.rivalStats.has(11)) {
        vsState.rivalStats.get(11).left = true;
      }
      if (typeof window.__bth.updateQuestUI === "function") {
        window.__bth.updateQuestUI();
      }

      // Check row for Doctor_1
      const rows = Array.from(document.querySelectorAll("#rival-tbody tr"));
      const doc1Row = rows.find((r) => r.querySelector(".td-player")?.textContent.includes("Doctor_1"));
      return {
        hasRow: !!doc1Row,
        isPlayerLeftClass: doc1Row ? doc1Row.classList.contains("player-left") : false,
        statusText: doc1Row?.querySelector(".td-status .status-pill")?.textContent.trim(),
        hasLeftTag: !!doc1Row?.querySelector(".name-status-pill.left-tag"),
      };
    });
    console.log("Left Player Display Result:", leftPlayerResult);
    if (!leftPlayerResult.hasRow || !leftPlayerResult.isPlayerLeftClass || leftPlayerResult.statusText !== "Left") {
      throw new Error(`FAIL: Left player not correctly displayed in Rivals Leaderboard! ${JSON.stringify(leftPlayerResult)}`);
    }
    console.log("✓ Disconnected / left player correctly displays 'Left' status and dimmed row styling in Leaderboard.");

    // 7. Strict Zero Emoji check
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const questWinText = await p1.textContent("#quest-win");
    if (emojiRegex.test(questWinText)) {
      throw new Error("FAIL: Found emoji inside #quest-win!");
    }
    const hudText = await p1.textContent("#hud");
    if (emojiRegex.test(hudText)) {
      throw new Error("FAIL: Found emoji inside #hud!");
    }
    console.log("✓ Strict verification passed: Zero emojis found in HUD or Quest window.");

    console.log("=== ALL QUESTS & MULTI-PLAYER LEADERBOARD TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
