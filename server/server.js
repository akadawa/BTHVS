/* Static file server + WebSocket room relay for Browser Theme Hospital.
 *
 *   node server/server.js [--port 8080] [--host 0.0.0.0]
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
const PORT = parseInt(process.env.PORT || arg("port", "8080"), 10);
const HOST = process.env.HOST || arg("host", "0.0.0.0");
const ROOT = path.resolve(__dirname, "..", "dist");
const MAX_PLAYERS = 4;
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
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
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

class Room {
  constructor(code, max) {
    this.code = code;
    this.max = max;
    this.started = false;
    this.config = null;
    this.players = new Map(); // id -> {id, name, token, ws|null}
    this.nextId = 0;
    this.hostId = null;
    this.emptySince = null;
  }
  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
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
      const max = Math.max(2, Math.min(MAX_PLAYERS, msg.max | 0 || 2));
      const room = new Room(newCode(), max);
      rooms.set(room.code, room);
      const p = { id: room.nextId++, name: String(msg.name || "Host").slice(0, 24), token: String(msg.token || ""), ws };
      room.players.set(p.id, p);
      room.hostId = p.id;
      ws.room = room;
      ws.pid = p.id;
      send(ws, { t: "joined", code: room.code, id: p.id, host: true, max: room.max, players: room.playerList() });
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
        rejoin = true;
      } else {
        if (room.started) return send(ws, { t: "error", error: "already_started" });
        if (room.connectedCount() >= room.max) return send(ws, { t: "error", error: "room_full" });
        p = { id: room.nextId++, name: String(msg.name || "Player").slice(0, 24), token, ws };
        room.players.set(p.id, p);
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
        config: room.started ? room.config : null,
        rejoin,
      });
      room.broadcast({ t: "players", players: room.playerList(), joined: p.id, rejoin }, p.id);
      break;
    }
    case "start": {
      const room = ws.room;
      if (!room || ws.pid !== room.hostId || room.started) return;
      room.started = true;
      room.config = Object.assign({}, msg.config || {}, {
        players: room.playerList().filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name })),
      });
      room.broadcast({ t: "start", config: room.config });
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
