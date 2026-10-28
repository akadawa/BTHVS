"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Leaderboard Drawer & Fixed Username with Lock Notice & Zero Icons/Emojis ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "LeaderboardVisitor");
    await loadDemo(p1);
    await sleep(400);

    // 1. Verify ZERO SVG elements
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) {
      throw new Error(`FAIL: Expected 0 SVG elements, found ${svgCount}!`);
    }
    console.log("✓ Zero SVG elements found across document.");

    // 2. Verify Username Info indicator '?' and permanently visible notice
    const btnUserHelp = await p1.$("#btn-username-info");
    if (!btnUserHelp) throw new Error("FAIL: #btn-username-info not found!");
    const btnUserHelpText = (await btnUserHelp.textContent()).trim();
    if (btnUserHelpText !== "?") {
      throw new Error(`FAIL: #btn-username-info text should be '?', got '${btnUserHelpText}'`);
    }

    // Info notice should be permanently visible (does not collapse/unfold)
    const hintVisible = await p1.isVisible("#username-info-box");
    if (!hintVisible) throw new Error("FAIL: #username-info-box should be permanently visible!");
    const hintText = await p1.textContent("#username-info-box");
    if (!hintText.includes("Leaderboard") || !hintText.includes("cache")) {
      throw new Error(`FAIL: #username-info-box text missing key notice, got: ${hintText}`);
    }
    // Verify question mark icon/pill inside the hint card
    const hintPill = await p1.$("#username-info-box .hint-mark-pill");
    if (!hintPill) throw new Error("FAIL: .hint-mark-pill not found inside #username-info-box!");

    // Clicking '?' highlights the card without collapsing it
    await p1.click("#btn-username-info");
    await sleep(150);
    const stillVisible = await p1.isVisible("#username-info-box");
    if (!stillVisible) throw new Error("FAIL: #username-info-box should remain visible after clicking '?'!");
    console.log("✓ Username notice is permanently visible with '?' indicator mark.");

    // 3. Test Username Input & Locking
    await p1.fill("#player-name", "Dr. House");
    await p1.click("#btn-lock-name");
    await sleep(200);

    const isLocked = await p1.evaluate(() => {
      const input = document.querySelector("#player-name");
      const badge = document.querySelector("#player-name-lock-badge");
      const btn = document.querySelector("#btn-lock-name");
      const stored = localStorage.getItem("bth-name");
      const lockedFlag = localStorage.getItem("bth-name-locked");
      return {
        readOnly: input ? input.readOnly : false,
        hasLockedClass: input ? input.classList.contains("locked") : false,
        badgeVisible: badge ? !badge.hidden : false,
        btnText: btn ? btn.textContent.trim() : "",
        storedName: stored,
        lockedFlag: lockedFlag
      };
    });
    console.log("Username lock state:", isLocked);
    if (!isLocked.readOnly || !isLocked.hasLockedClass || !isLocked.badgeVisible || isLocked.btnText !== "Change") {
      throw new Error(`FAIL: Username was not properly locked! State: ${JSON.stringify(isLocked)}`);
    }
    if (isLocked.storedName !== "Dr. House" || isLocked.lockedFlag !== "true") {
      throw new Error(`FAIL: localStorage not updated correctly: ${JSON.stringify(isLocked)}`);
    }
    console.log("✓ Username successfully locked and stored in browser data.");

    // 4. Test Leaderboard Toggle Button on Far Right (right: 0)
    const lbBtn = await p1.$("#leaderboard-btn");
    if (!lbBtn) throw new Error("FAIL: #leaderboard-btn not found!");
    const lbBtnText = (await lbBtn.textContent()).trim();
    if (lbBtnText !== "Leaderboard") {
      throw new Error(`FAIL: #leaderboard-btn text should be 'Leaderboard', got '${lbBtnText}'`);
    }
    const lbBox = await lbBtn.boundingBox();
    console.log("Leaderboard button bounding box:", lbBox);
    const windowWidth = await p1.evaluate(() => window.innerWidth);
    if (lbBox.x + lbBox.width < windowWidth - 10) {
      throw new Error(`FAIL: #leaderboard-btn should be docked on the far right (x+w >= ${windowWidth - 10}), got ${lbBox.x + lbBox.width}`);
    }
    console.log("✓ #leaderboard-btn is docked to the far right edge.");

    // 5. Open Leaderboard Drawer
    await p1.click("#leaderboard-btn");
    await sleep(350);

    const isDrawerOpen = await p1.evaluate(() => {
      const d = document.querySelector("#leaderboard-drawer");
      return d && d.classList.contains("open");
    });
    if (!isDrawerOpen) throw new Error("FAIL: #leaderboard-drawer does not have class 'open'!");
    console.log("✓ #leaderboard-drawer opened successfully.");

    // 6. Verify Player Card & Overview (starts at clean 0 state)
    const playerCardData = await p1.evaluate(() => {
      return {
        name: document.querySelector("#lb-my-name")?.textContent.trim(),
        status: document.querySelector("#lb-my-status")?.textContent.trim(),
        rank: document.querySelector("#lb-my-rank")?.textContent.trim(),
        cured: document.querySelector("#lb-my-cured")?.textContent.trim(),
        active: document.querySelector("#lb-active-count")?.textContent.trim(),
        games: document.querySelector("#lb-games-count")?.textContent.trim()
      };
    });
    console.log("Player Card in Leaderboard:", playerCardData);
    if (playerCardData.name !== "Dr. House") {
      throw new Error(`FAIL: Expected Dr. House on player card, got: '${playerCardData.name}'`);
    }
    if (playerCardData.cured !== "0" || playerCardData.games !== "0") {
      throw new Error(`FAIL: Expected leaderboard stats to start at 0, got: cured=${playerCardData.cured}, games=${playerCardData.games}`);
    }
    console.log("✓ Player Card accurately reflects locked doctor name and clean zero start state.");

    // 7. Verify Tabs and Rankings
    const tabs = ["cured", "cash", "playtime", "lobbies", "wins"];
    for (const tab of tabs) {
      await p1.click(`.lb-tab[data-tab="${tab}"]`);
      await sleep(150);
      const itemsCount = await p1.$$eval(".lb-item", (els) => els.length);
      if (itemsCount < 1) {
        throw new Error(`FAIL: Tab '${tab}' has fewer than 1 leaderboard items (got ${itemsCount})!`);
      }
      const topName = await p1.evaluate(() => document.querySelector(".lb-item .lb-item-name")?.textContent.trim());
      const topVal = await p1.evaluate(() => document.querySelector(".lb-item .lb-item-val")?.textContent.trim());
      console.log(`Tab '${tab}': ${itemsCount} doctors, Top 1: ${topName} (${topVal})`);
    }
    console.log("✓ All 5 Leaderboard categories verified with clean zero ranking.");

    // 8. Strict Zero Emojis check in Leaderboard Drawer
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const allDrawerText = await p1.evaluate(() => document.querySelector("#leaderboard-drawer")?.innerText || "");
    if (emojiRegex.test(allDrawerText)) {
      throw new Error("FAIL: Found emoji inside leaderboard drawer!");
    }
    console.log("✓ Strict verification passed: Zero emojis found in leaderboard drawer.");

    // 9. Test Close Drawer via close button
    await p1.click("#leaderboard-close");
    await sleep(250);
    const isClosed = await p1.evaluate(() => !document.querySelector("#leaderboard-drawer").classList.contains("open"));
    if (!isClosed) throw new Error("FAIL: Leaderboard drawer did not close on #leaderboard-close click!");
    console.log("✓ Leaderboard drawer closed via close button.");

    // 10. Re-open and close via Escape
    await p1.click("#leaderboard-btn");
    await sleep(200);

    // 11. Test Reset Stats Button and Single-Recording Guard
    console.log("Testing Reset Stats button & single-recording victory guard...");
    const resetBtn = await p1.$("#btn-reset-stats");
    if (!resetBtn) throw new Error("FAIL: #btn-reset-stats not found!");

    // Simulate accumulated stats
    await p1.evaluate(() => {
      window.__bth.recordMatchStats(true, 12, 45000, 25);
      window.__bth.renderLeaderboard("cured");
    });
    const statsBeforeReset = await p1.evaluate(() => window.__bth.getPlayerStats());
    console.log("Stats before reset:", statsBeforeReset);
    if (statsBeforeReset.cured !== 12 || statsBeforeReset.games !== 1) {
      throw new Error(`FAIL: Stats were not simulated properly: ${JSON.stringify(statsBeforeReset)}`);
    }

    // Click Reset Stats
    await p1.click("#btn-reset-stats");
    await sleep(200);

    const statsAfterReset = await p1.evaluate(() => window.__bth.getPlayerStats());
    console.log("Stats after reset:", statsAfterReset);
    if (statsAfterReset.cured !== 0 || statsAfterReset.cash !== 0 || statsAfterReset.games !== 0 || statsAfterReset.wins !== 0) {
      throw new Error(`FAIL: Stats were not cleanly reset to zero! Got: ${JSON.stringify(statsAfterReset)}`);
    }
    const resetBtnTxt = await p1.$eval("#btn-reset-stats", (el) => el.textContent.trim());
    if (resetBtnTxt !== "Stats Reset!") {
      throw new Error(`FAIL: Expected 'Stats Reset!' button feedback, got '${resetBtnTxt}'`);
    }
    console.log("✓ #btn-reset-stats cleanly wiped all stats to 0 and showed confirmation feedback.");

    // Verify victory modal guard: multiple calls must not inflate stats
    await p1.evaluate(() => {
      // Simulate state.vs
      window.__bth.state.vs = {
        goals: { cured: 25, money: 100000, timeLimit: 30 },
        startTime: Date.now() - 60000,
        myStats: { cured: 5, bal: 30000 },
        oppStats: { cured: 2, bal: 20000 },
        winner: null,
        matchRecorded: false
      };
      // Simulate 10 rapid triggers
      for (let i = 0; i < 10; i++) {
        window.__bth.checkWinConditions();
      }
    });
    const guardedStats = await p1.evaluate(() => window.__bth.getPlayerStats());
    console.log("Stats after 10 rapid victory triggers:", guardedStats);
    if (guardedStats.games > 1) {
      throw new Error(`FAIL: Victory guard failed! Games count inflated to ${guardedStats.games}`);
    }
    console.log("✓ Single-recording victory guard verified: stats cannot run away in rapid loops.");

    // Clean reset back to 0
    await p1.evaluate(() => window.__bth.resetAllStats());

    await p1.keyboard.press("Escape");
    await sleep(200);
    const isClosedByEsc = await p1.evaluate(() => !document.querySelector("#leaderboard-drawer").classList.contains("open"));
    if (!isClosedByEsc) throw new Error("FAIL: Leaderboard drawer did not close on Escape key!");
    console.log("✓ Leaderboard drawer closed via Escape key.");

    console.log("=== ALL LEADERBOARD & USERNAME TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
