"use strict";
/* Shared helpers for the browser tests (Playwright + the real server). */
const path = require("path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const { server } = (() => {
  process.env.PORT = process.env.PORT || "0";
  return require(path.join(root, "server", "server.js"));
})();

const ZIP = path.join(root, "HOSP.zip");

function listen() {
  return new Promise((res) => {
    if (server.listening) return res(server.address().port);
    server.on("listening", () => res(server.address().port));
  });
}

async function launch() {
  return chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
      "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  });
}

async function newPage(browser, port, name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.w || 1024, height: opts.h || 768 } });
  const page = await ctx.newPage();
  page.logs = [];
  page.on("console", (m) => {
    const t = m.text();
    page.logs.push(t);
    if (process.env.VERBOSE) console.log(`[${name}]`, t);
  });
  page.on("pageerror", (e) => { page.logs.push("PAGEERROR " + e.message); console.log(`[${name}] PAGEERROR`, e.message); });
  await page.goto(`http://127.0.0.1:${port}/${opts.query || ""}`);
  return page;
}

async function loadDemo(page) {
  await page.evaluate(() => { window.__ALLOW_DEMO_FOR_TESTS = true; });
  await page.setInputFiles("#file-zip", ZIP);
  await page.waitForFunction(() => {
    const txt = document.querySelector("#data-status")?.textContent || "";
    return txt.includes("ready") || txt.includes("bereit");
  }, null, { timeout: 60000 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { listen, launch, newPage, loadDemo, sleep, root, server };
