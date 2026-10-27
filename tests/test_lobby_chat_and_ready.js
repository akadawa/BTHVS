"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Lobby Chat & Ready Button Synchronization ===");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  p1.on("console", (m) => console.log("[HostConsole]", m.text()));
  p2.on("console", (m) => console.log("[GuestConsole]", m.text()));

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "HostDoc");
  await p2.fill("#player-name", "GuestDoc");

  // 1. Host creates room
  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();
  console.log("Room created:", code);

  // 2. Guest joins room
  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p2.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await sleep(600);

  // 3. Verify initial ready status: both are "⏳ Wartet", and Host's Start button is disabled
  const checkInitialReady = async (page) => {
    return page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll("#player-list .badge-ready")).map(b => b.textContent.trim());
      const btnReadyText = document.querySelector("#btn-ready")?.textContent.trim();
      const startDisabled = document.querySelector("#btn-start")?.disabled;
      return { badges, btnReadyText, startDisabled };
    });
  };

  const p1Init = await checkInitialReady(p1);
  const p2Init = await checkInitialReady(p2);
  console.log("Host initial ready state:", p1Init);
  console.log("Guest initial ready state:", p2Init);

  if (p1Init.badges.length !== 2 || !p1Init.badges.every(b => b.includes("Wartet"))) {
    throw new Error("Both players should initially have status '⏳ Wartet'!");
  }
  if (!p1Init.startDisabled) {
    throw new Error("Host's 'Spiel starten' button MUST be disabled initially!");
  }

  // 4. Test Lobby Chat: Host sends message, Guest verifies receipt
  console.log("Testing Host -> Guest chat...");
  await p1.fill("#lobby-chat-input", "Hallo vom Host!");
  await p1.click("#lobby-chat-form button[type='submit']");
  await sleep(500);

  const p2ChatHasHostMsg = await p2.evaluate(() => {
    return document.querySelector("#lobby-chat-log").textContent.includes("Hallo vom Host!");
  });
  if (!p2ChatHasHostMsg) {
    throw new Error("Guest did not receive Host's chat message in #lobby-chat-log!");
  }
  console.log("Host -> Guest chat verified!");

  // Guest sends message, Host verifies receipt
  console.log("Testing Guest -> Host chat...");
  await p2.fill("#lobby-chat-input", "Hi Host, ich bin startklar!");
  await p2.click("#lobby-chat-form button[type='submit']");
  await sleep(500);

  const p1ChatHasGuestMsg = await p1.evaluate(() => {
    return document.querySelector("#lobby-chat-log").textContent.includes("Hi Host, ich bin startklar!");
  });
  if (!p1ChatHasGuestMsg) {
    throw new Error("Host did not receive Guest's chat message in #lobby-chat-log!");
  }
  console.log("Guest -> Host chat verified!");

  // 5. Host attempts to start before both are ready -> should be blocked
  console.log("Verifying Host cannot start before ready...");
  await p1.evaluate(() => window.__bth.hostStart());
  await sleep(500);
  const hostStartedEarly = await p1.evaluate(() => !document.getElementById("game").hidden);
  if (hostStartedEarly) {
    throw new Error("Game started even though players were not ready!");
  }
  console.log("Start block verified!");

  // 6. Guest clicks [✓ Bereit melden]
  console.log("Guest clicks [✓ Bereit melden]...");
  await p2.click("#btn-ready");
  await sleep(600);

  const p1AfterGuestReady = await p1.evaluate(() => {
    const badges = Array.from(document.querySelectorAll("#player-list li")).map(li => ({
      text: li.querySelector("span")?.textContent,
      ready: li.querySelector(".badge-ready")?.textContent.trim(),
    }));
    const startDisabled = document.querySelector("#btn-start")?.disabled;
    return { badges, startDisabled };
  });
  console.log("Host view after Guest ready:", p1AfterGuestReady);

  const guestItemOnHost = p1AfterGuestReady.badges.find(b => b.text.includes("GuestDoc"));
  const hostItemOnHost = p1AfterGuestReady.badges.find(b => b.text.includes("HostDoc"));

  if (!guestItemOnHost || !guestItemOnHost.ready.includes("Bereit")) {
    throw new Error("Guest should be marked '✓ Bereit' on Host's screen!");
  }
  if (!hostItemOnHost || !hostItemOnHost.ready.includes("Wartet")) {
    throw new Error("Host should still be marked '⏳ Wartet'!");
  }
  if (!p1AfterGuestReady.startDisabled) {
    throw new Error("Host's start button MUST still be disabled when only Guest is ready!");
  }

  // 7. Host clicks [✓ Bereit melden]
  console.log("Host clicks [✓ Bereit melden]...");
  await p1.click("#btn-ready");
  await sleep(600);

  const p1BothReady = await p1.evaluate(() => {
    const badges = Array.from(document.querySelectorAll("#player-list .badge-ready")).map(b => b.textContent.trim());
    const startDisabled = document.querySelector("#btn-start")?.disabled;
    const hasAllReadyClass = document.querySelector("#btn-start")?.classList.contains("all-ready");
    return { badges, startDisabled, hasAllReadyClass };
  });
  console.log("Host view when both ready:", p1BothReady);

  if (p1BothReady.badges.length !== 2 || !p1BothReady.badges.every(b => b.includes("Bereit"))) {
    throw new Error("Both players should now be marked '✓ Bereit'!");
  }
  if (p1BothReady.startDisabled) {
    throw new Error("Host's start button MUST now be enabled!");
  }
  if (!p1BothReady.hasAllReadyClass) {
    throw new Error("Host's start button should have class 'all-ready'!");
  }
  console.log("Both ready & button enabled verified!");

  // 8. Test settings change resets ready state
  console.log("Host changes goal to test ready-reset...");
  await p1.selectOption("#vs-goal", "cured_10");
  await p1.evaluate(() => document.querySelector("#vs-goal").dispatchEvent(new Event("change")));
  await sleep(600);

  const p1AfterModeChange = await p1.evaluate(() => {
    const badges = Array.from(document.querySelectorAll("#player-list .badge-ready")).map(b => b.textContent.trim());
    const startDisabled = document.querySelector("#btn-start")?.disabled;
    const chatLog = document.querySelector("#lobby-chat-log").textContent;
    return { badges, startDisabled, hasResetMsg: chatLog.includes("zurückgesetzt") };
  });
  console.log("Host view after mode change:", p1AfterModeChange);

  if (!p1AfterModeChange.badges.every(b => b.includes("Wartet"))) {
    throw new Error("Changing settings did not reset players' ready statuses!");
  }
  if (!p1AfterModeChange.startDisabled) {
    throw new Error("Start button should be disabled after settings change reset!");
  }
  if (!p1AfterModeChange.hasResetMsg) {
    throw new Error("Lobby chat did not announce ready reset on settings change!");
  }
  console.log("Settings change ready-reset verified!");

  // 9. Both ready up again
  console.log("Both re-confirm ready...");
  await p1.click("#btn-ready");
  await sleep(300);
  await p2.click("#btn-ready");
  await sleep(600);

  const p1ReadyAgain = await p1.evaluate(() => document.querySelector("#btn-start")?.disabled);
  if (p1ReadyAgain) {
    throw new Error("Start button should be enabled after both re-confirm ready!");
  }

  // 10. Host starts the game
  console.log("Host clicking 'Spiel starten'...");
  const hostDebugBeforeClick = await p1.evaluate(() => {
    return {
      btnDisabled: document.querySelector("#btn-start")?.disabled,
      lobby: window.__bth?.state?.lobby,
      netState: window.__bth?.state?.net?.ws?.readyState,
    };
  });
  console.log("Host debug before click:", hostDebugBeforeClick);

  await p1.click("#btn-start");
  await sleep(1000);

  const hostDebugAfterClick = await p1.evaluate(() => {
    return {
      gameHidden: document.querySelector("#game")?.hidden,
      menuHidden: document.querySelector("#menu")?.hidden,
      lobby: window.__bth?.state?.lobby,
      errorText: document.querySelector("#menu-error")?.textContent,
      chatLog: document.querySelector("#lobby-chat-log")?.textContent,
    };
  });
  console.log("Host debug after click:", hostDebugAfterClick);

  // Wait for game screen to become visible on both
  await Promise.all([
    p1.waitForSelector("#game:not([hidden])", { timeout: 15000 }),
    p2.waitForSelector("#game:not([hidden])", { timeout: 15000 }),
  ]);

  console.log("SUCCESS! Game launched successfully for both players after both were ready!");
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
