"use strict";
const path = require("path");
const fs = require("fs");
const { chromium } = require("../tests/node_modules/playwright");

function makeIcoFromPng(pngBuffer, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // 1 image

  const entry = Buffer.alloc(16);
  entry.writeUInt8(width >= 256 ? 0 : width, 0);
  entry.writeUInt8(height >= 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2); // color palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // image size
  entry.writeUInt32LE(22, 12); // offset (6 + 16 = 22)

  return Buffer.concat([header, entry, pngBuffer]);
}

(async () => {
  console.log("=== Generating BTHVS Browser Favicons ===");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    
    // HTML with exact hospital logo: #19b5a5 background, rounded rect, white bold cross
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
      <meta charset="utf-8">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: transparent; display: flex; align-items: center; justify-content: center; }
        .logo-box {
          border-radius: 25%;
          background: #19b5a5;
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif;
          font-weight: 700;
          line-height: 1;
        }
      </style>
      </head>
      <body>
        <div id="icon" class="logo-box">✚</div>
      </body>
      </html>
    `;

    await page.setContent(html);

    // 1. Generate 32x32 favicon.png
    await page.evaluate(() => {
      const el = document.querySelector("#icon");
      el.style.width = "32px";
      el.style.height = "32px";
      el.style.fontSize = "20px";
      el.style.borderRadius = "8px";
    });
    const el32 = await page.$("#icon");
    const buf32 = await el32.screenshot({ omitBackground: true });
    
    const distDir = path.resolve(__dirname, "..", "dist");
    const p32 = path.join(distDir, "favicon.png");
    fs.writeFileSync(p32, buf32);
    console.log("✓ Saved 32x32 favicon:", p32);

    // Generate favicon.ico from 32x32 PNG
    const icoBuf = makeIcoFromPng(buf32, 32, 32);
    const pIco = path.join(distDir, "favicon.ico");
    fs.writeFileSync(pIco, icoBuf);
    console.log("✓ Saved favicon.ico:", pIco);

    // 2. Generate 180x180 apple-touch-icon.png
    await page.evaluate(() => {
      const el = document.querySelector("#icon");
      el.style.width = "180px";
      el.style.height = "180px";
      el.style.fontSize = "110px";
      el.style.borderRadius = "40px";
    });
    const el180 = await page.$("#icon");
    const buf180 = await el180.screenshot({ omitBackground: true });
    const p180 = path.join(distDir, "apple-touch-icon.png");
    fs.writeFileSync(p180, buf180);
    console.log("✓ Saved 180x180 apple-touch-icon.png:", p180);

    // Also copy to root for GitHub and direct server access
    fs.copyFileSync(pIco, path.resolve(__dirname, "..", "favicon.ico"));
    fs.copyFileSync(p32, path.resolve(__dirname, "..", "favicon.png"));

    console.log("=== Favicons successfully generated! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error("Favicon generation failed:", err);
  process.exit(1);
});
