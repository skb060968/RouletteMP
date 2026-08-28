/**
 * Roulette MP — TV controller
 *
 * TV-host flow: home → tv-create → tv-lobby → tv-game (betting/spinning/payout)
 *
 * The TV is the authoritative writer for game state, wheel results, and
 * chip balances. Phones only write their own bets.
 */

import {
  createRoomAsTv, listenRoom, setupTvDisconnectHandler,
  openBets as fbOpenBets, closeBets as fbCloseBets, settleRound,
  topUpPlayers, resetPlayerBalances,
  deleteRoom as fbDeleteRoom, rejoinRoom, setPaused, removeDisconnectedPlayers,
  removePlayer, serverNow,
  MAX_PLAYERS,
} from './firebase-sync.js';
import { WHEEL_SEQUENCE, colorOf } from './wheel.js';
import { initAudio, playSound, isMuted, toggleMute, startBackgroundMusic, stopBackgroundMusic, setBackgroundMusicVolume } from './sound-manager.js';
import { showScreen, showToast, confirmModal, dismissConfirmModals } from './platform-ui.js';
import { createShareHandler, showQRCode, closeActiveQRCode } from './deep-link-handler.js';

const SESSION_KEY = 'roulette_mp_session';

let roomCode = null;
let unsubscribe = null;
let cancelTvDisconnect = null;
let firebaseSnapshot = {};
let _autoCloseTimer = null;
let _countdownTimer = null;
let _countdownDeadline = null;
let _spinInFlight = false;
let _createInFlight = false;
const _delayedTimers = new Map();

/* Lobby presence: a dropped player lingers briefly with the OFFLINE treatment,
   then is pruned from the TV list. The counter and Start count only connected. */
const LOBBY_PRUNE_DELAY_MS = 2500;
let lobbyDisconnectedSince = {};
let lobbyPruneTimer = null;

function delayed(ms, callback) {
  const id = setTimeout(() => {
    _delayedTimers.delete(id);
    callback();
  }, ms);
  _delayedTimers.set(id, null);
  return id;
}

function delayPromise(ms) {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      _delayedTimers.delete(id);
      resolve(true);
    }, ms);
    _delayedTimers.set(id, resolve);
  });
}

function cancelDelayedTimers() {
  _delayedTimers.forEach((resolve, id) => {
    clearTimeout(id);
    if (resolve) resolve(false);
  });
  _delayedTimers.clear();
}

/* ======= CANVAS WHEEL STATE ======= */
// Physics state for the canvas-based wheel + ball renderer
const _wheel = {
  angle: 0,
  angVel: 0,
  spinning: false,
};
const _ball = {
  angle: 0,
  angVel: 0,
  dropped: false,
  settling: false,
  settleT: 0,
  settleStart: 0,
  visible: false,
};
let _rafId = null;           // requestAnimationFrame handle for wheel loop
let _offscreenCanvas = null; // pre-rendered static wheel face
let _canvasSize = 0;         // last rendered canvas size

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ role: 'tv', roomCode })); } catch (_) {}
  }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

/* ======= ENTRY ======= */
export async function startTvFlow() {
  document.body.dataset.mode = 'tv';
  initAudio();
  buildWheel();
  showScreen('tv-create');
  wireTvCreate();
  wireTvLobby();
  wireTvGame();
}

export async function resumeTvSession(savedRoomCode) {
  document.body.dataset.mode = 'tv';
  initAudio();
  buildWheel();
  roomCode = savedRoomCode;
  const result = await rejoinRoom(savedRoomCode, null, 'tv');
  if (!result.success) { clearSession(); showScreen('home'); return; }
  cancelTvDisconnect = setupTvDisconnectHandler(roomCode);
  attachRoomListener();
  if (result.status === 'lobby') {
    showScreen('tv-lobby');
    setupLobbyUi();
  } else {
    showScreen('tv-game');
    setupGameUi();
    startBackgroundMusic(0.4); // Start at 40% volume when resuming into game screen
  }
  wireTvCreate();
  wireTvLobby();
  wireTvGame();
}

/* ======= TV CREATE ======= */
function wireTvCreate() {
  const screen = document.getElementById('tv-create');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const submit = document.getElementById('btn-tv-create-submit');
  const back = document.getElementById('btn-tv-create-back');
  if (submit) submit.addEventListener('click', async () => {
    if (_createInFlight) return;
    _createInFlight = true;
    submit.disabled = true;
    if (back) back.disabled = true;
    try {
      const result = await createRoomAsTv('TV', '🎰');
      roomCode = result.roomCode;
      saveSession();
      cancelTvDisconnect = setupTvDisconnectHandler(roomCode);
      attachRoomListener();
      setupLobbyUi();
      showScreen('tv-lobby');
    } catch (err) {
      console.error(err);
      showToast('Failed to create room.');
    } finally {
      _createInFlight = false;
      submit.disabled = false;
      if (back) back.disabled = false;
    }
  });
  if (back) back.addEventListener('click', cleanupAndGoHome);
}

/* ======= ROOM LISTENER ======= */
function attachRoomListener() {
  if (unsubscribe) unsubscribe();
  unsubscribe = listenRoom(roomCode, {
    onRoomChange: (room) => {
      firebaseSnapshot = room;
    },
    onMetaChange: (meta) => {
      firebaseSnapshot.meta = meta;
      if (meta.status === 'lobby') {
        renderLobbyUi();
      }
      // Sync pause button UI when meta changes
      syncPauseUi(meta.autoPaused || false);
    },
    onPlayersChange: (players) => {
      firebaseSnapshot.players = players;
      renderLobbyUi();
      if (firebaseSnapshot.meta?.status !== 'lobby') {
        renderPlayerStrip();
      }
    },
    onBetsChange: (bets) => {
      firebaseSnapshot.bets = bets;
      renderTotalBets();
    },
    onGameChange: (game) => {
      firebaseSnapshot.game = game;
      if (game.phase === 'betting' && game.betsCloseAt) {
        startCountdown(game.betsCloseAt);
      } else {
        stopCountdown();
      }
      if (game.phase === 'spinning' && Number.isSafeInteger(game.winningNumber) && !_spinInFlight) {
        _spinInFlight = true;
        showScreen('tv-game');
        setupGameUi();
        startPhysicsSpin({
          winningNumber: game.winningNumber,
          roundNumber: game.roundNumber,
          revision: game.revision,
        });
      }
    },
    onWheelChange: (wheel) => {
      firebaseSnapshot.wheel = wheel;
    },
    onPayoutsChange: (payouts) => {
      firebaseSnapshot.payouts = payouts;
    },
    onRoomDeleted: () => {
      cleanupAndGoHome();
    },
  });
}

/* ======= LOBBY ======= */
function setupLobbyUi() {
  stopBackgroundMusic(); // Stop music when returning to lobby
  const codeEl = document.getElementById('tv-lobby-code');
  if (codeEl) codeEl.textContent = roomCode;
  
  // Set up delegated event listener for remove buttons (only once)
  const playerList = document.getElementById('tv-lobby-players');
  if (playerList && !playerList.dataset.removeListenerAdded) {
    playerList.dataset.removeListenerAdded = 'true';
    playerList.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('.remove-player-btn');
      if (!removeBtn || removeBtn.disabled) return;
      
      const targetIndex = parseInt(removeBtn.dataset.playerIndex, 10);
      const playerName = removeBtn.dataset.playerName;
      
      if (isNaN(targetIndex) || !roomCode) return;
      
      removeBtn.disabled = true;
      try {
        await removePlayer(roomCode, targetIndex, { revision: firebaseSnapshot.game?.revision });
        showToast(`${playerName} removed from room`);
      } catch (err) {
        console.error('Failed to remove player:', err);
        showToast('Failed to remove player');
        removeBtn.disabled = false;
      }
    });
  }
  
  renderLobbyUi();
}

/** All named players, in slot order (ghost slots without a name excluded). */
function lobbyPlayerKeys() {
  const players = firebaseSnapshot.players || {};
  return Object.keys(players).filter((k) => players[k] && players[k].name).sort();
}

/** Named players still connected — the roster the counter and Start button use. */
function connectedLobbyKeys() {
  const players = firebaseSnapshot.players || {};
  return lobbyPlayerKeys().filter((k) => players[k]?.connected !== false);
}

/** Track when each player first went offline so a dropped row can linger with
    the OFFLINE treatment and then be pruned. */
function trackLobbyDisconnections() {
  const players = firebaseSnapshot.players || {};
  const stamp = Date.now();
  const next = {};
  let pruneNeeded = false;
  lobbyPlayerKeys().forEach((k) => {
    if (players[k]?.connected === false) {
      next[k] = lobbyDisconnectedSince[k] || stamp;
      if (stamp - next[k] < LOBBY_PRUNE_DELAY_MS) pruneNeeded = true;
    }
  });
  lobbyDisconnectedSince = next;
  if (!pruneNeeded || lobbyPruneTimer !== null) return;
  lobbyPruneTimer = setTimeout(() => {
    lobbyPruneTimer = null;
    renderLobbyUi();
  }, LOBBY_PRUNE_DELAY_MS);
}

/** Whether a player row still belongs in the lobby list. */
function isLobbyKeyVisible(k) {
  const players = firebaseSnapshot.players || {};
  if (players[k]?.connected !== false) return true;
  const since = lobbyDisconnectedSince[k];
  return typeof since === 'number' && Date.now() - since < LOBBY_PRUNE_DELAY_MS;
}

function renderLobbyUi() {
  const list = document.getElementById('tv-lobby-players');
  if (!list) return;
  const players = firebaseSnapshot.players || {};
  trackLobbyDisconnections();
  // Skip ghost slots (no name) and prune players offline past the linger window.
  const keys = lobbyPlayerKeys().filter(isLobbyKeyVisible);
  list.innerHTML = '';
  if (keys.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'tv-empty';
    empty.textContent = 'Waiting for players to join…';
    list.appendChild(empty);
  } else {
    keys.forEach((k) => {
      const p = players[k] || {};
      const li = document.createElement('li');
      li.className = 'tv-lobby-player';
      
      const emojiSpan = document.createElement('span');
      emojiSpan.className = 'emoji';
      emojiSpan.textContent = p.emoji || '😀';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.textContent = p.name || 'Player';
      
      const chipsSpan = document.createElement('span');
      chipsSpan.className = 'chips';
      chipsSpan.textContent = `💰 ${p.chips ?? 0}`;
      
      li.appendChild(emojiSpan);
      li.appendChild(nameSpan);
      li.appendChild(chipsSpan);
      
      // Add remove button for TV host
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-player-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove player';
      // Store player info in data attributes for event delegation
      const playerIndex = parseInt(k.replace('player_', ''), 10);
      removeBtn.dataset.playerIndex = playerIndex;
      removeBtn.dataset.playerName = p.name;
      li.appendChild(removeBtn);
      
      if (!p.connected) li.classList.add('disconnected');
      list.appendChild(li);
    });
  }
  const connectedKeys = connectedLobbyKeys();
  const startBtn = document.getElementById('btn-tv-start-round');
  // Need at least one CONNECTED player who has chips.
  const hasReady = connectedKeys.some((k) => (players[k]?.chips ?? 0) > 0);
  if (startBtn) startBtn.disabled = !hasReady;
  const countEl = document.getElementById('tv-lobby-count');
  if (countEl) countEl.textContent = `${connectedKeys.length} / ${MAX_PLAYERS}`;
}

function wireTvLobby() {
  const screen = document.getElementById('tv-lobby');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const startBtn = document.getElementById('btn-tv-start-round');
  if (startBtn) startBtn.addEventListener('click', startRound);

  const shareBtn = document.getElementById('btn-tv-share-code');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => createShareHandler(roomCode, 'Roulette MP')());
  }
  
  const qrBtn = document.getElementById('btn-tv-qr-code');
  if (qrBtn) {
    qrBtn.addEventListener('click', () => {
      if (roomCode) showQRCode(roomCode, 'Roulette MP');
    });
  }

  const closeBtn = document.getElementById('btn-tv-lobby-close');
  if (closeBtn) closeBtn.addEventListener('click', async () => {
    const ok = await confirmModal('Close room?', 'All players will be disconnected.', 'Close', 'Cancel');
    if (!ok) return;
    if (roomCode) { try { await cancelTvDisconnect?.(); await fbDeleteRoom(roomCode); } catch (_) {} }
    cancelTvDisconnect = null;
    cleanupAndGoHome();
  });

  const muteBtn = document.getElementById('btn-tv-mute');
  if (muteBtn) {
    syncMuteUi();
    muteBtn.addEventListener('click', () => { toggleMute(); syncMuteUi(); });
  }
}

function syncMuteUi() {
  ['btn-tv-mute', 'btn-tv-game-mute'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.textContent = isMuted() ? '🔇' : '🔊';
  });
}

function syncPauseUi(paused) {
  const btn = document.getElementById('btn-tv-pause-auto');
  if (btn) {
    if (paused) {
      btn.textContent = '▶ Resume Auto';
      btn.classList.add('paused');
    } else {
      btn.textContent = '⏸ Pause Auto';
      btn.classList.remove('paused');
    }
  }
}

/* ======= START ROUND (open bets) ======= */
async function startRound() {
  if (!roomCode || _spinInFlight) return;
  const phase = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
  if (phase !== 'lobby' && phase !== 'payout') return;
  const players = firebaseSnapshot.players || {};
  const hasAny = Object.values(players).some((p) => p?.connected !== false && Number.isSafeInteger(p?.chips) && p.chips > 0);
  if (!hasAny) {
    showToast('No players have chips. Top Up first.');
    return;
  }
  try {
    const game = await fbOpenBets(roomCode, 30, { revision: firebaseSnapshot.game?.revision });
    showScreen('tv-game');
    setupGameUi();
    startBackgroundMusic(0.4);
    if (game.betsCloseAt) startCountdown(game.betsCloseAt);
  } catch (err) {
    console.warn('Open bets rejected:', err.message);
    showToast('Round state changed. Try again.');
  }
}

function setupGameUi() {
  renderPlayerStrip();
  renderTotalBets();
  // Sync pause button UI
  syncPauseUi(firebaseSnapshot.meta?.autoPaused || false);
  // Reset wheel + ball to idle state
  _wheel.angle   = 0;
  _wheel.angVel  = 0;
  _wheel.spinning = false;
  _ball.visible   = false;
  _ball.dropped   = false;
  _ball.settling  = false;
  _ball.angle     = 0;
  _ball.angVel    = 0;
  _ball._spinT    = 0;
  // Hide winning-number tag and rien flash
  const tag = document.getElementById('tv-winning-tag');
  if (tag) { tag.classList.remove('show'); tag.innerHTML = ''; }
  const rien = document.getElementById('tv-rien');
  if (rien) rien.classList.remove('show');
  // Ensure render loop is running so the idle wheel is visible
  startWheelRenderLoop();
}

function wireTvGame() {
  const screen = document.getElementById('tv-game');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const openBtn = document.getElementById('btn-tv-open-bets');
  if (openBtn) openBtn.addEventListener('click', startRound);

  const spinBtn = document.getElementById('btn-tv-spin');
  if (spinBtn) spinBtn.addEventListener('click', () => triggerSpin());

  const topUpBtn = document.getElementById('btn-tv-topup');
  if (topUpBtn) topUpBtn.addEventListener('click', async () => {
    const phase = firebaseSnapshot.game?.phase;
    if (phase !== 'lobby' && phase !== 'payout') { showToast('Top up after the round settles.'); return; }
    const players = firebaseSnapshot.players || {};
    const broke = Object.entries(players).filter(([, p]) => p.broke || (p.chips ?? 0) === 0);
    if (broke.length === 0) { showToast('No broke players.'); return; }
    const ok = await confirmModal('Top up broke players?', `Give 500 chips to ${broke.length} broke player${broke.length === 1 ? '' : 's'}.`, 'Top Up', 'Cancel');
    if (!ok) return;
    try {
      await topUpPlayers(roomCode, { revision: firebaseSnapshot.game?.revision });
      showToast('Topped up!');
    } catch (err) { showToast('Top up rejected because room state changed.'); }
  });

  const resetBtn = document.getElementById('btn-tv-reset');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    const phase = firebaseSnapshot.game?.phase;
    if (phase !== 'lobby' && phase !== 'payout') { showToast('Reset after the round settles.'); return; }
    const ok = await confirmModal('Reset all chips?', 'Every player will go back to 1000 chips.', 'Reset', 'Cancel');
    if (!ok) return;
    try {
      await resetPlayerBalances(roomCode, { revision: firebaseSnapshot.game?.revision });
      showToast('All chips reset.');
    } catch (err) { showToast('Reset rejected because room state changed.'); }
  });

  const endBtn = document.getElementById('btn-tv-end');
  if (endBtn) endBtn.addEventListener('click', async () => {
    const ok = await confirmModal('End game?', 'Close room and return to home.', 'End', 'Cancel');
    if (!ok) return;
    if (roomCode) { try { await cancelTvDisconnect?.(); await fbDeleteRoom(roomCode); } catch (_) {} }
    cancelTvDisconnect = null;
    cleanupAndGoHome();
  });

  const muteBtn = document.getElementById('btn-tv-game-mute');
  if (muteBtn) {
    syncMuteUi();
    muteBtn.addEventListener('click', () => { toggleMute(); syncMuteUi(); });
  }

  const pauseBtn = document.getElementById('btn-tv-pause-auto');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', async () => {
      const currentlyPaused = firebaseSnapshot.meta?.autoPaused || false;
      const newPaused = !currentlyPaused;
      try {
        await setPaused(roomCode, newPaused, {
          phase: firebaseSnapshot.game?.phase,
          revision: firebaseSnapshot.game?.revision,
        });
        syncPauseUi(newPaused);
        showToast(newPaused ? 'Auto-start paused' : 'Auto-start resumed', 2000);
      } catch (err) {
        showToast('Pause change rejected because room state changed.');
      }
    });
  }

  const removeDisconnectedBtn = document.getElementById('btn-tv-remove-disconnected');
  if (removeDisconnectedBtn) {
    removeDisconnectedBtn.addEventListener('click', async () => {
      const phase = firebaseSnapshot.game?.phase;
      if (phase !== 'lobby' && phase !== 'payout') {
        showToast('Remove players after the round settles.');
        return;
      }
      const players = firebaseSnapshot.players || {};
      const disconnected = Object.keys(players).filter((k) => {
        const p = players[k];
        return !p || !p.name || p.connected === false;
      });
      
      if (disconnected.length === 0) {
        showToast('No disconnected players');
        return;
      }
      
      const playerNames = disconnected.map((k) => {
        const p = players[k];
        return p?.name || 'Unknown';
      }).join(', ');
      
      const ok = await confirmModal(
        'Remove disconnected players?',
        `Remove ${disconnected.length} player${disconnected.length === 1 ? '' : 's'}: ${playerNames}`,
        'Remove',
        'Cancel'
      );
      
      if (!ok) return;
      
      try {
        const result = await removeDisconnectedPlayers(roomCode, { revision: firebaseSnapshot.game?.revision });
        showToast(`Removed ${result.removed} player${result.removed === 1 ? '' : 's'}`, 2000);
      } catch (err) {
        showToast('Removal rejected because room state changed.');
      }
    });
  }
}

/* ======= COUNTDOWN ======= */
function startCountdown(deadline) {
  if (!Number.isFinite(deadline)) return;
  if (_countdownDeadline === deadline && _countdownTimer) return;
  stopCountdown();
  _countdownDeadline = deadline;
  const tick = () => {
    const remaining = Math.max(0, deadline - serverNow());
    const sec = Math.ceil(remaining / 1000);
    const tag = document.getElementById('tv-winning-tag');
    if (tag) {
      tag.innerHTML = `<span class="bets-open">BETS OPEN · ${sec}s</span>`;
      tag.classList.add('show');
    }
    if (remaining <= 0) {
      stopCountdown();
      void triggerSpin();
    }
  };
  tick();
  _countdownTimer = setInterval(tick, 250);
  _autoCloseTimer = setTimeout(() => {
    stopCountdown();
    void triggerSpin();
  }, Math.max(0, deadline - serverNow()) + 50);
}

function stopCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
  if (_autoCloseTimer) { clearTimeout(_autoCloseTimer); _autoCloseTimer = null; }
  _countdownDeadline = null;
}

/* ======= SPIN ======= */
async function triggerSpin() {
  if (!roomCode || _spinInFlight) return;
  const game = firebaseSnapshot.game || {};
  if ((game.phase || firebaseSnapshot.meta?.status) !== 'betting') return;

  _spinInFlight = true;
  stopCountdown();
  let spin;
  try {
    spin = await fbCloseBets(roomCode, game.roundNumber, game.revision);
  } catch (err) {
    _spinInFlight = false;
    console.warn('Close bets rejected:', err.message);
    showToast('Spin rejected because the round changed.');
    return;
  }

  const rien = document.getElementById('tv-rien');
  if (rien) {
    rien.classList.remove('show');
    void rien.offsetWidth;
    rien.classList.add('show');
  }
  playSound('betClose', 1.0);

  delayed(1000, () => {
    if (!_spinInFlight || roomCode == null) return;
    const tag = document.getElementById('tv-winning-tag');
    if (tag) {
      tag.innerHTML = `<span class="spinning">SPINNING…</span>`;
      tag.classList.add('show');
    }
    setBackgroundMusicVolume(0.15);
    playSound('spin', 1.0);
    startPhysicsSpin(spin);
  });
}

/**
 * Compute the target wheel angle (radians, clockwise) so that the
 * winning segment's centre lands exactly under the ball.
 *
 * Canvas rotation model:
 *   g.rotate(W) shifts all drawn content by +W in screen angle.
 *   Segment i centre in face = (i+0.5)*segRad - π/2.
 *   Segment i centre on screen after wheel rotates W = (i+0.5)*segRad - π/2 + W.
 *
 * Ball screen angle = -ballFinalAngle - π/2  (ball.angle increases → moves CW).
 *
 * Winning condition:  segCenter - π/2 + W  =  -ballFinalAngle - π/2
 *   → W = -segCenter - ballFinalAngle  (mod 2π, positive)
 */
function targetAngleForWinning(winningNumber, extraSpins, ballFinalAngle) {
  const idx = WHEEL_SEQUENCE.indexOf(winningNumber);
  if (idx < 0) return extraSpins * Math.PI * 2;
  const segRad    = (Math.PI * 2) / WHEEL_SEQUENCE.length;
  const segCenter = (idx + 0.5) * segRad;
  const target    = ((-segCenter - ballFinalAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  return extraSpins * Math.PI * 2 + target;
}

/**
 * Launch a time-based eased spin.
 * Uses a power ease-out curve (progress = 1 - (1-t)^p) which guarantees
 * EXACT final position with zero drift or snap lunge — the ball arrives
 * smoothly at ballFinalAngle without any hard jump.
 */
function startPhysicsSpin(spin) {
  const { winningNumber } = spin;
  const SPIN_DURATION = 5.0;

  const ballFinalAngle = (Math.PI * 0.15) + Math.random() * (Math.PI * 1.7);
  const finalWheelAngle = targetAngleForWinning(winningNumber, 5, ballFinalAngle);
  const ballTotalAngle = 7 * Math.PI * 2 + ballFinalAngle;
  const POWER = 4;

  // Reset state
  _wheel.angle   = 0;
  _wheel.spinning = true;
  _ball.angle    = 0;
  _ball.dropped  = false;
  _ball.settling = false;
  _ball.visible  = true;

  // Store spin params for drawWheelFrame to use for continuous inward drift
  _ball._spinT = 0; // current normalised time 0→1 (written each frame)

  const startTime = performance.now();
  let settled = false;

  function frame(now) {
    const elapsed = (now - startTime) / 1000;
    const t = Math.min(elapsed / SPIN_DURATION, 1.0);
    const progress = 1 - Math.pow(1 - t, POWER);

    _ball._spinT = t; // expose to drawWheelFrame for radius calculation
    _wheel.angle = finalWheelAngle * progress;
    _ball.angle  = ballTotalAngle  * progress;

    if (t >= 1.0 && !settled) {
      settled = true;
      _wheel.angle   = finalWheelAngle % (Math.PI * 2);
      _wheel.angVel  = 0;
      _wheel.spinning = false;
      _ball.angle    = ballFinalAngle;
      _ball._spinT   = 1.0;
      _ball.dropped  = true; // lock at pocketOrbitR
      drawWheelFrame();
      onSpinSettled(spin);
      return;
    }

    drawWheelFrame();
    _rafId = requestAnimationFrame(frame);
  }

  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = requestAnimationFrame(frame);
}

async function onSpinSettled(spin) {
  if (!await delayPromise(500) || !_spinInFlight || !roomCode) return;
  setBackgroundMusicVolume(0.4);

  let settled;
  try {
    settled = await settleRound(roomCode, spin.roundNumber, spin.revision);
  } catch (err) {
    _spinInFlight = false;
    console.error('Settlement rejected:', err);
    showToast('Round settlement was rejected.');
    return;
  }
  _spinInFlight = false;
  const winningNumber = settled.game.winningNumber;
  const payouts = settled.payouts || {};

  const color = colorOf(winningNumber);
  const tag = document.getElementById('tv-winning-tag');
  if (tag) {
    tag.innerHTML = `
      <span class="winning ${color}">
        <span class="num">${winningNumber}</span>
        <span class="label">${color.toUpperCase()}</span>
      </span>`;
    tag.classList.add('show', 'reveal');
  }

  const sorted = Object.entries(payouts).sort((a, b) => (b[1].netDelta || 0) - (a[1].netDelta || 0));
  const top = sorted[0];
  if (top && top[1].netDelta > 0) {
    const player = settled.players?.[top[0]];
    showToast(`🏆 ${player?.name || 'Player'} won ${top[1].netDelta} chips!`, 3000);
  }

  const settlementRevision = settled.game.revision;
  delayed(3500, () => {
    const game = firebaseSnapshot.game || {};
    if (game.phase !== 'payout' || game.revision !== settlementRevision) return;
    const banner = document.getElementById('tv-winning-tag');
    if (banner) banner.classList.remove('reveal');
    if (!firebaseSnapshot.meta?.autoPaused) {
      void startRound();
    } else if (banner) {
      banner.innerHTML = `<span class="paused-msg">⏸ Auto-Start Paused</span>`;
      banner.classList.add('show');
    }
  });
}

/* ======= CANVAS WHEEL RENDERER ======= */

/**
 * Pre-render the static wheel face matching the reference image.
 *
 * Structure from outside to inside:
 *   1. Wide mahogany outer bowl (fills ~35% of radius from edge)
 *   2. Thin gold rim ring
 *   3. Thin dark ball track groove
 *   4. Number band — labeled red/black/green pockets
 *   5. Thin gold separator ring
 *   6. Mahogany inner bowl (same colour as outer)
 *      - 4 thin diagonal X-lines
 *      - 4 gold diamond markers at cardinal points
 *   7. 4 diagonal × spoke arms from hub
 *   8. Gold hub disc + knob
 */
function buildOffscreenWheel(size) {
  if (_offscreenCanvas && _canvasSize === size) return _offscreenCanvas;
  _canvasSize = size;

  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const g = oc.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const R  = size / 2;

  // ── Radii ────────────────────────────────────────────────────────────────
  const rGoldOuter  = R * 0.82;   // outer edge of gold rim
  const rGoldInner  = R * 0.78;   // inner edge of gold rim / outer edge of track
  const rTrackInner = R * 0.755;  // inner edge of track / outer edge of number band
  const rNumOuter   = R * 0.755;  // number band outer
  const rNumInner   = R * 0.620;  // number band inner
  const rPlainOuter = R * 0.610;  // plain pocket ring outer
  const rPlainInner = R * 0.500;  // plain pocket ring inner
  const rSepOuter   = R * 0.500;  // gold separator outer
  const rSepInner   = R * 0.482;  // gold separator inner / inner bowl outer

  const segRad = (Math.PI * 2) / WHEEL_SEQUENCE.length;

  // ── 1. Full mahogany base ────────────────────────────────────────────────
  const mahoGrad = g.createRadialGradient(cx - R*0.15, cy - R*0.18, R*0.05, cx, cy, R);
  mahoGrad.addColorStop(0,   '#a0321a');
  mahoGrad.addColorStop(0.3, '#841e0a');
  mahoGrad.addColorStop(0.65,'#5e1005');
  mahoGrad.addColorStop(1,   '#3a0800');
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = mahoGrad; g.fill();

  // Golden ring at outer periphery
  g.beginPath(); g.arc(cx, cy, R - R*0.008, 0, Math.PI * 2);
  g.strokeStyle = '#ffd700';
  g.lineWidth = R * 0.016;
  g.stroke();

  // ── 2. Gold rim ──────────────────────────────────────────────────────────
  const rimGrad = g.createRadialGradient(cx, cy, rGoldInner, cx, cy, rGoldOuter);
  rimGrad.addColorStop(0,   '#a07000');
  rimGrad.addColorStop(0.25,'#ffd700');
  rimGrad.addColorStop(0.55,'#ffe566');
  rimGrad.addColorStop(0.8, '#ffd700');
  rimGrad.addColorStop(1,   '#8a5e00');
  g.beginPath(); g.arc(cx, cy, rGoldOuter, 0, Math.PI * 2);
  g.fillStyle = rimGrad; g.fill();

  // ── 3. Ball track groove ─────────────────────────────────────────────────
  g.beginPath(); g.arc(cx, cy, rGoldInner, 0, Math.PI * 2);
  g.fillStyle = '#080400'; g.fill();

  // Subtle centre-line highlight in the groove
  g.beginPath();
  g.arc(cx, cy, (rGoldInner + rTrackInner) / 2, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,210,80,0.15)';
  g.lineWidth = R * 0.008;
  g.stroke();

  // ── 4. Number band ────────────────────────────────────────────────────────
  g.beginPath(); g.arc(cx, cy, rNumOuter, 0, Math.PI * 2);
  g.fillStyle = '#080808'; g.fill();

  WHEEL_SEQUENCE.forEach((n, i) => {
    const startA = i * segRad - Math.PI / 2;
    const endA   = startA + segRad;
    const midA   = startA + segRad / 2;

    g.beginPath();
    g.arc(cx, cy, rNumOuter - R*0.002, startA + 0.008, endA - 0.008);
    g.arc(cx, cy, rNumInner + R*0.002, endA - 0.008, startA + 0.008, true);
    g.closePath();

    const c = colorOf(n);
    if (c === 'green') {
      const gg = g.createLinearGradient(
        cx + rNumInner * Math.cos(midA), cy + rNumInner * Math.sin(midA),
        cx + rNumOuter * Math.cos(midA), cy + rNumOuter * Math.sin(midA));
      gg.addColorStop(0, '#0d4020'); gg.addColorStop(0.5, '#1e8040'); gg.addColorStop(1, '#0d4020');
      g.fillStyle = gg;
    } else if (c === 'red') {
      const rg = g.createLinearGradient(
        cx + rNumInner * Math.cos(midA), cy + rNumInner * Math.sin(midA),
        cx + rNumOuter * Math.cos(midA), cy + rNumOuter * Math.sin(midA));
      rg.addColorStop(0, '#680000'); rg.addColorStop(0.5, '#cc1515'); rg.addColorStop(1, '#680000');
      g.fillStyle = rg;
    } else {
      g.fillStyle = '#090909';
    }
    g.fill();

    // Gold dividers
    g.beginPath();
    g.moveTo(cx + rNumInner * Math.cos(startA), cy + rNumInner * Math.sin(startA));
    g.lineTo(cx + rNumOuter * Math.cos(startA), cy + rNumOuter * Math.sin(startA));
    g.strokeStyle = '#c8960c';
    g.lineWidth = R * 0.004;
    g.stroke();
  });

  // Number labels — radially upright
  const labelR = (rNumOuter + rNumInner) / 2;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  WHEEL_SEQUENCE.forEach((n, i) => {
    const midA = i * segRad - Math.PI / 2 + segRad / 2;
    const lx = cx + labelR * Math.cos(midA);
    const ly = cy + labelR * Math.sin(midA);
    g.save();
    g.translate(lx, ly);
    g.rotate(midA + Math.PI / 2);
    g.font = `900 ${Math.round(R * 0.060)}px Arial, sans-serif`;
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 2;
    g.fillStyle = '#ffffff';
    g.fillText(String(n), 0, 0);
    g.shadowBlur = 0;
    g.restore();
  });

  // Gold ring between number band and plain pocket ring
  g.beginPath(); g.arc(cx, cy, rNumInner, 0, Math.PI * 2);
  const numSepGrad = g.createRadialGradient(cx, cy, rNumInner - R*0.01, cx, cy, rNumInner + R*0.003);
  numSepGrad.addColorStop(0, '#a07000'); numSepGrad.addColorStop(0.5, '#ffd700'); numSepGrad.addColorStop(1, '#a07000');
  g.strokeStyle = numSepGrad;
  g.lineWidth = R * 0.018;
  g.stroke();

  // ── 4b. Plain pocket ring (ball settles here — no numbers) ──────────────
  g.beginPath(); g.arc(cx, cy, rPlainOuter, 0, Math.PI * 2);
  g.fillStyle = '#0a0a0a'; g.fill();

  WHEEL_SEQUENCE.forEach((n, i) => {
    const startA = i * segRad - Math.PI / 2;
    const endA   = startA + segRad;
    const midA   = startA + segRad / 2;
    g.beginPath();
    g.arc(cx, cy, rPlainOuter - R*0.002, startA + 0.008, endA - 0.008);
    g.arc(cx, cy, rPlainInner + R*0.002, endA - 0.008, startA + 0.008, true);
    g.closePath();
    const c = colorOf(n);
    if (c === 'green') {
      g.fillStyle = '#155222';
    } else if (c === 'red') {
      const rg = g.createLinearGradient(
        cx + rPlainInner * Math.cos(midA), cy + rPlainInner * Math.sin(midA),
        cx + rPlainOuter * Math.cos(midA), cy + rPlainOuter * Math.sin(midA));
      rg.addColorStop(0, '#5a0000'); rg.addColorStop(0.5, '#aa1010'); rg.addColorStop(1, '#5a0000');
      g.fillStyle = rg;
    } else {
      g.fillStyle = '#080808';
    }
    g.fill();
    // Gold dividers
    g.beginPath();
    g.moveTo(cx + rPlainInner * Math.cos(startA), cy + rPlainInner * Math.sin(startA));
    g.lineTo(cx + rPlainOuter * Math.cos(startA), cy + rPlainOuter * Math.sin(startA));
    g.strokeStyle = '#c8960c'; g.lineWidth = R * 0.004; g.stroke();
  });

  // ── 5. Gold separator ring ────────────────────────────────────────────────
  const sepGrad = g.createRadialGradient(cx, cy, rSepInner, cx, cy, rSepOuter);
  sepGrad.addColorStop(0, '#a07000'); sepGrad.addColorStop(0.5, '#ffd700'); sepGrad.addColorStop(1, '#a07000');
  g.beginPath(); g.arc(cx, cy, rSepOuter, 0, Math.PI * 2);
  g.fillStyle = sepGrad; g.fill();

  // ── 6. Inner mahogany bowl — same gradient as outer ───────────────────────
  const innerGrad = g.createRadialGradient(cx - R*0.08, cy - R*0.1, R*0.02, cx, cy, rSepInner);
  innerGrad.addColorStop(0,   '#a0321a');
  innerGrad.addColorStop(0.35,'#841e0a');
  innerGrad.addColorStop(0.7, '#5e1005');
  innerGrad.addColorStop(1,   '#3a0800');
  g.beginPath(); g.arc(cx, cy, rSepInner, 0, Math.PI * 2);
  g.fillStyle = innerGrad; g.fill();

  // The turret hub radius (computed same as in section 7 below)
  const tHubRad = rSepInner * 0.28;

  // 4 thin diagonal X-lines — from just outside the turret hub to the bowl edge
  // at same angles as the spoke arms (45/135/225/315) so they align perfectly
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4; // 45°, 135°, 225°, 315°
    g.beginPath();
    g.moveTo(cx + tHubRad * 1.15 * Math.cos(a), cy + tHubRad * 1.15 * Math.sin(a));
    g.lineTo(cx + rSepInner * 0.96 * Math.cos(a), cy + rSepInner * 0.96 * Math.sin(a));
    g.strokeStyle = 'rgba(210,165,20,0.45)';
    g.lineWidth = R * 0.006;
    g.stroke();
  }

  // 4 gold diamond markers at cardinal points on inner bowl edge
  [0, Math.PI/2, Math.PI, Math.PI*3/2].forEach(a => {
    const dr = rSepInner * 0.88;
    const dx = cx + dr * Math.cos(a - Math.PI/2);
    const dy = cy + dr * Math.sin(a - Math.PI/2);
    const ds = R * 0.026;
    g.save();
    g.translate(dx, dy);
    g.rotate(a);
    const dg = g.createRadialGradient(-ds*0.2, -ds*0.25, 0, 0, 0, ds);
    dg.addColorStop(0, '#fffacc'); dg.addColorStop(0.4, '#ffd700'); dg.addColorStop(1, '#8a6000');
    g.beginPath();
    g.moveTo(0, -ds); g.lineTo(ds*0.5, 0); g.lineTo(0, ds); g.lineTo(-ds*0.5, 0);
    g.closePath();
    g.fillStyle = dg; g.fill();
    g.restore();
  });

  // ── 7. Turret: tapered baton arms + large hub platform + elevated centre sphere ──
  const tHubR    = rSepInner * 0.28;  // hub platform radius
  const tArmW2   = rSepInner * 0.048; // arm width at widest (centre)
  const tArmLen2 = rSepInner * 0.72;  // arm reach from centre
  const tBallR   = rSepInner * 0.068; // arm-tip ball radius
  const tTopR    = rSepInner * 0.095; // elevated top sphere radius

  // Hub platform drop shadow
  g.beginPath(); g.arc(cx, cy + tHubR * 0.1, tHubR * 1.06, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.4)'; g.fill();

  // 4 tapered baton arms BEHIND the hub disc
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4; // ×45°
    g.save();
    g.translate(cx, cy);
    g.rotate(a);

    // Tapered baton: wider at centre (hub edge), tapers to narrower near ball
    // Draw as a trapezoid path
    const wNear = tArmW2;           // width at hub end
    const wFar  = tArmW2 * 0.55;   // width at ball end
    const near  = tHubR * 0.85;    // start distance from centre
    const far   = tArmLen2;         // end distance from centre

    // Side-lit gradient (dark edges, bright centre = cylindrical look)
    const rodGrad = g.createLinearGradient(-wNear, 0, wNear, 0);
    rodGrad.addColorStop(0,    '#5a3800');
    rodGrad.addColorStop(0.2,  '#c8960c');
    rodGrad.addColorStop(0.45, '#fff8c0');
    rodGrad.addColorStop(0.55, '#fffacc');
    rodGrad.addColorStop(0.8,  '#c8960c');
    rodGrad.addColorStop(1,    '#5a3800');

    g.beginPath();
    g.moveTo(-wNear / 2, near);
    g.lineTo(-wFar  / 2, far);
    g.arc(0, far, wFar / 2, Math.PI, 0); // rounded tip
    g.lineTo( wNear / 2, near);
    g.closePath();
    g.fillStyle = rodGrad; g.fill();

    // Ball at tip
    const ballGrad2 = g.createRadialGradient(
      -tBallR * 0.3, far - tBallR * 0.35, tBallR * 0.05,
      0, far, tBallR);
    ballGrad2.addColorStop(0,   '#fffacc');
    ballGrad2.addColorStop(0.3, '#ffd700');
    ballGrad2.addColorStop(0.7, '#c8960c');
    ballGrad2.addColorStop(1,   '#6a4800');
    g.beginPath(); g.arc(0, far, tBallR, 0, Math.PI * 2);
    g.fillStyle = ballGrad2; g.fill();
    // Ball specular
    g.beginPath(); g.arc(-tBallR*0.3, far - tBallR*0.35, tBallR*0.28, 0, Math.PI*2);
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.fill();

    g.restore();
  }

  // Hub platform — large disc with concentric ring detail
  const hubGrad1 = g.createRadialGradient(cx - tHubR*0.22, cy - tHubR*0.26, tHubR*0.05, cx, cy, tHubR);
  hubGrad1.addColorStop(0,   '#fffacc');
  hubGrad1.addColorStop(0.2, '#ffd700');
  hubGrad1.addColorStop(0.55,'#c8960c');
  hubGrad1.addColorStop(1,   '#7a5200');
  g.beginPath(); g.arc(cx, cy, tHubR, 0, Math.PI * 2);
  g.fillStyle = hubGrad1; g.fill();

  // Outer engraved ring on hub
  g.beginPath(); g.arc(cx, cy, tHubR * 0.82, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(60,40,0,0.55)'; g.lineWidth = tHubR * 0.045; g.stroke();

  // Inner platform (raised inner disc)
  const hubGrad2 = g.createRadialGradient(cx - tHubR*0.18, cy - tHubR*0.22, tHubR*0.03, cx, cy, tHubR * 0.64);
  hubGrad2.addColorStop(0,   '#fffacc');
  hubGrad2.addColorStop(0.25,'#ffd700');
  hubGrad2.addColorStop(0.7, '#c8960c');
  hubGrad2.addColorStop(1,   '#8a6200');
  g.beginPath(); g.arc(cx, cy, tHubR * 0.64, 0, Math.PI * 2);
  g.fillStyle = hubGrad2; g.fill();

  // Inner engraved ring
  g.beginPath(); g.arc(cx, cy, tHubR * 0.46, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(60,40,0,0.45)'; g.lineWidth = tHubR * 0.035; g.stroke();

  // ── Elevated centre sphere on top of hub ────────────────────────────────
  // Drop shadow for sphere
  g.beginPath(); g.arc(cx + tTopR * 0.1, cy + tTopR * 0.15, tTopR * 1.0, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill();

  const topGrad = g.createRadialGradient(
    cx - tTopR * 0.35, cy - tTopR * 0.38, tTopR * 0.04,
    cx, cy, tTopR);
  topGrad.addColorStop(0,   '#ffffff');
  topGrad.addColorStop(0.15,'#fffacc');
  topGrad.addColorStop(0.4, '#ffd700');
  topGrad.addColorStop(0.75,'#c8960c');
  topGrad.addColorStop(1,   '#6a4800');
  g.beginPath(); g.arc(cx, cy, tTopR, 0, Math.PI * 2);
  g.fillStyle = topGrad; g.fill();

  // Sphere specular
  g.beginPath(); g.arc(cx - tTopR*0.32, cy - tTopR*0.36, tTopR * 0.3, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.8)'; g.fill();

  // ── 8. Overall sheen ──────────────────────────────────────────────────────
  const sheen = g.createRadialGradient(cx - R*0.2, cy - R*0.25, 0, cx, cy, R);
  sheen.addColorStop(0,   'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  sheen.addColorStop(1,   'rgba(0,0,0,0.22)');
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = sheen; g.fill();

  _offscreenCanvas = oc;
  return oc;
}

/**
 * Draw one frame of the wheel onto the live canvas.
 * Applies the current wheel rotation angle, then draws the ball on top.
 */
function drawWheelFrame() {
  const canvas = document.getElementById('tv-wheel-canvas');
  if (!canvas) return;

  // Resize canvas to match its CSS display size
  const rect = canvas.getBoundingClientRect();
  const size = Math.round(rect.width * (window.devicePixelRatio || 1));
  if (canvas.width !== size) {
    canvas.width  = size;
    canvas.height = size;
    _offscreenCanvas = null; // force rebuild at new size
  }
  if (size === 0) return;

  const g  = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const R  = size / 2;

  g.clearRect(0, 0, size, size);

  // Cast shadow
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.7)';
  g.shadowBlur  = R * 0.18;
  g.shadowOffsetY = R * 0.14;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = '#000';
  g.fill();
  g.restore();

  // Draw rotating wheel face
  const face = buildOffscreenWheel(size);
  g.save();
  g.translate(cx, cy);
  g.rotate(_wheel.angle);
  g.translate(-cx, -cy);
  g.drawImage(face, 0, 0);
  g.restore();

  // Ball — spirals inward continuously as it decelerates (physics-based path)
  if (_ball.visible) {
    const trackOrbitR  = R * 0.768; // outer track groove centre
    const pocketOrbitR = R * 0.555; // plain pocket ring centre

    // Radial drift: stays at trackOrbitR until 70% through spin,
    // then eases inward quadratically, arriving at pocketOrbitR at t=1.
    // This gives a natural spiral — no L-shaped path.
    let orbitR;
    if (_ball.dropped) {
      orbitR = pocketOrbitR;
    } else {
      const t = _ball._spinT || 0;
      const driftStart = 0.10; // start drifting inward at 10% of spin
      const radialT = Math.max(0, (t - driftStart) / (1 - driftStart));
      const radialEase = radialT * radialT; // quadratic — gentle start, firm finish
      orbitR = trackOrbitR + (pocketOrbitR - trackOrbitR) * radialEase;
    }

    const bx = cx + orbitR * Math.cos(-_ball.angle - Math.PI / 2);
    const by = cy + orbitR * Math.sin(-_ball.angle - Math.PI / 2);
    const br = Math.max(4, R * 0.038);

    // Ball shadow
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur  = br * 1.5;
    g.shadowOffsetX = br * 0.4;
    g.shadowOffsetY = br * 0.6;

    // Ball body — ivory gradient
    const ballGrad = g.createRadialGradient(bx - br * 0.3, by - br * 0.35, br * 0.05, bx, by, br);
    ballGrad.addColorStop(0, '#ffffff');
    ballGrad.addColorStop(0.35, '#fff8e7');
    ballGrad.addColorStop(0.85, '#b8a888');
    ballGrad.addColorStop(1, '#5e5443');
    g.beginPath();
    g.arc(bx, by, br, 0, Math.PI * 2);
    g.fillStyle = ballGrad;
    g.fill();
    g.restore();

    // Specular highlight
    g.beginPath();
    g.arc(bx - br * 0.28, by - br * 0.3, br * 0.28, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fill();
  }
}

/** Start the render loop (runs every frame, draws idle wheel + ball). */
function startWheelRenderLoop() {
  if (_rafId) return; // already running
  function loop() {
    drawWheelFrame();
    _rafId = requestAnimationFrame(loop);
  }
  _rafId = requestAnimationFrame(loop);
}

/** Stop the render loop (called on cleanup). */
function stopWheelRenderLoop() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
}

function buildWheel() {
  // Canvas is built lazily in drawWheelFrame — just start the render loop.
  startWheelRenderLoop();
}

/* ======= RENDER HELPERS ======= */
function renderPlayerStrip() {
  const left = document.getElementById('tv-players-left');
  const right = document.getElementById('tv-players-right');
  if (!left || !right) return;
  const players = firebaseSnapshot.players || {};
  // Skip ghost slots (see renderLobbyUi for context).
  const keys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
  const half = Math.ceil(keys.length / 2);

  const renderInto = (el, slice) => {
    el.innerHTML = '';
    el.classList.toggle('cols-2', slice.length > 6);
    slice.forEach((k) => {
      const p = players[k] || {};
      const card = document.createElement('div');
      card.className = 'tv-player-card';
      if (p.broke || (p.chips ?? 0) <= 0) card.classList.add('broke');
      if (!p.connected) card.classList.add('disconnected');
      card.innerHTML = `
        <span class="pc-emoji">${escapeHtml(p.emoji || '😀')}</span>
        <span class="pc-name">${escapeHtml(p.name || 'Player')}</span>
        <span class="pc-chips">💰 ${p.chips ?? 0}</span>`;
      el.appendChild(card);
    });
  };
  renderInto(left,  keys.slice(0, half));
  renderInto(right, keys.slice(half));
}

function renderTotalBets() {
  // Just shows total table action while bets are open, for host info.
  const el = document.getElementById('tv-total-bets');
  if (!el) return;
  const bets = firebaseSnapshot.bets || {};
  let total = 0;
  Object.values(bets).forEach((playerBets) => {
    Object.values(playerBets || {}).forEach((b) => { total += (b.chips || 0); });
  });
  el.textContent = `Table: ${total} chips`;
}

/* ======= CLEANUP ======= */
function cleanupAndGoHome() {
  stopCountdown();
  cancelDelayedTimers();
  _spinInFlight = false;
  _createInFlight = false;
  stopWheelRenderLoop();
  stopBackgroundMusic();
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (cancelTvDisconnect) { void cancelTvDisconnect(); cancelTvDisconnect = null; }
  dismissConfirmModals();
  closeActiveQRCode(false);
  clearSession();
  roomCode = null;
  firebaseSnapshot = {};
  delete document.body.dataset.mode;
  showScreen('home');
}

window.addEventListener('beforeunload', () => {
  if (unsubscribe) unsubscribe();
});

/* ======= UTIL ======= */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
