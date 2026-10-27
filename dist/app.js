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
      title: "❤️ Rettungsrennen: 10 Patienten heilen",
      shortTitle: "10 Heilungen",
      desc: "10 Patienten heilen",
      quests: [
        { id: "cured", name: "Geheilte Patienten", target: 10, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_25: {
      id: "cured_25",
      title: "❤️ Meisterschaft: 25 Patienten heilen",
      shortTitle: "25 Heilungen",
      desc: "25 Patienten heilen",
      quests: [
        { id: "cured", name: "Geheilte Patienten", target: 25, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_100: {
      id: "cured_100",
      title: "❤️ Großhospital: 100 Patienten heilen",
      shortTitle: "100 Heilungen",
      desc: "100 Patienten heilen",
      quests: [
        { id: "cured", name: "Geheilte Patienten", target: 100, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_200: {
      id: "cured_200",
      title: "❤️ Metropole: 200 Patienten heilen",
      shortTitle: "200 Heilungen",
      desc: "200 Patienten heilen",
      quests: [
        { id: "cured", name: "Geheilte Patienten", target: 200, unit: "", getVal: (s) => s.cured },
      ],
    },
    cured_400: {
      id: "cured_400",
      title: "❤️ Legende: 400 Patienten heilen",
      shortTitle: "400 Heilungen",
      desc: "400 Patienten heilen",
      quests: [
        { id: "cured", name: "Geheilte Patienten", target: 400, unit: "", getVal: (s) => s.cured },
      ],
    },
    time_20m: {
      id: "time_20m",
      title: "⏱️ 20-Minuten-Sprint: Meistes Geld nach 20 Min.",
      shortTitle: "20 Min. Cash-Race",
      desc: "Wer nach 20 Minuten Spielzeit das meiste Barvermögen hat, gewinnt!",
      durationSec: 20 * 60,
      isTimed: true,
      quests: [
        { id: "bal", name: "Barvermögen", target: 0, unit: "$", getVal: (s) => s.bal },
      ],
    },
    time_30m: {
      id: "time_30m",
      title: "⏱️ 30-Minuten-Duell: Meistes Geld nach 30 Min.",
      shortTitle: "30 Min. Cash-Race",
      desc: "Wer nach 30 Minuten Spielzeit das meiste Barvermögen hat, gewinnt!",
      durationSec: 30 * 60,
      isTimed: true,
      quests: [
        { id: "bal", name: "Barvermögen", target: 0, unit: "$", getVal: (s) => s.bal },
      ],
    },
    time_60m: {
      id: "time_60m",
      title: "⏱️ 60-Minuten-Marathon: Meistes Geld nach 60 Min.",
      shortTitle: "60 Min. Cash-Race",
      desc: "Wer nach 60 Minuten Spielzeit das meiste Barvermögen hat, gewinnt!",
      durationSec: 60 * 60,
      isTimed: true,
      quests: [
        { id: "bal", name: "Barvermögen", target: 0, unit: "$", getVal: (s) => s.bal },
      ],
    },
    money_100k: {
      id: "money_100k",
      title: "💰 Wirtschaftsrennen: $100.000 Barvermögen",
      shortTitle: "$100.000 Guthaben",
      desc: "Krankenhaus mit $100.000 Barvermögen",
      quests: [
        { id: "bal", name: "Barvermögen", target: 100000, unit: "$", getVal: (s) => s.bal },
      ],
    },
    money_150k: {
      id: "money_150k",
      title: "💎 Tycoon: $150.000 Barvermögen",
      shortTitle: "$150.000 Guthaben",
      desc: "Großes Wirtschaftsrennen: $150.000 Barvermögen",
      quests: [
        { id: "bal", name: "Barvermögen", target: 150000, unit: "$", getVal: (s) => s.bal },
      ],
    },
    expand_5: {
      id: "expand_5",
      title: "🏥 Bau-Duell: 5 verschiedene Räume & 5 Mitarbeiter",
      shortTitle: "5 Räume & 5 Mitarbeiter",
      desc: "5 funktionierende Räume & 5 Mitarbeiter anstellen",
      quests: [
        { id: "rooms", name: "Funktionierende Räume", target: 5, unit: "", getVal: (s) => s.rooms },
        { id: "staff", name: "Mitarbeiter angestellt", target: 5, unit: "", getVal: (s) => s.staff },
      ],
    },
    allround: {
      id: "allround",
      title: "⭐ Allrounder: $75.000, 4 Räume, 4 Mitarbeiter & 5 Heilungen",
      shortTitle: "Allrounder-Klinik",
      desc: "$75.000 Guthaben, 4 Räume, 4 Mitarbeiter und 5 Heilungen",
      quests: [
        { id: "bal", name: "Barvermögen", target: 75000, unit: "$", getVal: (s) => s.bal },
        { id: "rooms", name: "Räume gebaut", target: 4, unit: "", getVal: (s) => s.rooms },
        { id: "staff", name: "Mitarbeiter angestellt", target: 4, unit: "", getVal: (s) => s.staff },
        { id: "cured", name: "Geheilte Patienten", target: 5, unit: "", getVal: (s) => s.cured },
      ],
    },
    val_150k: {
      id: "val_150k",
      title: "🏷️ Gesamtbewertung: Krankenhauswert $150.000",
      shortTitle: "Krankenhauswert $150.000",
      desc: "Krankenhaus-Gesamtwert von mindestens $150.000 erreichen",
      quests: [
        { id: "val", name: "Krankenhauswert", target: 150000, unit: "$", getVal: (s) => s.val },
      ],
    },
    endless: {
      id: "endless",
      title: "♾️ Freies Duell (Punkte- & Statistikvergleich)",
      shortTitle: "Endlos-Duell",
      desc: "Kein festes Sieg-Ziel – Vergleicht live eure Kennzahlen und Statistiken!",
      quests: [],
    },
  };

  const PRESETS = {
    sprint: { cured: 10, money: 0, rooms: 0, timeLimit: 0 },
    duel: { cured: 25, money: 0, rooms: 0, timeLimit: 30 },
    cashrace: { cured: 0, money: 100000, rooms: 0, timeLimit: 20 },
    tycoon: { cured: 50, money: 150000, rooms: 0, timeLimit: 0 },
    builder: { cured: 0, money: 0, rooms: 5, timeLimit: 0 },
  };

  function getGoalsFromUI() {
    const cured = parseInt($("#goal-cured") ? $("#goal-cured").value : "25", 10) || 0;
    const money = parseInt($("#goal-money") ? $("#goal-money").value : "100000", 10) || 0;
    const rooms = parseInt($("#goal-rooms") ? $("#goal-rooms").value : "0", 10) || 0;
    const timeLimit = parseInt($("#goal-time") ? $("#goal-time").value : "30", 10) || 0;
    return { cured, money, rooms, timeLimit };
  }

  function setGoalsInUI(g) {
    if (!g) return;
    if ($("#goal-cured")) $("#goal-cured").value = String(g.cured ?? 0);
    if ($("#goal-money")) $("#goal-money").value = String(g.money ?? 0);
    if ($("#goal-rooms")) $("#goal-rooms").value = String(g.rooms ?? 0);
    if ($("#goal-time")) $("#goal-time").value = String(g.timeLimit ?? 0);
  }

  function formatGoalsList(g) {
    if (!g) return ["10 Patienten heilen"];
    const items = [];
    if (g.cured > 0) items.push(`❤️ ${g.cured} Patienten heilen`);
    if (g.money > 0) items.push(`💰 $${g.money.toLocaleString()} Guthaben`);
    if (g.rooms > 0) items.push(`🏥 ${g.rooms} Räume & Mitarbeiter`);
    if (g.timeLimit > 0) items.push(`⏱️ ${g.timeLimit} Min. Zeitlimit`);
    if (items.length === 0) items.push("♾️ Freies Duell (Punkte- & Statistikvergleich)");
    return items;
  }

  function updateGoalSummaryUI(g) {
    const items = formatGoalsList(g);
    const textEl = $("#goal-summary-text");
    if (textEl) {
      textEl.innerHTML = items.map((it) => `<span>• ${escapeHtml(it)}</span>`).join("<br>");
    }
    const guestSummaryEl = $("#guest-goal-summary");
    if (guestSummaryEl) {
      guestSummaryEl.innerHTML = items.map((it) => `<span class="guest-goal-badge">${escapeHtml(it)}</span>`).join("");
    }
  }

  function buildQuestsFromConfig(g) {
    const quests = [];
    if (!g) return quests;
    if (g.cured > 0) {
      quests.push({
        id: "cured",
        name: "Geheilte Patienten",
        target: g.cured,
        unit: "",
        getVal: (s) => s.cured || 0,
      });
    }
    if (g.money > 0) {
      quests.push({
        id: "bal",
        name: "Barvermögen",
        target: g.money,
        unit: "$",
        getVal: (s) => s.bal || 0,
      });
    }
    if (g.rooms > 0) {
      quests.push({
        id: "rooms",
        name: "Funktionierende Räume",
        target: g.rooms,
        unit: "",
        getVal: (s) => s.rooms || 0,
      });
      quests.push({
        id: "staff",
        name: "Mitarbeiter angestellt",
        target: g.rooms,
        unit: "",
        getVal: (s) => s.staff || 0,
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
      goals: { cured: 25, money: 100000, rooms: 0, timeLimit: 30 },
      startTime: 0,
      myStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false },
      oppStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false, name: "Gegner" },
      winner: null,
      tab: "goals",
    },
  };
  window.__bth = state;

  /** entries: Array<[relativePath, Uint8Array]> -> normalised data set or throws. */
  function normaliseEntries(entries, name) {
    const norm = entries
      .map(([p, d]) => [p.replace(/\\/g, "/").replace(/^\.\//, ""), d])
      .filter(([p]) => !p.endsWith("/"));
    const marker = norm.find(([p]) => /(^|\/)data\/vspr-0\.tab$/i.test(p));
    if (!marker) throw new Error("Das sieht nicht nach Theme Hospital aus (DATA/VSPR-0.TAB fehlt).");
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
      if (!files.some(([p]) => p.toLowerCase() === n)) throw new Error("Datei fehlt: " + n.toUpperCase());
    }
    return { files, demo, name, bytes };
  }

  async function importZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const unz = fflate.unzipSync(buf, { filter: (f) => !/\.(exe|dll|bat)$/i.test(f.name) && f.size > 0 || f.name.endsWith("/") });
    return normaliseEntries(Object.entries(unz), file.name);
  }
  async function importFolder(fileList) {
    const entries = [];
    for (const f of fileList) {
      const p = f.webkitRelativePath || f.name;
      if (/\.(exe|dll|bat)$/i.test(p)) continue;
      entries.push([p, new Uint8Array(await f.arrayBuffer())]);
    }
    return normaliseEntries(entries, (fileList[0].webkitRelativePath || "Ordner").split("/")[0]);
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
    for (const [p, f] of out) {
      if (/\.(exe|dll|bat)$/i.test(p)) continue;
      entries.push([p, new Uint8Array(await f.arrayBuffer())]);
    }
    return normaliseEntries(entries, out.length ? out[0][0].split("/")[0] : "Ordner");
  }

  function fmtMB(b) { return (b / 1048576).toFixed(1) + " MB"; }

  function renderDataStatus() {
    const st = $("#data-status");
    const d = state.data;
    if (d) {
      st.className = "status ok";
      st.textContent = `✔ ${d.demo ? "Demo" : "Vollversion"}-Daten bereit (${d.name}, ${fmtMB(d.bytes)})`;
    } else {
      st.className = "status warn";
      st.textContent = "Keine Spieldaten gefunden";
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
      showMenuError("Spieldaten konnten nicht dauerhaft gespeichert werden (Speicherplatz?). Sie gelten nur für diese Sitzung.");
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
  /** What the host can pick. `full: true` = requires all players to have full game files. */
  const LEVELS = [
    { id: "demo", label: "Demo-Level (Originalkrankenhaus)", full: false },
    { id: "avatar", label: "Avatar (Große Stadt)", full: false },
    { id: "confined_v5", label: "Confined (Kompaktes Gelände)", full: false },
    { id: "finisham", label: "Finisham (Flusslandschaft)", full: false },
    { id: "st.peter's", label: "St. Peter's (Klassische Anlage)", full: false },
    { id: "level1", label: "Level 1 – Originalkampagne", full: false },
  ];
  function refreshLevelOptions() {
    const sel = $("#mp-level");
    if (!sel) return;
    const L = state.lobby;
    const anyDemo = L && L.players && L.players.length > 0
      ? L.players.some((p) => p.demo)
      : (state.data ? state.data.demo : true);

    const cur = sel.value || (L && L.level) || "demo";
    sel.innerHTML = "";
    let foundCurrent = false;

    for (const l of LEVELS) {
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.label;
      if (l.id === cur) foundCurrent = true;
      sel.appendChild(o);
    }

    if (foundCurrent) {
      sel.value = cur;
    } else {
      sel.value = "demo";
    }
    if (L && L.host && sel.value !== cur) {
      broadcastLobbyConfig();
    }

    const hintEl = $("#level-compat-hint");
    if (hintEl) {
      hintEl.hidden = true;
      hintEl.textContent = "";
    }

    const helpEl = $("#mp-mode-help");
    if (helpEl) {
      helpEl.textContent = "Beide Spieler leiten auf derselben Karte ihr eigenes Hospital. Wer das gewählte Ziel als Erster erreicht, gewinnt das Match!";
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

  class Net {
    constructor() {
      this.ws = null;
      this.listeners = new Map();
      this.inbox = []; // messages for the Lua side: {from, d}
      this.id = null;
      this.pingMs = null;
      this.open = false;
    }
    on(t, fn) { (this.listeners.get(t) || this.listeners.set(t, []).get(t)).push(fn); }
    off(t) { this.listeners.delete(t); }
    emit(t, m) { for (const fn of this.listeners.get(t) || []) fn(m); }
    connect() {
      return new Promise((resolve, reject) => {
        const wsUrl = getRelayUrl();
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        ws.onopen = () => {
          this.open = true;
          this._pingTimer = setInterval(() => this.sendRaw({ t: "ping", ts: performance.now() }), 2000);
          resolve();
        };
        ws.onerror = () => { if (!this.open) reject(new Error("Server nicht erreichbar")); };
        ws.onclose = () => {
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
      nameSpan.textContent = p.name + (p.id === L.id ? " (du)" : "");

      const badges = document.createElement("div");
      badges.className = "player-badges";

      const tag = document.createElement("span");
      tag.className = "tag";
      const contentTag = p.demo ? "Demo" : "Vollversion";
      tag.textContent = (p.host ? "HOST · " : "") + contentTag;

      const readyBadge = document.createElement("span");
      readyBadge.className = "badge-ready " + (p.ready ? "ready" : "waiting");
      readyBadge.textContent = p.ready ? "✓ Bereit" : "⏳ Wartet";

      badges.appendChild(tag);
      badges.appendChild(readyBadge);
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
        btnReady.textContent = "✓ Du bist bereit (Klicken zum Abbrechen)";
        btnReady.className = "btn ready-active";
      } else {
        btnReady.textContent = "✓ Bereit melden";
        btnReady.className = "btn secondary";
      }
    }

    const max = L.max || 2;
    if ($("#players-header")) $("#players-header").textContent = `Spieler im Raum (${connectedCount}/${max})`;
    $("#host-options").hidden = !L.host;
    $("#guest-options").hidden = !!L.host;
    $("#btn-start").hidden = !L.host;
    $("#btn-start").disabled = !allReady;
    if (allReady) {
      $("#btn-start").classList.add("all-ready");
    } else {
      $("#btn-start").classList.remove("all-ready");
    }

    if (L.host) {
      if (connectedCount < 2) {
        $("#lobby-hint").textContent = "Warte auf Mitspieler … Teile den Code oder den Einladungslink.";
      } else if (!allReady) {
        $("#lobby-hint").textContent = "Beide Spieler müssen auf 'Bereit melden' klicken, bevor gestartet werden kann.";
      } else {
        $("#lobby-hint").textContent = "Beide Spieler sind bereit! Klicke auf 'Spiel starten'.";
      }
      if (L.goals) setGoalsInUI(L.goals);
      updateGoalSummaryUI(L.goals || getGoalsFromUI());
      refreshLevelOptions();
    } else {
      const levelObj = LEVELS.find((x) => x.id === L.level);
      const levelName = levelObj ? levelObj.label : (L.level || "Demo-Level");
      if ($("#guest-level-val")) $("#guest-level-val").textContent = levelName;
      updateGoalSummaryUI(L.goals);
      const guestWait = $("#guest-wait");
      if (guestWait) {
        if (!amReady) {
          guestWait.textContent = "Bitte klicke auf 'Bereit melden', wenn du startklar bist.";
        } else if (!allReady) {
          guestWait.textContent = "Du bist bereit! Warte darauf, dass der Host sich bereit meldet …";
        } else {
          guestWait.textContent = "Beide bereit! Warte darauf, dass der Host das Spiel startet …";
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
    line.textContent = `ℹ ${text}`;

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
      const level = $("#mp-level") ? $("#mp-level").value : (state.lobby.level || "demo");
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
    if (chatLog) chatLog.innerHTML = '<div class="chat-placeholder">Noch keine Nachrichten im Lobby-Chat.</div>';
    const net = new Net();
    state.net = net;
    try {
      await net.connect();
    } catch (e) {
      const isVercel = location.hostname.endsWith(".vercel.app") || location.hostname.includes("vercel");
      if (isVercel) {
        showMenuError("Verbindung zum WebSocket-Server fehlgeschlagen. Vercel unterstützt keine dauerhaften WebSockets. Bitte trage deinen Relay-Server (z. B. auf Render.com) unten bei '⚙️ Relay-Server' ein oder hänge '?server=wss://...' an.");
      } else {
        showMenuError("Verbindung zum Server fehlgeschlagen. Läuft der Server? (" + getRelayUrl() + ")");
      }
      return;
    }
    const name = playerName();
    const isDemo = state.data ? !!state.data.demo : true;
    net.on("joined", (m) => {
      state.lobby = {
        code: m.code,
        id: m.id,
        host: m.host,
        players: m.players,
        max: m.max,
        mode: "versus",
        goals: (m.config && m.config.goals) ? m.config.goals : { cured: 25, money: 100000, rooms: 0, timeLimit: 30 },
        level: (m.config && m.config.level) ? m.config.level : "demo",
      };
      net.id = m.id;
      if (m.started && m.config) { startMultiplayer(m.config, true); return; }
      history.replaceState(null, "", "?join=" + m.code);
      if (m.host) {
        state.lobby.goals = getGoalsFromUI();
      } else {
        setGoalsInUI(state.lobby.goals);
      }
      renderLobby();
      lobbyChatSys(`Raum ${m.code} betreten als "${name}".`);
    });
    net.on("players", (m) => {
      if (state.lobby && !state.game) {
        state.lobby.players = m.players;
        if (m.config) {
          if (m.config.goals) state.lobby.goals = m.config.goals;
          if (m.config.level) state.lobby.level = m.config.level;
        }
        if (m.readyChange) {
          const statusTxt = m.readyChange.ready ? "BEREIT ✓" : "nicht mehr bereit ⏳";
          lobbyChatSys(`${m.readyChange.name} ist jetzt ${statusTxt}`);
        } else if (m.joined !== undefined && m.joined !== net.id) {
          const joinedP = m.players.find((p) => p.id === m.joined);
          if (joinedP) lobbyChatSys(`${joinedP.name} ist dem Raum beigetreten.`);
        }
        renderLobby();
      }
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
        lobbyChatSys("Einstellungen geändert – Bereitschaft zurückgesetzt.");
        if (!state.lobby.host) renderLobby();
      }
    });
    net.on("chat", (m) => {
      lobbyChatMsg(m.name, m.text, m.from === net.id);
    });
    net.on("left", (m) => {
      if (!state.lobby) return;
      const leftPlayer = state.lobby.players.find((p) => p.id === m.id);
      if (leftPlayer) lobbyChatSys(`${leftPlayer.name} hat den Raum verlassen.`);
      state.lobby.players = m.players;
      if (m.host !== undefined && m.host !== null) state.lobby.host = m.host === state.lobby.id;
      if (!state.game) renderLobby();
    });
    net.on("error", (m) => {
      if (m.error === "not_all_ready") {
        lobbyChatSys("Start abgebrochen: Beide Spieler müssen bereit sein!");
        if ($("#lobby-hint")) $("#lobby-hint").textContent = "Beide Spieler müssen auf 'Bereit melden' klicken!";
        return;
      }
      const t = { no_such_room: "Diesen Raum gibt es nicht.", room_full: "Der Raum ist voll.", alreadyを開始: "Das Spiel läuft bereits." }[m.error] || m.error;
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
    if (kind === "create") net.sendRaw({ t: "create", name, demo: isDemo, max: parseInt($("#max-players").value, 10), token: token() });
    else net.sendRaw({ t: "join", code, name, demo: isDemo, token: token() });
  }

  function playerName() {
    const n = $("#player-name").value.trim() || "Spieler";
    localStorage.setItem("bth-name", n);
    return n;
  }

  function leaveLobby() {
    if (state.net) { state.net.sendRaw({ t: "leave" }); state.net.close(); }
    state.net = null;
    state.lobby = null;
    $("#card-lobby").hidden = true;
    if ($("#view-setup")) $("#view-setup").hidden = false;
    const chatLog = $("#lobby-chat-log");
    if (chatLog) chatLog.innerHTML = '<div class="chat-placeholder">Noch keine Nachrichten im Lobby-Chat.</div>';
    history.replaceState(null, "", location.pathname);
  }

  function hostStart() {
    const L = state.lobby;
    if (!L || !L.host || !state.net) return;
    const connectedPlayers = L.players.filter((p) => p.connected);
    if (connectedPlayers.length < 2) {
      lobbyChatSys("Es werden mindestens 2 Spieler benötigt, um zu starten.");
      return;
    }
    if (!connectedPlayers.every((p) => p.ready)) {
      lobbyChatSys("Alle Spieler müssen bereit sein, bevor das Spiel gestartet werden kann!");
      return;
    }
    const goals = getGoalsFromUI();
    let level = $("#mp-level") ? $("#mp-level").value : (L.level || "demo");
    const anyDemo = L.players.some((p) => p.demo);
    const lObj = LEVELS.find((x) => x.id === level);
    if (anyDemo && lObj && lObj.full) {
      level = "demo";
    }
    const seed = (Math.random() * 0x7fffffff) | 0;
    state.net.sendRaw({ t: "start", config: { mode: "versus", level, goals, seed, language: $("#language").value } });
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
      s.onerror = () => rej(new Error("Konnte " + src + " nicht laden – wurde das Spiel gebaut? (npm run build)"));
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
    setLoading("Lade Spiel-Engine …");
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
      setLoading("Kopiere Spieldaten …");
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
      setLoading("Starte …");
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
        const winName = parts[1] || "Ein Spieler";
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
      parts.push(`<span class="hud-role-host" title="Host des Spiels">👑 Host: <b>${escapeHtml(hostP.name)}</b>${isMe ? " (Du)" : ""}${offline}</span>`);
    }
    if (guestPs.length > 0) {
      for (const gp of guestPs) {
        const isMe = gp.id === myId;
        const offline = gp.connected === false ? " (offline)" : "";
        parts.push(`<span class="hud-role-guest" title="Beigetretener Spieler">🎮 Gast: <b>${escapeHtml(gp.name)}</b>${isMe ? " (Du)" : ""}${offline}</span>`);
      }
    } else {
      parts.push(`<span class="hud-role-guest muted">🎮 Gast: (wartet …)</span>`);
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
    const mapLabel = lObj ? lObj.label.split(" (")[0] : (mp && mp.level || "");
    const roomCode = (state.lobby && state.lobby.code) || (mp && mp.code) || "";
    $("#hud-room").textContent = "Raum " + roomCode + (mapLabel ? " · " + mapLabel : "");
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
            Object.assign(state.vs.oppStats, s);
            updateQuestUI();
            checkWinConditions();
          }
        } else if (typeof m.d === "string" && m.d.startsWith("win:")) {
          const parts = m.d.slice(4).split("|");
          const winId = parseInt(parts[0], 10);
          const winName = parts[1] || "Ein Spieler";
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
        chatSys(`${((state.lobby && state.lobby.players || []).find(p=>p.id===m.id)||{name:"Ein Spieler"}).name} hat die Verbindung verloren.`);
        updateHudPlayers();
      });
      net.on("start_sim", () => {
        net.inbox.push({ from: -1, d: "start_sim" });
        const banner = $("#net-banner");
        if (banner) {
          banner.className = "";
          banner.textContent = "Spiel gestartet!";
          setTimeout(() => { banner.hidden = true; }, 3000);
        }
      });
      net.on("close", () => { $("#net-banner").className = "err"; $("#net-banner").textContent = "Verbindung zum Server verloren – Spiel angehalten."; $("#net-banner").hidden = false; net.inbox.push({ from: -1, d: "server_closed" }); });
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
          timerEl.textContent = `⏱️ ${remMin}:${String(remSec).padStart(2, "0")}`;
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
    const g = state.vs.goals || { cured: 25, money: 100000, rooms: 0, timeLimit: 30 };
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
          winnerName = opp.name || "Gegner";
          isMe = false;
        } else {
          // Compare cash balance
          if (my.bal > opp.bal) {
            winnerId = state.lobby ? state.lobby.id : 0;
            winnerName = playerName();
            isMe = true;
          } else if (opp.bal > my.bal) {
            winnerId = -999;
            winnerName = opp.name || "Gegner";
            isMe = false;
          } else {
            // Tie breaker: hospital overall value
            if (my.val >= opp.val) {
              winnerId = state.lobby ? state.lobby.id : 0;
              winnerName = playerName();
              isMe = true;
            } else {
              winnerId = -999;
              winnerName = opp.name || "Gegner";
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
        showVictoryModal(opp.name || "Gegner", false);
      }
    }
  }

  function updateQuestUI() {
    const g = state.vs.goals || { cured: 25, money: 100000, rooms: 0, timeLimit: 30 };
    const my = state.vs.myStats;
    const opp = state.vs.oppStats;
    const quests = buildQuestsFromConfig(g);

    // Header names
    const thYou = $("#th-you");
    if (thYou) thYou.textContent = "Du (" + playerName() + ")";
    const thOpp = $("#th-opp");
    if (thOpp) thOpp.textContent = opp.name || "Gegner";

    // Match Goal footer
    const goalFooter = $("#quest-match-goal");
    if (goalFooter) goalFooter.textContent = "Ziele: " + formatGoalsList(g).join(" + ");

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
          leadText.innerHTML = `🟢 <b>Du liegst in Führung! (+$${diff.toLocaleString()})</b> · Restzeit: <b>${timeStr}</b>`;
        } else if (diff < -500) {
          leadText.innerHTML = `⚠️ <b>${escapeHtml(opp.name || "Gegner")} liegt vorn! (+$${Math.abs(diff).toLocaleString()})</b> · Restzeit: <b>${timeStr}</b>`;
        } else {
          leadText.innerHTML = `⚔️ <b>Gleichstand beim Barvermögen!</b> · Restzeit: <b>${timeStr}</b>`;
        }
      } else if (quests.length === 0) {
        leadText.innerHTML = "♾️ <b>Freies Duell</b> – Vergleicht eure Statistiken live!";
      } else {
        let myPctSum = 0, oppPctSum = 0;
        for (const q of quests) {
          myPctSum += Math.min(100, Math.max(0, (q.getVal(my) / q.target) * 100));
          oppPctSum += Math.min(100, Math.max(0, (q.getVal(opp) / q.target) * 100));
        }
        const myAvg = Math.round(myPctSum / quests.length);
        const oppAvg = Math.round(oppPctSum / quests.length);

        if (myAvg > oppAvg + 5) {
          leadText.innerHTML = `🟢 <b>Du führst das Rennen an!</b> (${myAvg}% vs. ${oppAvg}%)`;
        } else if (oppAvg > myAvg + 5) {
          leadText.innerHTML = `⚠️ <b>${escapeHtml(opp.name || "Gegner")} liegt vorn!</b> (${oppAvg}% vs. ${myAvg}%)`;
        } else {
          leadText.innerHTML = `⚔️ <b>Kopf-an-Kopf-Rennen!</b> (${myAvg}% vs. ${oppAvg}%)`;
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
              <span class="quest-card-title">⏱️ Zeit-Wettkampf (${g.timeLimit} Min.)</span>
              <span class="quest-badge ${rem < 120 ? 'done' : 'pending'}">⏱️ ${timeStr} verbleibend</span>
            </div>
            <p class="muted small" style="margin: 4px 0 8px;">
              Wer nach Ablauf der Zeit die Ziele bzw. das meiste Barvermögen hat, gewinnt!
            </p>
            <div class="prog-row">
              <div class="prog-label">
                <span>Du: $${(my.bal || 0).toLocaleString()}</span>
                <span>${diff >= 0 ? '+' : ''}$${diff.toLocaleString()} (${myPct}%)</span>
              </div>
              <div class="prog-bar-wrap">
                <div class="prog-bar-fill you" style="width: ${myPct}%"></div>
              </div>
            </div>
            <div class="prog-row">
              <div class="prog-label">
                <span>${escapeHtml(opp.name || "Gegner")}: $${(opp.bal || 0).toLocaleString()}</span>
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

        cardsHtml.push(`
          <div class="quest-card">
            <div class="quest-card-header">
              <span class="quest-card-title">${escapeHtml(q.name)}</span>
              <span class="quest-badge ${myDone ? "done" : "pending"}">Ziel: ${formatVal(q.target, q.unit)}</span>
            </div>
            <div class="prog-row">
              <div class="prog-label">
                <span>Du: ${formatVal(myVal, q.unit)}</span>
                <span>${myPct}%${myDone ? " ✓" : ""}</span>
              </div>
              <div class="prog-bar-wrap">
                <div class="prog-bar-fill you" style="width: ${myPct}%"></div>
              </div>
            </div>
            <div class="prog-row">
              <div class="prog-label">
                <span>${escapeHtml(opp.name || "Gegner")}: ${formatVal(oppVal, q.unit)}</span>
                <span>${oppPct}%${oppDone ? " ✓" : ""}</span>
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
              <span class="quest-card-title">♾️ Freies Endlos-Duell</span>
            </div>
            <p class="muted small" style="margin: 6px 0 0;">In diesem Modus gibt es kein festes Sieg-Kriterium. Vergleicht eure Kennzahlen live im Tab <b>Rivalen-Dashboard</b>!</p>
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

      const myStatus = myStarted ? '<span class="status-pill active">🟢 Gestartet</span>' : '<span class="status-pill wait">⏳ Wartet</span>';
      const oppStatus = oppStarted ? '<span class="status-pill active">🟢 Gestartet</span>' : '<span class="status-pill wait">⏳ Wartet</span>';

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
          <td>Status Unternehmen</td>
          <td class="val-you">${myStatus}</td>
          <td class="val-opp">${oppStatus}</td>
        </tr>
        <tr>
          <td>💰 Barvermögen</td>
          <td class="val-you ${cBal1}">$${my.bal.toLocaleString()}</td>
          <td class="val-opp ${cBal2}">$${opp.bal.toLocaleString()}</td>
        </tr>
        <tr>
          <td>🏥 Räume / Gebäude</td>
          <td class="val-you ${cRooms1}">${my.rooms} ${my.rooms === 1 ? "Raum" : "Räume"}</td>
          <td class="val-opp ${cRooms2}">${opp.rooms} ${opp.rooms === 1 ? "Raum" : "Räume"}</td>
        </tr>
        <tr>
          <td>👥 Mitarbeiter</td>
          <td class="val-you ${cStaff1}">${my.staff} Personal</td>
          <td class="val-opp ${cStaff2}">${opp.staff} Personal</td>
        </tr>
        <tr>
          <td>💉 Geheilte Patienten</td>
          <td class="val-you ${cCured1}">${my.cured}</td>
          <td class="val-opp ${cCured2}">${opp.cured}</td>
        </tr>
        <tr>
          <td>💀 Todesfälle</td>
          <td class="val-you ${cDeaths1}">${my.deaths}</td>
          <td class="val-opp ${cDeaths2}">${opp.deaths}</td>
        </tr>
        <tr>
          <td>⭐ Ruf des Hauses</td>
          <td class="val-you ${cRep1}">${my.rep} / 1000</td>
          <td class="val-opp ${cRep2}">${opp.rep} / 1000</td>
        </tr>
        <tr>
          <td>📈 Gesamtwert</td>
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

    if (iconEl) iconEl.textContent = isMe ? "🏆" : "🥈";
    if (titleEl) {
      titleEl.textContent = isMe ? "🎉 Sieg! Du hast gewonnen!" : `Match beendet – ${winnerName} gewinnt!`;
      titleEl.className = isMe ? "vic-won" : "vic-lost";
    }
    if (descEl) {
      const g = state.vs.goals || { cured: 25, money: 100000, rooms: 0, timeLimit: 30 };
      const goalsDesc = formatGoalsList(g).join(" und ");
      if (g.timeLimit > 0) {
        const my = state.vs.myStats;
        const opp = state.vs.oppStats;
        descEl.textContent = isMe
          ? `Glückwunsch! Nach Ablauf der ${g.timeLimit} Minuten hast du mit einem Barvermögen von $${(my.bal || 0).toLocaleString()} gegenüber $${(opp.bal || 0).toLocaleString()} gesiegt! (Ziele: ${goalsDesc})`
          : `Die ${g.timeLimit} Minuten sind um! ${winnerName} gewinnt mit einem Barvermögen von $${(opp.bal || 0).toLocaleString()} gegenüber $${(my.bal || 0).toLocaleString()}. (Ziele: ${goalsDesc})`;
      } else {
        descEl.textContent = isMe
          ? `Glückwunsch! Du hast die Ziele (${goalsDesc}) vor deinem Kontrahenten erreicht!`
          : `${winnerName} hat die Ziele (${goalsDesc}) als Erster abgeschlossen.`;
      }
    }

    if (summaryEl) {
      const my = state.vs.myStats;
      const opp = state.vs.oppStats;
      summaryEl.innerHTML = `
        <table class="rival-table">
          <thead>
            <tr>
              <th>Statistik</th>
              <th id="th-you">Du (${escapeHtml(playerName())})</th>
              <th id="th-opp">${escapeHtml(opp.name || "Gegner")}</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>💰 Barvermögen</td><td class="val-you">$${my.bal.toLocaleString()}</td><td class="val-opp">$${opp.bal.toLocaleString()}</td></tr>
            <tr><td>🏥 Räume</td><td class="val-you">${my.rooms}</td><td class="val-opp">${opp.rooms}</td></tr>
            <tr><td>👥 Mitarbeiter</td><td class="val-you">${my.staff}</td><td class="val-opp">${opp.staff}</td></tr>
            <tr><td>💉 Geheilte Patienten</td><td class="val-you">${my.cured}</td><td class="val-opp">${opp.cured}</td></tr>
            <tr><td>💀 Todesfälle</td><td class="val-you">${my.deaths}</td><td class="val-opp">${opp.deaths}</td></tr>
            <tr><td>⭐ Ruf des Hauses</td><td class="val-you">${my.rep} / 1000</td><td class="val-opp">${opp.rep} / 1000</td></tr>
            <tr><td>📈 Gesamtwert</td><td class="val-you">$${my.val.toLocaleString()}</td><td class="val-opp">$${opp.val.toLocaleString()}</td></tr>
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
    const goals = config.goals || (L && L.goals) || { cured: 25, money: 100000, rooms: 0, timeLimit: 30 };

    state.vs = {
      goal: config.goal || "custom",
      goals,
      startTime: Date.now(),
      myStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false },
      oppStats: { bal: 0, rep: 500, rooms: 0, staff: 0, cured: 0, deaths: 0, val: 0, started: false, name: opp ? opp.name : "Gegner" },
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
        banner.textContent = "Spiel gestartet!";
        setTimeout(() => { banner.hidden = true; }, 3000);
      }
    });
    startGame({ mp, language: config.language, name: me.name });
  }

  // ----------------------------------------------------------------- wiring
  async function init() {
    $("#player-name").value = localStorage.getItem("bth-name") || "";
    $("#language").value = localStorage.getItem("bth-lang") || "German";
    $("#language").onchange = () => localStorage.setItem("bth-lang", $("#language").value);

    try { state.data = (await kvGet("thdata")) || null; } catch (e) { state.data = null; }
    renderDataStatus();

    $("#btn-zip").onclick = () => $("#file-zip").click();
    $("#btn-folder").onclick = () => $("#file-folder").click();
    $("#btn-forget").onclick = async () => { await kvDel("thdata"); state.data = null; renderDataStatus(); };
    $("#file-zip").onchange = (e) => { const f = e.target.files[0]; if (f) withBusy("Entpacke " + f.name + " …", () => importZip(f)); e.target.value = ""; };
    $("#file-folder").onchange = (e) => { const fl = [...e.target.files]; if (fl.length) withBusy("Lese Ordner …", () => importFolder(fl)); e.target.value = ""; };

    const dz = $("#dropzone");
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => {
      const items = e.dataTransfer.items;
      if (items && items.length) withBusy("Lese Dateien …", () => readDropped([...items].map((i) => i)));
    });
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    if ($("#btn-single")) $("#btn-single").onclick = () => startGame({ language: $("#language").value, name: playerName() });
    $("#btn-create").onclick = () => enterLobby("create");
    $("#btn-join").onclick = () => {
      const code = $("#join-code").value.trim().toUpperCase();
      if (code.length < 4) { showMenuError("Bitte den Raum-Code eingeben."); return; }
      enterLobby("join", code);
    };
    $("#join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    $("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-join").click(); });
    $("#btn-ready").onclick = toggleReady;
    $("#btn-leave-lobby").onclick = leaveLobby;
    $("#btn-start").onclick = hostStart;
    for (const gid of ["#goal-cured", "#goal-money", "#goal-rooms", "#goal-time"]) {
      const el = $(gid);
      if (el) el.onchange = () => broadcastLobbyConfig();
    }
    document.querySelectorAll(".quest-preset-bar .btn-chip").forEach((btn) => {
      btn.onclick = () => {
        const p = PRESETS[btn.dataset.preset];
        if (p) {
          setGoalsInUI(p);
          broadcastLobbyConfig();
        }
      };
    });
    $("#mp-level").onchange = () => { broadcastLobbyConfig(); };
    $("#btn-copy-code").onclick = () => {
      if (state.lobby) navigator.clipboard.writeText(state.lobby.code).catch(() => {});
      const btn = $("#btn-copy-code");
      const oldTxt = btn.textContent;
      btn.textContent = "✓ Code kopiert!";
      setTimeout(() => { btn.textContent = oldTxt; }, 1800);
    };
    $("#btn-copy-link").onclick = () => {
      const u = new URL(location.origin + location.pathname);
      if (state.lobby) u.searchParams.set("join", state.lobby.code);
      const relayParam = new URLSearchParams(location.search).get("server") || new URLSearchParams(location.search).get("relay") || localStorage.getItem("bth-relay-url");
      if (relayParam) u.searchParams.set("server", relayParam);
      navigator.clipboard.writeText(u.toString()).catch(() => {});
      const btn = $("#btn-copy-link");
      const oldTxt = btn.textContent;
      btn.textContent = "✓ Link kopiert!";
      setTimeout(() => { btn.textContent = oldTxt; }, 1800);
    };
    $("#fatal-reload").onclick = () => (location.href = location.pathname);

    const updateRelayDisplay = () => {
      const el = $("#current-relay-host");
      if (!el) return;
      const saved = localStorage.getItem("bth-relay-url");
      const param = new URLSearchParams(location.search).get("server") || new URLSearchParams(location.search).get("relay");
      if (param) el.textContent = param;
      else if (saved) el.textContent = saved;
      else el.textContent = "Automatisch (" + location.host + ")";
    };
    updateRelayDisplay();

    const btnServer = $("#btn-server-settings");
    if (btnServer) {
      btnServer.onclick = () => {
        const current = localStorage.getItem("bth-relay-url") || "";
        const input = prompt(
          "WebSocket Relay-Server URL eingeben (z. B. wss://mein-hospital.onrender.com/ws):\n\nLeer lassen für Standard (gleicher Host wie Webseite):",
          current
        );
        if (input !== null) {
          const trimmed = input.trim();
          if (trimmed) {
            let u = trimmed;
            if (!u.startsWith("ws://") && !u.startsWith("wss://")) {
              u = (location.protocol === "https:" ? "wss://" : "ws://") + u;
            }
            if (!u.includes("/ws") && !u.endsWith("/")) u += "/ws";
            localStorage.setItem("bth-relay-url", u);
          } else {
            localStorage.removeItem("bth-relay-url");
          }
          updateRelayDisplay();
        }
      };
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

    refreshLevelOptions();
    const join = new URLSearchParams(location.search).get("join");
    if (join) $("#join-code").value = join.toUpperCase().slice(0, 5);

    // test hooks (used by tests/*.js)
    window.__bth = { state, startGame, setData, normaliseEntries, enterLobby, hostStart, toggleReady, checkWinConditions, updateQuestUI };
  }

  init();
})();
