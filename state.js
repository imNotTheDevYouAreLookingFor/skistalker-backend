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
};
