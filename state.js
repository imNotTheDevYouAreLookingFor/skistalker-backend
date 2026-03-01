'use strict';

/** @type {Map<string, {ws: import('ws').WebSocket, userId: string, name: string, avatarUrl: string, lat: number, lng: number, speed: number, heading: number, altitude: number, lastUpdate: number}>} */
const users = new Map();

function addOrUpdateUser(userId, data) {
  const existing = users.get(userId);
  if (existing) {
    Object.assign(existing, data);
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
  users.delete(userId);
}

function getSnapshot() {
  return Array.from(users.values()).map(({ ws: _ws, ...session }) => session);
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const user of users.values()) {
    if (user.ws.readyState === 1 /* OPEN */) {
      user.ws.send(data);
    }
  }
}

function getUserCount() {
  return users.size;
}

const STALE_MS = 5 * 60 * 1000; // 5 minutes

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
  if (user && user.ws.readyState === 1) {
    user.ws.send(JSON.stringify(message));
  }
}

// ── Shouts ───────────────────────────────────────────────────────────────────
const SHOUT_MAX = 50;
const SHOUT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** @type {{ id: string, userId: string, name: string, avatarUrl: string, lat: number, lng: number, altitude?: number, text: string, timestamp: number, announcement: boolean, pin?: boolean }[]} */
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
  }
  shouts.push(shout);
  if (shouts.length > SHOUT_MAX) shouts.shift();
  return true;
}

function getShouts() {
  const cutoff = Date.now() - SHOUT_TTL_MS;
  return shouts.filter((s) => s.timestamp > cutoff);
}

function removeShout(id, requestingUserId) {
  const idx = shouts.findIndex((s) => s.id === id && s.userId === requestingUserId);
  if (idx === -1) return false;
  shouts.splice(idx, 1);
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
  sendToUser,
};
