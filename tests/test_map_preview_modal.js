"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Map / Level Question Mark Button and Map Preview Modal ===");
  const port = await listen();
  const browser = await launch();
  const pHost = await newPage(browser, port, "Host");
  const pGuest = await newPage(browser, port, "Guest");

  await Promise.all([loadDemo(pHost), loadDemo(pGuest)]);
  await pHost.fill("#player-name", "DrMapPreview");
  await pGuest.fill("#player-name", "NursePreview");

  // Host creates lobby
  await pHost.click("#btn-create");
  await pHost.waitForSelector("#card-lobby:not([hidden])");
  const roomCode = (await pHost.textContent("#room-code")).trim();

  // Guest joins lobby
  await pGuest.fill("#join-code", roomCode);
  await pGuest.click("#btn-join");
  await pGuest.waitForSelector("#card-lobby:not([hidden])");
  await sleep(400);

  // 1. Verify Question Mark Buttons exist next to Map / Level
  console.log("1. Checking question mark buttons in Host and Guest UI...");
  const hostBtn = await pHost.$("#btn-map-preview-host");
  const guestBtn = await pGuest.$("#btn-map-preview-guest");
  if (!hostBtn) throw new Error("FAIL: Missing #btn-map-preview-host button next to Map / Level!");
  if (!guestBtn) throw new Error("FAIL: Missing #btn-map-preview-guest button next to Guest Map line!");

  const hostBtnText = (await hostBtn.textContent()).trim();
  console.log("Host map button text:", hostBtnText);
  if (hostBtnText !== "?") throw new Error("FAIL: Host map preview button text must be '?'!");

  // 2. Click Host '?' and verify modal opens
  console.log("2. Clicking Host '?' button to open Map Preview Modal...");
  let isModalHidden = await pHost.$eval("#map-modal", (el) => el.hidden);
  if (!isModalHidden) throw new Error("FAIL: Map modal should be hidden by default!");

  await pHost.click("#btn-map-preview-host");
  await pHost.waitForFunction(() => !document.querySelector("#map-modal").hidden);
  console.log("✓ Map Preview Modal opened successfully!");

  // 3. Verify modal contents: Close button, title, and map cards
  console.log("3. Verifying map modal contents and previews...");
  const modalTitle = await pHost.textContent(".modal-title");
  console.log("Modal title:", modalTitle.trim());
  if (!modalTitle.includes("Maps")) throw new Error("FAIL: Missing modal title!");

  const closeBtn = await pHost.$("#map-modal-close");
  if (!closeBtn) throw new Error("FAIL: Missing #map-modal-close button!");

  const cardCount = await pHost.$$eval(".map-card", (cards) => cards.length);
  console.log("Rendered map cards count:", cardCount);
  if (cardCount < 6) throw new Error(`FAIL: Expected at least 6 map cards, found ${cardCount}!`);

  const cardNames = await pHost.$$eval(".map-card .map-card-name", (els) => els.map((e) => e.textContent.trim()));
  console.log("Sample map names:", cardNames.slice(0, 5));
  if (!cardNames.some((n) => n.includes("Town 1")) || !cardNames.some((n) => n.includes("Avatar"))) {
    throw new Error("FAIL: Map list must include Town 1 and Avatar!");
  }

  const cardImages = await pHost.$$eval(".map-card .map-card-thumb img", (imgs) => imgs.map((i) => i.getAttribute("src")));
  console.log("Sample map image sources:", cardImages.slice(0, 3));
  if (!cardImages[0].includes(".png")) throw new Error("FAIL: Map images must point to valid PNG previews!");

  // 4. Test closing modal via X button
  console.log("4. Testing closing modal via top-right X button...");
  await pHost.click("#map-modal-close");
  await pHost.waitForFunction(() => document.querySelector("#map-modal").hidden);
  console.log("✓ Modal closed successfully via X button!");

  // 5. Test selecting a map from the modal in Host mode
  console.log("5. Testing map selection from modal...");
  await pHost.click("#btn-map-preview-host");
  await pHost.waitForFunction(() => !document.querySelector("#map-modal").hidden);

  // Click 'Select Map' on Avatar
  const avatarSelectBtn = await pHost.$(".map-card[data-level='avatar'] .btn-select-map");
  if (!avatarSelectBtn) throw new Error("FAIL: Missing Select Map button on Avatar card!");
  await avatarSelectBtn.click();

  // Verify modal closed and dropdown updated
  await pHost.waitForFunction(() => document.querySelector("#map-modal").hidden);
  const selectedLevel = await pHost.$eval("#mp-level", (sel) => sel.value);
  console.log("Selected level in dropdown:", selectedLevel);
  if (selectedLevel !== "avatar") throw new Error(`FAIL: Expected 'avatar' selected in #mp-level, got ${selectedLevel}!`);
  console.log("✓ Map selection from modal updated dropdown to Avatar!");

  // Verify sync to guest
  await sleep(300);
  const guestLevelVal = await pGuest.textContent("#guest-level-val");
  console.log("Guest level value display:", guestLevelVal);
  if (!guestLevelVal.includes("Avatar")) throw new Error("FAIL: Guest should see 'Avatar' map updated!");
  console.log("✓ Map choice synchronized to Guest!");

  // 6. Test Guest clicking '?'
  console.log("6. Testing Guest clicking '?' button...");
  await pGuest.click("#btn-map-preview-guest");
  await pGuest.waitForFunction(() => !document.querySelector("#map-modal").hidden);
  console.log("✓ Guest successfully opened Map Preview Modal!");

  // Test closing via Escape key
  await pGuest.keyboard.press("Escape");
  await pGuest.waitForFunction(() => document.querySelector("#map-modal").hidden);
  console.log("✓ Modal closed via Escape key!");

  await browser.close();
  console.log("\n*** ALL MAP PREVIEW MODAL TESTS PASSED! ***");
  process.exit(0);
})().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
