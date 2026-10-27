// api/lobbies.js - Vercel Serverless Function for Public Lobby Discovery
"use strict";

// Module-level in-memory cache for warm lambda executions
const lobbies = new Map();
const TTL_MS = 60000; // 60 seconds TTL

function prune() {
  const now = Date.now();
  for (const [code, lob] of lobbies.entries()) {
    if (now - lob.updatedAt > TTL_MS) {
      lobbies.delete(code);
    }
  }
}

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  prune();

  if (req.method === "GET") {
    const list = [];
    for (const lob of lobbies.values()) {
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
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, lobbies: list }));
    return;
  }

  const handleBody = (data) => {
    const code = String(data.code || "").trim().toUpperCase();
    if (!code) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Missing room code" }));
      return;
    }

    if (data.action === "close") {
      lobbies.delete(code);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, closed: code }));
      return;
    }

    // Add or update room
    lobbies.set(code, {
      code,
      hostName: String(data.hostName || "Host").slice(0, 24),
      players: Math.max(1, parseInt(data.players, 10) || 1),
      max: Math.max(2, Math.min(5, parseInt(data.max, 10) || 5)),
      level: String(data.level || "demo"),
      goals: data.goals || { cured: 25, money: 100000, timeLimit: 30 },
      netMode: data.netMode || "p2p",
      updatedAt: Date.now(),
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, registered: code }));
  };

  if (req.method === "POST") {
    if (req.body && typeof req.body === "object") {
      handleBody(req.body);
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch (e) {}
      handleBody(data);
    });
    return;
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, "http://localhost");
    const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    if (code) lobbies.delete(code);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, deleted: code }));
    return;
  }

  res.statusCode = 405;
  res.end();
};
