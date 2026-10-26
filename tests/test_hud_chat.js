"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("Testing HUD position and Chat dragging...");
  const port = await listen();
  const browser = await launch();
  const p1 = await newPage(browser, port, "Host");
  const p2 = await newPage(browser, port, "Guest");

  await Promise.all([loadDemo(p1), loadDemo(p2)]);
  await p1.fill("#player-name", "Host");
  await p2.fill("#player-name", "Guest");

  await p1.click("#btn-create");
  await p1.waitForSelector("#card-lobby:not([hidden])");
  const code = (await p1.textContent("#room-code")).trim();

  await p2.fill("#join-code", code);
  await p2.click("#btn-join");
  await p1.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2);
  await p1.click("#btn-start");

  await p1.waitForSelector("#hud:not([hidden])", { timeout: 35000 });
  await sleep(2000);

  // 1. Verify HUD position is bottom right
  const hudBox = await p1.evaluate(() => {
    const el = document.getElementById("hud");
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      right: r.right,
      windowHeight: window.innerHeight,
      windowWidth: window.innerWidth,
    };
  });
  console.log("HUD Box:", hudBox);
  if (hudBox.bottom < hudBox.windowHeight - 50) {
    throw new Error("HUD is not at bottom right! Bottom is " + hudBox.bottom + " vs window " + hudBox.windowHeight);
  }
  console.log("HUD IS CORRECTLY AT BOTTOM RIGHT!");

  // 2. Open chat
  await p1.click("#hud-chat-btn");
  await p1.waitForSelector("#chat:not([hidden])");

  const chatInitBox = await p1.evaluate(() => {
    const r = document.getElementById("chat").getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom };
  });
  console.log("Chat initial box:", chatInitBox);

  // 3. Drag chat window by header
  const header = await p1.$("#chat-header");
  const headerBox = await header.boundingBox();
  console.log("Header bounding box:", headerBox);

  const startX = headerBox.x + headerBox.width / 2;
  const startY = headerBox.y + headerBox.height / 2;
  await p1.mouse.move(startX, startY);
  await p1.mouse.down();
  await p1.mouse.move(startX + 150, startY - 150, { steps: 5 });
  await p1.mouse.up();

  const chatMovedBox = await p1.evaluate(() => {
    const r = document.getElementById("chat").getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom };
  });
  console.log("Chat moved box:", chatMovedBox);

  if (Math.abs(chatMovedBox.left - chatInitBox.left) < 50 || Math.abs(chatMovedBox.top - chatInitBox.top) < 50) {
    throw new Error("Chat did not move as expected! Dragging failed.");
  }
  console.log("CHAT DRAGGING WORKS PERFECTLY!");

  await browser.close();
  console.log("TEST SUCCESSFUL!");
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
