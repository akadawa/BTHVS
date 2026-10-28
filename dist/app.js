/* Browser Theme Hospital – front end: game data import, lobby, WASM launcher.
 *
 * Responsibilities
 *  - import the user's Theme Hospital data (ZIP / folder) and keep it in IndexedDB
 *  - lobby (room codes) over the WebSocket relay
 *  - boot the Emscripten build and provide the JS side of the Lua "web" bridge
 *    (net.send / net.poll / snapshots / persistence / status overlay)
 */
"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const log = (...a) => console.log("[bth]", ...a);

  // ------------------------------------------------------------------ utils
  const enc = new TextEncoder();
  function b64FromBytes(u8) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function bytesFromB64(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  function luaLiteral(v) {
    switch (typeof v) {
      case "string": return JSON.stringify(v).replace(/\\u([0-9a-f]{4})/gi, (_, h) => "?");
      case "number": case "boolean": return String(v);
      case "object":
        if (v === null) return "nil";
        if (Array.isArray(v)) return "{" + v.map(luaLiteral).join(",") + "}";
        return "{" + Object.entries(v).map(([k, x]) => `[${JSON.stringify(k)}]=${luaLiteral(x)}`).join(",") + "}";
      default: return "nil";
    }
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ----------------------------------------------------------- IndexedDB kv
  const DB_NAME = "bth", STORE = "kv";
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvPut(key, val) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function kvDel(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ------------------------------------------------------------ game data
  /** Directories of an original installation the engine can use. */
  const KEEP_RE = /^(data|datam|qdata|qdatam|levels|anims|intro|sound\/data|sound\/midi)\//i;
  const GOAL_PRESETS = {
    cured_10: {
      id: "cured_10",
      title: "Rescue Race: Cure 10 Patients",
      shortTitle: "10 Cures",
      desc: "Cure 10 patients",
      quests: [
        { id: "cured", name: "Cured Patients", target: 10, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_25: {
      id: "cured_25",
      title: "Championship: Cure 25 Patients",
      shortTitle: "25 Cures",
      desc: "Cure 25 patients",
      quests: [
        { id: "cured", name: "Cured Patients", target: 25, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_100: {
      id: "cured_100",
      title: "Grand Hospital: Cure 100 Patients",
      shortTitle: "100 Cures",
      desc: "Cure 100 patients",
      quests: [
        { id: "cured", name: "Cured Patients", target: 100, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_200: {
      id: "cured_200",
      title: "Metropolis: Cure 200 Patients",
      shortTitle: "200 Cures",
      desc: "Cure 200 patients",
      quests: [
        { id: "cured", name: "Cured Patients", target: 200, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_400: {
      id: "cured_400",
      title: "Legend: Cure 400 Patients",
      shortTitle: "400 Cures",
      desc: "Cure 400 patients",
      quests: [
        { id: "cured", name: "Cured Patients", target: 400, unit: "", getVal: (s) => s.cured },
      ],
    },
    time_20m: {
      id: "time_20m",
      title: "20-Minute Sprint: Most cash after 20 min",
      shortTitle: "20 Min Cash Race",
      desc: "The player with the most cash after 20 minutes wins!",
      durationSec: 20 * 60,
      isTimed: true,
      quests: [
        { id: "bal", name: "Cash Balance", target: 0, unit: "$", getVal: (s) => s.bal },
      ],
    },
    time_30m: {
      id: "time_30m",
      title: "30-Minute Duel: Most cash after 30 min",
      shortTitle: "30 Min Cash Race",
      desc: "The player with the most cash after 30 minutes wins!",
      durationSec: 30 * 60,
      isTimed: true,
      quests: [
        { id: "bal", name: "Cash Balance", target: 0, unit: "$", getVal: (s) => s.bal },
      ],
    },
    time_60m: {
      id: "time_60m",
      title: "60-Minute Marathon: Most cash after 60 min",
      shortTitle: "60 Min Cash Race",
      desc: "The player with the most cash after 60 minutes wins!",
      durationSec: 60 * 60,
      isTimed: true,
      quests: [
        { id: "bal", name: "Cash Balance", target: 0, unit: "$", getVal: (s) => s.bal },
      ],
    },
    money_100k: {
      id: "money_100k",
      title: "Economy Race: $100,000 Cash Balance",
      shortTitle: "$100,000 Balance",
      desc: "Reach $100,000 in hospital cash balance",
      quests: [
        { id: "bal", name: "Cash Balance", target: 100000, unit: "$", getVal: (s) => s.bal },
      ],
    },
    money_150k: {
      id: "money_150k",
      title: "Tycoon: $150,000 Cash Balance",
      shortTitle: "$150,000 Balance",
      desc: "Reach $150,000 in hospital cash balance",
      quests: [
        { id: "bal", name: "Cash Balance", target: 150000, unit: "$", getVal: (s) => s.bal },
      ],
    },
    endless: {
      id: "endless",
      title: "Free Versus (Live Stats Comparison)",
      shortTitle: "Endless Duel",
      desc: "No fixed victory condition – Compare metrics and live stats with your rivals!",
      quests: [],
    },
  };

  function getGoalsFromUI() {
    const cured = parseInt($("#goal-cured") ? $("#goal-cured").value : "25", 10) || 0;
    const money = parseInt($("#goal-money") ? $("#goal-money").value : "100000", 10) || 0;
    const timeLimit = parseInt($("#goal-time") ? $("#goal-time").value : "30", 10) || 0;
    return { cured, money, timeLimit };
  }

  function setGoalsInUI(g) {
    if (!g) return;
    if ($("#goal-cured")) $("#goal-cured").value = String(g.cured ?? 0);
    if ($("#goal-money")) $("#goal-money").value = String(g.money ?? 0);
    if ($("#goal-time")) $("#goal-time").value = String(g.timeLimit ?? 0);
  }

  function formatGoalsList(g, html = false) {
    if (!g) return [html ? '<svg class="th-icon" aria-hidden="true"><use href="#th-patient"/></svg> Cure 25 patients' : "Cure 25 patients"];
    const items = [];
    if (g.cured > 0) items.push(html ? `<svg class="th-icon" aria-hidden="true"><use href="#th-patient"/></svg> Cure ${g.cured} patients` : `Cure ${g.cured} patients`);
    if (g.money > 0) items.push(html ? `<svg class="th-icon" aria-hidden="true"><use href="#th-money"/></svg> $${g.money.toLocaleString()} Cash balance` : `$${g.money.toLocaleString()} Cash balance`);
    if (g.timeLimit > 0) items.push(html ? `<svg class="th-icon" aria-hidden="true"><use href="#th-time"/></svg> ${g.timeLimit} Min. time limit` : `${g.timeLimit} Min. time limit`);
    if (items.length === 0) items.push("Free Versus (Live Stats Comparison)");
    return items;
  }

  function updateGoalSummaryUI(g) {
    const htmlItems = formatGoalsList(g, true);
    const textEl = $("#goal-summary-text");
    if (textEl) {
      textEl.innerHTML = htmlItems.map((it) => `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">${it}</div>`).join("");
    }
    const guestSummaryEl = $("#guest-goal-summary");
    if (guestSummaryEl) {
      guestSummaryEl.innerHTML = htmlItems.map((it) => `<span class="guest-goal-badge">${it}</span>`).join("");
    }
  }

  function buildQuestsFromConfig(g) {
    const quests = [];
    if (!g) return quests;
    if (g.cured > 0) {
      quests.push({
        id: "cured",
        name: "Cured Patients",
        target: g.cured,
        unit: "",
        getVal: (s) => s.cured || 0,
      });
    }
    if (g.money > 0) {
      quests.push({
        id: "bal",
        name: "Cash Balance",
        target: g.money,
        unit: "$",
        getVal: (s) => s.bal || 0,
      });
    }
    return quests;
  }

  const state = {
    data: null, // {files: [[path, Uint8Array]], demo: bool, name: string, bytes: number}
    net: null,
    lobby: null,
    session: null,
    game: null,
    vs: {
      goal: "custom",
      goals: { cured: 25, money: 100000, timeLimit: 30 },
      startTime: 0,
      myStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false },
      oppStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false, name: "Opponent" },
      rivalStats: new Map(),
      winner: null,
      tab: "goals",
    },
  };
  window.__bth = state;

  /** entries: Array<[relativePath, Uint8Array]> -> normalised data set or throws. */
  function normaliseEntries(entries, name, sourceType = "folder", sourcePath = "") {
    const norm = entries
      .map(([p, d]) => [p.replace(/\\/g, "/").replace(/^\.\//, ""), d])
      .filter(([p]) => !p.endsWith("/"));
    const marker = norm.find(([p]) => /(^|\/)data\/vspr-0\.tab$/i.test(p));
    if (!marker) throw new Error("This does not appear to be Theme Hospital (DATA/VSPR-0.TAB is missing).");
    const prefix = marker[0].slice(0, marker[0].length - "data/vspr-0.tab".length);
    const files = [];
    let demo = false, bytes = 0;
    for (const [p, d] of norm) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (!KEEP_RE.test(rel)) continue;
      if (/^datam\/demo\.dat$/i.test(rel)) demo = true;
      files.push([rel, d]);
      bytes += d.length;
    }
    const need = ["data/vblk-0.dat", "data/vspr-0.dat", "qdata/font00v.dat"];
    for (const n of need) {
      if (!files.some(([p]) => p.toLowerCase() === n)) throw new Error("Missing required file: " + n.toUpperCase());
    }
    if (demo && !window.__ALLOW_DEMO_FOR_TESTS) {
      throw new Error("Demo version detected! Only the full version of Theme Hospital is supported. Please upload your full game files (e.g. from GOG.com or EA).");
    }
    return { files, demo, name, bytes, sourceType, sourcePath: sourcePath || name };
  }

  function extractFolderSourcePath(fileList) {
    if (!fileList || !fileList.length) return "Folder";
    const markerFile = fileList.find((f) => {
      const p = (f.webkitRelativePath || f.name || "").replace(/\\/g, "/");
      return /(^|\/)data\/vspr-0\.tab$/i.test(p);
    }) || fileList[0];

    // If running in Chromium desktop / Electron or environment that provides file.path
    if (markerFile && markerFile.path) {
      const full = markerFile.path;
      const stripped = full.replace(/[\\/]data[\\/]vspr-0\.tab$/i, "");
      if (stripped && stripped !== full) return stripped;
      const lastSlash = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
      if (lastSlash > 0) return full.slice(0, lastSlash);
      return full;
    }

    // From webkitRelativePath
    const rel = markerFile && markerFile.webkitRelativePath ? markerFile.webkitRelativePath : (fileList[0].webkitRelativePath || "");
    if (rel) {
      const stripped = rel.replace(/[\\/]data[\\/]vspr-0\.tab$/i, "");
      if (stripped && stripped !== rel) return stripped;
      const parts = rel.split(/[\\/]/);
      if (parts.length > 1) return parts[0];
    }

    return fileList[0].name ? fileList[0].name.replace(/[\\/][^\\/]+$/, "") : "Folder";
  }

  async function importZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const unz = fflate.unzipSync(buf, { filter: (f) => !/\.(exe|dll|bat)$/i.test(f.name) && f.size > 0 || f.name.endsWith("/") });
    const sourcePath = file.path || file.name || "Theme Hospital.zip";
    return normaliseEntries(Object.entries(unz), file.name, "zip", sourcePath);
  }
  async function importFolder(fileList) {
    const entries = [];
    for (const f of fileList) {
      const p = f.webkitRelativePath || f.name;
      if (/\.(exe|dll|bat)$/i.test(p)) continue;
      entries.push([p, new Uint8Array(await f.arrayBuffer())]);
    }
    const folderPath = extractFolderSourcePath(fileList);
    const folderName = (fileList[0].webkitRelativePath || "Folder").split(/[\\/]/)[0];
    return normaliseEntries(entries, folderName, "folder", folderPath);
  }
  async function readDropped(items) {
    // Files or directories from a drag & drop operation.
    const out = [];
    async function walk(entry, path) {
      if (entry.isFile) {
        const file = await new Promise((r, j) => entry.file(r, j));
        out.push([path + entry.name, file]);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((r, j) => reader.readEntries(r, j));
          if (!batch.length) break;
          for (const e of batch) await walk(e, path + entry.name + "/");
        }
      }
    }
    for (const it of items) {
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry) await walk(entry, "");
    }
    if (out.length === 1 && /\.zip$/i.test(out[0][0])) return importZip(out[0][1]);
    const entries = [];
    const filesList = [];
    for (const [p, f] of out) {
      if (/\.(exe|dll|bat)$/i.test(p)) continue;
      filesList.push(f);
      entries.push([p, new Uint8Array(await f.arrayBuffer())]);
    }
    const folderPath = extractFolderSourcePath(filesList);
    const folderName = out.length ? out[0][0].split(/[\\/]/)[0] : "Folder";
    return normaliseEntries(entries, folderName, "folder", folderPath);
  }

  function fmtMB(b) { return (b / 1048576).toFixed(1) + " MB"; }

  function renderDataStatus() {
    const st = $("#data-status");
    const d = state.data;
    if (d) {
      st.className = "status ok";
      const isZip = d.sourceType === "zip" || (!d.sourceType && (d.name || "").toLowerCase().endsWith(".zip"));
      const typeLabel = isZip ? "ZIP File" : "Folder";
      const pathLabel = d.sourcePath || d.name || (isZip ? "ZIP Archive" : "Theme Hospital Folder");
      st.innerHTML = `<span class="data-status-check" aria-hidden="true">✔</span> ` +
        `<b>Full version ready</b> · <span class="data-source-type">${escapeHtml(typeLabel)}:</span> ` +
        `<code class="data-path-code" title="${escapeHtml(pathLabel)}">${escapeHtml(pathLabel)}</code> ` +
        `<span class="data-size">(${fmtMB(d.bytes)})</span>`;
    } else {
      st.className = "status warn";
      st.textContent = "No game files found";
    }
    $("#btn-forget").hidden = !d;
    $("#card-mode").setAttribute("aria-disabled", d ? "false" : "true");
    for (const id of ["#btn-create", "#btn-join"]) if ($(id)) $(id).disabled = !d;
    refreshLevelOptions();
  }

  async function setData(data) {
    state.data = data;
    renderDataStatus();
    try {
      await kvPut("thdata", data);
    } catch (e) {
      console.warn("could not persist game data", e);
      showMenuError("Game data could not be saved to IndexedDB. It will be available for this session only.");
    }
  }

  async function withBusy(label, fn) {
    const st = $("#data-status");
    st.className = "status warn";
    st.textContent = label;
    try {
      await setData(await fn());
    } catch (e) {
      console.error(e);
      renderDataStatus();
      showMenuError(e.message || String(e));
    }
  }

  function showMenuError(msg) {
    const el = $("#menu-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ----------------------------------------------------------- level list
  const LEVELS = [
    { id: "demo", label: "Town 1 – Original Hospital (Standard)" },
    { id: "avatar", label: "Avatar – Large City" },
    { id: "confined_v5", label: "Confined – Compact Grounds" },
    { id: "finisham", label: "Finisham – River Landscape" },
    { id: "st.peter's", label: "St. Peter's – Classic Compound" },
    { id: "level1", label: "Level 1 – Original Campaign" },
  ];

  function refreshLevelOptions() {
    const sel = $("#mp-level");
    if (!sel) return;
    const L = state.lobby;
    const cur = sel.value || (L && L.level) || "demo";
    sel.innerHTML = "";
    let foundCurrent = false;

    for (const l of LEVELS) {
      const o = document.createElement("option");
      o.value = l.id;
      o.disabled = false;
      o.textContent = l.label;
      if (l.id === cur) foundCurrent = true;
      sel.appendChild(o);
    }

    const prev = cur;
    if (foundCurrent) {
      sel.value = cur;
    } else {
      sel.value = "demo";
    }
    if (L && L.host && sel.value !== prev) {
      broadcastLobbyConfig();
    }

    const hintEl = $("#level-compat-hint");
    if (hintEl) {
      hintEl.hidden = true;
      hintEl.textContent = "";
    }

    const helpEl = $("#mp-mode-help");
    if (helpEl) {
      helpEl.textContent = "All players manage their own hospital on the selected map. The first to reach all goals wins!";
    }
  }

  // ------------------------------------------------------------ networking
  function getRelayUrl() {
    const urlParams = new URLSearchParams(location.search);
    const fromParam = urlParams.get("server") || urlParams.get("relay");
    if (fromParam) {
      let u = fromParam.trim();
      if (!u.startsWith("ws://") && !u.startsWith("wss://")) {
        u = (location.protocol === "https:" ? "wss://" : "ws://") + u;
      }
      if (!u.includes("/ws") && !u.endsWith("/")) u += "/ws";
      return u;
    }
    const saved = localStorage.getItem("bth-relay-url");
    if (saved) return saved.trim();
    if (window.BTH_RELAY_URL) return window.BTH_RELAY_URL;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function newCode() {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    return c;
  }

  function getNetworkMode() {
    const saved = localStorage.getItem("bth-net-mode");
    if (saved) return saved;
    const param = new URLSearchParams(location.search).get("server") || new URLSearchParams(location.search).get("relay");
    if (param) return "ws";
    if (localStorage.getItem("bth-relay-url")) return "ws";
    const isVercel = location.hostname.endsWith(".vercel.app") || location.hostname.includes("vercel");
    if (isVercel) return "p2p";
    const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname.endsWith(".local") || location.hostname.endsWith(".lan");
    if (isLocal) return "ws";
    return "p2p";
  }

  class WsNet {
    constructor() {
      this.ws = null;
      this.listeners = new Map();
      this.inbox = [];
      this.id = null;
      this.pingMs = null;
      this.open = false;
      this.mode = "ws";
    }
    on(t, fn) { (this.listeners.get(t) || this.listeners.set(t, []).get(t)).push(fn); }
    off(t) { this.listeners.delete(t); }
    emit(t, m) { for (const fn of this.listeners.get(t) || []) fn(m); }
    connect() {
      return new Promise((resolve, reject) => {
        const wsUrl = getRelayUrl();
        let ws;
        try {
          ws = new WebSocket(wsUrl);
        } catch (e) {
          reject(e);
          return;
        }
        this.ws = ws;
        const tm = setTimeout(() => {
          if (!this.open) {
            try { ws.close(); } catch (e) {}
            reject(new Error("Timeout beim Verbinden mit WebSocket-Server"));
          }
        }, 5000);
        ws.onopen = () => {
          clearTimeout(tm);
          this.open = true;
          this._pingTimer = setInterval(() => this.sendRaw({ t: "ping", ts: performance.now() }), 2000);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(tm);
          if (!this.open) reject(new Error("Server nicht erreichbar"));
        };
        ws.onclose = () => {
          clearTimeout(tm);
          this.open = false;
          clearInterval(this._pingTimer);
          this.emit("close", {});
        };
        ws.onmessage = (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.t === "pong") { this.pingMs = Math.round(performance.now() - m.ts); this.emit("ping", this.pingMs); return; }
          if (m.t === "msg") { this.emit("msg", m); return; }
          this.emit(m.t, m);
        };
      });
    }
    sendRaw(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
    close() { try { this.ws && this.ws.close(); } catch (e) {} }
  }

  class P2PNet {
    constructor() {
      this.listeners = new Map();
      this.inbox = [];
      this.id = null;
      this.pingMs = null;
      this.open = false;
      this.mode = "p2p";
      this.isHost = false;
      this.peer = null;
      this.conn = null;
      this.guestConns = new Map();
      this.room = null;
      this._pingTimer = null;
    }
    on(t, fn) { (this.listeners.get(t) || this.listeners.set(t, []).get(t)).push(fn); }
    off(t) { this.listeners.delete(t); }
    emit(t, m) { for (const fn of this.listeners.get(t) || []) fn(m); }

    connect(kind, targetCode) {
      return new Promise((resolve, reject) => {
        if (!window.Peer) {
          reject(new Error("PeerJS library not available."));
          return;
        }
        const iceServers = [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ];

        if (kind === "create") {
          this.isHost = true;
          this.id = 0;
          let code = (targetCode || newCode()).toUpperCase();

          const initHostPeer = (c) => {
            const peerId = "bth-vs-" + c.toLowerCase();
            const peer = new Peer(peerId, { config: { iceServers } });
            this.peer = peer;

            peer.on("open", () => {
              this.open = true;
              this.roomCode = c;
              this.room = {
                code: c,
                max: 5,
                started: false,
                config: {
                  mode: "versus",
                  goals: { cured: 25, money: 100000, timeLimit: 30 },
                  level: "demo"
                },
                players: new Map()
              };

              peer.on("connection", (conn) => {
                conn.on("open", () => {});
                conn.on("data", (m) => this._hostHandleMsg(conn, m));
                conn.on("close", () => this._hostHandleDisconnect(conn));
                conn.on("error", () => this._hostHandleDisconnect(conn));
              });

              resolve();
            });

            peer.on("error", (err) => {
              if (err.type === "unavailable-id") {
                initHostPeer(newCode().toUpperCase());
              } else {
                if (!this.open) reject(new Error("P2P Error: " + (err.message || err.type)));
              }
            });
          };

          initHostPeer(code);

        } else {
          this.isHost = false;
          const code = String(targetCode || "").trim().toUpperCase();
          if (!code) {
            reject(new Error("Please enter a room code."));
            return;
          }
          this.roomCode = code;
          const peer = new Peer({ config: { iceServers } });
          this.peer = peer;

          peer.on("open", () => {
            const targetPeerId = "bth-vs-" + code.toLowerCase();
            const conn = peer.connect(targetPeerId, { reliable: true });
            this.conn = conn;

            const tm = setTimeout(() => {
              if (!this.open) {
                try { conn.close(); } catch (e) {}
                reject(new Error("Timeout: Room '" + code + "' is not responding. Is the host online?"));
              }
            }, 10000);

            conn.on("open", () => {
              clearTimeout(tm);
              this.open = true;
              this._pingTimer = setInterval(() => {
                if (conn && conn.open) conn.send({ t: "ping", ts: performance.now() });
              }, 2000);
              resolve();
            });

            conn.on("data", (m) => {
              if (m.t === "joined") {
                this.id = m.id;
              } else if (m.t === "pong") {
                this.pingMs = Math.round(performance.now() - m.ts);
                this.emit("ping", this.pingMs);
                return;
              } else if (m.t === "msg") {
                this.emit("msg", m);
                return;
              }
              this.emit(m.t, m);
            });

            conn.on("close", () => {
              clearTimeout(tm);
              this.open = false;
              clearInterval(this._pingTimer);
              this.emit("close", {});
            });

            conn.on("error", (err) => {
              clearTimeout(tm);
              if (!this.open) reject(new Error("P2P connection error: " + (err.message || err.type)));
            });
          });

          peer.on("error", (err) => {
            if (err.type === "peer-unavailable") {
              if (!this.open) reject(new Error("Room '" + code + "' not found. Please verify the code or check with the host."));
            } else {
              if (!this.open) reject(new Error("P2P Error: " + (err.message || err.type)));
            }
          });
        }
      });
    }

    _hostHandleMsg(conn, m) {
      if (!this.room) return;
      switch (m.t) {
        case "join": {
          if (this.room.started) {
            conn.send({ t: "error", error: "already_started" });
            return;
          }
          if (this.room.players.size >= this.room.max) {
            conn.send({ t: "error", error: "room_full" });
            return;
          }
          if (!conn._guestId) {
            let nextId = 1;
            while (this.room.players.has(nextId)) nextId++;
            conn._guestId = nextId;
          }
          const guestId = conn._guestId;
          const guest = {
            id: guestId,
            name: String(m.name || ("Player " + guestId)).slice(0, 24),
            demo: false,
            ready: false,
            connected: true,
            host: false,
            conn
          };
          this.guestConns.set(guestId, conn);
          this.room.players.set(guestId, guest);

          conn.send({
            t: "joined",
            code: this.room.code,
            id: guestId,
            host: false,
            max: this.room.max,
            players: this._playerList(),
            started: this.room.started,
            config: this.room.config
          });

          this._hostBroadcast({
            t: "players",
            players: this._playerList(),
            joined: guestId,
            config: this.room.config
          });
          break;
        }
        case "ready": {
          const guestId = conn._guestId;
          const p = guestId ? this.room.players.get(guestId) : null;
          if (p) {
            p.ready = !!m.ready;
            this._hostBroadcast({
              t: "players",
              players: this._playerList(),
              config: this.room.config,
              readyChange: { id: p.id, name: p.name, ready: p.ready }
            });
          }
          break;
        }
        case "chat": {
          const guestId = conn._guestId;
          const p = guestId ? this.room.players.get(guestId) : null;
          this._hostBroadcast({
            t: "chat",
            from: p ? p.id : 1,
            name: p ? p.name : "Guest",
            text: String(m.text || "").slice(0, 300)
          });
          break;
        }
        case "game_ready": {
          const guestId = conn._guestId;
          const p = guestId ? this.room.players.get(guestId) : null;
          if (p) p.gameReady = true;
          const allP = [...this.room.players.values()];
          if (allP.length > 0 && allP.every((pl) => pl.gameReady)) {
            this._hostBroadcast({ t: "start_sim" });
          }
          break;
        }
        case "msg": {
          const fromId = conn._guestId || 1;
          this.emit("msg", { t: "msg", from: fromId, d: m.d });
          for (const [gid, otherConn] of this.guestConns) {
            if (gid !== fromId && otherConn && otherConn.open) {
              try { otherConn.send({ t: "msg", from: fromId, d: m.d }); } catch (e) {}
            }
          }
          break;
        }
        case "ping": {
          conn.send({ t: "pong", ts: m.ts });
          break;
        }
        case "leave": {
          this._hostHandleDisconnect(conn);
          break;
        }
      }
    }

    _hostHandleDisconnect(conn) {
      if (!this.room) return;
      const guestId = conn._guestId;
      if (guestId && this.room.players.has(guestId)) {
        const guest = this.room.players.get(guestId);
        this.room.players.delete(guestId);
        this.guestConns.delete(guestId);
        this._hostBroadcast({
          t: "left",
          id: guestId,
          players: this._playerList(),
          host: 0,
          explicit: true
        });
      }
    }

    _playerList() {
      if (!this.room) return [];
      return [...this.room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        demo: false,
        ready: p.ready,
        connected: p.connected !== false,
        host: p.id === 0
      }));
    }

    _hostBroadcast(msg, skipHost = false) {
      for (const conn of this.guestConns.values()) {
        if (conn && conn.open) {
          try { conn.send(msg); } catch (e) {}
        }
      }
      if (!skipHost) {
        if (msg.t === "msg") this.emit("msg", msg);
        else this.emit(msg.t, msg);
      }
    }

    sendRaw(o) {
      if (this.isHost) {
        if (o.t === "create") {
          const hostPlayer = {
            id: 0,
            name: String(o.name || "Host").slice(0, 24),
            demo: false,
            ready: false,
            connected: true,
            host: true
          };
          this.room.max = Math.min(5, Math.max(2, o.max || 5));
          this.room.players.set(0, hostPlayer);
          setTimeout(() => {
            this.emit("joined", {
              t: "joined",
              code: this.room.code,
              id: 0,
              host: true,
              max: this.room.max,
              players: this._playerList(),
              config: this.room.config
            });
          }, 0);
          return;
        }
        const hostPlayer = this.room ? this.room.players.get(0) : null;
        switch (o.t) {
          case "kick": {
            const targetId = Number(o.targetId);
            const targetConn = this.guestConns.get(targetId);
            if (targetConn) {
              try { targetConn.send({ t: "kicked" }); } catch (e) {}
              try { targetConn.close(); } catch (e) {}
              this.guestConns.delete(targetId);
            }
            if (this.room && this.room.players.has(targetId)) {
              const kickedPlayer = this.room.players.get(targetId);
              this.room.players.delete(targetId);
              this._hostBroadcast({
                t: "left",
                id: targetId,
                players: this._playerList(),
                host: 0,
                explicit: true
              });
              this._hostBroadcast({
                t: "chat",
                from: null,
                sys: true,
                text: `${kickedPlayer ? kickedPlayer.name : "Player"} was kicked by the host.`
              });
            }
            break;
          }
          case "ready": {
            if (hostPlayer) {
              hostPlayer.ready = !!o.ready;
              this._hostBroadcast({
                t: "players",
                players: this._playerList(),
                config: this.room.config,
                readyChange: { id: 0, name: hostPlayer.name, ready: hostPlayer.ready }
              });
            }
            break;
          }
          case "lobby_config": {
            if (this.room) {
              if (o.goals) this.room.config.goals = o.goals;
              let level = o.level || this.room.config.level || "demo";
              this.room.config.level = level;
              if (o.mode) this.room.config.mode = o.mode;
              for (const p of this.room.players.values()) p.ready = false;
              this._hostBroadcast({
                t: "lobby_config",
                goal: "custom",
                goals: this.room.config.goals,
                mode: this.room.config.mode,
                level: this.room.config.level
              });
              this._hostBroadcast({
                t: "players",
                players: this._playerList(),
                config: this.room.config
              });
            }
            break;
          }
          case "start": {
            if (this.room) {
              this.room.started = true;
              let level = (o.config && o.config.level) || this.room.config.level || "demo";
              this.room.config = Object.assign({}, this.room.config, o.config || {}, {
                hostId: 0,
                level,
                players: this._playerList()
              });
              this._hostBroadcast({ t: "start", config: this.room.config });
            }
            break;
          }
          case "game_ready": {
            if (hostPlayer) hostPlayer.gameReady = true;
            const allP = [...this.room.players.values()];
            if (allP.length > 0 && allP.every((pl) => pl.gameReady)) {
              this._hostBroadcast({ t: "start_sim" });
            }
            break;
          }
          case "msg": {
            for (const conn of this.guestConns.values()) {
              if (conn && conn.open) {
                try { conn.send({ t: "msg", from: 0, d: o.d }); } catch (e) {}
              }
            }
            break;
          }
          case "chat": {
            this._hostBroadcast({
              t: "chat",
              from: 0,
              name: hostPlayer ? hostPlayer.name : "Host",
              text: String(o.text || "").slice(0, 300)
            });
            break;
          }
          case "ping": {
            this.pingMs = 1;
            this.emit("ping", 1);
            break;
          }
          case "leave": {
            this.close();
            break;
          }
        }
      } else {
        if (this.conn && this.conn.open) {
          try { this.conn.send(o); } catch (e) {}
        }
      }
    }

    close() {
      this.open = false;
      if (this._pingTimer) clearInterval(this._pingTimer);
      if (this.conn) {
        try { this.conn.close(); } catch (e) {}
      }
      for (const conn of this.guestConns.values()) {
        try { conn.close(); } catch (e) {}
      }
      if (this.peer) {
        try { this.peer.destroy(); } catch (e) {}
      }
      this.emit("close", {});
    }
  }

  function createNet(kind, code) {
    const mode = getNetworkMode();
    if (mode === "p2p" && window.Peer) {
      return new P2PNet();
    }
    return new WsNet();
  }

  function token() {
    let t = sessionStorage.getItem("bth-token");
    if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("bth-token", t); }
    return t;
  }

  function renderLobby() {
    const L = state.lobby;
    if (!L) return;
    if ($("#view-setup")) $("#view-setup").hidden = true;
    $("#card-lobby").hidden = false;
    $("#room-code").textContent = L.code;
    const ul = $("#player-list");
    ul.innerHTML = "";
    for (const p of L.players) {
      const li = document.createElement("li");
      if (!p.connected) li.className = "off";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name + (p.id === L.id ? " (you)" : "");

      const badges = document.createElement("div");
      badges.className = "player-badges";

      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = p.host ? "Host" : "Player";

      const readyBadge = document.createElement("span");
      readyBadge.className = "badge-ready " + (p.ready ? "ready" : "waiting");
      readyBadge.textContent = p.ready ? "Ready" : "Waiting";

      badges.appendChild(tag);
      badges.appendChild(readyBadge);

      if (L.host && p.id !== L.id) {
        const kickBtn = document.createElement("button");
        kickBtn.className = "btn-kick";
        kickBtn.textContent = "Kick";
        kickBtn.title = "Kick " + p.name;
        kickBtn.onclick = (e) => {
          e.stopPropagation();
          if (confirm(`Kick ${p.name} from the room?`)) {
            state.net.sendRaw({ t: "kick", targetId: p.id });
          }
        };
        badges.appendChild(kickBtn);
      }

      li.appendChild(nameSpan);
      li.appendChild(badges);
      ul.appendChild(li);
    }

    const connectedPlayers = L.players.filter((p) => p.connected);
    const connectedCount = connectedPlayers.length;
    const allReady = connectedCount >= 2 && connectedPlayers.every((p) => p.ready);
    const myPlayer = L.players.find((p) => p.id === L.id);
    const amReady = !!(myPlayer && myPlayer.ready);

    const btnReady = $("#btn-ready");
    if (btnReady) {
      if (amReady) {
        btnReady.textContent = "Ready (Click to cancel)";
        btnReady.className = "btn ready-active";
      } else {
        btnReady.textContent = "Ready";
        btnReady.className = "btn secondary";
      }
    }

    const btnStart = $("#btn-start");
    if (btnStart) {
      btnStart.textContent = "Start Game";
      btnStart.hidden = !L.host;
      btnStart.disabled = !allReady;
      if (allReady) {
        btnStart.classList.add("all-ready");
      } else {
        btnStart.classList.remove("all-ready");
      }
    }

    const btnLeave = $("#btn-leave-lobby");
    if (btnLeave) {
      btnLeave.textContent = "Leave Room";
    }

    const max = L.max || 5;
    if ($("#players-header")) $("#players-header").textContent = `Players in Room (${connectedCount}/${max})`;
    $("#host-options").hidden = !L.host;
    $("#guest-options").hidden = !!L.host;

    if (L.host) {
      if (connectedCount < 2) {
        $("#lobby-hint").textContent = "Waiting for players... Share the room code or invite link.";
      } else if (!allReady) {
        $("#lobby-hint").textContent = "All players must click 'Ready' before the match can be started.";
      } else {
        $("#lobby-hint").textContent = "All players are ready! Click 'Start Game'.";
      }
      if (L.goals) setGoalsInUI(L.goals);
      updateGoalSummaryUI(L.goals || getGoalsFromUI());
      refreshLevelOptions();
    } else {
      const levelObj = LEVELS.find((x) => x.id === L.level);
      const levelName = levelObj ? levelObj.label : (L.level || "Town 1");
      if ($("#guest-level-val")) $("#guest-level-val").textContent = levelName;
      updateGoalSummaryUI(L.goals);
      const guestWait = $("#guest-wait");
      if (guestWait) {
        if (!amReady) {
          guestWait.textContent = "Please click 'Ready' when you are set.";
        } else if (!allReady) {
          guestWait.textContent = "You are ready! Waiting for other players...";
        } else {
          guestWait.textContent = "Everyone is ready! Waiting for the host to start...";
        }
      }
    }
  }

  function lobbyChatMsg(name, text, isMe) {
    const logEl = $("#lobby-chat-log");
    if (!logEl) return;
    const placeholder = logEl.querySelector(".chat-placeholder");
    if (placeholder) placeholder.remove();

    const line = document.createElement("div");
    line.className = "chat-line";

    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, "0") + ":" +
                    String(now.getMinutes()).padStart(2, "0");

    const timeSpan = document.createElement("span");
    timeSpan.className = "chat-time";
    timeSpan.textContent = `[${timeStr}]`;

    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-name" + (isMe ? "" : " partner");
    nameSpan.textContent = name + ": ";

    const textSpan = document.createElement("span");
    textSpan.textContent = text;

    line.appendChild(timeSpan);
    line.appendChild(nameSpan);
    line.appendChild(textSpan);

    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function lobbyChatSys(text) {
    const logEl = $("#lobby-chat-log");
    if (!logEl) return;
    const placeholder = logEl.querySelector(".chat-placeholder");
    if (placeholder) placeholder.remove();

    const line = document.createElement("div");
    line.className = "chat-line chat-sys";
    line.textContent = text;

    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function toggleReady() {
    if (!state.lobby || !state.net) return;
    const myPlayer = state.lobby.players.find((p) => p.id === state.lobby.id);
    const nextReady = !(myPlayer && myPlayer.ready);
    state.net.sendRaw({ t: "ready", ready: nextReady });
  }

  function broadcastLobbyConfig() {
    if (state.lobby && state.lobby.host && state.net) {
      const goals = getGoalsFromUI();
      let level = $("#mp-level") ? $("#mp-level").value : (state.lobby.level || "demo");
      state.lobby.mode = "versus";
      state.lobby.goals = goals;
      state.lobby.level = level;
      updateGoalSummaryUI(goals);
      state.net.sendRaw({ t: "lobby_config", mode: "versus", level, goals, goal: "custom" });
    }
  }

  async function enterLobby(kind, code) {
    showMenuError("");
    const chatLog = $("#lobby-chat-log");
    if (chatLog) chatLog.innerHTML = '<div class="chat-placeholder">No messages in lobby chat yet.</div>';
    let net = createNet(kind, code);
    state.net = net;
    try {
      await net.connect(kind, code);
    } catch (e) {
      console.warn("Net connect failed", e);
      if (net.mode === "ws" && window.Peer) {
        console.log("WebSocket connection failed, falling back to WebRTC P2P...");
        net = new P2PNet();
        state.net = net;
        try {
          await net.connect(kind, code);
        } catch (e2) {
          showMenuError(e2.message || "Connection failed.");
          return;
        }
      } else {
        const isVercel = location.hostname.endsWith(".vercel.app") || location.hostname.includes("vercel");
        if (isVercel && net.mode === "ws") {
          showMenuError("WebSocket connection failed. You can switch to WebRTC P2P (Serverless) at the bottom under 'Network'.");
        } else {
          showMenuError(e.message || "Connection to server failed.");
        }
        return;
      }
    }
    const name = playerName();
    const isDemo = false;
    net.on("joined", (m) => {
      const isPublic = $("#create-public") ? $("#create-public").checked : true;
      state.lobby = {
        code: m.code,
        id: m.id,
        host: m.host,
        players: m.players,
        max: m.max || 5,
        isPublic,
        mode: "versus",
        goals: (m.config && m.config.goals) ? m.config.goals : { cured: 25, money: 100000, timeLimit: 30 },
        level: (m.config && m.config.level) ? m.config.level : "demo",
      };
      net.id = m.id;
      if (m.started && m.config) { startMultiplayer(m.config, true); return; }
      history.replaceState(null, "", "?join=" + m.code);
      if (m.host) {
        state.lobby.goals = getGoalsFromUI();
        const curTotal = (parseInt(localStorage.getItem("bth_total_lobbies") || "0", 10) || 0) + 1;
        localStorage.setItem("bth_total_lobbies", String(curTotal));
        updateTotalHostedUI(curTotal);
        if (isPublic) {
          registerPublicLobby(state.lobby);
          if (_lobbyHeartbeatTimer) clearInterval(_lobbyHeartbeatTimer);
          _lobbyHeartbeatTimer = setInterval(() => {
            if (state.lobby && state.lobby.host && state.lobby.isPublic && !state.game) {
              registerPublicLobby(state.lobby);
            }
          }, 25000);
        }
      } else {
        setGoalsInUI(state.lobby.goals);
      }
      renderLobby();
      lobbyChatSys(`Entered room ${m.code} as "${name}".`);
    });
    net.on("players", (m) => {
      if (state.lobby && !state.game) {
        state.lobby.players = m.players;
        if (m.config) {
          if (m.config.goals) state.lobby.goals = m.config.goals;
          if (m.config.level) state.lobby.level = m.config.level;
        }
        if (state.lobby.host && state.lobby.isPublic) {
          registerPublicLobby(state.lobby);
        }
        if (m.readyChange) {
          const statusTxt = m.readyChange.ready ? "READY" : "NOT READY";
          lobbyChatSys(`${m.readyChange.name} is now ${statusTxt}`);
        } else if (m.joined !== undefined && m.joined !== net.id) {
          const joinedP = m.players.find((p) => p.id === m.joined);
          if (joinedP) lobbyChatSys(`${joinedP.name} joined the room.`);
        }
        renderLobby();
      }
    });
    net.on("kicked", () => {
      leaveLobby();
      showMenuError("You were kicked from the room by the host.");
    });
    net.on("lobby_config", (m) => {
      if (state.lobby && !state.game) {
        state.lobby.mode = "versus";
        state.lobby.level = m.level;
        if (m.goals) {
          state.lobby.goals = m.goals;
          setGoalsInUI(m.goals);
        }
        updateGoalSummaryUI(state.lobby.goals);
        lobbyChatSys("Settings updated – Ready status reset.");
        if (state.lobby.host && state.lobby.isPublic) registerPublicLobby(state.lobby);
        if (!state.lobby.host) renderLobby();
      }
    });
    net.on("chat", (m) => {
      lobbyChatMsg(m.name, m.text, m.from === net.id);
    });
    net.on("left", (m) => {
      if (!state.lobby) return;
      const leftPlayer = state.lobby.players.find((p) => p.id === m.id);
      if (leftPlayer) lobbyChatSys(`${leftPlayer.name} left the room.`);
      state.lobby.players = m.players;
      if (m.host !== undefined && m.host !== null) state.lobby.host = m.host === state.lobby.id;
      if (state.lobby.host && state.lobby.isPublic) registerPublicLobby(state.lobby);
      if (!state.game) renderLobby();
    });
    net.on("error", (m) => {
      if (m.error === "not_all_ready") {
        lobbyChatSys("Start canceled: All players must be ready!");
        if ($("#lobby-hint")) $("#lobby-hint").textContent = "All players must click 'Ready' before starting!";
        return;
      }
      const t = {
        no_such_room: "This room does not exist.",
        room_full: "The room is full.",
        already_started: "The match has already started."
      }[m.error] || m.error;
      showMenuError(t);
      $("#card-lobby").hidden = true;
      if ($("#view-setup")) $("#view-setup").hidden = false;
      net.close();
      state.net = null;
    });
    net.on("start", (m) => startMultiplayer(m.config, false));
    net.on("close", () => {
      if (!state.game) {
        state.lobby = null;
        $("#card-lobby").hidden = true;
        if ($("#view-setup")) $("#view-setup").hidden = false;
        if (state.net === net) state.net = null;
      }
    });
    if (kind === "create") {
      const isPublic = $("#create-public") ? $("#create-public").checked : true;
      net.sendRaw({
        t: "create",
        name,
        demo: false,
        max: parseInt($("#max-players") ? $("#max-players").value : "5", 10),
        isPublic,
        token: token()
      });
    } else {
      net.sendRaw({ t: "join", code, name, demo: false, token: token() });
    }
  }

  function playerName() {
    const n = $("#player-name").value.trim() || "Player";
    localStorage.setItem("bth-name", n);
    return n;
  }

  function leaveLobby() {
    if (state.lobby) unregisterPublicLobby(state.lobby.code);
    if (state.net) { state.net.sendRaw({ t: "leave" }); state.net.close(); }
    state.net = null;
    state.lobby = null;
    $("#card-lobby").hidden = true;
    if ($("#view-setup")) $("#view-setup").hidden = false;
    const chatLog = $("#lobby-chat-log");
    if (chatLog) chatLog.innerHTML = '<div class="chat-placeholder">No messages in lobby chat yet.</div>';
    history.replaceState(null, "", location.pathname);
    refreshPublicLobbies();
  }

  function hostStart() {
    const L = state.lobby;
    if (!L || !L.host || !state.net) return;
    const connectedPlayers = L.players.filter((p) => p.connected);
    if (connectedPlayers.length < 2) {
      lobbyChatSys("At least 2 players are required to start.");
      return;
    }
    if (!connectedPlayers.every((p) => p.ready)) {
      lobbyChatSys("All players must be ready before the match can be started!");
      return;
    }
    const goals = getGoalsFromUI();
    let level = $("#mp-level") ? $("#mp-level").value : (L.level || "demo");
    const seed = (Math.random() * 0x7fffffff) | 0;
    unregisterPublicLobby(L.code);
    state.net.sendRaw({ t: "start", config: { mode: "versus", level, goals, seed, language: $("#language").value } });
  }

  let _lobbyHeartbeatTimer = null;
  function getLobbiesApiUrl() {
    const mode = getNetworkMode();
    const relayWs = getRelayUrl();
    if (relayWs && (mode === "ws" || localStorage.getItem("bth-relay-url"))) {
      try {
        const u = new URL(relayWs);
        const proto = u.protocol === "wss:" ? "https:" : "http:";
        return `${proto}//${u.host}/api/lobbies`;
      } catch (e) {}
    }
    return "/api/lobbies";
  }

  async function registerPublicLobby(room) {
    if (!room || !room.isPublic) return;
    const apiUrl = getLobbiesApiUrl();
    const payload = {
      code: room.code,
      hostName: playerName(),
      players: room.players ? room.players.filter((p) => p.connected !== false).length : 1,
      max: room.max || 5,
      level: room.config ? room.config.level : (room.level || "demo"),
      goals: room.config ? room.config.goals : room.goals,
      netMode: getNetworkMode(),
    };
    try {
      await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }

  async function unregisterPublicLobby(code) {
    if (!code) return;
    if (_lobbyHeartbeatTimer) {
      clearInterval(_lobbyHeartbeatTimer);
      _lobbyHeartbeatTimer = null;
    }
    const apiUrl = getLobbiesApiUrl();
    try {
      await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, action: "close" }),
      });
    } catch (e) {}
  }

  function updateTotalHostedUI(count) {
    const el = $("#count-lobbies-hosted");
    if (el) el.textContent = (count || 0).toLocaleString();
  }

  async function refreshPublicLobbies() {
    const container = $("#lobbies-container");
    if (!container) return;
    const apiUrl = getLobbiesApiUrl();
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (typeof data.totalHosted === "number") {
        const cur = Math.max(data.totalHosted, parseInt(localStorage.getItem("bth_total_lobbies") || "0", 10) || 0);
        localStorage.setItem("bth_total_lobbies", String(cur));
        updateTotalHostedUI(cur);
      }
      const lobbies = data.lobbies || [];
      const newKey = lobbies.map((l) => `${l.code}:${l.players || 1}:${l.hostName}:${l.level}`).join("|");
      if (container._lastLobbiesKey === newKey) return;
      container._lastLobbiesKey = newKey;
      if (lobbies.length === 0) {
        container.innerHTML = '<div class="lobbies-empty">No active public lobbies found right now. Check "List in Public Lobby Browser" when creating a room above!</div>';
        return;
      }
      let html = `
        <table class="lobbies-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Host</th>
              <th>Players</th>
              <th>Map</th>
              <th>Goals</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
      `;
      for (const lob of lobbies) {
        const goalsDesc = lob.goals ? formatGoalsList(lob.goals).join(", ") : "Standard";
        const lObj = LEVELS.find((x) => x.id === lob.level);
        const mapName = lObj ? lObj.label.split(" (")[0].split(" –")[0] : (lob.level || "Town 1");
        const count = lob.players || lob.playerCount || 1;
        const max = lob.max || 5;
        html += `
          <tr>
            <td><span class="room-code-badge">${escapeHtml(lob.code)}</span></td>
            <td><b>${escapeHtml(lob.hostName || "Host")}</b></td>
            <td>${count} / ${max}</td>
            <td>${escapeHtml(mapName)}</td>
            <td style="font-size: 0.82rem; color: var(--muted);">${escapeHtml(goalsDesc)}</td>
            <td>
              <button class="btn primary btn-sm btn-join-lobby" data-code="${escapeHtml(lob.code)}">Join</button>
            </td>
          </tr>
        `;
      }
      html += `</tbody></table>`;
      container.innerHTML = html;
      container.querySelectorAll(".btn-join-lobby").forEach((btn) => {
        btn.onclick = () => {
          const code = btn.dataset.code;
          if ($("#join-code")) $("#join-code").value = code;
          enterLobby("join", code);
        };
      });
    } catch (e) {
      if (!container._lastLobbiesKey) {
        container.innerHTML = '<div class="lobbies-empty">No active public lobbies found right now. Check "List in Public Lobby Browser" when creating a room above!</div>';
      }
    }
  }

  // ----------------------------------------------------------- game launch
  function configText(w, h, lang, name) {
    const q = (s) => "[[" + s + "]]";
    return [
      "fullscreen = false",
      `width = ${w}`,
      `height = ${h}`,
      `language = ${q(lang)}`,
      "audio = true",
      "play_sounds = true",
      "sound_volume = 0.5",
      "play_announcements = true",
      "announcement_volume = 0.5",
      "play_music = false",
      "music_volume = 0.5",
      "movies = false",
      "play_intro = false",
      "play_demo = false",
      "check_for_updates = false",
      "capture_mouse = false",
      "debug = false",
      "allow_user_actions_while_paused = true",
      `theme_hospital_install = ${q("/thdata")}`,
      `player_name = ${q(name)}`,
      "",
    ].join("\n");
  }

  function mkdirp(FS, dir) {
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur += "/" + p;
      try { FS.mkdir(cur); } catch (e) { /* exists */ }
    }
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error("Could not load " + src + " – has the game been built? (npm run build)"));
      document.head.appendChild(s);
    });
  }

  function setLoading(text) { $("#loading-text").textContent = text; }

  async function startGame(session) {
    if (state.game) return;
    state.session = session;
    $("#menu").hidden = true;
    $("#game").hidden = false;
    $("#loading").hidden = false;
    setLoading("Loading game engine ...");
    const canvas = $("#canvas");
    const W = Math.max(640, window.innerWidth), H = Math.max(480, window.innerHeight);
    let ready;
    try {
      if (!window.createCorsixTH) await loadScript("game/corsixth.js");
      const mod = await createCorsixTH({
        canvas,
        locateFile: (p) => "game/" + p,
        print: (t) => console.log("[game]", t),
        printErr: (t) => console.warn("[game]", t),
        thBridge: (cmd, arg) => bridge(cmd, arg),
        thFatal: (msg) => fatal(msg),
        thExit: (restart) => gameExit(restart),
        setStatus: (t) => { if (t) setLoading(t); },
      });
      state.game = { mod, canvas };
      const FS = mod.FS;
      setLoading("Copying game files ...");
      for (const [p, d] of state.data.files) {
        const full = "/thdata/" + p;
        mkdirp(FS, full.slice(0, full.lastIndexOf("/")));
        FS.writeFile(full, d);
      }
      // Persistent config + savegames
      const cfgDir = "/home/web_user/.config/CorsixTH";
      mkdirp(FS, cfgDir);
      try {
        FS.mount(FS.filesystems.IDBFS, {}, cfgDir);
        await new Promise((res) => FS.syncfs(true, () => res()));
      } catch (e) { console.warn("IDBFS unavailable", e); }
      FS.writeFile(cfgDir + "/config.txt", configText(W, H, session.language || $("#language").value, session.name || playerName()));
      mkdirp(FS, "/tmp");
      canvas.focus();
      setLoading("Launching ...");
      installWindowHandlers(mod);
      mod.callMain([]);
      // First frame arrives asynchronously; hide the loader shortly after.
      setTimeout(() => { $("#loading").hidden = true; canvas.focus(); }, 800);
      if (session.mp) setupHud();
    } catch (e) {
      console.error(e);
      fatal(String(e && e.stack || e));
    }
  }

  function installWindowHandlers(mod) {
    let t = null;
    const resize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const w = Math.max(640, window.innerWidth), h = Math.max(480, window.innerHeight);
        try { mod._th_resize(w, h); } catch (e) {}
      }, 120);
    };
    window.addEventListener("resize", resize);
    document.addEventListener("fullscreenchange", resize);
    window.addEventListener("beforeunload", (e) => {
      if (state.session && state.session.mp) { e.preventDefault(); e.returnValue = ""; }
    });
    $("#canvas").addEventListener("mousedown", () => $("#canvas").focus());
    // keep browser shortcuts (F5/F11) usable but swallow game keys that scroll the page
    $("#canvas").addEventListener("keydown", (e) => {
      if (["Tab", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) e.preventDefault();
    });
  }

  function fatal(msg) {
    log("fatal", msg);
    $("#fatal-text").textContent = String(msg);
    $("#fatal").hidden = false;
    $("#loading").hidden = true;
  }
  function gameExit(restart) {
    log("game exit, restart=", restart);
    if (state.net) { state.net.sendRaw({ t: "leave" }); state.net.close(); }
    location.href = location.pathname;
  }

  // ------------------------------------------------------------ Lua bridge
  function parseStats(str) {
    if (!str) return null;
    const parts = str.split(",").map((x) => parseInt(x, 10));
    if (parts.length < 7 || parts.some(isNaN)) return null;
    return {
      bal: parts[0],
      rep: parts[1],
      rooms: parts[2],
      staff: parts[3],
      cured: parts[4],
      deaths: parts[5],
      val: parts[6],
      started: true,
    };
  }

  function bridge(cmd, arg) {
    const net = state.net;
    switch (cmd) {
      case "test.val":
        window.__test_val = arg;
        return null;
      case "game.ready":
        if (net) net.sendRaw({ t: "game_ready" });
        return null;
      case "mp.session":
        return state.session && state.session.mp ? "return " + luaLiteral(state.session.mp) : "";
      case "net.send": {
        if (!net) return null;
        // arg: "<to>|<payload>" (to = all | peer id)
        const i = arg.indexOf("|");
        const to = arg.slice(0, i);
        net.sendRaw({ t: "msg", to: to === "all" ? "all" : parseInt(to, 10), d: arg.slice(i + 1) });
        return null;
      }
      case "net.poll": {
        if (!net || !net.inbox.length) return null;
        const m = net.inbox.shift();
        return m.from + "|" + m.d;
      }
      case "net.ping":
        return net && net.pingMs != null ? String(net.pingMs) : "";
      case "vs.mystats": {
        const s = parseStats(arg);
        if (s) {
          Object.assign(state.vs.myStats, s);
          updateQuestUI();
          checkWinConditions();
        }
        return null;
      }
      case "vs.win": {
        const parts = (arg || "").split("|");
        const winId = parseInt(parts[0], 10);
        const winName = parts[1] || "A Player";
        showVictoryModal(winName, winId === (state.lobby ? state.lobby.id : -1));
        return null;
      }
      case "fs.sync": {
        try { state.game.mod.FS.syncfs(false, () => {}); } catch (e) {}
        return null;
      }
      case "ui.banner": {
        const el = $("#net-banner");
        if (!arg) { el.hidden = true; return null; }
        const [kind, text] = [arg.charAt(0), arg.slice(1)];
        el.className = kind === "e" ? "err" : "";
        el.textContent = text;
        el.hidden = false;
        return null;
      }
      case "ui.sync": {
        const el = $("#hud-sync");
        const [kind, text] = [arg.charAt(0), arg.slice(1)];
        el.className = "chip " + (kind === "o" ? "ok" : kind === "w" ? "warn" : "err");
        el.textContent = text;
        return null;
      }
      case "time.now":
        return String(Date.now());
      case "log":
        console.log("[lua]", arg);
        return null;
      }
      return null;
    }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function updateHudPlayers() {
    const el = $("#hud-players");
    if (!el) return;
    const mp = state.session && state.session.mp;
    if (!mp) { el.hidden = true; return; }
    const players = (state.lobby && state.lobby.players && state.lobby.players.length) ? state.lobby.players : (mp.players || []);
    const hostId = (state.lobby && state.lobby.hostId !== undefined) ? state.lobby.hostId : (mp.host !== undefined ? mp.host : 0);
    const myId = mp.id;

    const hostP = players.find((p) => p.id === hostId || p.host) || players[0];
    const guestPs = players.filter((p) => p && p !== hostP);

    const parts = [];
    if (hostP) {
      const isMe = hostP.id === myId;
      const offline = hostP.connected === false ? " (offline)" : "";
      parts.push(`<span class="hud-role-host" title="Game Host">Host: <b>${escapeHtml(hostP.name)}</b>${isMe ? " (You)" : ""}${offline}</span>`);
    }
    if (guestPs.length > 0) {
      for (const gp of guestPs) {
        const isMe = gp.id === myId;
        const offline = gp.connected === false ? " (offline)" : "";
        parts.push(`<span class="hud-role-guest" title="Connected Player">Player: <b>${escapeHtml(gp.name)}</b>${isMe ? " (You)" : ""}${offline}</span>`);
      }
    } else {
      parts.push(`<span class="hud-role-guest muted">Player: (waiting …)</span>`);
    }
    el.innerHTML = parts.join(' <span class="hud-sep">·</span> ');
    el.hidden = false;
  }

  // -------------------------------------------------------- multiplayer HUD
  function setupHud() {
    const net = state.net;
    $("#hud").hidden = false;
    const mp = state.session && state.session.mp;
    const lObj = LEVELS.find((x) => x.id === (mp && mp.level));
    const mapLabel = lObj ? lObj.label.split(" (")[0].split(" –")[0] : (mp && mp.level || "");
    const roomCode = (state.lobby && state.lobby.code) || (mp && mp.code) || "";
    $("#hud-room").textContent = "Room " + roomCode + (mapLabel ? " · " + mapLabel : "");
    updateHudPlayers();
    if (net) {
      net.on("ping", (ms) => {
        const el = $("#hud-ping");
        el.textContent = ms + " ms";
        el.className = "chip " + (ms < 120 ? "ok" : ms < 300 ? "warn" : "err");
      });
      net.on("msg", (m) => {
        if (typeof m.d === "string" && m.d.startsWith("vstats:")) {
          const s = parseStats(m.d.slice(7));
          if (s) {
            const fromP = state.lobby && state.lobby.players ? state.lobby.players.find((p) => p.id === m.from) : null;
            s.name = (fromP && fromP.name) || `Player ${m.from}`;
            state.vs.rivalStats.set(m.from, s);
            Object.assign(state.vs.oppStats, s);
            updateQuestUI();
            checkWinConditions();
          }
        } else if (typeof m.d === "string" && m.d.startsWith("win:")) {
          const parts = m.d.slice(4).split("|");
          const winId = parseInt(parts[0], 10);
          const winName = parts[1] || "A Player";
          showVictoryModal(winName, winId === (state.lobby ? state.lobby.id : -1));
        } else {
          net.inbox.push({ from: m.from, d: m.d });
        }
      });
      net.on("players", (m) => {
        if (state.lobby) state.lobby.players = m.players;
        net.inbox.push({ from: -1, d: "peers:" + peersString(m.players) });
        updateHudPlayers();
      });
      net.on("left", (m) => {
        if (state.lobby) {
          state.lobby.players = m.players;
          if (m.host !== null && m.host !== undefined) {
            state.lobby.hostId = m.host;
            if (state.session && state.session.mp) state.session.mp.host = m.host;
          }
        }
        net.inbox.push({ from: -1, d: "peers:" + peersString(m.players) + (m.host !== null && m.host !== undefined ? "|host=" + m.host : "") });
        chatSys(`${((state.lobby && state.lobby.players || []).find(p=>p.id===m.id)||{name:"A Player"}).name} disconnected.`);
        updateHudPlayers();
      });
      net.on("start_sim", () => {
        net.inbox.push({ from: -1, d: "start_sim" });
        const banner = $("#net-banner");
        if (banner) {
          banner.className = "";
          banner.textContent = "Match started!";
          setTimeout(() => { banner.hidden = true; }, 3000);
        }
      });
      net.on("close", () => { $("#net-banner").className = "err"; $("#net-banner").textContent = "Lost connection to server – Game paused."; $("#net-banner").hidden = false; net.inbox.push({ from: -1, d: "server_closed" }); });
      net.on("chat", (m) => chatMsg(m.name, m.text, m.from !== net.id));
    }
    const tickTimer = () => {
      const g = state.vs && state.vs.goals;
      const timerEl = $("#hud-timer");
      if (g && g.timeLimit > 0 && state.vs.startTime) {
        const elapsed = Math.floor((Date.now() - state.vs.startTime) / 1000);
        const rem = Math.max(0, g.timeLimit * 60 - elapsed);
        const remMin = Math.floor(rem / 60);
        const remSec = rem % 60;
        if (timerEl) {
          timerEl.hidden = false;
          timerEl.innerHTML = `<svg class="th-icon" aria-hidden="true"><use href="#th-time"/></svg> <span>${remMin}:${String(remSec).padStart(2, "0")}</span>`;
          timerEl.className = "chip " + (rem < 120 ? "err" : rem < 300 ? "warn" : "ok");
        }
        if (!$("#quest-win").hidden && state.vs.tab === "goals") {
          updateQuestUI();
        }
        checkWinConditions();
      } else {
        if (timerEl) timerEl.hidden = true;
      }
    };
    if (state._timerInterval) clearInterval(state._timerInterval);
    tickTimer();
    state._timerInterval = setInterval(tickTimer, 1000);
    setupChat();
    setupQuests();
    $("#hud-fs-btn").onclick = toggleFullscreen;

    // Automatically open Chat and Quests on match start
    if ($("#chat")) $("#chat").hidden = false;
    if ($("#quest-win")) {
      $("#quest-win").hidden = false;
      updateQuestUI();
    }
    // Carry over lobby chat history into in-game chat
    const lobbyLines = document.querySelectorAll("#lobby-chat-log .chat-line:not(.chat-placeholder)");
    const inGameLog = $("#chat-log");
    if (lobbyLines.length > 0 && inGameLog && inGameLog.children.length === 0) {
      lobbyLines.forEach((line) => {
        const clone = line.cloneNode(true);
        inGameLog.appendChild(clone);
      });
      inGameLog.scrollTop = inGameLog.scrollHeight;
    }
    // Return canvas focus so player controls work immediately
    if ($("#canvas")) $("#canvas").focus();
  }
  function peersString(players) {
    return players.map((p) => p.id + ":" + (p.connected ? 1 : 0)).join(",");
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function makeDraggable(box, header, ignoreSelector) {
    if (!box || !header) return;
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let initialLeft = 0, initialTop = 0;

    const onDragStart = (clientX, clientY) => {
      isDragging = true;
      dragStartX = clientX;
      dragStartY = clientY;
      const rect = box.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      box.style.bottom = "auto";
      box.style.right = "auto";
      box.style.left = initialLeft + "px";
      box.style.top = initialTop + "px";
    };

    const onDragMove = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = clientX - dragStartX;
      const dy = clientY - dragStartY;
      const maxX = Math.max(0, window.innerWidth - box.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - box.offsetHeight);
      const newX = Math.max(0, Math.min(maxX, initialLeft + dx));
      const newY = Math.max(0, Math.min(maxY, initialTop + dy));
      box.style.left = newX + "px";
      box.style.top = newY + "px";
    };

    header.addEventListener("mousedown", (e) => {
      if (ignoreSelector && e.target && (e.target.matches(ignoreSelector) || e.target.closest(ignoreSelector))) return;
      onDragStart(e.clientX, e.clientY);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => onDragMove(e.clientX, e.clientY));
    window.addEventListener("mouseup", () => { isDragging = false; });

    header.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      if (ignoreSelector && e.target && (e.target.matches(ignoreSelector) || e.target.closest(ignoreSelector))) return;
      onDragStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (isDragging && e.touches.length === 1) onDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchend", () => { isDragging = false; });
  }

  function makeResizable(box, handle) {
    if (!box || !handle) return;
    let isResizing = false;
    let startX = 0, startY = 0;
    let startW = 0, startH = 0;

    const onPointerDown = (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = box.offsetWidth;
      startH = box.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e) => {
      if (!isResizing) return;
      const newW = Math.max(280, startW + (e.clientX - startX));
      const newH = Math.max(160, startH + (e.clientY - startY));
      box.style.width = newW + "px";
      box.style.height = newH + "px";
    };

    const onPointerUp = () => {
      isResizing = false;
    };

    handle.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);

    handle.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        isResizing = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startW = box.offsetWidth;
        startH = box.offsetHeight;
        e.stopPropagation();
      }
    }, { passive: false });
    window.addEventListener("touchmove", (e) => {
      if (isResizing && e.touches.length === 1) {
        const newW = Math.max(280, startW + (e.touches[0].clientX - startX));
        const newH = Math.max(160, startH + (e.touches[0].clientY - startY));
        box.style.width = newW + "px";
        box.style.height = newH + "px";
      }
    }, { passive: true });
    window.addEventListener("touchend", () => { isResizing = false; });
  }

  // ------------------------------------------------------------------ chat
  let unread = 0;
  function chatLog() { return $("#chat-log"); }
  function chatMsg(name, text, incoming) {
    const d = document.createElement("div");
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = name + ": ";
    d.appendChild(w);
    d.appendChild(document.createTextNode(text));
    chatLog().appendChild(d);
    chatLog().scrollTop = chatLog().scrollHeight;
    if ($("#chat").hidden && incoming) { unread++; $("#chat-badge").hidden = false; }
  }
  function chatSys(text) {
    const d = document.createElement("div");
    d.className = "sys";
    d.textContent = text;
    chatLog().appendChild(d);
    chatLog().scrollTop = chatLog().scrollHeight;
  }
  function setupChat() {
    const box = $("#chat"), input = $("#chat-input"), header = $("#chat-header");
    const toggle = (show) => {
      box.hidden = show === undefined ? !box.hidden : !show;
      if (!box.hidden) { unread = 0; $("#chat-badge").hidden = true; input.focus(); } else $("#canvas").focus();
    };
    $("#hud-chat-btn").onclick = () => toggle();
    if ($("#chat-close")) $("#chat-close").onclick = () => toggle(false);

    makeDraggable(box, header, "#chat-close");
    makeResizable(box, box.querySelector(".win-resize-handle"));

    $("#chat-form").onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (text) state.net.sendRaw({ t: "chat", text });
      input.value = "";
      toggle(false);
    };
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") toggle(false); });
    $("#canvas").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.ctrlKey && !e.altKey) { /* game uses Enter rarely */ } });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey && !state.game ? false : e.key === "Enter" && e.shiftKey) { e.preventDefault(); toggle(true); }
    });
  }

  // ------------------------------------------------------------------ quests & versus
  function formatVal(val, unit) {
    if (unit === "$") return "$" + (val || 0).toLocaleString();
    return (val || 0).toLocaleString() + (unit ? " " + unit : "");
  }

  function checkWinConditions() {
    if (state.vs.winner) return; // match already concluded
    if (!state.vs.startTime || Date.now() - state.vs.startTime < 4000) return;
    const g = state.vs.goals || { cured: 25, money: 100000, timeLimit: 30 };
    const my = state.vs.myStats;
    const opp = state.vs.oppStats;
    const quests = buildQuestsFromConfig(g);

    // 1. Time limit expired check
    if (g.timeLimit > 0) {
      const elapsedSec = (Date.now() - state.vs.startTime) / 1000;
      const totalSec = g.timeLimit * 60;
      if (elapsedSec >= totalSec) {
        let winnerId = null;
        let winnerName = null;
        let isMe = false;

        const myQuestsDone = quests.length > 0 && my.started && quests.every((q) => q.getVal(my) >= q.target);
        const oppQuestsDone = quests.length > 0 && opp.started && quests.every((q) => q.getVal(opp) >= q.target);

        if (myQuestsDone && !oppQuestsDone) {
          winnerId = state.lobby ? state.lobby.id : 0;
          winnerName = playerName();
          isMe = true;
        } else if (oppQuestsDone && !myQuestsDone) {
          winnerId = -999;
          winnerName = opp.name || "Opponent";
          isMe = false;
        } else {
          // Compare cash balance
          if (my.bal > opp.bal) {
            winnerId = state.lobby ? state.lobby.id : 0;
            winnerName = playerName();
            isMe = true;
          } else if (opp.bal > my.bal) {
            winnerId = -999;
            winnerName = opp.name || "Opponent";
            isMe = false;
          } else {
            // Tie breaker: hospital overall value
            if (my.val >= opp.val) {
              winnerId = state.lobby ? state.lobby.id : 0;
              winnerName = playerName();
              isMe = true;
            } else {
              winnerId = -999;
              winnerName = opp.name || "Opponent";
              isMe = false;
            }
          }
        }
        state.vs.winner = winnerId;
        if (isMe && state.net) {
          state.net.sendRaw({ t: "msg", to: "all", d: `win:${winnerId}|${winnerName}` });
        }
        showVictoryModal(winnerName, isMe);
        return;
      }
    }

    // 2. All active non-timed quests check (if any quests are set)
    if (quests.length > 0) {
      const myMet = my.started && quests.every((q) => q.getVal(my) >= q.target);
      const oppMet = opp.started && quests.every((q) => q.getVal(opp) >= q.target);

      if (myMet) {
        state.vs.winner = state.lobby ? state.lobby.id : 1;
        const myName = playerName();
        if (state.net) {
          state.net.sendRaw({ t: "msg", to: "all", d: `win:${state.vs.winner}|${myName}` });
        }
        showVictoryModal(myName, true);
      } else if (oppMet) {
        state.vs.winner = -999;
        showVictoryModal(opp.name || "Opponent", false);
      }
    }
  }

  function updateQuestUI() {
    const g = state.vs.goals || { cured: 25, money: 100000, timeLimit: 30 };
    const my = state.vs.myStats;
    const opp = state.vs.oppStats;
    const quests = buildQuestsFromConfig(g);

    // Header names
    const thYou = $("#th-you");
    if (thYou) thYou.textContent = "You (" + playerName() + ")";
    const thOpp = $("#th-opp");
    if (thOpp) thOpp.textContent = opp.name || "Opponent";

    // Match Goal footer
    const goalFooter = $("#quest-match-goal");
    if (goalFooter) goalFooter.textContent = "Goals: " + formatGoalsList(g).join(" + ");

    // Lead Banner
    const leadText = $("#quest-lead-text");
    if (leadText) {
      if (g.timeLimit > 0) {
        const elapsed = Math.floor((Date.now() - state.vs.startTime) / 1000);
        const rem = Math.max(0, g.timeLimit * 60 - elapsed);
        const remMin = Math.floor(rem / 60);
        const remSec = rem % 60;
        const timeStr = `${remMin}:${String(remSec).padStart(2, "0")}`;
        const diff = (my.bal || 0) - (opp.bal || 0);

        if (diff > 500) {
          leadText.innerHTML = `<span class="lead-pill lead-you">Lead</span> <b>You are in the lead! (+$${diff.toLocaleString()})</b> · Time left: <b>${timeStr}</b>`;
        } else if (diff < -500) {
          leadText.innerHTML = `<span class="lead-pill lead-opp">Behind</span> <b>${escapeHtml(opp.name || "Opponent")} is leading! (+$${Math.abs(diff).toLocaleString()})</b> · Time left: <b>${timeStr}</b>`;
        } else {
          leadText.innerHTML = `<span class="lead-pill lead-tie">Tied</span> <b>Tied cash balance!</b> · Time left: <b>${timeStr}</b>`;
        }
      } else if (quests.length === 0) {
        leadText.innerHTML = "<b>Free Versus</b> – Compare your live metrics!";
      } else {
        let myPctSum = 0, oppPctSum = 0;
        for (const q of quests) {
          myPctSum += Math.min(100, Math.max(0, (q.getVal(my) / q.target) * 100));
          oppPctSum += Math.min(100, Math.max(0, (q.getVal(opp) / q.target) * 100));
        }
        const myAvg = Math.round(myPctSum / quests.length);
        const oppAvg = Math.round(oppPctSum / quests.length);

        if (myAvg > oppAvg + 5) {
          leadText.innerHTML = `<span class="lead-pill lead-you">Lead</span> <b>You are leading the race!</b> (${myAvg}% vs. ${oppAvg}%)`;
        } else if (oppAvg > myAvg + 5) {
          leadText.innerHTML = `<span class="lead-pill lead-opp">Behind</span> <b>${escapeHtml(opp.name || "Opponent")} is leading!</b> (${oppAvg}% vs. ${myAvg}%)`;
        } else {
          leadText.innerHTML = `<span class="lead-pill lead-tie">Tied</span> <b>Head-to-head race!</b> (${myAvg}% vs. ${oppAvg}%)`;
        }
      }
    }

    // Quest Cards list
    const list = $("#quest-list");
    if (list) {
      const cardsHtml = [];

      // If time limit is set, show a timer countdown card
      if (g.timeLimit > 0) {
        const elapsed = Math.floor((Date.now() - state.vs.startTime) / 1000);
        const rem = Math.max(0, g.timeLimit * 60 - elapsed);
        const remMin = Math.floor(rem / 60);
        const remSec = rem % 60;
        const timeStr = `${remMin}:${String(remSec).padStart(2, "0")}`;
        const totalCash = Math.max(1, Math.max(0, my.bal || 0) + Math.max(0, opp.bal || 0));
        const myPct = Math.min(100, Math.max(0, Math.round(((my.bal || 0) / totalCash) * 100)));
        const oppPct = Math.min(100, Math.max(0, Math.round(((opp.bal || 0) / totalCash) * 100)));
        const diff = (my.bal || 0) - (opp.bal || 0);

        cardsHtml.push(`
          <div class="quest-card">
            <div class="quest-card-header">
              <span class="quest-card-title"><svg class="th-icon" aria-hidden="true"><use href="#th-time"/></svg> Time Challenge (${g.timeLimit} Min.)</span>
              <span class="quest-badge ${rem < 120 ? 'done' : 'pending'}"><svg class="th-icon" aria-hidden="true"><use href="#th-time"/></svg> ${timeStr} left</span>
            </div>
            <p class="muted small" style="margin: 4px 0 8px;">
              Whoever reaches the goals or holds the most cash when time runs out wins!
            </p>
            <div class="prog-row">
              <div class="prog-label">
                <span>You: $${(my.bal || 0).toLocaleString()}</span>
                <span>${diff >= 0 ? '+' : ''}$${diff.toLocaleString()} (${myPct}%)</span>
              </div>
              <div class="prog-bar-wrap">
                <div class="prog-bar-fill you" style="width: ${myPct}%"></div>
              </div>
            </div>
            <div class="prog-row">
              <div class="prog-label">
                <span>${escapeHtml(opp.name || "Opponent")}: $${(opp.bal || 0).toLocaleString()}</span>
                <span>${oppPct}%</span>
              </div>
              <div class="prog-bar-wrap">
                <div class="prog-bar-fill opp" style="width: ${oppPct}%"></div>
              </div>
            </div>
          </div>
        `);
      }

      for (const q of quests) {
        const myVal = q.getVal(my);
        const oppVal = q.getVal(opp);
        const myPct = Math.min(100, Math.max(0, Math.round((myVal / q.target) * 100)));
        const oppPct = Math.min(100, Math.max(0, Math.round((oppVal / q.target) * 100)));
        const myDone = myVal >= q.target;
        const oppDone = oppVal >= q.target;
        const iconHref = q.id === "cured" ? "#th-patient" : q.id === "bal" ? "#th-money" : "#th-trophy";

        cardsHtml.push(`
          <div class="quest-card">
            <div class="quest-card-header">
              <span class="quest-card-title"><svg class="th-icon" aria-hidden="true"><use href="${iconHref}"/></svg> ${escapeHtml(q.name)}</span>
              <span class="quest-badge ${myDone ? "done" : "pending"}">Goal: ${formatVal(q.target, q.unit)}</span>
            </div>
            <div class="prog-row">
              <div class="prog-label">
                <span>You: ${formatVal(myVal, q.unit)}</span>
                <span>${myPct}%${myDone ? " (Done)" : ""}</span>
              </div>
              <div class="prog-bar-wrap">
                <div class="prog-bar-fill you" style="width: ${myPct}%"></div>
              </div>
            </div>
            <div class="prog-row">
              <div class="prog-label">
                <span>${escapeHtml(opp.name || "Opponent")}: ${formatVal(oppVal, q.unit)}</span>
                <span>${oppPct}%${oppDone ? " (Done)" : ""}</span>
              </div>
              <div class="prog-bar-wrap">
                <div class="prog-bar-fill opp" style="width: ${oppPct}%"></div>
              </div>
            </div>
          </div>
        `);
      }

      if (cardsHtml.length === 0) {
        cardsHtml.push(`
          <div class="quest-card">
            <div class="quest-card-header">
              <span class="quest-card-title">Free Versus Match</span>
            </div>
            <p class="muted small" style="margin: 6px 0 0;">There is no fixed victory condition in this mode. Compare metrics in real time under the <b>Rivals Dashboard</b> tab!</p>
          </div>
        `);
      }

      list.innerHTML = cardsHtml.join("");
    }

    // Rivalen-Dashboard table
    const tbody = $("#rival-tbody");
    if (tbody) {
      const myStarted = my.started;
      const oppStarted = opp.started;

      const myStatus = myStarted ? '<span class="status-pill active">Active</span>' : '<span class="status-pill wait">Waiting</span>';
      const oppStatus = oppStarted ? '<span class="status-pill active">Active</span>' : '<span class="status-pill wait">Waiting</span>';

      const cmp = (v1, v2, higherIsBetter = true) => {
        if (v1 === v2) return ["", ""];
        if ((v1 > v2) === higherIsBetter) return ['val-leader', ''];
        return ['', 'val-leader'];
      };

      const [cBal1, cBal2] = cmp(my.bal, opp.bal);
      const [cRooms1, cRooms2] = cmp(my.rooms, opp.rooms);
      const [cStaff1, cStaff2] = cmp(my.staff, opp.staff);
      const [cCured1, cCured2] = cmp(my.cured, opp.cured);
      const [cDeaths1, cDeaths2] = cmp(my.deaths, opp.deaths, false);
      const [cRep1, cRep2] = cmp(my.rep, opp.rep);
      const [cVal1, cVal2] = cmp(my.val, opp.val);

      tbody.innerHTML = `
        <tr>
          <td>Hospital Status</td>
          <td class="val-you">${myStatus}</td>
          <td class="val-opp">${oppStatus}</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-money"/></svg> Cash Balance</td>
          <td class="val-you ${cBal1}">$${my.bal.toLocaleString()}</td>
          <td class="val-opp ${cBal2}">$${opp.bal.toLocaleString()}</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-room"/></svg> Built Rooms</td>
          <td class="val-you ${cRooms1}">${my.rooms} ${my.rooms === 1 ? "Room" : "Rooms"}</td>
          <td class="val-opp ${cRooms2}">${opp.rooms} ${opp.rooms === 1 ? "Room" : "Rooms"}</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-staff"/></svg> Staff Members</td>
          <td class="val-you ${cStaff1}">${my.staff} Staff</td>
          <td class="val-opp ${cStaff2}">${opp.staff} Staff</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-patient"/></svg> Cured Patients</td>
          <td class="val-you ${cCured1}">${my.cured}</td>
          <td class="val-opp ${cCured2}">${opp.cured}</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-death"/></svg> Patient Deaths</td>
          <td class="val-you ${cDeaths1}">${my.deaths}</td>
          <td class="val-opp ${cDeaths2}">${opp.deaths}</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-rep"/></svg> Hospital Reputation</td>
          <td class="val-you ${cRep1}">${my.rep} / 1000</td>
          <td class="val-opp ${cRep2}">${opp.rep} / 1000</td>
        </tr>
        <tr>
          <td><svg class="th-icon" aria-hidden="true"><use href="#th-val"/></svg> Overall Valuation</td>
          <td class="val-you ${cVal1}">$${my.val.toLocaleString()}</td>
          <td class="val-opp ${cVal2}">$${opp.val.toLocaleString()}</td>
        </tr>
      `;
    }
  }

  function setupQuests() {
    const win = $("#quest-win");
    const toggle = (show) => {
      win.hidden = show === undefined ? !win.hidden : !show;
      if (!win.hidden) {
        if ($("#quest-badge")) $("#quest-badge").hidden = true;
        updateQuestUI();
      }
    };

    if ($("#hud-quest-btn")) $("#hud-quest-btn").onclick = () => toggle();
    if ($("#quest-close")) $("#quest-close").onclick = () => toggle(false);

    const tabBtns = document.querySelectorAll("#quest-tabs .quest-tab-btn");
    tabBtns.forEach((btn) => {
      btn.onclick = () => {
        tabBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab;
        state.vs.tab = tab;
        $("#quest-view-goals").hidden = tab !== "goals";
        $("#quest-view-dashboard").hidden = tab !== "dashboard";
      };
    });

    makeDraggable(win, $("#quest-header"), "#quest-close");
    makeResizable(win, win.querySelector(".win-resize-handle"));

    if ($("#vic-continue")) {
      $("#vic-continue").onclick = () => {
        $("#victory-modal").hidden = true;
      };
    }
    if ($("#vic-exit")) {
      $("#vic-exit").onclick = () => gameExit(false);
    }

    window.addEventListener("keydown", (e) => {
      if ((e.key === "q" || e.key === "Q" || e.key === "h" || e.key === "H") && state.game && !$("#chat:not([hidden])") && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        toggle();
      }
    });

    updateQuestUI();
  }

  function showVictoryModal(winnerName, isMe) {
    const modal = $("#victory-modal");
    if (!modal) return;
    const iconEl = $("#vic-icon");
    const titleEl = $("#vic-title");
    const descEl = $("#vic-desc");
    const summaryEl = $("#vic-stats-summary");

    if (iconEl) iconEl.innerHTML = isMe ? '<svg class="th-icon th-icon-hero" aria-hidden="true"><use href="#th-trophy"/></svg>' : '<svg class="th-icon th-icon-hero" aria-hidden="true"><use href="#th-val"/></svg>';
    if (titleEl) {
      titleEl.textContent = isMe ? "Victory! You won the match!" : `Match concluded – ${winnerName} won!`;
      titleEl.className = isMe ? "vic-won" : "vic-lost";
    }
    if (descEl) {
      const g = state.vs.goals || { cured: 25, money: 100000, timeLimit: 30 };
      const goalsDesc = formatGoalsList(g).join(" and ");
      if (g.timeLimit > 0) {
        const my = state.vs.myStats;
        const opp = state.vs.oppStats;
        descEl.textContent = isMe
          ? `Congratulations! After ${g.timeLimit} minutes, you won with a cash balance of $${(my.bal || 0).toLocaleString()} compared to $${(opp.bal || 0).toLocaleString()}! (Goals: ${goalsDesc})`
          : `Time is up! ${winnerName} won with a cash balance of $${(opp.bal || 0).toLocaleString()} compared to $${(my.bal || 0).toLocaleString()}. (Goals: ${goalsDesc})`;
      } else {
        descEl.textContent = isMe
          ? `Congratulations! You reached all goals (${goalsDesc}) before your rivals!`
          : `${winnerName} reached all goals (${goalsDesc}) first.`;
      }
    }

    if (summaryEl) {
      const my = state.vs.myStats;
      const opp = state.vs.oppStats;
      summaryEl.innerHTML = `
        <table class="rival-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th id="th-you">You (${escapeHtml(playerName())})</th>
              <th id="th-opp">${escapeHtml(opp.name || "Opponent")}</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-money"/></svg> Cash Balance</td><td class="val-you">$${my.bal.toLocaleString()}</td><td class="val-opp">$${opp.bal.toLocaleString()}</td></tr>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-room"/></svg> Built Rooms</td><td class="val-you">${my.rooms}</td><td class="val-opp">${opp.rooms}</td></tr>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-staff"/></svg> Staff Members</td><td class="val-you">${my.staff}</td><td class="val-opp">${opp.staff}</td></tr>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-patient"/></svg> Cured Patients</td><td class="val-you">${my.cured}</td><td class="val-opp">${opp.cured}</td></tr>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-death"/></svg> Patient Deaths</td><td class="val-you">${my.deaths}</td><td class="val-opp">${opp.deaths}</td></tr>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-rep"/></svg> Hospital Reputation</td><td class="val-you">${my.rep} / 1000</td><td class="val-opp">${opp.rep} / 1000</td></tr>
            <tr><td><svg class="th-icon" aria-hidden="true"><use href="#th-val"/></svg> Overall Valuation</td><td class="val-you">$${my.val.toLocaleString()}</td><td class="val-opp">$${opp.val.toLocaleString()}</td></tr>
          </tbody>
        </table>
      `;
    }

    modal.hidden = false;
  }

  // ------------------------------------------------------------ MP startup
  function startMultiplayer(config, rejoin) {
    const L = state.lobby;
    const players = config.players || (L && L.players) || [];
    const me = players.find((p) => p.id === L.id) || { id: L.id, name: playerName() };
    const opp = players.find((p) => p.id !== L.id);
    const hostId = config.hostId !== undefined ? config.hostId : (players.find((p) => p.host) ? players.find((p) => p.host).id : (players.length ? Math.min(...players.map((p) => p.id)) : 0));
    const goals = config.goals || (L && L.goals) || { cured: 25, money: 100000, timeLimit: 30 };

    state.vs = {
      goal: config.goal || "custom",
      goals,
      startTime: Date.now(),
      myStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false },
      oppStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false, name: opp ? opp.name : "Opponent" },
      rivalStats: new Map(),
      winner: null,
      tab: "goals",
    };

    const mp = {
      id: L.id,
      code: L.code,
      name: me.name,
      players,
      mode: "versus",
      goals,
      level: config.level,
      seed: config.seed,
      rejoin: !!rejoin,
      host: hostId,
    };
    state.net.off("joined");
    state.net.off("start");
    state.net.off("chat");
    state.net.on("start_sim", () => {
      if (state.net) state.net.inbox.push({ from: -1, d: "start_sim" });
      const banner = $("#net-banner");
      if (banner) {
        banner.className = "";
        banner.textContent = "Match started!";
        setTimeout(() => { banner.hidden = true; }, 3000);
      }
    });
    startGame({ mp, language: config.language, name: me.name });
  }

  // ----------------------------------------------------------------- wiring
  async function init() {
    $("#player-name").value = localStorage.getItem("bth-name") || "";
    $("#language").value = localStorage.getItem("bth-lang") || "English";
    $("#language").onchange = () => localStorage.setItem("bth-lang", $("#language").value);

    try { state.data = (await kvGet("thdata")) || null; } catch (e) { state.data = null; }
    renderDataStatus();

    $("#btn-zip").onclick = () => $("#file-zip").click();
    $("#btn-folder").onclick = () => $("#file-folder").click();
    $("#btn-forget").onclick = async () => { await kvDel("thdata"); state.data = null; renderDataStatus(); };
    $("#file-zip").onchange = (e) => { const f = e.target.files[0]; if (f) withBusy("Unpacking " + f.name + " …", () => importZip(f)); e.target.value = ""; };
    $("#file-folder").onchange = (e) => {
      const fl = [...e.target.files];
      if (fl.length) {
        const folderName = (fl[0].webkitRelativePath || "Folder").split(/[\\/]/)[0];
        withBusy("Reading folder '" + folderName + "' …", () => importFolder(fl));
      }
      e.target.value = "";
    };

    const dz = $("#dropzone");
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => {
      const items = e.dataTransfer.items;
      if (items && items.length) withBusy("Reading files …", () => readDropped([...items].map((i) => i)));
    });
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    if ($("#btn-single")) $("#btn-single").onclick = () => startGame({ language: $("#language").value, name: playerName() });
    $("#btn-create").onclick = () => enterLobby("create");
    $("#btn-join").onclick = () => {
      const code = $("#join-code").value.trim().toUpperCase();
      if (code.length < 4) { showMenuError("Please enter a room code."); return; }
      enterLobby("join", code);
    };
    $("#join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    $("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-join").click(); });
    $("#btn-ready").onclick = toggleReady;
    $("#btn-leave-lobby").onclick = leaveLobby;
    $("#btn-start").onclick = hostStart;
    for (const gid of ["#goal-cured", "#goal-money", "#goal-time"]) {
      const el = $(gid);
      if (el) el.onchange = () => broadcastLobbyConfig();
    }
    $("#mp-level").onchange = () => { broadcastLobbyConfig(); };
    $("#btn-copy-code").onclick = () => {
      if (state.lobby) navigator.clipboard.writeText(state.lobby.code).catch(() => {});
      const btn = $("#btn-copy-code");
      const oldTxt = btn.textContent;
      btn.textContent = "Code copied!";
      setTimeout(() => { btn.textContent = oldTxt; }, 1800);
    };
    $("#btn-copy-link").onclick = () => {
      const u = new URL(location.origin + location.pathname);
      if (state.lobby) u.searchParams.set("join", state.lobby.code);
      if (state.net && state.net.mode === "ws") {
        const relayParam = new URLSearchParams(location.search).get("server") || new URLSearchParams(location.search).get("relay") || localStorage.getItem("bth-relay-url");
        if (relayParam) u.searchParams.set("server", relayParam);
      }
      navigator.clipboard.writeText(u.toString()).catch(() => {});
      const btn = $("#btn-copy-link");
      const oldTxt = btn.textContent;
      btn.textContent = "Link copied!";
      setTimeout(() => { btn.textContent = oldTxt; }, 1800);
    };
    $("#fatal-reload").onclick = () => (location.href = location.pathname);

    const btnRefreshLobbies = $("#btn-refresh-lobbies");
    if (btnRefreshLobbies) {
      btnRefreshLobbies.onclick = () => refreshPublicLobbies();
    }

    const lobbyChatForm = $("#lobby-chat-form");
    const lobbyChatInput = $("#lobby-chat-input");
    if (lobbyChatForm && lobbyChatInput) {
      lobbyChatForm.onsubmit = (e) => {
        e.preventDefault();
        const text = lobbyChatInput.value.trim();
        if (text && state.net) {
          state.net.sendRaw({ t: "chat", text });
          lobbyChatInput.value = "";
        }
      };
    }

    updateTotalHostedUI(parseInt(localStorage.getItem("bth_total_lobbies") || "0", 10) || 0);
    refreshLevelOptions();
    refreshPublicLobbies();
    setInterval(() => {
      const setupView = $("#view-setup");
      if (setupView && !setupView.hidden && !state.lobby && !state.game) {
        refreshPublicLobbies();
      }
    }, 4000);

    const join = new URLSearchParams(location.search).get("join");
    if (join) $("#join-code").value = join.toUpperCase().slice(0, 5);

    // test hooks (used by tests/*.js)
    window.__bth = { state, startGame, setData, normaliseEntries, enterLobby, hostStart, toggleReady, checkWinConditions, updateQuestUI, refreshPublicLobbies, updateTotalHostedUI };
  }

  init();
})();
