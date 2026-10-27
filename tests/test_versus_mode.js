"use strict";
const { listen, launch, newPage, loadDemo, sleep, root } = require("./lib");
const path = require("path");
const fs = require("fs");

(async () => {
  console.log("=== Testing 1v1 Versus Rival Mode & Quest System ===");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[HostConsole]", m.text()));
  p2.on("console", (m) => console.log("[GuestConsole]", m.text()));

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "Chefarzt-Host");
  await p2.fill("#player-name", "Rivale-Gast");

  // 1. Host creates room
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();
  console.log("Room created:", code);

  // 2. Host selects goal: "cured_10"
  await p1.selectOption("#vs-goal", "cured_10");
  await sleep(300);

  // 3. Guest joins room
  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(600);

  // 4. Verify Guest sees the chosen goal
  const guestGoalText = await p2.textContent("#guest-goal-val");
  console.log("Guest goal display:", guestGoalText);
  if (!guestGoalText.includes("10 Patienten") && !guestGoalText.includes("Rettungsrennen")) {
    throw new Error(`Guest should see 'cured_10' goal, got: ${guestGoalText}`);
  }

  // 5. Host switches goal to "money_100k" -> Guest updates in real-time
  console.log("Host switches goal to money_100k...");
  await p1.selectOption("#vs-goal", "money_100k");
  await p1.evaluate(() => {
    document.querySelector("#vs-goal").dispatchEvent(new Event("change"));
  });
  await sleep(600);

  const guestGoalUpdated = await p2.textContent("#guest-goal-val");
  console.log("Guest updated goal display:", guestGoalUpdated);
  if (!guestGoalUpdated.includes("100.000") && !guestGoalUpdated.includes("Barvermögen")) {
    throw new Error(`Guest should see updated goal $100.000, got: ${guestGoalUpdated}`);
  }

  // 6. Both players click ready and host starts
  console.log("Both players readying up...");
  await p1.click("#btn-ready");
  await p2.click("#btn-ready");
  await sleep(500);

  const canStart = await p1.evaluate(() => !document.querySelector("#btn-start").disabled);
  if (!canStart) throw new Error("Host start button should be enabled after both are ready!");

  console.log("Starting versus match...");
  await p1.click("#btn-start");

  // Wait for game canvases to load
  await Promise.all([
    p1.waitForSelector("#canvas", { timeout: 25000 }),
    p2.waitForSelector("#canvas", { timeout: 25000 }),
  ]);
  console.log("Both players game canvas present!");
  await sleep(3000);

  // 7. Verify HUD elements
  const p1HudPlayers = await p1.textContent("#hud-players");
  const p2HudPlayers = await p2.textContent("#hud-players");
  console.log("Host HUD Players:", p1HudPlayers);
  console.log("Guest HUD Players:", p2HudPlayers);
  if (!p1HudPlayers.includes("Host") || !p1HudPlayers.includes("Gast")) {
    throw new Error("HUD should clearly identify Host and Gast!");
  }

  // 8. Open Quest window on both players
  console.log("Testing Quest window toggle...");
  await p1.click("#hud-quest-btn");
  await p1.waitForSelector("#quest-win:not([hidden])");

  await p2.keyboard.press("q");
  await p2.waitForSelector("#quest-win:not([hidden])");
  console.log("Quest window successfully opened on both clients!");

  // 9. Verify Active Quests view
  const p1QuestTitle = await p1.textContent("#quest-match-goal");
  console.log("Host Quest Match Goal footer:", p1QuestTitle);
  if (!p1QuestTitle.includes("100.000")) {
    throw new Error(`Quest goal footer should show $100.000 goal, got: ${p1QuestTitle}`);
  }

  const p1Cards = await p1.evaluate(() => {
    return Array.from(document.querySelectorAll("#quest-list .quest-card")).map(c => c.textContent.trim());
  });
  console.log("Quest cards rendered on Host:", p1Cards);
  if (p1Cards.length === 0) {
    throw new Error("At least one Quest Card should be rendered for money_100k!");
  }

  // 10. Switch to Rivalen-Dashboard Tab
  console.log("Switching to Rivalen-Dashboard tab on Host...");
  await p1.click("button[data-tab='dashboard']");
  await p1.waitForSelector("#quest-view-dashboard:not([hidden])");

  // 11. Test live telemetry stats injection to verify reactive updates
  console.log("Testing live telemetry updates...");
  await p1.evaluate(() => {
    // Simulate Lua calling bridge with local hospital stats
    window.__bth.state.game.mod.ccall ? null : null;
    // Call bridge directly via state hook
    const ev = "15000,600,2,2,0,0,25000"; // bal=15000, rep=600, rooms=2, staff=2, cured=0, deaths=0, val=25000
    // We can simulate bridge call:
    window.__bth.state.net.emit("msg", {
      from: 1,
      d: "vstats:12500,550,1,1,0,0,18000" // Opponent stats
    });
  });
  await sleep(500);

  const dashboardRows = await p1.evaluate(() => {
    return Array.from(document.querySelectorAll("#rival-tbody tr")).map(r => {
      const tds = Array.from(r.querySelectorAll("td")).map(td => td.textContent.trim());
      return tds.join(" | ");
    });
  });
  console.log("Dashboard rows after stats injection:\n" + dashboardRows.join("\n"));

  const hasStarted = dashboardRows.some(r => r.includes("🟢 Gestartet"));
  const hasOppVal = dashboardRows.some(r => r.includes("$60.000") || r.includes("60.000") || r.includes("$12.500") || r.includes("12.500"));
  if (!hasStarted || !hasOppVal) {
    throw new Error("Opponent stats not reflected in Rivalen-Dashboard!");
  }

  // 12. Test victory condition
  console.log("Testing win condition trigger...");
  await p1.evaluate(() => {
    // Send a win notification
    window.__bth.state.net.emit("msg", {
      from: 1,
      d: "win:1|Chefarzt-Host"
    });
  });
  await sleep(500);

  const victoryModalVisible = await p1.evaluate(() => !document.querySelector("#victory-modal").hidden);
  const victoryTitle = await p1.textContent("#vic-title");
  console.log("Victory Modal visible:", victoryModalVisible, "| Title:", victoryTitle);

  if (!victoryModalVisible || (!victoryTitle.includes("Sieg") && !victoryTitle.includes("gewinnt"))) {
    throw new Error("Victory modal should be visible with winner announcement!");
  }

  // Click Weiterspielen
  await p1.click("#vic-continue");
  const victoryModalHidden = await p1.evaluate(() => document.querySelector("#victory-modal").hidden);
  console.log("Victory Modal hidden after 'Weiterspielen':", victoryModalHidden);
  if (!victoryModalHidden) {
    throw new Error("Victory modal should close after clicking Weiterspielen!");
  }

  // Take screenshot of Versus Mode with Quest & Dashboard
  fs.mkdirSync(path.join(root, "tests", "out"), { recursive: true });
  await p1.screenshot({ path: path.join(root, "tests", "out", "versus_mode_dashboard.png") });
  console.log("Screenshot saved to tests/out/versus_mode_dashboard.png");

  console.log("=== Versus Mode Test PASSED Successfully! ===");
  await browser.close();
  process.exit(0);
})().catch(async (e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
