/* Static file server + WebSocket room relay for Browser Theme Hospital.
 *
 *   node server/server.js [--port 8085] [--host 0.0.0.0]
 *
 * The relay is intentionally dumb: it only manages lobbies (room codes) and
 * forwards opaque game messages between the members of a room. All game logic
 * (lockstep simulation, desync detection, snapshots) lives in the clients.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(process.env.PORT || arg("port", "8085"), 10);
const HOST = process.env.HOST || arg("host", "0.0.0.0");
const ROOT = path.resolve(__dirname, "..", "dist");
const MAX_PLAYERS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const externalLobbies = new Map();
const allHostedCodes = new Set();
let totalHosted = 0;
const LOBBY_TTL = 60000;

function pruneExternal() {
  const now = Date.now();
  for (const [code, lob] of externalLobbies.entries()) {
    if (now - lob.updatedAt > LOBBY_TTL) externalLobbies.delete(code);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "Content-Type",
    });
    res.end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (url.pathname === "/api/lobbies") {
    pruneExternal();
    if (req.method === "GET") {
      const list = [];
      const seen = new Set();
      for (const r of rooms.values()) {
        if (r.isPublic && !r.started && r.connectedCount() < r.max && r.connectedCount() > 0) {
          const host = r.players.get(r.hostId);
          list.push({
            code: r.code,
            hostName: host ? host.name : "Host",
            players: r.connectedCount(),
            max: r.max,
            level: r.config.level,
            goals: r.config.goals,
            netMode: "ws",
          });
          seen.add(r.code);
        }
      }
      for (const lob of externalLobbies.values()) {
        if (!seen.has(lob.code)) {
          list.push({
            code: lob.code,
            hostName: lob.hostName,
            players: lob.players || 1,
            max: lob.max || 5,
            level: lob.level || "demo",
            goals: lob.goals,
            netMode: lob.netMode || "p2p",
          });
        }
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
      });
      res.end(JSON.stringify({ ok: true, lobbies: list, totalHosted }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let data = {};
        try { data = JSON.parse(body || "{}"); } catch (e) {}
        const code = String(data.code || "").trim().toUpperCase();
        if (!code) {
          res.writeHead(400, { "content-type": "application/json", "access-control-allow-origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Missing room code" }));
          return;
        }
        if (data.action === "close") {
          externalLobbies.delete(code);
          res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
          res.end(JSON.stringify({ ok: true, closed: code }));
          return;
        }
        if (!allHostedCodes.has(code)) {
          allHostedCodes.add(code);
          totalHosted++;
        }
        externalLobbies.set(code, {
          code,
          hostName: String(data.hostName || "Host").slice(0, 24),
          players: Math.max(1, parseInt(data.players, 10) || 1),
          max: Math.max(2, Math.min(5, parseInt(data.max, 10) || 5)),
          level: String(data.level || "demo"),
          goals: data.goals || { cured: 25, money: 100000, timeLimit: 30 },
          netMode: data.netMode || "p2p",
          updatedAt: Date.now(),
        });
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ ok: true, registered: code, totalHosted }));
      });
      return;
    }
    if (req.method === "DELETE") {
      const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
      if (code) externalLobbies.delete(code);
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, deleted: code }));
      return;
    }
  }
  const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]+)$/);
  if (m) {
    const room = rooms.get(m[1].toUpperCase());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        room
          ? { exists: true, started: room.started, players: room.playerList().length, max: room.max }
          : { exists: false }
      )
    );
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
});

/** @type {Map<string, Room>} */
const rooms = new Map();

function isFullOnlyLevel(lvl) {
  const s = String(lvl || "").toLowerCase();
  return s !== "demo";
}

class Room {
  constructor(code, max, isPublic = true) {
    this.code = code;
    this.max = max;
    this.isPublic = isPublic;
    this.started = false;
    this.config = {
      mode: "versus",
      goals: { cured: 25, money: 100000, timeLimit: 30 },
      level: "demo"
    };
    this.players = new Map(); // id -> {id, name, demo, token, ws|null}
    this.nextId = 0;
    this.hostId = null;
    this.emptySince = null;
  }
  hasDemoPlayer() {
    return [...this.players.values()].some((p) => p.ws && p.demo);
  }
  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      demo: !!p.demo,
      ready: !!p.ready,
      host: p.id === this.hostId,
      connected: !!p.ws,
    }));
  }
  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.ws && p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
    }
  }
  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.ws) n++;
    return n;
  }
}

function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.room = null;
  ws.pid = null;

  ws.on("message", (raw, isBinary) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    handle(ws, msg);
  });
  ws.on("close", () => leave(ws, false));
  ws.on("error", () => {});
});

function handle(ws, msg) {
  switch (msg.t) {
    case "create": {
      if (ws.room) return;
      const max = Math.max(2, Math.min(MAX_PLAYERS, msg.max | 0 || 5));
      const isPublic = msg.isPublic !== undefined ? !!msg.isPublic : true;
      const room = new Room(newCode(), max, isPublic);
      rooms.set(room.code, room);
      if (!allHostedCodes.has(room.code)) {
        allHostedCodes.add(room.code);
        totalHosted++;
      }
      const p = { id: room.nextId++, name: String(msg.name || "Host").slice(0, 24), demo: !!msg.demo, ready: false, token: String(msg.token || ""), ws };
      room.players.set(p.id, p);
      room.hostId = p.id;
      ws.room = room;
      ws.pid = p.id;
      send(ws, { t: "joined", code: room.code, id: p.id, host: true, max: room.max, players: room.playerList(), config: room.config });
      break;
    }
    case "list_lobbies": {
      const list = [];
      for (const r of rooms.values()) {
        if (r.isPublic && !r.started && r.connectedCount() < r.max && r.connectedCount() > 0) {
          const host = r.players.get(r.hostId);
          list.push({
            code: r.code,
            hostName: host ? host.name : "Host",
            players: r.connectedCount(),
            max: r.max,
            level: r.config.level,
            goals: r.config.goals,
          });
        }
      }
      send(ws, { t: "lobbies", lobbies: list });
      break;
    }
    case "kick": {
      const room = ws.room;
      if (!room || ws.pid !== room.hostId || room.started) return;
      const targetId = msg.targetId | 0;
      if (targetId === room.hostId) return;
      const targetP = room.players.get(targetId);
      if (!targetP) return;
      if (targetP.ws && targetP.ws.readyState === 1) {
        send(targetP.ws, { t: "kicked", reason: "You were kicked from the lobby by the host." });
        targetP.ws.room = null;
        targetP.ws.pid = null;
      }
      room.players.delete(targetId);
      for (const pl of room.players.values()) pl.ready = false;
      room.broadcast({ t: "players", players: room.playerList(), config: room.config });
      room.broadcast({ t: "chat", from: -1, name: "System", text: `${targetP.name} was kicked from the lobby.` });
      break;
    }
    case "join": {
      if (ws.room) return;
      const room = rooms.get(String(msg.code || "").trim().toUpperCase());
      if (!room) return send(ws, { t: "error", error: "no_such_room" });
      const token = String(msg.token || "");
      // Seat reclaim after a connection drop.
      let p = token ? [...room.players.values()].find((q) => q.token === token && !q.ws) : null;
      let rejoin = false;
      if (p) {
        p.ws = ws;
        if (msg.demo !== undefined) p.demo = !!msg.demo;
        rejoin = true;
      } else {
        if (room.started) return send(ws, { t: "error", error: "already_started" });
        if (room.connectedCount() >= room.max) return send(ws, { t: "error", error: "room_full" });
        p = { id: room.nextId++, name: String(msg.name || "Player").slice(0, 24), demo: !!msg.demo, ready: false, token, ws };
        room.players.set(p.id, p);
      }
      if (room.hasDemoPlayer() && isFullOnlyLevel(room.config.level)) {
        room.config.level = "demo";
      }
      room.emptySince = null;
      ws.room = room;
      ws.pid = p.id;
      send(ws, {
        t: "joined",
        code: room.code,
        id: p.id,
        host: p.id === room.hostId,
        max: room.max,
        players: room.playerList(),
        started: room.started,
        config: room.config,
        rejoin,
      });
      room.broadcast({ t: "players", players: room.playerList(), joined: p.id, rejoin, config: room.config }, p.id);
      break;
    }
    case "ready": {
      const room = ws.room;
      if (!room || room.started) return;
      const p = room.players.get(ws.pid);
      if (!p) return;
      p.ready = !!msg.ready;
      room.broadcast({
        t: "players",
        players: room.playerList(),
        config: room.config,
        readyChange: { id: p.id, name: p.name, ready: p.ready },
      });
      break;
    }
    case "lobby_config": {
      const room = ws.room;
      if (!room || ws.pid !== room.hostId || room.started) return;
      if (msg.goal) room.config.goal = String(msg.goal);
      if (msg.goals && typeof msg.goals === "object") {
        room.config.goals = {
          cured: Number(msg.goals.cured) || 0,
          money: Number(msg.goals.money) || 0,
          timeLimit: Number(msg.goals.timeLimit) || 0,
        };
      }
      if (msg.mode) room.config.mode = String(msg.mode);
      if (msg.level) {
        room.config.level = String(msg.level);
      }
      // Unready players on settings change so everyone re-confirms
      for (const pl of room.players.values()) pl.ready = false;
      room.broadcast({
        t: "lobby_config",
        goal: room.config.goal,
        goals: room.config.goals,
        mode: room.config.mode,
        level: room.config.level,
      });
      room.broadcast({ t: "players", players: room.playerList(), config: room.config });
      break;
    }
    case "start": {
      const room = ws.room;
      if (!room || ws.pid !== room.hostId || room.started) return;
      const connected = [...room.players.values()].filter((pl) => pl.ws);
      if (connected.length < 2 || !connected.every((pl) => pl.ready)) {
        return send(ws, { t: "error", error: "not_all_ready" });
      }
      room.started = true;
      for (const pl of room.players.values()) pl.gameReady = false;
      let level = (msg.config && msg.config.level) || room.config.level || "demo";
      room.config = Object.assign({}, room.config, msg.config || {}, {
        level,
        hostId: room.hostId,
        goals: (msg.config && msg.config.goals) || room.config.goals || { cured: 25, money: 100000, timeLimit: 30 },
        players: connected.map((pl) => ({ id: pl.id, name: pl.name, demo: pl.demo, host: pl.id === room.hostId })),
      });
      room.broadcast({ t: "start", config: room.config });
      break;
    }
    case "game_ready": {
      const room = ws.room;
      if (!room || !room.started) return;
      const p = room.players.get(ws.pid);
      if (p) p.gameReady = true;
      const connected = [...room.players.values()].filter((pl) => pl.ws);
      if (connected.length >= 1 && connected.every((pl) => pl.gameReady)) {
        room.broadcast({ t: "start_sim" });
      }
      break;
    }
    case "msg": {
      const room = ws.room;
      if (!room) return;
      const out = JSON.stringify({ t: "msg", from: ws.pid, d: msg.d });
      if (msg.to === undefined || msg.to === null || msg.to === "all") {
        for (const p of room.players.values()) {
          if (p.ws && p.id !== ws.pid && p.ws.readyState === 1) p.ws.send(out);
        }
      } else {
        const p = room.players.get(msg.to | 0);
        if (p && p.ws && p.ws.readyState === 1) p.ws.send(out);
      }
      break;
    }
    case "chat": {
      const room = ws.room;
      if (!room) return;
      const p = room.players.get(ws.pid);
      room.broadcast({ t: "chat", from: ws.pid, name: p ? p.name : "?", text: String(msg.text || "").slice(0, 300) });
      break;
    }
    case "leave":
      leave(ws, true);
      break;
    case "ping":
      send(ws, { t: "pong", ts: msg.ts });
      break;
  }
}

function leave(ws, explicit) {
  const room = ws.room;
  if (!room) return;
  const p = room.players.get(ws.pid);
  ws.room = null;
  ws.pid = null;
  if (!p || p.ws !== ws) return;
  p.ws = null;
  // Before the game starts, a leaving player simply disappears.
  if (!room.started || explicit) room.players.delete(p.id);
  if (!room.started) {
    for (const pl of room.players.values()) pl.ready = false;
  }
  if (room.hostId === p.id) {
    const next = [...room.players.values()].find((q) => q.ws);
    room.hostId = next ? next.id : null;
  }
  room.broadcast({ t: "left", id: p.id, players: room.playerList(), host: room.hostId, explicit });
  if (room.connectedCount() === 0) {
    room.emptySince = Date.now();
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  }
  // Drop rooms nobody is connected to for a while.
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > 10 * 60 * 1000) rooms.delete(code);
  }
}, 15000);

server.listen(PORT, HOST, () => {
  console.log(`Browser Theme Hospital server on http://${HOST}:${PORT}  (serving ${ROOT})`);
});

module.exports = { server, rooms };
