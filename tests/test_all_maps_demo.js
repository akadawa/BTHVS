"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  const port = await listen();
  const browser = await launch();
  const page = await newPage(browser, port, "A");
  await loadDemo(page);

  const maps = ["avatar", "confined_v5", "finisham", "st.peter's"];
  for (const map of maps) {
    console.log("Testing map:", map);
    const p = await newPage(browser, port, map);
    await loadDemo(p);
    await p.evaluate((m) => {
      window.__bth.state.lobby = { code: "TEST1", id: 0, host: true, players: [{id: 0, name: "Doc", host: true, connected: true}] };
      window.__bth.startGame({
        mp: { id: 0, code: "TEST1", name: "Doc", players: [{id: 0, name: "Doc", host: true, connected: true}], mode: "versus", goal: "cured_10", level: m, seed: 12345, host: 0 },
        language: "German",
        name: "Doc"
      });
    }, map);
    await sleep(4000);
    const fatal = await p.evaluate(() => !document.querySelector("#fatal").hidden && document.querySelector("#fatal-text").textContent);
    console.log(`Map ${map} fatal:`, fatal || "none");
    if (fatal) {
      console.error(`Map ${map} failed: ${fatal}`);
      process.exit(1);
    }
  }

  console.log("All custom maps loaded successfully with demo files!");
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
