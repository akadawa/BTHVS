"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Direct Lobby Landing via Invite Link & Player Status LEDs ===");
  const port = await listen();
  const browser = await launch();

  try {
    const pHost = await newPage(browser, port, "Host");
    await loadDemo(pHost);
    await pHost.fill("#player-name", "HostDoc");

    // Host creates room first
    await pHost.click("#btn-create");
    await pHost.waitForSelector("#card-lobby:not([hidden])", { timeout: 10000 });
    const code = (await pHost.textContent("#room-code")).trim();
    console.log("Host room created with code:", code);

    // Now configure custom goals inside the lobby
    await pHost.selectOption("#goal-cured", "10");
    await pHost.selectOption("#goal-money", "50000");
    await pHost.selectOption("#goal-time", "20");
    await sleep(400);

    // Verify Copy Invite Link contains join and goals
    await pHost.click("#btn-copy-link");
    const inviteLink = await pHost.evaluate(() => {
      const u = new URL(location.origin + location.pathname);
      u.searchParams.set("join", window.__bth.state.lobby.code);
      const goals = window.__bth.state.lobby.goals;
      if (goals) {
        if (goals.cured !== undefined) u.searchParams.set("curedPatients", goals.cured);
        if (goals.money !== undefined) u.searchParams.set("cashBalance", goals.money);
        if (goals.timeLimit !== undefined) u.searchParams.set("timeLimit", goals.timeLimit);
      }
      if (window.__bth.state.lobby.level) {
        u.searchParams.set("level", window.__bth.state.lobby.level);
      }
      return u.toString();
    });
    console.log("Generated Invite Link:", inviteLink);

    if (!inviteLink.includes(`join=${code}`)) {
      throw new Error(`Invite link missing room code: ${inviteLink}`);
    }
    if (!inviteLink.includes("curedPatients=10") || !inviteLink.includes("cashBalance=50000") || !inviteLink.includes("timeLimit=20")) {
      throw new Error(`Invite link missing custom goals: ${inviteLink}`);
    }
    console.log("✓ Invite link parameters verified successfully!");

    // Test 1: Guest visits with cached data -> direct landing into lobby
    console.log("\nTesting Guest opening invite link with pre-cached data...");
    const urlObj = new URL(inviteLink);
    const query = urlObj.search; // e.g. "?join=CODE&curedPatients=10..."

    // Open guest context and pre-seed indexedDB (load demo, wait for IDB save, then navigate with invite link)
    const pGuest = await newPage(browser, port, "GuestDirect");
    await loadDemo(pGuest);
    await pGuest.waitForFunction(() => window.__bth?.state?.kvSaved, null, { timeout: 15000 });
    // Now navigate directly to the invite link URL with query params
    pGuest.on("console", (m) => console.log("[GuestDirectConsole]", m.text()));
    await pGuest.goto(`http://127.0.0.1:${port}/${query}`);
    await sleep(1500);
    const guestDiag = await pGuest.evaluate(() => ({
      hasBth: !!window.__bth,
      hasStateData: !!window.__bth?.state?.data,
      lobby: window.__bth?.state?.lobby,
      menuError: document.querySelector("#menu-error")?.textContent,
      joinVal: document.querySelector("#join-code")?.value,
      pending: window.__pendingJoinCode,
    }));
    console.log("Guest Diagnostic right after navigation:", guestDiag);

    // Verify Guest directly lands in lobby without clicking #btn-join or typing code!
    await pGuest.waitForSelector("#card-lobby:not([hidden])", { timeout: 12000 });
    const setupHidden = await pGuest.evaluate(() => document.getElementById("view-setup").hidden);
    const lobbyHidden = await pGuest.evaluate(() => document.getElementById("card-lobby").hidden);
    const guestRoomCode = (await pGuest.textContent("#room-code")).trim();

    if (!setupHidden || lobbyHidden || guestRoomCode !== code) {
      throw new Error(`Guest did not land directly in lobby: setupHidden=${setupHidden}, lobbyHidden=${lobbyHidden}, guestCode=${guestRoomCode}`);
    }
    console.log("✓ Guest landed directly in lobby!");

    // Wait for players to sync
    await pHost.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 10000 });
    await pGuest.waitForFunction(() => document.querySelectorAll("#player-list li").length >= 2, null, { timeout: 10000 });

    // Verify LED indicator and removal of text badges
    console.log("\nVerifying player list LED indicators...");
    const getLobbyPlayersInfo = async (page) => {
      return page.evaluate(() => {
        const lis = Array.from(document.querySelectorAll("#player-list li"));
        return lis.map((li) => {
          const led = li.querySelector(".player-status-led");
          const ledClass = led ? led.className : null;
          const ledTitle = led ? led.title : null;
          const name = li.querySelector(".player-name-text")?.textContent || li.querySelector("span")?.textContent;
          const textBadges = Array.from(li.querySelectorAll(".badge-ready")).map(b => b.textContent.trim());
          return { name, ledClass, ledTitle, textBadges };
        });
      });
    };

    const hostViewPlayers = await getLobbyPlayersInfo(pHost);
    console.log("Host view player items:", hostViewPlayers);

    for (const p of hostViewPlayers) {
      if (!p.ledClass || !p.ledClass.includes("player-status-led")) {
        throw new Error(`Player item missing .player-status-led: ${JSON.stringify(p)}`);
      }
      if (!p.ledClass.includes("waiting")) {
        throw new Error(`Initial status LED should be waiting (orange), got: ${p.ledClass}`);
      }
      if (p.textBadges.length > 0) {
        throw new Error(`Text badges like 'Ready'/'Waiting' must not be present: ${JSON.stringify(p.textBadges)}`);
      }
    }
    console.log("✓ Initial status LEDs are correctly 'waiting' (orange) and no text badges exist!");

    // Guest clicks Ready
    console.log("\nGuest clicks Ready button...");
    await pGuest.click("#btn-ready");
    await sleep(600);

    const hostViewAfterGuestReady = await getLobbyPlayersInfo(pHost);
    console.log("Host view after Guest ready:", hostViewAfterGuestReady);

    const guestOnHost = hostViewAfterGuestReady.find(p => !p.name.includes("HostDoc"));
    const hostOnHost = hostViewAfterGuestReady.find(p => p.name.includes("HostDoc"));

    if (!guestOnHost || !guestOnHost.ledClass.includes("ready")) {
      throw new Error(`Guest LED on Host view should be green ('ready'), got: ${guestOnHost ? guestOnHost.ledClass : "not found"}`);
    }
    if (!hostOnHost || !hostOnHost.ledClass.includes("waiting")) {
      throw new Error(`Host LED should still be orange ('waiting'), got: ${hostOnHost ? hostOnHost.ledClass : "not found"}`);
    }
    console.log("✓ Guest LED updated to green ('ready') and Host LED remains orange ('waiting')!");

    // Host clicks Ready
    console.log("\nHost clicks Ready button...");
    await pHost.click("#btn-ready");
    await sleep(600);

    const hostViewBothReady = await getLobbyPlayersInfo(pHost);
    console.log("Host view with both ready:", hostViewBothReady);
    for (const p of hostViewBothReady) {
      if (!p.ledClass.includes("ready")) {
        throw new Error(`Player ${p.name} LED should be ready (green)!`);
      }
    }
    console.log("✓ Both players now show green LEDs ('ready')!");

    // Test 2: Guest visits without data first, then selects data -> auto-enters lobby
    console.log("\nTesting first-time visitor with invite link (no cached data -> auto enters upon setData)...");
    const pNewGuest = await newPage(browser, port, "NewGuest");
    // Clear any existing stored data to simulate a fresh first visit
    await pNewGuest.evaluate(async () => {
      indexedDB.deleteDatabase("bth-db");
    });
    await pNewGuest.goto(`http://127.0.0.1:${port}/${query}`);
    await sleep(400);

    // Initially on setup screen because no data is loaded yet
    const pendingCode = await pNewGuest.evaluate(() => window.__pendingJoinCode);
    const inputCode = await pNewGuest.inputValue("#join-code");
    if (pendingCode !== code || inputCode !== code) {
      throw new Error(`Pending join code not stored properly: pending=${pendingCode}, input=${inputCode}`);
    }
    console.log("✓ Pending join code stored in memory while waiting for game files.");

    // Now user loads files (via loadDemo)
    await loadDemo(pNewGuest);
    // Should immediately auto-enter lobby!
    await pNewGuest.waitForSelector("#card-lobby:not([hidden])", { timeout: 12000 });
    const newGuestRoomCode = (await pNewGuest.textContent("#room-code")).trim();
    if (newGuestRoomCode !== code) {
      throw new Error(`New guest did not auto-join lobby upon setData: ${newGuestRoomCode}`);
    }
    console.log("✓ New guest auto-joined room upon file selection!");

    console.log("\n*** ALL INVITE LINK AND LED TESTS PASSED SUCCESSFULLY! ***");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
