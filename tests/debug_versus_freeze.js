"use strict";
const { chromium } = require("./node_modules/playwright");
const { loadDemo, sleep } = require("./lib");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context1 = await browser.newContext();
  const context2 = await browser.newContext();

  const pHost = await context1.newPage();
  const pGuest = await context2.newPage();

  pHost.on("console", (m) => console.log("[Host]", m.text()));
  pGuest.on("console", (m) => console.log("[Guest]", m.text()));

  await pHost.goto("http://localhost:8085");
  await pGuest.goto("http://localhost:8085");

  await loadDemo(pHost);
  await loadDemo(pGuest);
  await sleep(1000);

  // Host creates room
  console.log("Host creates room...");
  await pHost.click("#btn-create");
  await sleep(1000);

  const roomCode = await pHost.$eval("#room-code", (el) => el.textContent.trim());
  console.log("Room code:", roomCode);

  // Guest joins
  console.log("Guest joins room...");
  await pGuest.fill("#join-code", roomCode);
  await pGuest.click("#btn-join");
  await sleep(1000);

  // Inspect level options on Host
  const levelOptions = await pHost.$$eval("#lobby-level option", (opts) =>
    opts.map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled }))
  );
  console.log("Lobby level options on Host:", JSON.stringify(levelOptions, null, 2));

  // Guest clicks ready
  console.log("Guest toggles ready...");
  await pGuest.click("#btn-ready");
  await sleep(1000);

  // Host clicks start
  console.log("Host starts match...");
  await pHost.click("#btn-start-game");

  // Wait for engines to load
  console.log("Waiting 10s for game engines to start...");
  await sleep(10000);

  // Inspect state in both pages
  const hostInspect = await pHost.evaluate(() => {
    return {
      started: window.__bth?.state?.lobby?.started,
      netConnected: !!window.__bth?.state?.net,
      // Check windows if accessible
    };
  });
  console.log("Host state:", hostInspect);

  await pHost.screenshot({ path: "tests/out/debug_host_freeze.png" });
  await pGuest.screenshot({ path: "tests/out/debug_guest_freeze.png" });
  console.log("Screenshots taken.");

  await browser.close();
})();
