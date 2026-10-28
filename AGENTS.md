# BTHVS – Agent Knowledge Base & Developer Guide

This document is the authoritative project reference for AI agents and human developers maintaining **Browser Theme Hospital – Versus (BTHVS)**.

> IMPORTANT DEPLOYMENT NOTICE:
> This file (`AGENTS.md`) is internal documentation intended ONLY for the private repository on `git.gol.lan`.
> It must NOT be pushed to the public GitHub repository. See the Git Remotes & Synchronization section below.

---

## 1. Project Overview & Mission

- **Name**: BTHVS – Browser THospital Versus
- **Current Version**: `0.0.1`
- **Core Technology**:
  - Open-source **CorsixTH** engine (**v0.70.2**, `SAVEGAME_VERSION = 254`, Lua API `2717`) compiled to WebAssembly via Emscripten (`-O3`).
  - Lua 5.4 scripting layer with fixed random seed for deterministic simulation.
  - Serverless WebRTC Peer-to-Peer (DataChannels via PeerJS) + WebSocket relay fallback.
  - Vanilla HTML5 / modern CSS (glassmorphism dark hospital theme) / vanilla ES2022 JavaScript.
- **Live Demo**: `https://bthvs.vercel.app`
- **Primary Objective**: Provide competitive real-time multiplayer versus matches of Theme Hospital directly in modern web browsers without installations or plugins. Players compete on the same level layout to cure patients, generate cash, and complete custom victory conditions.

---

## 2. Git Remotes & Push Workflow

The repository is connected to two remotes:

1. **Internal Remote (`origin`)**:
   - URL: `https://git.gol.lan/daniel/BrowserTHospital.git`
   - Purpose: Full internal repository. **Must contain `AGENTS.md`**.
2. **Public Remote (`github`)**:
   - URL: `https://github.com/akadawa/BTHVS.git`
   - Purpose: Clean public open-source repository. **Must NOT contain `AGENTS.md`**.

### Push Workflow Instructions

Whenever you make changes to the project:

#### A. Pushing to git.gol.lan (Internal)
```powershell
# Standard commit on main branch
git add .
git commit -m "feat/fix/style: description without emojis"
git push origin main -v
```

#### B. Synchronizing to GitHub (Public)
To push code to GitHub without exposing `AGENTS.md`:
Use the automated helper script:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/push_github.ps1 -CommitMessage "sync: public release"
```
Or execute manually:
```bash
git checkout -B github-release main
git rm -f AGENTS.md
git commit -m "sync: public release to github"
git push github github-release:main --force
git checkout main
git branch -D github-release
```

---

## 3. Strict Development Guidelines & Invariants

All future agents must strictly follow these rules:

1. **ABSOLUTE ZERO-ICON AND ZERO-EMOJI POLICY**:
   - No SVG icons, FontAwesome, Lucide, or external icon sets.
   - No Unicode emojis (such as smiley faces, trophies, medals, party poppers, etc.) anywhere in the HTML, CSS, JavaScript, chat, HUD, lobby, quests, or markdown.
   - Verified by automated tests: `p1.$$eval("svg", (els) => els.length) === 0` and emoji regex tests.
   - Use clean typography, badges, text chips, status dots (LEDs), and standard typographic symbols (e.g. `?` for help, `&times;` for modal close, `✚` for the hospital logo).
2. **Clickable File Links**:
   - When communicating file locations, always provide clickable `file:///` URLs (e.g. `[dist/index.html](file:///c:/Users/danie/Desktop/BrowserTHospital/dist/index.html)`).
3. **Responsive UI Symmetry**:
   - Left side: Patchnotes toggle button (`left: 0; transform: translateY(-50%); border-radius: 0 8px 8px 0; border-left: none;`).
   - Right side: Leaderboard toggle button (`right: 0; transform: translateY(-50%); border-radius: 8px 0 0 8px; border-right: none;`).
   - Both drawers must hide when the game canvas is active (`#menu[hidden] ~ .patchnotes-toggle, #menu[hidden] ~ .leaderboard-toggle { display: none !important; }`).

---

## 4. Architecture & Key Directory Breakdown

```
BrowserTHospital/
├── api/
│   └── lobbies.js              # Vercel Serverless Function for public lobby discovery (/api/lobbies)
├── dist/                       # Production web client root
│   ├── app.js                  # Master client application coordinator (networking, lobby, UI, WASM bridge)
│   ├── index.html              # Single Page Application HTML markup
│   ├── style.css               # Theme Hospital dark teal/navy glassmorphism stylesheet
│   ├── favicon.ico             # 32x32 multi-size hospital cross favicon
│   ├── favicon.png             # 32x32 PNG browser tab icon
│   ├── apple-touch-icon.png    # 180x180 mobile touch icon
│   ├── assets/                 # Backgrounds, map preview PNGs
│   ├── game/                   # Precompiled CorsixTH v0.70.2 WebAssembly binaries
│   │   ├── build.json          # SHA-256 cache-busting manifest + exact asset byte sizes
│   │   ├── corsixth.wasm       # Wasm binary compiled from C++/Lua (-O3)
│   │   ├── corsixth.js         # Emscripten JS runtime loader
│   │   └── corsixth.data       # Stripped & preloaded Lua scripts, levels, runtime bitmaps (~6.81 MB)
│   └── vendor/
│       ├── peerjs.min.js       # WebRTC P2P DataChannels library
│       └── fflate.js           # Fast browser ZIP decompressor for HOSP.zip
├── server/
│   └── server.js               # Node.js static server (with gzip streaming) + WebSocket room relay fallback
├── third_party/
│   ├── CorsixTH/               # Vendored CorsixTH v0.70.2 source tree
│   │   └── CorsixTH/Lua/
│   │       ├── multiplayer.lua # Custom versus state synchronization, speed & modal pause isolation
│   │       ├── app.lua         # Engine lifecycle hooks, root VFS path handling & exit management
│   │       ├── ui.lua          # High-DPI UI scale viewport clamping & web fullscreen delegation
│   │       └── game_ui.lua     # UI overlays & window positioning
│   ├── lua/                    # Lua 5.4 runtime source
│   ├── lfs/                    # LuaFileSystem
│   └── lpeg/                   # LPeg parser library
├── web/
│   ├── CMakeLists.txt          # Emscripten CMake build configuration
│   ├── build.ps1               # Automated WebAssembly compilation & asset-stripping script
│   └── src/
│       ├── web_main.cpp        # WebAssembly entry point
│       ├── web_loop.h          # Direct C++ -> Lua frame/event dispatch loop
│       └── web_bridge.cpp      # JS <-> Lua bridge (_th_resize, _th_eval_lua)
├── tests/
│   ├── lib.js                  # Shared Playwright test runner & local server helpers
│   ├── test_v0702_upgrade_and_perf.js
│   ├── test_fullscreen_leave.js
│   ├── test_corsix_menu_and_speed.js
│   ├── test_wasm_cache_bust.js
│   ├── test_quests_and_leaderboard_multiplayer.js
│   ├── test_invite_link_and_leds.js
│   ├── test_game_language_and_notes.js
│   ├── test_patchnotes_drawer.js
│   ├── test_leaderboard_and_username.js
│   ├── test_ui_improvements_oct28.js
│   ├── test_p2p_versus.js
│   └── test_map_preview_modal.js
└── scripts/
    ├── generate_favicon.js     # Headless renderer for browser favicons
    ├── push_github.ps1         # Syncs origin with AGENTS.md and github without AGENTS.md
    ├── take_patchnotes_screenshot.js
    └── take_landing_screenshot.js
```

---

## 5. Key Systems & Feature Details

### A. Game Data Ingestion & Storage
- Theme Hospital data (`HOSP.zip` or folder) is imported via `fflate.js` directly in the browser.
- Assets are stored in IndexedDB (`bth/kv`).
- When data is missing, the Play section is disabled with a centered `Game Files Needed` badge.
- **Game Language Detection**: Relocated to the Game Data card (`#field-game-language`) as `Game Language (Choose your game language)`. Detects available languages directly from original game data files (`data/lang-*.dat`: English, German, French, Spanish, Italian, Swedish). The dropdown dynamically filters to only the languages present in the loaded game files while preserving the user's selected choice in `localStorage` (`bth-lang`).
- **Collapsible Project Notes**: The Project Notes & Match Information card in Game Data is an accordion (`<details id="project-notes-details">`) with a dynamic `Show`/`Hide` toggle badge, keeping the UI tidy while keeping documentation accessible.

### B. Fixed Player Name & Leaderboard Reservation
- Player names are locked via the **Lock In** button or automatically upon entering a room.
- State is stored in `localStorage`: `bth-name` and `bth-name-locked`.
- The `?` indicator mark (`#btn-username-info`) visually references the permanently visible notice card below the input (`#username-info-box`), informing players that their player name is stored in browser cache and reserved for the Leaderboard. Clicking the mark highlights the card.
- A "Change" button allows unlocking the player name if needed.

### C. Patchnotes Drawer (Left)
- Slide-out drawer docked on the far left.
- Fetches live commits via GitHub API: `https://api.github.com/repos/akadawa/BTHVS/commits?per_page=15`.
- Caches commits in `localStorage` (`bth_patchnotes_cache`).
- Features built-in fallback data (`FALLBACK_PATCHNOTES`) in case of rate limits (HTTP 403) or offline play.
- Filters out any emoji characters from commit messages.

### D. Leaderboard Drawer (Right)
- Slide-out drawer docked on the far right.
- Overview metrics: Active doctors, total games played, total lobbies hosted.
- Personal Doctor Card with current rank, cures, cash, matches, and playtime.
- Five ranking tabs:
  1. `cured`: Patients Cured
  2. `cash`: Peak Cash Balance
  3. `playtime`: Longest Games & Session Duration
  4. `lobbies`: Lobbies Hosted
  5. `wins`: Versus Match Victories
- Initial state starts completely clean at zero (`DEFAULT_LEADERBOARD = []`, all stats start at 0).
- No Reset, Export, or Import buttons exist in the UI.
- Single-recording match guard (`state.vs.matchRecorded`) guarantees match statistics are recorded at most once per match, preventing stat runaway.

### E. Minimalist In-Game HUD, Leave Match Flow & Window Persistence
- **Minimalist In-Game HUD**: Docked at `top: 8px; right: 8px` to ensure zero overlap with the Theme Hospital game action toolbar at 1080p and 720p resolutions. Redundant telemetry (ping `- ms`, sync badge, host/player listings) was completely removed to keep the HUD unobtrusive.
  - Visible HUD elements: `[v0.0.1] [Room CODE · Map] [Timer (if timed)] [Quests] [Chat] [FS] [Leave]`
- **Leave Match Button, Fullscreen Exit & Zero-BeforeUnload Flow**: Inside active matches, the top-right `Leave` chip button (`#hud-exit-btn`) and the `Escape` key open the `#leave-modal` confirmation dialog (automatically releasing any active Pointer Lock and ensuring `default` OS cursor visibility). Confirming calls `gameExit(false)`, which sets `state.isExiting = true` (suppressing both app and SDL2 `beforeunload` prompts via a capture-phase `stopImmediatePropagation` guard), exits HTML5 Fullscreen cleanly before navigation, notifies rivals with `{ t: "leave" }`, and navigates via `window.location.replace(location.pathname)`. All fullscreen requests (HUD `FS` button, `canvas.requestFullscreen`, and CorsixTH `UI:toggleFullscreen` / `Alt+Enter`) target `document.documentElement` so `#hud` and `#leave-modal` always remain visible on top.
- **Window Persistence**: Quests and Chat windows are draggable and resizable with handles; their positions and dimensions are persisted across sessions in `localStorage` (`bth_win_quests` and `bth_win_chat`).

### F. Simplified In-Game Quests & Multi-Player Rivals Leaderboard
- **Glanceable Quest Cards**: Stripped of long explanatory paragraphs. Each card provides instant answers to three vital questions:
  1. *What is the goal?* (`Goal: 25`, `Goal: $100k`, `Limit: 30m`)
  2. *What do I still need?* (`Need: 7 more`, `Completed!`) + current progress bar.
  3. *What do rivals have right now?* Compact comparative rows for all opponents.
- **10-Player Rivals Leaderboard Table**: The Leaderboard tab (`#quest-view-dashboard`) renders a full ranking table supporting up to 10 players with Rank, Player, Cured, Cash, Rooms, Reputation, and Status, perfectly proportioned for 1080p and 720p screens.
- **Disconnected / Left Player Tracking**: When a player disconnects or leaves the game (`net.on("left")`), they are registered in `state.vs.leftPlayerIds`:
  - In the Rivals Leaderboard table, their status pill renders as `<span class="status-pill left">Left</span>`, and their row is dimmed with `.player-left`.
  - In Quest cards, their row shows `(Left)` and drops to inactive opacity.
  - If all opponents leave, the status banner informs the remaining player: `All rivals have left the match.`

### G. Multiplayer-Only CorsixTH In-Game Menu & Speed Lock
- **Simulation Speed Enforcement**:
  - Speed is strictly limited to **Normal** (`app.world:setSpeed("Normal")`) and **Pause** (`app.world:setSpeed("Pause")`).
  - Speed adjustments in `_S.menu_options.game_speed` (`third_party/CorsixTH/CorsixTH/Lua/dialogs/menu.lua`) were pruned to strictly `pause` and `normal`. Faster/slower presets (`slowest`, `slower`, `max_speed`, `and_then_some_more`) and speed-up key handlers (`GameUI:keySpeedUp`) are disabled.
  - Simulation netcode in `multiplayer.lua` enforces speed clamping so any out-of-bounds speed defaults to `Normal` and emits `speed:` packets with namespaced banners (`Pause (Player)` / `Normal (Player)`).
  - Local modal dialogs (`UIFax`, `UIAnnualReport`, `UIStaffRise`) have `World:mustPause*` overridden during active multiplayer so opening a fax or year-end report never pauses rivals or blocks speed sync, and `updateScreenBlueFilter()` keeps the hospital view clear (`allow_user_actions_while_paused = true`).
- **File Menu Pruning (Save / Load / Restart / Quit)**:
  - The File menu (`_S.menu.file`) was removed from the top in-game menu bar (`UIMenuBar:makeGameMenu`).
  - Bottom panel hotkeys and actions for quicksave, quickload, save, load, restart, and quit in `bottom_panel.lua` are disabled/no-ops.
- **Audio, Display & Gameplay Options Kept**:
  - Audio (Sounds, Announcements, Music, Volumes, Jukebox) remain active.
  - Options kept: `edge_scrolling` ("Am Bildschirmrand scrollen"), `capture_mouse` ("Mauszeiger vereinfachen"), `twentyfour_hour_clock` ("24-Stunden-Uhr"), `adviser_disabled` ("Berater"), `wage_increase` ("Gehaltserhöhung"), `warmth_colors` ("Farben für Wärmedarstellung"), and `charts` ("Statistik").
  - `lock_windows` ("Fenster festhalten") is removed.
- **Zero Standalone DOS Menu / Direct Web Exit**:
  - CorsixTH standalone singleplayer main menu (`UIMainMenu`) is completely blocked.
  - If `App:loadMainMenu`, `GameUI:quit`, or `UIMainMenu` is invoked, `self:exit()` is executed, cleanly returning the user to the web application (`location.pathname`).

### H. 8-Character Unique Room Codes & Pure Join Invite Links
- **8-Character Alphanumeric Room Codes**:
  - Room codes are strictly 8 characters drawn from `CODE_ALPHABET` (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding ambiguous characters like `0`/`O`, `1`/`I`).
  - Total combinations exceed 1.09 trillion ($32^8$), preventing accidental collisions.
  - UI inputs (`#join-code` with `maxlength="8"`, placeholder `ABCDEFGH`) and lobby banners (`#room-code`) are scaled and styled with responsive font-size and letter-spacing.
- **Non-Repeating Code Guarantee & Storage**:
  - In the browser client (`dist/app.js`), every created room code is recorded in `localStorage` under `bth_used_room_codes` and checked against known public lobbies. `newCode()` verifies that newly generated codes are never re-issued.
- **Pure Join Invite Links (Zero Query Param Clutter)**:
  - Shared invite links (`#btn-copy-link`) and browser address bar state (`history.replaceState`) strictly encode `?join=CODE` (plus optional `server` parameter only if using a custom relay).

### I. WebAssembly Package Cache-Busting, Bundle Stripping & Runtime Optimizations
- **Automatic Build Manifest (`dist/game/build.json`) & 54.6% Data Package Reduction**:
  - `web/build.ps1` strips build-time `.bmp`/`.spec`/`.lua` bitmap sources, unused standalone `mainmenu*.dat` bitmaps, and singleplayer `Campaigns/` saves during staging, shrinking `corsixth.data` from `15.71 MB` to `7.14 MB` (`6.81 MiB`, `1.86 MiB` gzipped) and computes a 12-character SHA-256 fingerprint across `corsixth.js`, `corsixth.wasm`, and `corsixth.data`.
- **Parallel Asset Download & VFS Directory Memoization**:
  - `startGame` in `dist/app.js` downloads `corsixth.js` and `corsixth.data` concurrently via `Promise.all`, verifies `corsixth.data` byte length against `dataSize` (re-fetching with `cache: "no-store"` on mismatch), and memoizes created VFS directories (`FS._bthDirs`) in `mkdirp` to avoid thousands of thrown `FS.mkdir` exceptions when mounting `HOSP.zip`.
- **Server Gzip Streaming (`server/server.js`)**:
  - Compresses `.html`, `.js`, `.mjs`, `.css`, `.json`, `.wasm`, and `.data` responses (>1 KB) via streaming gzip (`level: 1`), cutting wire transfer size by 53%–73%.
- **DOM Diff Memoization & Telemetry Deduplication**:
  - `updateQuestUI()` skips rendering when `#quest-win` is hidden and uses `setHtmlIfChanged` to guarantee zero redundant DOM rewrites when stats haven't changed.
  - `multiplayer.lua` deduplicates `vstats:` / `vs.mystats` payloads across unchanged ticks (with a 5s heartbeat) and auto-hides transient `#net-banner` notifications after 3.5s.
- **High-DPI UI Scaling (`1x`–`3x`) with Viewport Safety Clamping**:
  - Supports CorsixTH `v0.70.2` `ui_scale` (`window.__bth.setGameUIScale(scale)`) and automatically clamps `ui_scale` in `UI:changeResolution(w, h)` so `640 * scale <= w` and `480 * scale <= h` whenever the browser window resizes.

---

## 6. Testing Guide

Run tests before committing any changes:
```powershell
# Run CorsixTH v0.70.2 upgrade, High-DPI scale clamp, gzip, and runtime performance verification
node tests/test_v0702_upgrade_and_perf.js

# Run Fullscreen & Leave Match (zero browser beforeunload dialog) verification
node tests/test_fullscreen_leave.js

# Run CorsixTH menu pruning & speed lock verification
node tests/test_corsix_menu_and_speed.js

# Run WebAssembly & data package cache-busting and size integrity verification
node tests/test_wasm_cache_bust.js

# Run the simplified quests & multi-player leaderboard test
node tests/test_quests_and_leaderboard_multiplayer.js

# Run the 8-character room codes and pure join invite links verification
node tests/test_invite_link_and_leds.js

# Run the game language & collapsible notes verification
node tests/test_game_language_and_notes.js

# Run the patchnotes drawer verification (checks 0 SVG, 0 emojis, left dock, live commits)
node tests/test_patchnotes_drawer.js

# Run the leaderboard & locked username verification (checks 5 tabs, '?' hint, locking)
node tests/test_leaderboard_and_username.js

# Run the UI improvements regression test (checks top-right HUD, window persistence, play badge)
node tests/test_ui_improvements_oct28.js

# Run WebRTC P2P Versus and Map Preview Modal tests
node tests/test_p2p_versus.js
node tests/test_map_preview_modal.js
```

---

## 7. CorsixTH v0.70.2 Engine Upgrade Summary (Completed)

- Upgraded `third_party/CorsixTH` from `v0.69.2` (`SAVEGAME_VERSION = 222`) to `v0.70.2` (`release/v0.70` hotfix commit `22040b6`, `SAVEGAME_VERSION = 254`, Lua API `2717`).
- Migrated C++/WASM mainloop (`sdl_core.cpp`, `web_loop.h`, `web_main.cpp`) from coroutine yield/resume to direct C++ `push_app_dispatch` + `lua_pcall` execution (including `v0.70.2` `SDL_KEYUP` modifier table hotfix #3535 and root `"/"` VFS path normalization in `utility.lua` / `app.lua`).
- Verified across 12 automated Playwright suites with zero regressions.
