/**
 * Roulette MP — Firebase Sync
 *
 * Rooms stored under `roulette-rooms/{roomCode}`.
 * TV is the single writer for game/wheel/players(chips, broke); phones write
 * only their own bets under bets/player_N/{betKey}.
 */

import { db, auth } from './firebase-config.js';
import {
  ref, set, get, update, remove, onValue, off, onDisconnect,
} from 'firebase/database';

const ROOM_PATH = 'roulette-rooms';
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const MAX_PLAYERS = 12;
export const STARTING_CHIPS = 1000;

/* ======= SERVER TIME =======
 * Both TV and phones must agree on "now" so the bet timer countdown matches.
 * Local Date.now() can drift between devices by several seconds — using
 * Firebase's .info/serverTimeOffset lets every device compute the same
 * server-time when scheduling/reading betsCloseAt. */
let _serverTimeOffset = 0;
let _offsetSubscribed = false;
function subscribeServerTimeOffset() {
  if (_offsetSubscribed) return;
  _offsetSubscribed = true;
  try {
    onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
      const v = snap.val();
      if (typeof v === 'number') _serverTimeOffset = v;
    });
  } catch (err) {
    console.warn('serverTimeOffset listener failed:', err.message);
  }
}
subscribeServerTimeOffset();

/** Returns the current server time in ms (Date.now() + serverTimeOffset).
 *  Use this everywhere the TV and phones must agree on "now". */
export function serverNow() {
  return Date.now() + _serverTimeOffset;
}

export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`Firebase retry ${attempt + 1}/${maxRetries}:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return code;
}

/* ======= TV: CREATE ======= */
export async function createRoomAsTv(hostName, hostEmoji) {
  const uid = auth.currentUser?.uid || 'anonymous';
  const roomCode = generateRoomCode();
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const data = {
    meta: {
      host: { name: hostName, emoji: hostEmoji, uid, connected: true },
      status: 'lobby',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    players: {},
    bets: {},
    wheel: { spinning: false, winningNumber: null, spinStartedAt: 0 },
    game: { roundNumber: 0, betsCloseAt: null, autoCloseSeconds: 30, lastResults: [] },
    payouts: {},
  };
  await firebaseRetry(() => set(roomRef, data));
  return { roomCode };
}

/* ======= PHONE: JOIN ======= */
export async function joinRoomAsPlayer(roomCode, playerName, playerEmoji) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const snap = await firebaseRetry(() => get(roomRef));
  if (!snap.exists()) return { success: false, reason: 'Room not found' };
  const data = snap.val();
  if (data.meta?.status === 'ended') return { success: false, reason: 'Room has ended' };

  const players = data.players || {};
  // A "ghost" slot is one that has no name (only a leftover `connected:false`
  // written by a stale onDisconnect handler after the player tapped Leave).
  // Drop those from the index calculation AND clean them up so the lobby
  // doesn't show empty cards.
  const ghostKeys = Object.keys(players).filter((k) => !players[k] || !players[k].name);
  const validKeys = Object.keys(players).filter((k) => players[k] && players[k].name);
  const existingIndices = validKeys
    .map((k) => parseInt(k.replace('player_', ''), 10))
    .filter((n) => !isNaN(n));
  if (existingIndices.length >= MAX_PLAYERS) {
    return { success: false, reason: `Room is full (${MAX_PLAYERS})` };
  }
  // Cleanup any ghost slots so they vanish from the lobby. Best-effort:
  // it's fine if these fail (e.g. permissions), the join itself proceeds.
  if (ghostKeys.length > 0) {
    try {
      const cleanup = {};
      ghostKeys.forEach((k) => { cleanup[`players/${k}`] = null; });
      await update(ref(db, `${ROOM_PATH}/${roomCode}`), cleanup);
    } catch (_) {}
  }
  const nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 0;
  const uid = auth.currentUser?.uid || 'anonymous';
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      [`players/player_${nextIndex}`]: {
        name: playerName, emoji: playerEmoji, uid,
        connected: true, chips: STARTING_CHIPS, broke: false,
      },
      'meta/updatedAt': Date.now(),
    })
  );
  return { success: true, playerIndex: nextIndex };
}

/* ======= REJOIN ======= */
export async function rejoinRoom(roomCode, playerIndex, role) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const snap = await firebaseRetry(() => get(roomRef));
  if (!snap.exists()) return { success: false, reason: 'Room no longer exists' };
  const data = snap.val();
  if (role === 'tv') {
    await firebaseRetry(() =>
      update(ref(db, `${ROOM_PATH}/${roomCode}/meta/host`), { connected: true })
    );
    return { success: true, status: data.meta.status };
  }
  const playerKey = `player_${playerIndex}`;
  if (!data.players || !data.players[playerKey]) {
    return { success: false, reason: 'Player slot not found' };
  }
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/players/${playerKey}`), { connected: true })
  );
  return { success: true, status: data.meta.status };
}

/* ======= LISTEN ======= */
export function listenRoom(roomCode, callbacks) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const handler = (snap) => {
    if (!snap.exists()) {
      if (callbacks.onRoomDeleted) callbacks.onRoomDeleted();
      return;
    }
    const data = snap.val();
    if (callbacks.onMetaChange && data.meta) callbacks.onMetaChange(data.meta);
    if (callbacks.onPlayersChange) callbacks.onPlayersChange(data.players || {});
    if (callbacks.onBetsChange) callbacks.onBetsChange(data.bets || {});
    if (callbacks.onGameChange) callbacks.onGameChange(data.game || {});
    if (callbacks.onWheelChange) callbacks.onWheelChange(data.wheel || {});
    if (callbacks.onPayoutsChange) callbacks.onPayoutsChange(data.payouts || {});
  };
  onValue(roomRef, handler);
  return () => off(roomRef, 'value', handler);
}

/* ======= TV WRITES ======= */

/** Open the betting phase. Phones unlock the felt. */
export async function openBets(roomCode, autoCloseSeconds = 30) {
  // Use server-aligned time so phones' countdowns match the TV's regardless
  // of device clock drift between them.
  const closesAt = autoCloseSeconds ? serverNow() + autoCloseSeconds * 1000 : null;
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      'meta/status': 'betting',
      'meta/updatedAt': Date.now(),
      'game/betsCloseAt': closesAt,
      'game/autoCloseSeconds': autoCloseSeconds || null,
      'wheel/winningNumber': null,
      'wheel/spinning': false,
      bets: {},
      payouts: {},
    })
  );
}

/** Close betting (called when timer fires or host taps Spin Now). */
export async function closeBets(roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      'meta/status': 'spinning',
      'meta/updatedAt': Date.now(),
      'game/betsCloseAt': null,
      'wheel/spinning': true,
      'wheel/spinStartedAt': Date.now(),
    })
  );
}

/** Reveal the winning number (after the visual spin completes). */
export async function revealWinningNumber(roomCode, winningNumber) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      'wheel/winningNumber': winningNumber,
      'wheel/spinning': false,
      'meta/status': 'payout',
      'meta/updatedAt': Date.now(),
    })
  );
}

/**
 * Apply round payouts atomically. Updates every player's chips + broke flags
 * and writes the per-player payout summary.
 *
 * @param {object} updates  e.g. { 'players/player_0/chips': 950, 'payouts/player_0': {...}, ... }
 */
export async function applyPayouts(roomCode, updates) {
  const all = { ...updates, 'meta/updatedAt': Date.now() };
  await firebaseRetry(() => update(ref(db, `${ROOM_PATH}/${roomCode}`), all));
}

/** Push a number into the lastResults array (capped at last 10).
 *  roundNumber is passed in explicitly so it keeps incrementing past 10
 *  even though lastResults is capped. */
export async function pushResult(roomCode, winningNumber, currentResults, currentRoundNumber) {
  const next = [...(currentResults || []), winningNumber].slice(-10);
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/game`), {
      lastResults: next,
      roundNumber: (currentRoundNumber || 0) + 1,
    })
  );
}

/** Apply a chips/broke update to many players in one write. */
export async function applyBalanceUpdates(roomCode, newBalances, newBroke) {
  const updates = {};
  Object.keys(newBalances).forEach((key) => {
    updates[`players/${key}/chips`] = newBalances[key];
    updates[`players/${key}/broke`] = !!newBroke[key];
  });
  updates['meta/updatedAt'] = Date.now();
  await firebaseRetry(() => update(ref(db, `${ROOM_PATH}/${roomCode}`), updates));
}

export async function endGame(roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/meta`), {
      status: 'ended', updatedAt: Date.now(),
    })
  );
}

/**
 * Toggles or sets the autoPaused flag.
 * When true, the TV won't automatically start the next round after payout.
 */
export async function setPaused(roomCode, paused) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/meta`), {
      autoPaused: paused,
      updatedAt: Date.now(),
    })
  );
}

/**
 * Removes all disconnected players from the room.
 * Cleans up ghost players and players who have lost connection.
 */
export async function removeDisconnectedPlayers(roomCode) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const snap = await firebaseRetry(() => get(roomRef));
  if (!snap.exists()) return { removed: 0 };
  
  const data = snap.val();
  const players = data.players || {};
  
  // Find all players that are disconnected or ghost (no name)
  const toRemove = Object.keys(players).filter((k) => {
    const p = players[k];
    return !p || !p.name || p.connected === false;
  });
  
  if (toRemove.length === 0) return { removed: 0 };
  
  // Build cleanup update
  const cleanup = {};
  toRemove.forEach((k) => {
    cleanup[`players/${k}`] = null;
    // Also clean up their bets if any
    cleanup[`bets/${k}`] = null;
  });
  cleanup['meta/updatedAt'] = Date.now();
  
  await firebaseRetry(() => update(ref(db, `${ROOM_PATH}/${roomCode}`), cleanup));
  
  return { removed: toRemove.length, players: toRemove };
}

export async function deleteRoom(roomCode) {
  await firebaseRetry(() => remove(ref(db, `${ROOM_PATH}/${roomCode}`)));
}

/* ======= PHONE WRITES ======= */

/**
 * Set (or replace) a single bet entry under bets/player_N/{betKey}.
 * Pass chips=0 to remove (Firebase removes null/0 leaves cleanly via remove).
 */
export async function writeBet(roomCode, playerIndex, betKey, payload) {
  const path = `${ROOM_PATH}/${roomCode}/bets/player_${playerIndex}/${betKey}`;
  if (!payload || payload.chips <= 0) {
    await firebaseRetry(() => remove(ref(db, path)));
  } else {
    await firebaseRetry(() => set(ref(db, path), payload));
  }
}

/** Wipe all bets for one player (the "Clear" button). */
export async function clearPlayerBets(roomCode, playerIndex) {
  await firebaseRetry(() =>
    remove(ref(db, `${ROOM_PATH}/${roomCode}/bets/player_${playerIndex}`))
  );
}

export async function leaveRoom(roomCode, playerIndex) {
  // Cancel the queued onDisconnect first. Otherwise, after we remove the
  // player node, the disconnect handler still fires when the page closes
  // and writes `connected: false` to players/player_N/connected — Firebase
  // recreates a ghost player (no name, no chips) at that slot, and the
  // next join takes player_N+1, so the lobby shows two cards for one user.
  const connectedRef = ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}/connected`);
  try { await onDisconnect(connectedRef).cancel(); } catch (_) {}
  await firebaseRetry(() =>
    remove(ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}`))
  );
}

/**
 * Host removes a player from the lobby (kick).
 * Similar to leaveRoom but can be called by the host on any player.
 */
export async function removePlayer(roomCode, playerIndex) {
  await firebaseRetry(() =>
    remove(ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}`))
  );
}

/* ======= DISCONNECT HOOKS ======= */
export function setupTvDisconnectHandler(roomCode) {
  const r = ref(db, `${ROOM_PATH}/${roomCode}/meta/host/connected`);
  onDisconnect(r).set(false).catch((err) => console.warn('TV onDisconnect failed:', err.message));
}

export function setupPlayerDisconnectHandler(roomCode, playerIndex) {
  const r = ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}/connected`);
  onDisconnect(r).set(false).catch((err) => console.warn('Player onDisconnect failed:', err.message));
}
