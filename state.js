'use strict';

/** @type {Map<string, {ws: import('ws').WebSocket, userId: string, name: string, avatarUrl: string, lat: number, lng: number, speed: number, heading: number, altitude: number, lastUpdate: number}>} */
const users = new Map();

function addOrUpdateUser(userId, data) {
  const existing = users.get(userId);
  if (existing) {
    // Don't overwrite a live ws with null (REST position updates)
    if (data.ws === null && existing.ws) delete data.ws;
    Object.assign(existing, data);
    delete existing.disconnectedAt;
  } else {
    users.set(userId, {
      userId,
      name: data.name ?? 'Unknown',
      avatarUrl: data.avatarUrl ?? '',
      lat: data.lat ?? 0,
      lng: data.lng ?? 0,
      speed: data.speed ?? 0,
      heading: data.heading ?? 0,
      altitude: data.altitude ?? 0,
      lastUpdate: Date.now(),
      ws: data.ws,
    });
  }
}

function updatePosition(userId, lat, lng, speed, heading, altitude) {
  const user = users.get(userId);
  if (user) {
    user.lat = lat;
    user.lng = lng;
    user.speed = speed;
    user.heading = heading;
    user.altitude = altitude;
    user.lastUpdate = Date.now();
  }
}

function removeUser(userId) {
  // Don't delete — just mark as disconnected so they stay visible to others
  const user = users.get(userId);
  if (user) {
    user.ws = null;
    user.disconnectedAt = Date.now();
  }
}

function getSnapshot() {
  return Array.from(users.values()).map(({ ws: _ws, disconnectedAt: _dc, ...session }) => session);
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const user of users.values()) {
    if (user.ws && user.ws.readyState === 1 /* OPEN */) {
      user.ws.send(data);
    }
  }
}

function getUserCount() {
  return users.size;
}

const STALE_MS = 30 * 60 * 1000; // 30 minutes

function evictStaleUsers() {
  const cutoff = Date.now() - STALE_MS;
  for (const [userId, user] of users) {
    if (user.lastUpdate < cutoff) {
      console.log('[state] evicting stale user:', userId, user.name);
      users.delete(userId);
    }
  }
}

// Run eviction every minute
setInterval(evictStaleUsers, 60_000);

function sendToUser(userId, message) {
  const user = users.get(userId);
  if (user && user.ws && user.ws.readyState === 1) {
    user.ws.send(JSON.stringify(message));
  }
}

// ── Shouts ───────────────────────────────────────────────────────────────────
const SHOUT_MAX = 100;
const SHOUT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PIN_REPLY_EXTEND_MS = 10 * 60 * 1000; // 10 minutes extension per reply

/**
 * @type {{
 *   id: string, userId: string, name: string, avatarUrl: string,
 *   lat: number, lng: number, altitude?: number, text: string,
 *   timestamp: number, announcement: boolean, pin?: boolean,
 *   expiresAt?: number, replyToPinId?: string
 * }[]}
 */
const shouts = [];

function addShout(shout) {
  if (shout.announcement && !shout.pin) {
    // One active announcement per user — reject if one already exists
    const hasExisting = shouts.some((s) => s.userId === shout.userId && s.announcement && !s.pin);
    if (hasExisting) return false;
  }
  if (shout.pin) {
    // Max 3 pins per user
    const pinCount = shouts.filter((s) => s.userId === shout.userId && s.pin).length;
    if (pinCount >= 3) return false;
    // Set initial expiry: 30 minutes from creation
    if (!shout.expiresAt) {
      shout.expiresAt = shout.timestamp + SHOUT_TTL_MS;
    }
  }
  shouts.push(shout);
  if (shouts.length > SHOUT_MAX) shouts.shift();
  return true;
}

function getShouts() {
  const now = Date.now();
  const cutoff = now - SHOUT_TTL_MS;
  return shouts.filter((s) => {
    if (s.pin) {
      // Pins use expiresAt; fall back to timestamp + TTL for pins created before this field
      const exp = s.expiresAt ?? (s.timestamp + SHOUT_TTL_MS);
      return exp > now;
    }
    if (s.replyToPinId) {
      // Replies live as long as their parent pin lives — filter out orphaned replies
      const parentAlive = shouts.some((p) => p.id === s.replyToPinId && p.pin && (p.expiresAt ?? (p.timestamp + SHOUT_TTL_MS)) > now);
      return parentAlive;
    }
    return s.timestamp > cutoff;
  });
}

/** Extends a pin's expiry by PIN_REPLY_EXTEND_MS. Returns the updated pin or null. */
function extendPinExpiry(pinId) {
  const pin = shouts.find((s) => s.id === pinId && s.pin);
  if (!pin) return null;
  const now = Date.now();
  pin.expiresAt = Math.max(pin.expiresAt ?? now, now + PIN_REPLY_EXTEND_MS);
  return pin;
}

function removeShout(id, requestingUserId) {
  const idx = shouts.findIndex((s) => s.id === id && s.userId === requestingUserId);
  if (idx === -1) return false;
  // Also remove all replies to this pin
  const toRemove = new Set([id]);
  for (let i = shouts.length - 1; i >= 0; i--) {
    if (shouts[i].replyToPinId && toRemove.has(shouts[i].replyToPinId)) {
      shouts.splice(i, 1);
    }
  }
  const pinIdx = shouts.findIndex((s) => s.id === id);
  if (pinIdx !== -1) shouts.splice(pinIdx, 1);
  return true;
}

// ── Bears 🐻 ─────────────────────────────────────────────────────────────────
const MAX_BEARS = 3;
const BEAR_COLLECT_RADIUS_M = 50;
const BEAR_SPAWN_MIN_MS = 30 * 60 * 1000; // 30 minutes
const BEAR_SPAWN_MAX_MS = 60 * 60 * 1000; // 60 minutes

// Hopfgarten/Skiwelt area bounding box for random spawning
const BEAR_BOUNDS = {
  minLat: 47.43, maxLat: 47.50,
  minLng: 12.10, maxLng: 12.25,
};

/** @type {{ id: string, lat: number, lng: number, spawnedAt: number }[]} */
const bears = [];

/** @type {Map<string, { userId: string, name: string, score: number }>} */
const bearScores = new Map();

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function spawnBear() {
  if (bears.length >= MAX_BEARS) return null;
  const bear = {
    id: `bear-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    lat: BEAR_BOUNDS.minLat + Math.random() * (BEAR_BOUNDS.maxLat - BEAR_BOUNDS.minLat),
    lng: BEAR_BOUNDS.minLng + Math.random() * (BEAR_BOUNDS.maxLng - BEAR_BOUNDS.minLng),
    spawnedAt: Date.now(),
  };
  bears.push(bear);
  console.log('[bears] spawned:', bear.id, 'at', bear.lat.toFixed(4), bear.lng.toFixed(4), `(${bears.length}/${MAX_BEARS})`);
  return bear;
}

function tryCollectBear(userId, userName, lat, lng) {
  for (let i = 0; i < bears.length; i++) {
    const dist = haversineM(lat, lng, bears[i].lat, bears[i].lng);
    if (dist <= BEAR_COLLECT_RADIUS_M) {
      const bear = bears.splice(i, 1)[0];
      const entry = bearScores.get(userId) || { userId, name: userName, score: 0 };
      entry.score += 1;
      entry.name = userName; // keep name fresh
      bearScores.set(userId, entry);
      console.log('[bears] collected:', bear.id, 'by', userName, 'score:', entry.score);
      return { bear, collector: entry };
    }
  }
  return null;
}

function getBears() {
  return bears.map(({ id, lat, lng, spawnedAt }) => ({ id, lat, lng, spawnedAt }));
}

function getBearScores() {
  return Array.from(bearScores.values()).sort((a, b) => b.score - a.score);
}

// Schedule next bear spawn
function scheduleNextSpawn() {
  const delay = BEAR_SPAWN_MIN_MS + Math.random() * (BEAR_SPAWN_MAX_MS - BEAR_SPAWN_MIN_MS);
  const mins = Math.round(delay / 60000);
  console.log('[bears] next spawn in', mins, 'minutes');
  setTimeout(() => {
    const bear = spawnBear();
    if (bear) {
      broadcast({ type: 'bears', bears: getBears() });
    }
    scheduleNextSpawn();
  }, delay);
}

// Spawn initial bear + start the cycle
spawnBear();
scheduleNextSpawn();

module.exports = {
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
  sendToUser,
  getBears,
  getBearScores,
  tryCollectBear,
  spawnBear,
};
