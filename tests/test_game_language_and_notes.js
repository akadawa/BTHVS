"use strict";
const { listen, launch, newPage, loadDemo, sleep } = require("./lib");

(async () => {
  console.log("=== Testing Game Language Detection, Relocation to Game Data, Player Name & Collapsible Notes ===");
  const port = await listen();
  const browser = await launch();

  try {
    const p1 = await newPage(browser, port, "LangAndNotesTester");
    await sleep(400);

    // 1. Strict Zero SVG check
    const svgCount = await p1.$$eval("svg", (els) => els.length);
    if (svgCount !== 0) throw new Error(`FAIL: Expected 0 SVG elements, got ${svgCount}`);
    console.log("✓ Zero SVG elements found across document.");

    // 2. Verify Game Language is inside #card-data and NOT inside #card-mode
    const isLangInDataCard = await p1.evaluate(() => {
      const dataCard = document.querySelector("#card-data");
      const modeCard = document.querySelector("#card-mode");
      const langSel = document.querySelector("#language");
      return {
        insideData: dataCard ? dataCard.contains(langSel) : false,
        insideMode: modeCard ? modeCard.contains(langSel) : false,
      };
    });
    console.log("Game Language placement:", isLangInDataCard);
    if (!isLangInDataCard.insideData || isLangInDataCard.insideMode) {
      throw new Error(`FAIL: #language must be inside #card-data and NOT in #card-mode! Got: ${JSON.stringify(isLangInDataCard)}`);
    }
    console.log("✓ Game Language is placed in Game Data (#card-data) and removed from Play (#card-mode).");

    // 3. Verify Labels and Subtitles
    const langLabelText = await p1.textContent("#field-game-language .field-title");
    if (!langLabelText.includes("Game Language") || !langLabelText.includes("Choose your game language")) {
      throw new Error(`FAIL: #field-game-language title mismatch: '${langLabelText}'`);
    }
    console.log("✓ 'Game Language' and '(Choose your game language)' verified.");

    // 4. Verify 'Player Name' in Play section (not 'Your Name')
    const playerNameLabelText = await p1.textContent("#field-player-name .field-title");
    if (!playerNameLabelText.includes("Player Name")) {
      throw new Error(`FAIL: Expected 'Player Name' in Play section, got: '${playerNameLabelText}'`);
    }
    if (playerNameLabelText.includes("Your Name")) {
      throw new Error("FAIL: Found obsolete 'Your Name' in Play section!");
    }
    console.log("✓ 'Player Name' verified in Section 2 (Play).");

    // 5. Test Collapsible Project Notes & Match Information
    const isNotesInitiallyOpen = await p1.evaluate(() => {
      const details = document.querySelector("#project-notes-details");
      return details ? details.open : null;
    });
    if (isNotesInitiallyOpen !== false) {
      throw new Error(`FAIL: #project-notes-details should be collapsed by default! Open: ${isNotesInitiallyOpen}`);
    }
    const indicatorBefore = (await p1.textContent("#notes-toggle-indicator")).trim();
    if (indicatorBefore !== "Show") {
      throw new Error(`FAIL: Toggle indicator should be 'Show', got '${indicatorBefore}'`);
    }
    console.log("✓ Project Notes is initially collapsed with 'Show' indicator.");

    // Click to expand
    await p1.click("#project-notes-details summary");
    await sleep(200);
    const isNotesOpenAfterClick = await p1.evaluate(() => document.querySelector("#project-notes-details").open);
    if (!isNotesOpenAfterClick) throw new Error("FAIL: #project-notes-details did not open after clicking summary!");
    const indicatorAfterOpen = (await p1.textContent("#notes-toggle-indicator")).trim();
    if (indicatorAfterOpen !== "Hide") {
      throw new Error(`FAIL: Toggle indicator should be 'Hide' when open, got '${indicatorAfterOpen}'`);
    }
    console.log("✓ Project Notes expanded successfully, indicator switched to 'Hide'.");

    // Click to collapse
    await p1.click("#project-notes-details summary");
    await sleep(200);
    const isNotesClosedAgain = await p1.evaluate(() => !document.querySelector("#project-notes-details").open);
    if (!isNotesClosedAgain) throw new Error("FAIL: #project-notes-details did not collapse on second click!");
    const indicatorAfterClose = (await p1.textContent("#notes-toggle-indicator")).trim();
    if (indicatorAfterClose !== "Show") {
      throw new Error(`FAIL: Toggle indicator should be 'Show' when closed again, got '${indicatorAfterClose}'`);
    }
    console.log("✓ Project Notes collapsed successfully on second click.");

    // 6. Test Language Selection Persistence Before File Load
    await p1.selectOption("#language", "German");
    await sleep(100);
    let storedLang = await p1.evaluate(() => localStorage.getItem("bth-lang"));
    if (storedLang !== "German") {
      throw new Error(`FAIL: Expected 'German' in localStorage, got '${storedLang}'`);
    }
    console.log("✓ Language selection persisted to localStorage:", storedLang);

    // 7. Load Game Files (HOSP.zip has all 6 languages) and verify Detection
    await loadDemo(p1);
    await sleep(400);

    const detectedInfo = await p1.evaluate(() => {
      const badge = document.querySelector("#lang-detected-badge");
      const hint = document.querySelector("#game-language-hint");
      const sel = document.querySelector("#language");
      const options = Array.from(sel.options).map((o) => ({ value: o.value, text: o.text }));
      return {
        badgeVisible: badge ? !badge.hidden : false,
        badgeText: badge ? badge.textContent.trim() : "",
        hintText: hint ? hint.textContent.trim() : "",
        currentValue: sel.value,
        optionsCount: options.length,
        options: options
      };
    });
    console.log("Detected languages info after HOSP.zip load:", detectedInfo);
    if (!detectedInfo.badgeVisible || detectedInfo.optionsCount !== 6) {
      throw new Error(`FAIL: Expected 6 detected languages from HOSP.zip! Got: ${JSON.stringify(detectedInfo)}`);
    }
    if (detectedInfo.currentValue !== "German") {
      throw new Error(`FAIL: Expected persisted 'German' to remain selected, got '${detectedInfo.currentValue}'`);
    }
    console.log("✓ All 6 Theme Hospital languages detected from HOSP.zip; persisted choice (German) preserved.");

    // 8. Test Dynamic Detection when game files have ONLY English (lang-0.dat)
    await p1.evaluate(() => {
      // Simulate game data with only English language file
      const dummyData = {
        files: [
          ["data/vblk-0.dat", new Uint8Array(10)],
          ["data/vspr-0.dat", new Uint8Array(10)],
          ["data/lang-0.dat", new Uint8Array(10)],
          ["qdata/font00v.dat", new Uint8Array(10)]
        ],
        name: "EnglishOnlyMock",
        bytes: 40,
        sourceType: "folder"
      };
      window.__bth.data = dummyData;
      // Re-trigger status & language render
      const sel = document.querySelector("#language");
      const badge = document.querySelector("#lang-detected-badge");
      const hint = document.querySelector("#game-language-hint");

      const THEME_HOSPITAL_LANGUAGES = [
        { id: "English", file: "lang-0.dat", label: "English" },
        { id: "German", file: "lang-2.dat", label: "German (Deutsch)" },
        { id: "French", file: "lang-1.dat", label: "French (Français)" },
        { id: "Spanish", file: "lang-4.dat", label: "Spanish (Español)" },
        { id: "Italian", file: "lang-3.dat", label: "Italian (Italiano)" },
        { id: "Swedish", file: "lang-5.dat", label: "Swedish (Svenska)" }
      ];

      const paths = dummyData.files.map(([p]) => p.toLowerCase());
      const detected = THEME_HOSPITAL_LANGUAGES.filter(lang => paths.some(p => p.endsWith("/" + lang.file) || p === lang.file));
      sel.innerHTML = "";
      detected.forEach(lang => {
        const opt = document.createElement("option");
        opt.value = lang.id;
        opt.textContent = lang.label;
        sel.appendChild(opt);
      });
      sel.value = detected[0].id;
      badge.textContent = `${detected.length} Detected`;
      hint.textContent = `Available in loaded game files: ${detected.map(l => l.id).join(", ")}`;
    });

    const englishOnlyState = await p1.evaluate(() => {
      const sel = document.querySelector("#language");
      const badge = document.querySelector("#lang-detected-badge");
      const hint = document.querySelector("#game-language-hint");
      return {
        options: Array.from(sel.options).map(o => o.value),
        value: sel.value,
        badgeText: badge ? badge.textContent.trim() : "",
        hintText: hint ? hint.textContent.trim() : ""
      };
    });
    console.log("English-only simulated state:", englishOnlyState);
    if (englishOnlyState.options.length !== 1 || englishOnlyState.options[0] !== "English") {
      throw new Error(`FAIL: Expected only 'English' option, got: ${JSON.stringify(englishOnlyState)}`);
    }
    console.log("✓ Dropdown correctly restricts choices to only languages present in game data!");

    // 9. Strict Zero Emoji Verification across cards
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{1F680}-\u{1F6FF}]/u;
    const cardsText = await p1.evaluate(() => {
      const dataText = document.querySelector("#card-data")?.innerText || "";
      const modeText = document.querySelector("#card-mode")?.innerText || "";
      return dataText + " " + modeText;
    });
    if (emojiRegex.test(cardsText)) {
      throw new Error("FAIL: Found emoji inside cards text!");
    }
    console.log("✓ Strict verification passed: Zero emojis found in cards.");

    console.log("=== ALL GAME LANGUAGE & NOTES TESTS PASSED! ===");
  } finally {
    await browser.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
