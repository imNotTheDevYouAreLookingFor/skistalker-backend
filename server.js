'use strict';

const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const {
  addOrUpdateUser,
  updatePosition,
  removeUser,
  getSnapshot,
  broadcast,
  getUserCount,
  addShout,
  getShouts,
  removeShout,
  extendPinExpiry,
  getBears,
  getBearScores,
  tryCollectBear,
} = require('./state.js');

const port = parseInt(process.env.PORT || '8080', 10);
const SKI_SECRET = process.env.SKI_SECRET || '';

// ── HTTP server ───────────────────────────────────────────────────────────────
// Serves health check + a minimal status endpoint. All real traffic is WS.
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ users: getUserCount(), uptime: Math.floor(process.uptime()) }));
    return;
  }

  // ── REST position update (for background location tasks) ────────────────
  if (req.method === 'POST' && req.url === '/position') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (SKI_SECRET && msg.token !== SKI_SECRET) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (!msg.userId || typeof msg.lat !== 'number' || typeof msg.lng !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing userId, lat, or lng' }));
          return;
        }
        // Ensure user exists (they may have been evicted while backgrounded)
        addOrUpdateUser(msg.userId, {
          ws: null,
          name: msg.name || 'Skier',
          avatarUrl: msg.avatarUrl || '',
        });
        updatePosition(
          msg.userId,
          msg.lat,
          msg.lng,
          msg.speed ?? 0,
          msg.heading ?? 0,
          msg.altitude ?? 0,
        );
        broadcast({ type: 'snapshot', users: getSnapshot() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// Track which ws connection maps to which userId (for cleanup on disconnect)
const wsToUserId = new Map();

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let userId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ── auth ──────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      if (SKI_SECRET && msg.token !== SKI_SECRET) {
        console.warn('[ws] rejected — bad token');
        ws.close(4001, 'Unauthorized');
        return;
      }
      userId = msg.userId;
      console.log('[ws] auth userId=%s name=%s', userId, msg.name);
      wsToUserId.set(ws, userId);
      addOrUpdateUser(userId, {
        ws,
        name: msg.name || 'Skier',
        avatarUrl: msg.avatarUrl || '',
      });
      // Send current snapshot + shout history + bears to the newly connected user
      const snap = getSnapshot();
      ws.send(JSON.stringify({ type: 'snapshot', users: snap }));
      ws.send(JSON.stringify({ type: 'shouts', shouts: getShouts() }));
      ws.send(JSON.stringify({ type: 'bears', bears: getBears() }));
      ws.send(JSON.stringify({ type: 'bear_scores', scores: getBearScores() }));
      // Broadcast updated snapshot to everyone
      broadcast({ type: 'snapshot', users: snap });
      return;
    }

    // ── position ──────────────────────────────────────────────────────────────
    if (msg.type === 'position') {
      if (!userId) {
        console.warn('[ws] position received before auth — dropped');
        return;
      }
      updatePosition(
        userId,
        msg.lat,
        msg.lng,
        msg.speed ?? 0,
        msg.heading ?? 0,
        msg.altitude ?? 0,
      );
      broadcast({ type: 'snapshot', users: getSnapshot() });

      // Check if user collected a bear
      const user = getSnapshot().find((u) => u.userId === userId);
      if (user) {
        const collected = tryCollectBear(userId, user.name, msg.lat, msg.lng);
        if (collected) {
          broadcast({ type: 'bear_collected', bear: collected.bear, collector: collected.collector });
          broadcast({ type: 'bears', bears: getBears() });
          broadcast({ type: 'bear_scores', scores: getBearScores() });
        }
      }
      return;
    }

    // ── shout ─────────────────────────────────────────────────────────────────
    if (msg.type === 'shout' && userId) {
      const user = getSnapshot().find((u) => u.userId === userId);
      if (user && msg.text && typeof msg.text === 'string' && (!msg.announcement || msg.pin || user.lat || user.lng)) {
        const shout = {
          id: `${userId}-${Date.now()}`,
          userId,
          name: user.name,
          avatarUrl: user.avatarUrl,
          lat: msg.pin && typeof msg.pinLat === 'number' ? msg.pinLat : user.lat,
          lng: msg.pin && typeof msg.pinLng === 'number' ? msg.pinLng : user.lng,
          altitude: msg.pin && typeof msg.pinAlt === 'number' ? msg.pinAlt : undefined,
          text: msg.text.slice(0, 200),
          timestamp: Date.now(),
          announcement: !!msg.announcement,
          pin: !!msg.pin,
        };
        const accepted = addShout(shout);
        if (accepted) broadcast({ type: 'shout', shout });
      }
      return;
    }

    // ── remove_shout ──────────────────────────────────────────────────────────
    if (msg.type === 'remove_shout' && userId && msg.id) {
      const removed = removeShout(msg.id, userId);
      if (removed) broadcast({ type: 'shout_removed', id: msg.id });
      return;
    }

    // ── pin_reply ─────────────────────────────────────────────────────────────
    if (msg.type === 'pin_reply' && userId && msg.pinId && msg.text) {
      const user = getSnapshot().find((u) => u.userId === userId);
      if (!user) return;
      const targetPin = getShouts().find((s) => s.id === msg.pinId && s.pin);
      if (!targetPin) return;
      const reply = {
        id: `${userId}-${Date.now()}`,
        userId,
        name: user.name,
        avatarUrl: user.avatarUrl,
        lat: targetPin.lat,
        lng: targetPin.lng,
        text: msg.text.slice(0, 200),
        timestamp: Date.now(),
        announcement: false,
        pin: false,
        replyToPinId: msg.pinId,
      };
      const accepted = addShout(reply);
      if (!accepted) return;
      const updatedPin = extendPinExpiry(msg.pinId);
      broadcast({ type: 'shout', shout: reply });
      if (updatedPin) broadcast({ type: 'shout', shout: updatedPin });
      return;
    }
  });

  ws.on('close', () => {
    if (userId) {
      console.log('[ws] disconnect userId=%s', userId);
      removeUser(userId);
      wsToUserId.delete(ws);
      broadcast({ type: 'snapshot', users: getSnapshot() });
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message);
  });
});

// ── Ping / pong keepalive ─────────────────────────────────────────────────────
// Mobile networks can silently drop WebSocket connections without triggering
// the close event, leaving zombie users until eviction. Pinging every 30s
// detects dead connections quickly.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(port, '0.0.0.0', () => {
  console.log('ski-stalker-server listening on port %d', port);
});
