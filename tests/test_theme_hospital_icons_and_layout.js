"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Theme Hospital Retro Icons, Lobby Chat Alignment, and Auto-Opened Windows ===");
  const port = await listen();
  const browser = await launch();
  const pHost = await newPage(browser, port, "Host");
  const pGuest = await newPage(browser, port, "Guest");

  await Promise.all([loadDemo(pHost), loadDemo(pGuest)]);
  await pHost.fill("#player-name", "DrBullfrog");
  await pGuest.fill("#player-name", "NurseRetro");

  // 0. Verify Game Data status displays checkmark and exact source path for ZIP and Folder
  console.log("0. Checking Game Data status display (Checkmark, Folder vs ZIP, and Path)...");
  const zipStatusHtml = await pHost.innerHTML("#data-status");
  const zipStatusText = await pHost.textContent("#data-status");
  console.log("ZIP Status rendered:", zipStatusText);
  if (!zipStatusText.includes("✔") || !zipStatusText.includes("ready")) {
    throw new Error("FAIL: #data-status must display the checkmark ✔ and 'ready'!");
  }
  if (!zipStatusText.includes("ZIP File:")) {
    throw new Error("FAIL: #data-status must indicate 'ZIP File:' for ZIP uploads!");
  }
  const hasPathCode = await pHost.$("#data-status code.data-path-code");
  if (!hasPathCode) throw new Error("FAIL: #data-status must render code.data-path-code!");

  // Now test Folder import status rendering (e.g. Origin / EA installation path)
  await pHost.evaluate(() => {
    window.__bth.setData({
      files: [],
      demo: false,
      name: "Theme Hospital",
      bytes: 149200000,
      sourceType: "folder",
      sourcePath: "C:\\Program Files (x86)\\Origin Games\\Theme Hospital"
    });
  });
  const folderStatusText = await pHost.textContent("#data-status");
  console.log("Folder Status rendered:", folderStatusText);
  if (!folderStatusText.includes("✔") || !folderStatusText.includes("Folder:") || !folderStatusText.includes("Origin Games\\Theme Hospital")) {
    throw new Error("FAIL: #data-status must show checkmark ✔, 'Folder:', and exact EA/Origin path!");
  }
  console.log("✓ Game Data status correctly displays ✔ checkmark, Folder vs ZIP File, and exact source path.");

  // Re-restore demo data for subsequent game boot tests
  await loadDemo(pHost);

  // 1. Verify NO SVG icons or symbols in DOM (clean icon-free / emoji-free design)
  console.log("1. Checking that SVG spritesheet and icons are completely removed...");
  const symbols = await pHost.$$eval("svg defs symbol", (syms) => syms.map((s) => s.id));
  if (symbols.length > 0) {
    throw new Error(`FAIL: Found SVG symbols in DOM: ${symbols.join(", ")}`);
  }
  const allSvgIcons = await pHost.$$eval(".th-icon, svg", (svgs) => svgs.length);
  if (allSvgIcons > 0) {
    throw new Error(`FAIL: Found ${allSvgIcons} SVG elements in page! All icons must be removed.`);
  }
  console.log("✓ Zero SVG icons and zero spritesheet symbols verified in DOM.");

  // Verify Header Hosted Lobbies Counter
  const hasHeaderCounter = await pHost.$("#header-lobbies-hosted");
  const initialHostedText = await pHost.textContent("#count-lobbies-hosted");
  console.log("Header lobbies hosted element present, initial count:", initialHostedText);
  if (!hasHeaderCounter || initialHostedText === null) {
    throw new Error("FAIL: Missing #header-lobbies-hosted counter in header!");
  }
  console.log("✓ Header features Total Hosted Lobbies counter in bottom-right corner.");

  // Verify Game Data Notes (GitHub, Serverless / Roadmap, Pause Notice)
  const notesText = await pHost.textContent(".data-project-notes");
  console.log("Game Data notes preview:", notesText.slice(0, 120));
  if (!notesText.includes("github.com/akadawa/BTHVS") && !notesText.includes("GitHub (akadawa/BTHVS)")) {
    throw new Error("FAIL: Missing GitHub repository link in Game Data!");
  }
  if (!notesText.includes("serverless") && !notesText.includes("Serverless")) {
    throw new Error("FAIL: Missing serverless on Vercel notice in Game Data!");
  }
  if (!notesText.includes("dedicated") && !notesText.includes("Dedicated")) {
    throw new Error("FAIL: Missing future dedicated server roadmap description!");
  }
  if (!notesText.includes("pause") && !notesText.includes("fax")) {
    throw new Error("FAIL: Missing notice that game briefly pauses during dialogs/choices/faxes!");
  }
  console.log("✓ Game Data notes contain GitHub link, serverless testing & dedicated server roadmap, and dialog pause notice.");

  // Verify Footer Card design, Based on, and GitHub link (Network WebSockets line removed as requested)
  const footerCard = await pHost.$("footer.card.footer-card");
  if (!footerCard) throw new Error("FAIL: Footer must have .card.footer-card class to match other cards!");
  const footerWidthMatch = await pHost.evaluate(() => {
    const cardData = document.querySelector("#card-data");
    const footer = document.querySelector("footer.footer-card");
    return cardData && footer && Math.abs(cardData.offsetWidth - footer.offsetWidth) < 4;
  });
  if (!footerWidthMatch) throw new Error("FAIL: Footer card should have the same width as the other cards!");
  const footerText = await pHost.textContent("footer.footer-card");
  console.log("Footer text display:", footerText.trim());
  if (!footerText.includes("Based on") || !footerText.includes("GitHub")) {
    throw new Error("FAIL: Footer must contain 'Based on' and 'GitHub'!");
  }
  if (footerText.includes("Network:") || footerText.includes("WebSockets")) {
    throw new Error("FAIL: Footer must NOT display Network WebSockets line!");
  }
  console.log("✓ Footer cleanly displays 'Based on' and GitHub join link without Network WebSockets line.");

  // 2. Test Lobby Chat Height Alignment with Left Column
  console.log("2. Checking Lobby Chat height alignment...");
  await pHost.click("#btn-create");
  await pHost.waitForSelector("#card-lobby:not([hidden])");
  const roomCode = (await pHost.textContent("#room-code")).trim();

  // Verify #goal-summary-box is removed from lobby to prevent layout jumping
  const goalSummaryBox = await pHost.$("#goal-summary-box");
  if (goalSummaryBox !== null) {
    throw new Error("FAIL: #goal-summary-box must be removed to avoid layout shifting on dropdown change!");
  }
  console.log("✓ Active match conditions summary box removed for stable, static layout.");

  await pGuest.fill("#join-code", roomCode);
  await pGuest.click("#btn-join");
  await pHost.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);

  // Measure bottom baseline of left column vs lobby chat box vs divider
  const alignment = await pHost.evaluate(() => {
    const leftCol = document.querySelector(".lobby-col-left");
    const chatBox = document.querySelector("#lobby-chat-box");
    const divider = document.querySelector(".lobby-divider");
    const leftRect = leftCol.getBoundingClientRect();
    const chatRect = chatBox.getBoundingClientRect();
    const divRect = divider.getBoundingClientRect();
    return {
      leftBottom: leftRect.bottom,
      chatBottom: chatRect.bottom,
      dividerTop: divRect.top,
      diff: Math.abs(leftRect.bottom - chatRect.bottom),
    };
  });
  console.log("Lobby layout alignment measurements:", alignment);
  // Both columns should end within 2px of each other (align-items: stretch)
  if (alignment.diff > 2) {
    throw new Error(`FAIL: Lobby chat box bottom (${alignment.chatBottom}) does not align with left column bottom (${alignment.leftBottom})! Diff: ${alignment.diff}px`);
  }
  if (alignment.dividerTop < alignment.leftBottom - 1) {
    throw new Error(`FAIL: Divider should sit beneath left column and chat box!`);
  }
  console.log("✓ Lobby chat box height perfectly stretches to match the left column down to the divider line!");

  // Send a message in lobby chat
  await pHost.fill("#lobby-chat-input", "Welcome to Theme Hospital Versus!");
  await pHost.click("#lobby-chat-form button[type='submit']");
  await sleep(300);

  // 3. Start game and verify auto-open of Chat and Quests, and message preservation
  console.log("3. Verifying auto-open of In-Game Chat and Quests on match start...");
  await pHost.click("#btn-ready");
  await pGuest.click("#btn-ready");
  await pHost.waitForFunction(() => document.querySelector("#btn-start:not([disabled])"));
  await pHost.click("#btn-start");

  await Promise.all([
    pHost.waitForSelector("#game:not([hidden])", { timeout: 15000 }),
    pGuest.waitForSelector("#game:not([hidden])", { timeout: 15000 }),
  ]);
  await pHost.waitForFunction(() => document.querySelector("#loading")?.hidden);
  await sleep(400);

  const isChatOpen = await pHost.isVisible("#chat");
  const isQuestOpen = await pHost.isVisible("#quest-win");
  console.log("In-game windows visible on start -> Chat:", isChatOpen, "Quests:", isQuestOpen);
  if (!isChatOpen) throw new Error("FAIL: In-game Chat must be auto-opened on match start!");
  if (!isQuestOpen) throw new Error("FAIL: In-game Quests must be auto-opened on match start!");

  // Verify non-overlapping positions (Quests on left, Chat on right)
  const windowPositions = await pHost.evaluate(() => {
    const qRect = document.querySelector("#quest-win").getBoundingClientRect();
    const cRect = document.querySelector("#chat").getBoundingClientRect();
    return {
      quest: { left: qRect.left, right: qRect.right, top: qRect.top },
      chat: { left: cRect.left, right: cRect.right, top: cRect.top },
      overlaps: !(qRect.right < cRect.left || qRect.left > cRect.right || qRect.bottom < cRect.top || qRect.top > cRect.bottom),
    };
  });
  console.log("Window layout positions:", windowPositions);
  if (windowPositions.overlaps) {
    throw new Error("FAIL: Quests and Chat windows overlap each other!");
  }
  console.log("✓ Quests window (top-left) and Chat window (top-right) are both cleanly displayed without overlapping!");

  // Verify lobby chat message was carried over to in-game chat
  const inGameChatContent = await pHost.textContent("#chat-log");
  console.log("In-game chat log text:", inGameChatContent);
  if (!inGameChatContent.includes("Welcome to Theme Hospital Versus!")) {
    throw new Error("FAIL: Lobby chat messages were not preserved into in-game chat!");
  }
  console.log("✓ Lobby chat conversation preserved into in-game chat log.");

  // Verify HUD Timer has NO icons
  const hudTimerIcon = await pHost.$eval("#hud-timer", (el) => el.innerHTML);
  if (hudTimerIcon.includes("<svg") || hudTimerIcon.includes("#th-")) {
    throw new Error("FAIL: HUD Timer must not contain any icons or SVGs!");
  }
  console.log("✓ HUD timer is clean and icon-free.");

  // Verify Rival Dashboard metrics have NO icons
  await pHost.click('#quest-tabs button[data-tab="dashboard"]');
  await sleep(200);
  const dashboardIcons = await pHost.$$eval("#rival-tbody tr td svg", (svgs) => svgs.length);
  if (dashboardIcons > 0) {
    throw new Error(`FAIL: Rival dashboard has ${dashboardIcons} icons! Must be 0.`);
  }
  console.log("✓ Rival Dashboard displays cleanly without icons across all hospital metrics!");

  await pHost.screenshot({ path: "tests/out/theme_hospital_icons_host.png" });
  await pGuest.screenshot({ path: "tests/out/theme_hospital_icons_guest.png" });
  console.log("Screenshots saved to tests/out/theme_hospital_icons_*.png");

  await browser.close();
  console.log("\n*** ALL THEME HOSPITAL ICONS AND LAYOUT TESTS PASSED! ***\n");
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
