/** Authenticated, transactional Firebase synchronization for Roulette MP. */
import { db, auth, authReady } from './firebase-config.js';
import {
  ref, get, set, onValue, off, onDisconnect, runTransaction,
} from 'firebase/database';
import { validateStoredBet } from './bet-validator.js';
import { resolveRound, STARTING_CHIPS, TOP_UP_AMOUNT } from './game-engine.js';

const ROOM_PATH = 'roulette-rooms';
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_RETRIES = 20;
const HISTORY_LIMIT = 10;
const PLAYER_KEY = /^player_([0-9]|1[01])$/;
export const MAX_PLAYERS = 12;
export { STARTING_CHIPS };

let _serverTimeOffset = 0;
let _offsetSubscribed = false;
function subscribeServerTimeOffset() {
  if (_offsetSubscribed) return;
  _offsetSubscribed = true;
  onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
    if (typeof snap.val() === 'number') _serverTimeOffset = snap.val();
  }, (err) => console.warn('serverTimeOffset listener failed:', err.message));
}
subscribeServerTimeOffset();

export function serverNow() {
  return Date.now() + _serverTimeOffset;
}

export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try { return await fn(); } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw new Error('Firebase retry exhausted');
}

async function requireUser() {
  await authReady;
  const user = auth.currentUser;
  if (!user?.uid) throw new Error('Authentication required');
  return user;
}

function randomUint32() {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0];
}

export function generateRoomCode() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness unavailable');
  let code = '';
  for (let i = 0; i < 4; i += 1) code += ROOM_CODE_CHARSET[randomUint32() % ROOM_CODE_CHARSET.length];
  return code;
}

function randomWinningNumber() {
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x100000000 / 37) * 37;
  let value;
  do { value = randomUint32(); } while (value >= limit);
  return value % 37;
}

function phaseOf(room) {
  return room?.game?.phase || room?.meta?.status;
}

function assertHost(room, uid) {
  return !!room && room.meta?.host?.uid === uid;
}

function failure(message, code = 'operation-aborted') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function expectedMatches(room, expectedRound, expectedRevision) {
  return room.game?.roundNumber === expectedRound && room.game?.revision === expectedRevision;
}

async function hostRoomTransaction(roomCode, mutate) {
  const { uid } = await requireUser();
  let reason = 'Room no longer exists';
  const result = await firebaseRetry(() => runTransaction(
    ref(db, `${ROOM_PATH}/${roomCode}`),
    (room) => {
      if (!room) { reason = 'Room no longer exists'; return undefined; }
      if (!assertHost(room, uid)) { reason = 'Host authority required'; return undefined; }
      try { return mutate(room); } catch (err) { reason = err.message; return undefined; }
    },
    { applyLocally: false },
  ));
  if (!result.committed) throw failure(reason);
  return result.snapshot.val();
}

function newRoom(hostName, hostEmoji, uid) {
  const now = serverNow();
  return {
    schemaVersion: 2,
    meta: {
      host: { name: hostName, emoji: hostEmoji, uid, connected: true },
      status: 'lobby', autoPaused: false, createdAt: now, updatedAt: now,
    },
    players: {}, bets: {}, payouts: {},
    wheel: { spinning: false, winningNumber: null, spinStartedAt: 0 },
    game: {
      phase: 'lobby', roundNumber: 0, revision: 0, settledRound: -1,
      lockedBets: {}, winningNumber: null, betsCloseAt: null,
      autoCloseSeconds: 30, lastResults: [],
    },
  };
}

export async function createRoomAsTv(hostName, hostEmoji) {
  const { uid } = await requireUser();
  for (let attempt = 0; attempt < ROOM_CODE_RETRIES; attempt += 1) {
    const roomCode = generateRoomCode();
    const result = await firebaseRetry(() => runTransaction(
      ref(db, `${ROOM_PATH}/${roomCode}`),
      (existing) => existing == null ? newRoom(hostName, hostEmoji, uid) : undefined,
      { applyLocally: false },
    ));
    if (result.committed) return { roomCode };
  }
  throw failure('Unable to claim a unique room code', 'room-code-collisions');
}

export async function joinRoomAsPlayer(roomCode, playerName, playerEmoji) {
  const { uid } = await requireUser();
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const roomSnapshot = await firebaseRetry(() => get(roomRef));
  const room = roomSnapshot.val();
  if (!room) return { success: false, reason: 'Room not found' };
  if (room.schemaVersion !== 2) return { success: false, reason: 'Unsupported room version' };
  if (phaseOf(room) !== 'lobby') return { success: false, reason: 'Room is not accepting players' };

  const players = room.players || {};
  const owned = Object.keys(players)
    .filter((key) => PLAYER_KEY.test(key) && players[key]?.uid === uid)
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  if (owned.length > 1) {
    return { success: false, reason: 'Duplicate player ownership requires host cleanup' };
  }

  const claimSlot = async (playerKey, requireOwned) => {
    const result = await firebaseRetry(() => runTransaction(
      ref(db, `${ROOM_PATH}/${roomCode}/players/${playerKey}`),
      (current) => {
        if (requireOwned) {
          if (current?.uid !== uid) return undefined;
          return { ...current, name: playerName, emoji: playerEmoji, connected: true, uid };
        }
        if (current != null) return undefined;
        return {
          name: playerName, emoji: playerEmoji, uid, connected: true,
          chips: STARTING_CHIPS, broke: false,
        };
      },
      { applyLocally: false },
    ));
    return result.committed;
  };

  if (owned[0]) {
    const claimed = await claimSlot(owned[0], true);
    return claimed
      ? { success: true, playerIndex: Number(owned[0].slice(7)) }
      : { success: false, reason: 'Player slot ownership changed' };
  }

  for (let index = 0; index < MAX_PLAYERS; index += 1) {
    const playerKey = `player_${index}`;
    if (players[playerKey]) continue;
    if (await claimSlot(playerKey, false)) return { success: true, playerIndex: index };
  }
  return { success: false, reason: `Room is full (${MAX_PLAYERS})` };
}

export async function rejoinRoom(roomCode, playerIndex, role) {
  const { uid } = await requireUser();
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const snapshot = await firebaseRetry(() => get(roomRef));
  const room = snapshot.val();
  if (!room) return { success: false, reason: 'Room no longer exists' };
  if (room.schemaVersion !== 2) return { success: false, reason: 'Unsupported room version' };

  if (role === 'tv') {
    if (room.meta?.host?.uid !== uid) {
      return { success: false, reason: 'Host session does not own this room' };
    }
    const result = await firebaseRetry(() => runTransaction(roomRef, (current) => {
      if (!current || current.meta?.host?.uid !== uid) return undefined;
      current.meta.host.connected = true;
      current.meta.updatedAt = serverNow();
      return current;
    }, { applyLocally: false }));
    if (!result.committed) return { success: false, reason: 'Host session could not reconnect' };
    const updated = result.snapshot.val();
    return { success: true, status: phaseOf(updated), game: updated.game };
  }

  const playerKey = `player_${playerIndex}`;
  if (!PLAYER_KEY.test(playerKey) || room.players?.[playerKey]?.uid !== uid) {
    return { success: false, reason: 'Player session does not own this slot' };
  }
  // Ownership is verified above, so mark reconnected unconditionally. Returning
  // `undefined` here (the previous `connected == null ? undefined : true`) aborted
  // the transaction on the initial locally-cached null pass after a page refresh,
  // before the server value was ever consulted — which broke rejoin-on-refresh.
  const result = await firebaseRetry(() => runTransaction(
    ref(db, `${ROOM_PATH}/${roomCode}/players/${playerKey}/connected`),
    () => true,
    { applyLocally: false },
  ));
  if (!result.committed) return { success: false, reason: 'Player session could not reconnect' };
  return { success: true, status: phaseOf(room), game: room.game };
}

/** One room listener supplies a coherent snapshot before compatibility callbacks. */
export function listenRoom(roomCode, callbacks = {}) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  let active = true;
  let handler = null;
  authReady.then(() => {
    if (!active) return;
    if (!auth.currentUser?.uid) {
      callbacks.onError?.(failure('Authentication required'));
      return;
    }
    handler = (snap) => {
      if (!snap.exists()) { callbacks.onRoomDeleted?.(); return; }
      const data = snap.val();
      callbacks.onRoomChange?.(data);
      callbacks.onMetaChange?.(data.meta || {}, data);
      callbacks.onPlayersChange?.(data.players || {}, data);
      callbacks.onBetsChange?.(data.bets || {}, data);
      callbacks.onGameChange?.(data.game || {}, data);
      callbacks.onWheelChange?.(data.wheel || {}, data);
      callbacks.onPayoutsChange?.(data.payouts || {}, data);
    };
    onValue(roomRef, handler, (err) => callbacks.onError?.(err));
  }).catch((err) => callbacks.onError?.(err));
  return () => {
    active = false;
    if (handler) off(roomRef, 'value', handler);
  };
}

export async function openBets(roomCode, autoCloseSeconds = 30, expected = {}) {
  const seconds = Number.isFinite(autoCloseSeconds) && autoCloseSeconds > 0 ? autoCloseSeconds : null;
  const room = await hostRoomTransaction(roomCode, (current) => {
    const phase = phaseOf(current);
    if (phase !== 'lobby' && phase !== 'payout') throw failure('Bets cannot open in the current phase');
    if (expected.revision != null && current.game?.revision !== expected.revision) throw failure('Stale host state');
    const now = serverNow();
    const revision = (current.game?.revision || 0) + 1;
    const roundNumber = (current.game?.roundNumber || 0) + 1;
    current.meta.status = 'betting';
    current.meta.updatedAt = now;
    current.game = {
      ...current.game, phase: 'betting', roundNumber, revision,
      lockedBets: {}, winningNumber: null,
      betsCloseAt: seconds ? now + seconds * 1000 : null,
      autoCloseSeconds: seconds,
    };
    current.wheel = { spinning: false, winningNumber: null, spinStartedAt: 0 };
    current.bets = {};
    current.payouts = {};
    return current;
  });
  return room.game;
}

export async function closeBets(roomCode, expectedRound, expectedRevision) {
  const winningNumber = randomWinningNumber();
  const room = await hostRoomTransaction(roomCode, (current) => {
    const phase = phaseOf(current);
    if (phase === 'spinning' && current.game?.roundNumber === expectedRound &&
        current.game?.revision === expectedRevision + 1 &&
        Number.isSafeInteger(current.game?.winningNumber)) {
      return current; // Idempotent retry after a lost response.
    }
    if (phase !== 'betting' || !expectedMatches(current, expectedRound, expectedRevision)) {
      throw failure('Bet close was stale or out of phase');
    }
    const authority = { roundNumber: expectedRound, revision: expectedRevision };
    // Validate and normalize the live book before locking it. Rules enforce
    // each payload; this final host boundary drops aggregate overcommitment.
    const preview = resolveRound(
      current.bets || {}, current.players || {}, winningNumber, authority,
    );
    const now = serverNow();
    current.game.phase = 'spinning';
    current.game.revision = expectedRevision + 1;
    current.game.betsCloseAt = null;
    current.bets = preview.acceptedBets;
    current.game.lockedBets = preview.acceptedBets;
    current.game.winningNumber = winningNumber;
    current.meta.status = 'spinning';
    current.meta.updatedAt = now;
    current.wheel = { spinning: true, winningNumber, spinStartedAt: now };
    return current;
  });
  return {
    winningNumber: room.game.winningNumber,
    roundNumber: room.game.roundNumber,
    revision: room.game.revision,
  };
}

export async function settleRound(roomCode, expectedRound, expectedRevision) {
  const room = await hostRoomTransaction(roomCode, (current) => {
    if (phaseOf(current) === 'payout' && current.game?.settledRound === expectedRound &&
        current.game?.revision === expectedRevision + 1) {
      return current;
    }
    if (phaseOf(current) !== 'spinning' || !expectedMatches(current, expectedRound, expectedRevision)) {
      throw failure('Settlement was stale or out of phase');
    }
    const winningNumber = current.game?.winningNumber;
    if (!Number.isSafeInteger(winningNumber) || winningNumber < 0 || winningNumber > 36) {
      throw failure('Persisted winning number is invalid');
    }
    const bettingAuthority = { roundNumber: expectedRound, revision: expectedRevision - 1 };
    const resolution = resolveRound(
      current.game.lockedBets || {}, current.players || {}, winningNumber, bettingAuthority,
    );
    const settlementRevision = expectedRevision + 1;
    for (const key of Object.keys(resolution.newBalances)) {
      current.players[key].chips = resolution.newBalances[key];
      current.players[key].broke = resolution.newBroke[key];
      resolution.payouts[key].roundNumber = expectedRound;
      resolution.payouts[key].revision = settlementRevision;
    }
    current.payouts = resolution.payouts;
    current.game.phase = 'payout';
    current.game.revision = settlementRevision;
    current.game.settledRound = expectedRound;
    current.game.lastResults = [...(current.game.lastResults || []), winningNumber].slice(-HISTORY_LIMIT);
    current.meta.status = 'payout';
    current.meta.updatedAt = serverNow();
    current.wheel = { ...current.wheel, spinning: false, winningNumber };
    return current;
  });
  return room;
}

function requireSafeHostMaintenancePhase(room, expected = {}) {
  const phase = phaseOf(room);
  if (phase !== 'lobby' && phase !== 'payout') throw failure('Action is not allowed during this phase');
  if (expected.revision != null && room.game?.revision !== expected.revision) throw failure('Stale host state');
}

export async function topUpPlayers(roomCode, expected = {}) {
  return hostRoomTransaction(roomCode, (room) => {
    requireSafeHostMaintenancePhase(room, expected);
    Object.values(room.players || {}).forEach((player) => {
      if (player && (player.broke || player.chips === 0)) {
        player.chips = TOP_UP_AMOUNT;
        player.broke = false;
      }
    });
    room.meta.updatedAt = serverNow();
    return room;
  });
}

export async function resetPlayerBalances(roomCode, expected = {}) {
  return hostRoomTransaction(roomCode, (room) => {
    requireSafeHostMaintenancePhase(room, expected);
    Object.values(room.players || {}).forEach((player) => {
      if (player) { player.chips = STARTING_CHIPS; player.broke = false; }
    });
    room.meta.updatedAt = serverNow();
    return room;
  });
}

export async function setPaused(roomCode, paused, expected = {}) {
  return hostRoomTransaction(roomCode, (room) => {
    if (phaseOf(room) === 'ended') throw failure('Room has ended');
    if (expected.phase && phaseOf(room) !== expected.phase) throw failure('Stale host phase');
    if (expected.revision != null && room.game?.revision !== expected.revision) throw failure('Stale host state');
    room.meta.autoPaused = !!paused;
    room.meta.updatedAt = serverNow();
    return room;
  });
}

export async function removeDisconnectedPlayers(roomCode, expected = {}) {
  let removed = [];
  await hostRoomTransaction(roomCode, (room) => {
    const phase = phaseOf(room);
    if (phase !== 'lobby' && phase !== 'payout') {
      throw failure('Disconnected players cannot be removed during this phase');
    }
    if (expected.revision != null && room.game?.revision !== expected.revision) throw failure('Stale host state');
    removed = Object.keys(room.players || {}).filter((key) => {
      const player = room.players[key];
      return !player || !player.name || player.connected === false;
    });
    for (const key of removed) {
      delete room.players[key];
      if (room.bets) delete room.bets[key];
    }
    room.meta.updatedAt = serverNow();
    return room;
  });
  return { removed: removed.length, players: removed };
}

export async function removePlayer(roomCode, playerIndex, expected = {}) {
  const key = `player_${playerIndex}`;
  if (!PLAYER_KEY.test(key)) throw failure('Invalid player slot');
  return hostRoomTransaction(roomCode, (room) => {
    if (phaseOf(room) !== 'lobby') throw failure('Players can only be removed in the lobby');
    if (expected.revision != null && room.game?.revision !== expected.revision) throw failure('Stale host state');
    delete room.players?.[key];
    delete room.bets?.[key];
    room.meta.updatedAt = serverNow();
    return room;
  });
}

async function playerBetTransaction(roomCode, playerIndex, authority, mutate) {
  const { uid } = await requireUser();
  const playerKey = `player_${playerIndex}`;
  if (!PLAYER_KEY.test(playerKey)) throw failure('Invalid player slot');

  const roomSnapshot = await firebaseRetry(() => get(ref(db, `${ROOM_PATH}/${roomCode}`)));
  const room = roomSnapshot.val();
  if (!room) throw failure('Room no longer exists', 'bet-rejected');
  if (phaseOf(room) !== 'betting' || !expectedMatches(room, authority?.roundNumber, authority?.revision)) {
    throw failure('Betting authority expired', 'bet-rejected');
  }
  const player = room.players?.[playerKey];
  if (player?.uid !== uid) throw failure('Player slot ownership failed', 'bet-rejected');
  if (!Number.isSafeInteger(player.chips) || player.chips < 0) {
    throw failure('Player balance is invalid', 'bet-rejected');
  }

  let reason = 'Bet rejected';
  const result = await firebaseRetry(() => runTransaction(
    ref(db, `${ROOM_PATH}/${roomCode}/bets/${playerKey}`),
    (currentBook) => {
      try { return mutate(currentBook || {}, player.chips); }
      catch (err) { reason = err.message; return undefined; }
    },
    { applyLocally: false },
  ));
  if (!result.committed) throw failure(reason, 'bet-rejected');
  return { playerBets: result.snapshot.val() || {}, game: room.game };
}

export async function replacePlayerBets(roomCode, playerIndex, draftBook, authority) {
  return playerBetTransaction(roomCode, playerIndex, authority, (_book, balance) => {
    if (!draftBook || typeof draftBook !== 'object' || Array.isArray(draftBook)) {
      throw failure('Malformed bet book');
    }
    const normalized = {};
    let total = 0;
    for (const [key, draftBet] of Object.entries(draftBook)) {
      const stored = {
        type: draftBet?.type,
        target: draftBet?.target ?? null,
        chips: draftBet?.chips,
        roundNumber: authority?.roundNumber,
        revision: authority?.revision,
      };
      if (!validateStoredBet(key, stored, authority)) throw failure('Malformed bet book');
      total += stored.chips;
      if (!Number.isSafeInteger(total)) throw failure('Unsafe aggregate bet value');
      normalized[key] = stored;
    }
    if (total > balance) throw failure('Aggregate bets exceed balance');
    return Object.keys(normalized).length ? normalized : null;
  });
}

export async function leaveRoom(roomCode, playerIndex) {
  const { uid } = await requireUser();
  const playerKey = `player_${playerIndex}`;
  if (!PLAYER_KEY.test(playerKey)) throw failure('Invalid player slot');
  const playerRef = ref(db, `${ROOM_PATH}/${roomCode}/players/${playerKey}`);
  const playerSnapshot = await firebaseRetry(() => get(playerRef));
  if (!playerSnapshot.exists()) return;
  if (playerSnapshot.val()?.uid !== uid) throw failure('Player slot ownership failed');

  try {
    const betRef = ref(db, `${ROOM_PATH}/${roomCode}/bets/${playerKey}`);
    const betSnapshot = await firebaseRetry(() => get(betRef));
    if (betSnapshot.exists()) {
      const betResult = await firebaseRetry(() => runTransaction(
        betRef, () => null, { applyLocally: false },
      ));
      if (!betResult.committed) throw failure('Bet cleanup was not committed');
    }

    const result = await firebaseRetry(() => runTransaction(
      playerRef,
      (player) => player?.uid === uid ? null : undefined,
      { applyLocally: false },
    ));
    if (!result.committed) throw failure('Player slot ownership failed');
  } catch (error) {
    try {
      await runTransaction(
        ref(db, `${ROOM_PATH}/${roomCode}/players/${playerKey}/connected`),
        (connected) => connected == null ? undefined : false,
        { applyLocally: false },
      );
    } catch (_) {}
    throw error;
  }
}

export async function deleteRoom(roomCode) {
  const { uid } = await requireUser();
  let reason = 'Room no longer exists';
  const result = await firebaseRetry(() => runTransaction(
    ref(db, `${ROOM_PATH}/${roomCode}`),
    (room) => {
      if (!room) return null;
      if (!assertHost(room, uid)) { reason = 'Host authority required'; return undefined; }
      return null;
    },
    { applyLocally: false },
  ));
  if (!result.committed) throw failure(reason);
}

export async function endGame(roomCode, expected = {}) {
  return hostRoomTransaction(roomCode, (room) => {
    if (expected.revision != null && room.game?.revision !== expected.revision) throw failure('Stale host state');
    room.meta.status = 'ended';
    room.meta.updatedAt = serverNow();
    room.game.phase = 'ended';
    room.game.revision = (room.game.revision || 0) + 1;
    room.game.betsCloseAt = null;
    return room;
  });
}

function setupDisconnect(path, ownershipCheck, label) {
  let registration = null;
  const registered = (async () => {
    const { uid } = await requireUser();
    const snapshot = await get(ref(db, path.replace(/\/connected$/, '')));
    if (!ownershipCheck(snapshot.val(), uid)) throw failure(`${label} ownership failed`);
    registration = onDisconnect(ref(db, path));
    await registration.set(false);
  })();
  registered.catch((err) => console.warn(`${label} onDisconnect failed:`, err.message));
  return async () => {
    try { await registered; } catch (_) { return; }
    if (registration) {
      try { await registration.cancel(); } catch (_) {}
    }
  };
}

export function setupTvDisconnectHandler(roomCode) {
  return setupDisconnect(
    `${ROOM_PATH}/${roomCode}/meta/host/connected`,
    (host, uid) => host?.uid === uid,
    'TV',
  );
}

export function setupPlayerDisconnectHandler(roomCode, playerIndex) {
  const playerPath = `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}`;
  const connectedRef = ref(db, `${playerPath}/connected`);
  const infoRef = ref(db, '.info/connected');
  let registration = null;
  let disposed = false;
  // Re-arm the offline write and self-heal `connected=true` every time the
  // socket (re)connects, so a brief drop that fired onDisconnect is undone.
  const handler = async (snapshot) => {
    if (!snapshot.val() || disposed) return;
    try {
      const { uid } = await requireUser();
      const owner = await get(ref(db, playerPath));
      if (owner.val()?.uid !== uid) return;
      registration = onDisconnect(connectedRef);
      await registration.set(false);
      if (!disposed) await set(connectedRef, true);
    } catch (err) {
      if (!disposed) console.warn('Player onDisconnect failed:', err.message);
    }
  };
  onValue(infoRef, handler);
  return async () => {
    disposed = true;
    off(infoRef, 'value', handler);
    if (registration) {
      try { await registration.cancel(); } catch (_) {}
    }
  };
}
