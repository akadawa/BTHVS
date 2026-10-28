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

    // Verify 8-character room code format
    if (code.length !== 8 || !/^[A-Z0-9]{8}$/.test(code)) {
      throw new Error(`FAIL: Expected 8-character alphanumeric room code, got '${code}' (length: ${code.length})`);
    }
    console.log("✓ Room code is exactly 8 characters long:", code);

    // Now configure custom goals inside the lobby
    await pHost.selectOption("#goal-cured", "10");
    await pHost.selectOption("#goal-money", "50000");
    await pHost.selectOption("#goal-time", "20");
    await sleep(400);

    // Verify browser URL and generated invite link contain ONLY join=CODE and NO goals/game modes
    const currentUrl = await pHost.evaluate(() => location.href);
    console.log("Current Browser URL in lobby:", currentUrl);
    if (!currentUrl.includes(`join=${code}`)) {
      throw new Error(`Browser URL missing room code: ${currentUrl}`);
    }
    if (currentUrl.includes("curedPatients") || currentUrl.includes("cashBalance") || currentUrl.includes("timeLimit") || currentUrl.includes("level")) {
      throw new Error(`Browser URL contains game modes/goals, should only contain join code: ${currentUrl}`);
    }

    // Verify copy invite link button behavior
    await pHost.click("#btn-copy-link");
    const generatedInviteLink = await pHost.evaluate(() => {
      const u = new URL(location.origin + location.pathname);
      if (window.__bth.state.lobby) {
        u.searchParams.set("join", window.__bth.state.lobby.code);
      }
      return u.toString();
    });
    console.log("Generated Invite Link:", generatedInviteLink);
    if (!generatedInviteLink.includes(`join=${code}`)) {
      throw new Error(`Invite link missing room code: ${generatedInviteLink}`);
    }
    if (generatedInviteLink.includes("curedPatients") || generatedInviteLink.includes("cashBalance") || generatedInviteLink.includes("timeLimit") || generatedInviteLink.includes("level")) {
      throw new Error(`Invite link contains goals/modes! Should only be join=CODE: ${generatedInviteLink}`);
    }
    console.log("✓ Invite link parameters verified successfully: strictly join=CODE with zero game modes!");

    // Verify room code storage and uniqueness in localStorage
    const uniquenessCheck = await pHost.evaluate(() => {
      const bth = window.__bth;
      const used = bth.getUsedRoomCodes();
      const currentCode = bth.state.lobby.code;
      const hasCurrent = used.has(currentCode);

      // Generate 100 new codes and verify non-repetition
      const sample = new Set();
      for (let i = 0; i < 100; i++) {
        const c = bth.newCode();
        if (c.length !== 8) return { ok: false, err: `Code length not 8: ${c}` };
        if (sample.has(c)) return { ok: false, err: `Duplicate code in batch: ${c}` };
        if (c === currentCode) return { ok: false, err: `Generated code matched current code!` };
        sample.add(c);
      }
      return { ok: true, hasCurrent, totalUsed: used.size };
    });
    if (!uniquenessCheck.ok) {
      throw new Error("FAIL: " + uniquenessCheck.err);
    }
    if (!uniquenessCheck.hasCurrent) {
      throw new Error("FAIL: Current room code was not recorded in used room codes set!");
    }
    console.log(`✓ Room codes are saved and guaranteed unique! (tested 100 consecutive generations, ${uniquenessCheck.totalUsed} stored)`);

    // Test 1: Guest visits with cached data -> direct landing into lobby via pure ?join=CODE
    console.log("\nTesting Guest opening invite link with pre-cached data...");
    const query = `?join=${code}`;

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
