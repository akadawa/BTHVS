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
  const state = {
    data: null, // {files: [[path, Uint8Array]], demo: bool, name: string, bytes: number}
    net: null,
    lobby: null,
    session: null,
    game: null,
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
    for (const id of ["#btn-single", "#btn-create", "#btn-join"]) $(id).disabled = !d;
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
  /** What the host can pick. `full` = needs the full game's graphics. */
  const LEVELS = [
    { id: "demo", label: "Demo-Level (Originalkrankenhaus)", full: false, modes: ["freebuild", "level"] },
    { id: "level1", label: "Level 1 – Originalkampagne", full: true, modes: ["level"] },
    { id: "avatar", label: "Avatar (Custom)", full: true, modes: ["freebuild", "level"] },
    { id: "confined_v5", label: "Confined (Custom)", full: true, modes: ["freebuild", "level"] },
    { id: "finisham", label: "Finisham (Custom)", full: true, modes: ["freebuild", "level"] },
    { id: "st.peter's", label: "St. Peter's (Custom)", full: true, modes: ["freebuild", "level"] },
  ];
  function refreshLevelOptions() {
    const sel = $("#mp-level");
    if (!sel) return;
    const mode = $("#mp-mode").value;
    const demo = state.data ? state.data.demo : true;
    const cur = sel.value;
    sel.innerHTML = "";
    for (const l of LEVELS) {
      if (!l.modes.includes(mode)) continue;
      if (demo && l.full) continue;
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.label;
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
    $("#mp-mode-help").textContent =
      mode === "freebuild"
        ? "Ihr baut zusammen ein Krankenhaus ohne Geld-, Sieg- oder Niederlagen-Druck. Ideal zum entspannten Aufbauen und Aufteilen der Aufgaben."
        : "Klassisches Spiel mit gemeinsamem Konto und Zielen: ihr teilt euch Bauen, Personal, Forschung und Finanzen – und gewinnt oder verliert zusammen.";
  }

  // ------------------------------------------------------------ networking
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
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${location.host}/ws`);
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
    $("#card-lobby").hidden = false;
    $("#room-code").textContent = L.code;
    const ul = $("#player-list");
    ul.innerHTML = "";
    for (const p of L.players) {
      const li = document.createElement("li");
      if (!p.connected) li.className = "off";
      li.innerHTML = `<span></span><span class="tag"></span>`;
      li.firstChild.textContent = p.name + (p.id === L.id ? " (du)" : "");
      li.lastChild.textContent = p.host ? "HOST" : "";
      ul.appendChild(li);
    }
    const connected = L.players.filter((p) => p.connected).length;
    $("#host-options").hidden = !L.host;
    $("#guest-wait").hidden = L.host;
    $("#btn-start").hidden = !L.host;
    $("#btn-start").disabled = connected < 2;
    $("#lobby-hint").textContent = L.host
      ? connected < 2 ? "Warte auf mindestens einen Mitspieler … Teile den Code oder den Einladungslink." : "Alle da? Dann kann es losgehen."
      : "";
    refreshLevelOptions();
  }

  async function enterLobby(kind, code) {
    showMenuError("");
    const net = new Net();
    state.net = net;
    try { await net.connect(); } catch (e) { showMenuError("Verbindung zum Server fehlgeschlagen. Läuft der Server?"); return; }
    const name = playerName();
    net.on("joined", (m) => {
      state.lobby = { code: m.code, id: m.id, host: m.host, players: m.players, max: m.max };
      net.id = m.id;
      if (m.started && m.config) { startMultiplayer(m.config, true); return; }
      history.replaceState(null, "", "?join=" + m.code);
      renderLobby();
    });
    net.on("players", (m) => { if (state.lobby && !state.game) { state.lobby.players = m.players; renderLobby(); } });
    net.on("left", (m) => {
      if (!state.lobby) return;
      state.lobby.players = m.players;
      if (m.host !== undefined && m.host !== null) state.lobby.host = m.host === state.lobby.id;
      if (!state.game) renderLobby();
    });
    net.on("error", (m) => {
      const t = { no_such_room: "Diesen Raum gibt es nicht.", room_full: "Der Raum ist voll.", already_started: "Das Spiel läuft bereits." }[m.error] || m.error;
      showMenuError(t);
      net.close();
      state.net = null;
    });
    net.on("start", (m) => startMultiplayer(m.config, false));
    net.on("close", () => {
      if (!state.game) { state.lobby = null; $("#card-lobby").hidden = true; if (state.net === net) state.net = null; }
    });
    if (kind === "create") net.sendRaw({ t: "create", name, max: parseInt($("#max-players").value, 10), token: token() });
    else net.sendRaw({ t: "join", code, name, token: token() });
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
    history.replaceState(null, "", location.pathname);
  }

  function hostStart() {
    const mode = $("#mp-mode").value;
    const level = $("#mp-level").value;
    const seed = (Math.random() * 0x7fffffff) | 0;
    state.net.sendRaw({ t: "start", config: { mode, level, seed, language: $("#language").value } });
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
  const snapIn = { chunks: new Map() };
  function bridge(cmd, arg) {
    const net = state.net;
    switch (cmd) {
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
      case "snap.send": {
        // arg: "<to>|<path>|<metaJson>"
        const [to, path, meta] = arg.split("|");
        const data = state.game.mod.FS.readFile(path);
        const z = fflate.zlibSync(data, { level: 3 });
        const payload = "SNAP|" + meta + "|" + b64FromBytes(z);
        net.sendRaw({ t: "msg", to: to === "all" ? "all" : parseInt(to, 10), d: payload });
        return String(z.length);
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

  // -------------------------------------------------------- multiplayer HUD
  function setupHud() {
    const net = state.net;
    $("#hud").hidden = false;
    $("#hud-room").textContent = "Raum " + state.lobby.code + " · " + state.session.mp.players.length + " Spieler";
    net.on("ping", (ms) => {
      const el = $("#hud-ping");
      el.textContent = ms + " ms";
      el.className = "chip " + (ms < 120 ? "ok" : ms < 300 ? "warn" : "err");
    });
    net.on("msg", (m) => {
      if (typeof m.d === "string" && m.d.startsWith("SNAP|")) {
        const i1 = m.d.indexOf("|", 5);
        const meta = m.d.slice(5, i1);
        const z = bytesFromB64(m.d.slice(i1 + 1));
        const data = fflate.unzlibSync(z);
        const FS = state.game.mod.FS;
        FS.writeFile("/tmp/snapshot_in.sav", data);
        net.inbox.push({ from: m.from, d: "snapshot:" + meta });
      } else {
        net.inbox.push({ from: m.from, d: m.d });
      }
    });
    net.on("players", (m) => { state.lobby.players = m.players; net.inbox.push({ from: -1, d: "peers:" + peersString(m.players) }); });
    net.on("left", (m) => { state.lobby.players = m.players; net.inbox.push({ from: -1, d: "peers:" + peersString(m.players) + (m.host !== null && m.host !== undefined ? "|host=" + m.host : "") }); chatSys(`${(state.lobby.players.find(p=>p.id===m.id)||{name:"Ein Spieler"}).name} hat die Verbindung verloren.`); });
    net.on("close", () => { $("#net-banner").className = "err"; $("#net-banner").textContent = "Verbindung zum Server verloren – Spiel angehalten."; $("#net-banner").hidden = false; net.inbox.push({ from: -1, d: "server_closed" }); });
    net.on("chat", (m) => chatMsg(m.name, m.text, m.from !== net.id));
    setupChat();
    $("#hud-fs-btn").onclick = toggleFullscreen;
  }
  function peersString(players) {
    return players.map((p) => p.id + ":" + (p.connected ? 1 : 0)).join(",");
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
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
  }
  function setupChat() {
    const box = $("#chat"), input = $("#chat-input");
    const toggle = (show) => {
      box.hidden = show === undefined ? !box.hidden : !show;
      if (!box.hidden) { unread = 0; $("#chat-badge").hidden = true; input.focus(); } else $("#canvas").focus();
    };
    $("#hud-chat-btn").onclick = () => toggle();
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

  // ------------------------------------------------------------ MP startup
  function startMultiplayer(config, rejoin) {
    const L = state.lobby;
    const players = config.players;
    const me = players.find((p) => p.id === L.id) || { id: L.id, name: playerName() };
    const mp = {
      id: L.id,
      code: L.code,
      name: me.name,
      players,
      mode: config.mode,
      level: config.level,
      seed: config.seed,
      rejoin: !!rejoin,
      host: players.length ? Math.min(...players.map((p) => p.id)) : 0,
    };
    state.net.off("joined");
    state.net.off("start");
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

    $("#btn-single").onclick = () => startGame({ language: $("#language").value, name: playerName() });
    $("#btn-create").onclick = () => enterLobby("create");
    $("#btn-join").onclick = () => {
      const code = $("#join-code").value.trim().toUpperCase();
      if (code.length < 4) { showMenuError("Bitte den Raum-Code eingeben."); return; }
      enterLobby("join", code);
    };
    $("#join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    $("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-join").click(); });
    $("#btn-leave-lobby").onclick = leaveLobby;
    $("#btn-start").onclick = hostStart;
    $("#mp-mode").onchange = refreshLevelOptions;
    $("#btn-copy-code").onclick = () => navigator.clipboard.writeText(state.lobby.code).catch(() => {});
    $("#btn-copy-link").onclick = () => navigator.clipboard.writeText(location.origin + location.pathname + "?join=" + state.lobby.code).catch(() => {});
    $("#fatal-reload").onclick = () => (location.href = location.pathname);

    refreshLevelOptions();
    const join = new URLSearchParams(location.search).get("join");
    if (join) $("#join-code").value = join.toUpperCase().slice(0, 5);

    // test hooks (used by tests/*.js)
    window.__bth = { state, startGame, setData, normaliseEntries, enterLobby, hostStart };
  }

  init();
})();
