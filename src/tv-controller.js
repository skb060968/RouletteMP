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
  openBets as fbOpenBets, closeBets as fbCloseBets,
  revealWinningNumber, applyPayouts, pushResult, applyBalanceUpdates,
  endGame as fbEndGame, deleteRoom as fbDeleteRoom, rejoinRoom,
  firebaseRetry, MAX_PLAYERS,
} from './firebase-sync.js';
import { resolveRound, applyTopUp, applyReset } from './game-engine.js';
import { WHEEL_SEQUENCE, colorOf } from './wheel.js';
import { initAudio, playSound, isMuted, toggleMute } from './sound-manager.js';
import { showScreen, showToast, confirmModal } from './platform-ui.js';
import { db } from './firebase-config.js';
import { ref, get } from 'firebase/database';

const SESSION_KEY = 'roulette_mp_session';

let roomCode = null;
let unsubscribe = null;
let firebaseSnapshot = {};
let _autoCloseTimer = null;
let _countdownTimer = null;
let _spinAnimationTimer = null;
let _resultsShown = false;

/* ======= CANVAS WHEEL STATE ======= */
// Physics state for the canvas-based wheel + ball renderer
const _wheel = {
  angle: 0,        // current wheel rotation in radians (clockwise)
  angVel: 0,       // current angular velocity rad/s
  targetAngle: 0,  // final resting angle
  spinning: false,
};
const _ball = {
  angle: 0,        // current ball position in radians (counter-clockwise from top)
  angVel: 0,       // angular velocity (positive = counter-clockwise)
  radius: 0,       // current orbit radius as fraction of wheel radius (0..1)
  outerR: 0.88,    // outer track radius fraction
  pocketR: 0.76,   // pocket (settled) radius fraction
  dropped: false,  // has ball dropped into pocket yet
  settling: false, // bounce animation in progress
  settleT: 0,      // settle animation time
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
  setupTvDisconnectHandler(roomCode);
  attachRoomListener();
  if (result.status === 'lobby') {
    showScreen('tv-lobby');
    setupLobbyUi();
  } else {
    showScreen('tv-game');
    setupGameUi();
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
    try {
      const result = await createRoomAsTv('TV', '🎰');
      roomCode = result.roomCode;
      saveSession();
      setupTvDisconnectHandler(roomCode);
      attachRoomListener();
      setupLobbyUi();
      showScreen('tv-lobby');
    } catch (err) {
      console.error(err);
      showToast('Failed to create room.');
    }
  });
  if (back) back.addEventListener('click', () => showScreen('home'));
}

/* ======= ROOM LISTENER ======= */
function attachRoomListener() {
  if (unsubscribe) unsubscribe();
  unsubscribe = listenRoom(roomCode, {
    onMetaChange: (meta) => {
      firebaseSnapshot.meta = meta;
      if (meta.status === 'lobby') {
        renderLobbyUi();
      }
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
  const codeEl = document.getElementById('tv-lobby-code');
  if (codeEl) codeEl.textContent = roomCode;
  renderLobbyUi();
}

function renderLobbyUi() {
  const list = document.getElementById('tv-lobby-players');
  if (!list) return;
  const players = firebaseSnapshot.players || {};
  // Skip ghost slots (no name) — these can be left behind by a stale
  // onDisconnect after a player tapped Leave; they get cleaned up on the
  // next join, but we filter here so they don't render in the meantime.
  const keys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
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
      li.innerHTML = `<span class="emoji">${escapeHtml(p.emoji || '😀')}</span><span class="name">${escapeHtml(p.name || 'Player')}</span><span class="chips">💰 ${p.chips ?? 0}</span>`;
      if (!p.connected) li.classList.add('disconnected');
      list.appendChild(li);
    });
  }
  const startBtn = document.getElementById('btn-tv-start-round');
  // Need at least 1 player AND someone with chips
  const hasReady = keys.some((k) => (players[k]?.chips ?? 0) > 0);
  if (startBtn) startBtn.disabled = !hasReady;
  const countEl = document.getElementById('tv-lobby-count');
  if (countEl) countEl.textContent = `${keys.length} / ${MAX_PLAYERS}`;
}

function wireTvLobby() {
  const screen = document.getElementById('tv-lobby');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const startBtn = document.getElementById('btn-tv-start-round');
  if (startBtn) startBtn.addEventListener('click', startRound);

  const closeBtn = document.getElementById('btn-tv-lobby-close');
  if (closeBtn) closeBtn.addEventListener('click', async () => {
    const ok = await confirmModal('Close room?', 'All players will be disconnected.', 'Close', 'Cancel');
    if (!ok) return;
    if (roomCode) { try { await fbDeleteRoom(roomCode); } catch (_) {} }
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

/* ======= START ROUND (open bets) ======= */
async function startRound() {
  const players = firebaseSnapshot.players || {};
  const hasAny = Object.values(players).some((p) => (p.chips ?? 0) > 0);
  if (!hasAny) {
    showToast('No players have chips. Top Up first.');
    return;
  }
  showScreen('tv-game');
  setupGameUi();
  await fbOpenBets(roomCode, 30);
  startCountdown(30);
}

function setupGameUi() {
  renderPlayerStrip();
  renderTotalBets();
  // Reset wheel + ball to idle state
  _wheel.angle   = 0;
  _wheel.angVel  = 0;
  _wheel.spinning = false;
  _ball.visible   = false;
  _ball.dropped   = false;
  _ball.settling  = false;
  _ball.angle     = 0;
  _ball.angVel    = 0;
  _ball.radius    = _ball.outerR;
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
    const players = firebaseSnapshot.players || {};
    const broke = Object.entries(players).filter(([, p]) => p.broke || (p.chips ?? 0) === 0);
    if (broke.length === 0) { showToast('No broke players.'); return; }
    const ok = await confirmModal('Top up broke players?', `Give 500 chips to ${broke.length} broke player${broke.length === 1 ? '' : 's'}.`, 'Top Up', 'Cancel');
    if (!ok) return;
    const { newBalances, newBroke } = applyTopUp(players);
    await applyBalanceUpdates(roomCode, newBalances, newBroke);
    showToast('Topped up!');
  });

  const resetBtn = document.getElementById('btn-tv-reset');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    const ok = await confirmModal('Reset all chips?', 'Every player will go back to 1000 chips.', 'Reset', 'Cancel');
    if (!ok) return;
    const players = firebaseSnapshot.players || {};
    const { newBalances, newBroke } = applyReset(players);
    await applyBalanceUpdates(roomCode, newBalances, newBroke);
    showToast('All chips reset.');
  });

  const endBtn = document.getElementById('btn-tv-end');
  if (endBtn) endBtn.addEventListener('click', async () => {
    const ok = await confirmModal('End game?', 'Close room and return to home.', 'End', 'Cancel');
    if (!ok) return;
    if (roomCode) { try { await fbDeleteRoom(roomCode); } catch (_) {} }
    cleanupAndGoHome();
  });

  const muteBtn = document.getElementById('btn-tv-game-mute');
  if (muteBtn) {
    syncMuteUi();
    muteBtn.addEventListener('click', () => { toggleMute(); syncMuteUi(); });
  }
}

/* ======= COUNTDOWN ======= */
function startCountdown(seconds) {
  stopCountdown();
  const startedAt = Date.now();
  const totalMs = seconds * 1000;
  const tick = () => {
    const remaining = Math.max(0, totalMs - (Date.now() - startedAt));
    const sec = Math.ceil(remaining / 1000);
    const tag = document.getElementById('tv-winning-tag');
    if (tag) {
      tag.innerHTML = `<span class="bets-open">BETS OPEN · ${sec}s</span>`;
      tag.classList.add('show');
    }
    if (remaining <= 0) {
      stopCountdown();
      triggerSpin();
    }
  };
  tick();
  _countdownTimer = setInterval(tick, 250);
  _autoCloseTimer = setTimeout(() => {
    stopCountdown();
    triggerSpin();
  }, totalMs);
}

function stopCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
  if (_autoCloseTimer) { clearTimeout(_autoCloseTimer); _autoCloseTimer = null; }
}

/* ======= SPIN ======= */
async function triggerSpin() {
  if (!roomCode) return;
  if (firebaseSnapshot.meta?.status !== 'betting') return;

  stopCountdown();
  await fbCloseBets(roomCode);

  const winningNumber = Math.floor(Math.random() * 37);

  // "Rien ne va plus" flash
  const rien = document.getElementById('tv-rien');
  if (rien) {
    rien.classList.remove('show');
    void rien.offsetWidth;
    rien.classList.add('show');
  }
  playSound('betClose', 1.0);

  // 1s flash delay, then start physics spin
  setTimeout(() => {
    const tag = document.getElementById('tv-winning-tag');
    if (tag) {
      tag.innerHTML = `<span class="spinning">SPINNING…</span>`;
      tag.classList.add('show');
    }
    playSound('spin', 1.0);
    startPhysicsSpin(winningNumber);
  }, 1000);
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
function startPhysicsSpin(winningNumber) {
  const SPIN_DURATION = 5.0;

  // Random final ball position (avoid top/bottom)
  const ballFinalAngle = (Math.PI * 0.15) + Math.random() * (Math.PI * 1.7);

  // Wheel target so winning pocket lands exactly under the ball
  const finalWheelAngle = targetAngleForWinning(winningNumber, 5, ballFinalAngle);

  // Ball total travel = 7 full CCW turns + random final offset
  const ballTotalAngle = 7 * Math.PI * 2 + ballFinalAngle;

  // Power ease-out: progress(t) = 1 - (1 - t/T)^p
  // p=4 → at t=4.5s (90% through): progress = 1 - 0.1^4 = 99.99% done ✅
  //       at t=3s   (60% through): progress = 1 - 0.4^4 = 97.4% done ✅ (fast early)
  // This naturally matches the sound file's slowdown at 4.5–5s.
  const POWER = 4;

  // Reset state
  _wheel.angle   = 0;
  _wheel.spinning = true;
  _ball.angle    = 0;
  _ball.radius   = _ball.outerR;
  _ball.dropped  = false;
  _ball.settling = false;
  _ball.settleT  = 0;
  _ball.visible  = true;

  const startTime = performance.now();
  let settled = false;

  function frame(now) {
    const elapsed = (now - startTime) / 1000;
    const t = Math.min(elapsed / SPIN_DURATION, 1.0);
    const progress = 1 - Math.pow(1 - t, POWER);

    _wheel.angle = finalWheelAngle * progress;
    _ball.angle  = ballTotalAngle  * progress;

    if (t >= 1.0 && !settled) {
      settled = true;
      // Snap to exact values — guaranteed to equal the computed targets
      _wheel.angle   = finalWheelAngle % (Math.PI * 2);
      _wheel.angVel  = 0;
      _wheel.spinning = false;
      _ball.angle    = ballFinalAngle;
      _ball.settling = true;
      _ball.settleT  = 0;
      drawWheelFrame();
      onSpinSettled(winningNumber);
      return;
    }

    if (_ball.settling) {
      _ball.settleT = (now - startTime) / 1000 - SPIN_DURATION;
      if (_ball.settleT > 0.5) _ball.settling = false;
    }
    drawWheelFrame();
    _rafId = requestAnimationFrame(frame);
  }

  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = requestAnimationFrame(frame);
}

async function onSpinSettled(winningNumber) {
  // 500ms theatrical pause — the silence after the ball lands lets the
  // reveal land harder than an instant cut.
  await new Promise((r) => setTimeout(r, 500));

  // Reveal + payout
  await revealWinningNumber(roomCode, winningNumber);

  const players = firebaseSnapshot.players || {};
  const bets = firebaseSnapshot.bets || {};
  const { newBalances, newBroke, payouts } = resolveRound(bets, players, winningNumber);

  // TV is silent at round end — only the wheel-spin and "no more bets"
  // sounds play on TV. Player phones celebrate their own wins individually.

  // Build a single update bundle
  const updates = {};
  Object.keys(newBalances).forEach((k) => {
    updates[`players/${k}/chips`] = newBalances[k];
    updates[`players/${k}/broke`] = !!newBroke[k];
    updates[`payouts/${k}`] = payouts[k];
  });
  await applyPayouts(roomCode, updates);
  await pushResult(roomCode, winningNumber, firebaseSnapshot.game?.lastResults || [], firebaseSnapshot.game?.roundNumber || 0);

  // Reveal UI
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

  // Highlight top winner
  const sorted = Object.entries(payouts).sort((a, b) => (b[1].netDelta || 0) - (a[1].netDelta || 0));
  const top = sorted[0];
  if (top && top[1].netDelta > 0) {
    const player = (firebaseSnapshot.players || {})[top[0]];
    showToast(`🏆 ${player?.name || 'Player'} won ${top[1].netDelta} chips!`, 3000);
  }

  // After 3s, auto-open the next round
  setTimeout(() => {
    if (firebaseSnapshot.meta?.status !== 'ended') {
      const banner = document.getElementById('tv-winning-tag');
      if (banner) banner.classList.remove('reveal');
      startRound();
    }
  }, 3500);
}

/* ======= CANVAS WHEEL RENDERER ======= */

/**
 * Pre-render the static wheel face.
 *
 * Layers from outside to inside (matching reference image):
 *   1. Outer gold rim
 *   2. Ball track groove (dark, where ball orbits)
 *   3. Number band — 37 labeled red/black/green pockets
 *   4. Inner gold ring separator
 *   5. Plain pocket ring — 37 alternating red/black (no numbers, ball rests here)
 *   6. Inner gold ring separator
 *   7. Mahogany inner bowl with diagonal gold spoke lines
 *   8. Gold hub with angled spokes + knob
 */
function buildOffscreenWheel(size) {
  if (_offscreenCanvas && _canvasSize === size) return _offscreenCanvas;
  _canvasSize = size;

  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const g = oc.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const R  = size / 2;

  // ── Radii ──────────────────────────────────────────────────────────────
  const rOuter        = R;         // outermost gold rim edge
  const rTrackOuter   = R * 0.965; // ball track outer edge
  const rTrackInner   = R * 0.895; // ball track inner edge / number band outer
  const rNumOuter     = R * 0.895; // number band outer
  const rNumInner     = R * 0.735; // number band inner
  const rSep1         = R * 0.735; // gold separator ring outer
  const rPlainOuter   = R * 0.715; // plain pocket ring outer
  const rPlainInner   = R * 0.590; // plain pocket ring inner
  const rSep2         = R * 0.590; // inner gold separator
  const rBowlOuter    = R * 0.570; // mahogany bowl outer
  const rBowlInner    = R * 0.195; // mahogany bowl inner / hub area
  const rHub          = R * 0.145; // hub disc

  const segRad = (Math.PI * 2) / WHEEL_SEQUENCE.length;

  // ── 1. Outer gold rim ───────────────────────────────────────────────────
  const rimGrad = g.createRadialGradient(cx, cy, rTrackOuter, cx, cy, rOuter);
  rimGrad.addColorStop(0,   '#b8860b');
  rimGrad.addColorStop(0.25,'#ffd700');
  rimGrad.addColorStop(0.5, '#ffe066');
  rimGrad.addColorStop(0.75,'#ffd700');
  rimGrad.addColorStop(1,   '#8a6200');
  g.beginPath(); g.arc(cx, cy, rOuter, 0, Math.PI * 2);
  g.fillStyle = rimGrad; g.fill();

  // ── 2. Ball track groove ────────────────────────────────────────────────
  const trackGrad = g.createRadialGradient(cx, cy, rTrackInner, cx, cy, rTrackOuter);
  trackGrad.addColorStop(0,   '#0a0400');
  trackGrad.addColorStop(0.4, '#1a0c02');
  trackGrad.addColorStop(0.8, '#0d0600');
  trackGrad.addColorStop(1,   '#000000');
  g.beginPath(); g.arc(cx, cy, rTrackOuter, 0, Math.PI * 2);
  g.fillStyle = trackGrad; g.fill();

  // Subtle groove highlight
  g.beginPath(); g.arc(cx, cy, (rTrackOuter + rTrackInner) / 2, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,220,100,0.18)';
  g.lineWidth = R * 0.012;
  g.stroke();

  // ── 3. Number band ──────────────────────────────────────────────────────
  g.beginPath(); g.arc(cx, cy, rNumOuter, 0, Math.PI * 2);
  g.fillStyle = '#111'; g.fill();

  WHEEL_SEQUENCE.forEach((n, i) => {
    const startA = i * segRad - Math.PI / 2;
    const endA   = startA + segRad;
    const midA   = startA + segRad / 2;

    // Pocket arc
    g.beginPath();
    g.arc(cx, cy, rNumOuter - R * 0.003, startA + 0.01, endA - 0.01);
    g.arc(cx, cy, rNumInner + R * 0.003, endA - 0.01, startA + 0.01, true);
    g.closePath();

    const c = colorOf(n);
    if (c === 'green') {
      const gg = g.createLinearGradient(
        cx + rNumInner * Math.cos(midA), cy + rNumInner * Math.sin(midA),
        cx + rNumOuter * Math.cos(midA), cy + rNumOuter * Math.sin(midA));
      gg.addColorStop(0, '#155222'); gg.addColorStop(0.5, '#27ae60'); gg.addColorStop(1, '#155222');
      g.fillStyle = gg;
    } else if (c === 'red') {
      const rg = g.createLinearGradient(
        cx + rNumInner * Math.cos(midA), cy + rNumInner * Math.sin(midA),
        cx + rNumOuter * Math.cos(midA), cy + rNumOuter * Math.sin(midA));
      rg.addColorStop(0, '#7a0000'); rg.addColorStop(0.5, '#cc1111'); rg.addColorStop(1, '#7a0000');
      g.fillStyle = rg;
    } else {
      g.fillStyle = '#0d0d0d';
    }
    g.fill();

    // Gold dividers
    g.beginPath();
    g.moveTo(cx + rNumInner * Math.cos(startA), cy + rNumInner * Math.sin(startA));
    g.lineTo(cx + rNumOuter * Math.cos(startA), cy + rNumOuter * Math.sin(startA));
    g.strokeStyle = '#c8960c';
    g.lineWidth = R * 0.005;
    g.stroke();
  });

  // Number labels — upright (radially oriented)
  const labelR = (rNumOuter + rNumInner) / 2;
  g.textAlign = 'center'; g.textBaseline = 'middle';

  WHEEL_SEQUENCE.forEach((n, i) => {
    const midA = i * segRad - Math.PI / 2 + segRad / 2;
    const lx = cx + labelR * Math.cos(midA);
    const ly = cy + labelR * Math.sin(midA);
    g.save();
    g.translate(lx, ly);
    g.rotate(midA + Math.PI / 2);
    g.font = `900 ${Math.round(R * 0.065)}px Arial, sans-serif`;
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 3;
    g.fillStyle = '#ffffff';
    g.fillText(String(n), 0, 0);
    g.shadowBlur = 0;
    g.restore();
  });

  // ── 4. Gold separator ring ──────────────────────────────────────────────
  g.beginPath(); g.arc(cx, cy, rSep1, 0, Math.PI * 2);
  g.strokeStyle = '#c8960c'; g.lineWidth = R * 0.022; g.stroke();

  // ── 5. Plain pocket ring (alternating red/black, no numbers) ───────────
  g.beginPath(); g.arc(cx, cy, rPlainOuter, 0, Math.PI * 2);
  g.fillStyle = '#111'; g.fill();

  WHEEL_SEQUENCE.forEach((n, i) => {
    const startA = i * segRad - Math.PI / 2;
    const endA   = startA + segRad;
    const midA   = startA + segRad / 2;

    g.beginPath();
    g.arc(cx, cy, rPlainOuter - R * 0.003, startA + 0.01, endA - 0.01);
    g.arc(cx, cy, rPlainInner + R * 0.003, endA - 0.01, startA + 0.01, true);
    g.closePath();

    const c = colorOf(n);
    // Plain pockets — same colour as number pocket above but darker/simpler
    if (c === 'green') {
      g.fillStyle = '#1a6b30';
    } else if (c === 'red') {
      const rg = g.createLinearGradient(
        cx + rPlainInner * Math.cos(midA), cy + rPlainInner * Math.sin(midA),
        cx + rPlainOuter * Math.cos(midA), cy + rPlainOuter * Math.sin(midA));
      rg.addColorStop(0, '#6a0000'); rg.addColorStop(0.5, '#aa0e0e'); rg.addColorStop(1, '#6a0000');
      g.fillStyle = rg;
    } else {
      g.fillStyle = '#0a0a0a';
    }
    g.fill();

    // Gold dividers
    g.beginPath();
    g.moveTo(cx + rPlainInner * Math.cos(startA), cy + rPlainInner * Math.sin(startA));
    g.lineTo(cx + rPlainOuter * Math.cos(startA), cy + rPlainOuter * Math.sin(startA));
    g.strokeStyle = '#c8960c';
    g.lineWidth = R * 0.005;
    g.stroke();
  });

  // ── 6. Inner gold separator ring ────────────────────────────────────────
  g.beginPath(); g.arc(cx, cy, rSep2, 0, Math.PI * 2);
  g.strokeStyle = '#c8960c'; g.lineWidth = R * 0.022; g.stroke();

  // ── 7. Mahogany inner bowl ───────────────────────────────────────────────
  const bowlGrad = g.createRadialGradient(cx - R*0.08, cy - R*0.1, R*0.02, cx, cy, rBowlOuter);
  bowlGrad.addColorStop(0,   '#8b2010');
  bowlGrad.addColorStop(0.3, '#6b1508');
  bowlGrad.addColorStop(0.7, '#4a0d04');
  bowlGrad.addColorStop(1,   '#2e0700');
  g.beginPath(); g.arc(cx, cy, rBowlOuter, 0, Math.PI * 2);
  g.fillStyle = bowlGrad; g.fill();

  // 8 diagonal gold spoke lines across the bowl
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI / 4) + Math.PI / 8;
    g.beginPath();
    g.moveTo(cx + rBowlInner * 1.1 * Math.cos(a), cy + rBowlInner * 1.1 * Math.sin(a));
    g.lineTo(cx + rBowlOuter * 0.96 * Math.cos(a), cy + rBowlOuter * 0.96 * Math.sin(a));
    g.strokeStyle = 'rgba(200,150,12,0.45)';
    g.lineWidth = R * 0.006;
    g.stroke();
  }

  // Gold diamond markers at 4 cardinal points on bowl edge
  [0, Math.PI/2, Math.PI, Math.PI*3/2].forEach(a => {
    const dx = cx + rBowlOuter * 0.97 * Math.cos(a - Math.PI/2);
    const dy = cy + rBowlOuter * 0.97 * Math.sin(a - Math.PI/2);
    const ds = R * 0.032;
    g.save();
    g.translate(dx, dy);
    g.rotate(a);
    const dg = g.createRadialGradient(-ds*0.2, -ds*0.3, 0, 0, 0, ds);
    dg.addColorStop(0, '#fffacc'); dg.addColorStop(0.4, '#ffd700'); dg.addColorStop(1, '#8a6000');
    g.beginPath();
    g.moveTo(0, -ds); g.lineTo(ds*0.5, 0); g.lineTo(0, ds); g.lineTo(-ds*0.5, 0);
    g.closePath();
    g.fillStyle = dg; g.fill();
    g.restore();
  });

  // ── 8. Hub — gold disc with angled spokes ───────────────────────────────
  // Shadow under hub
  g.beginPath(); g.arc(cx, cy, rHub * 1.4, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.4)'; g.fill();

  // 8 angled spokes
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + Math.PI / 8;
    const sg = g.createLinearGradient(
      cx + rHub * 1.1 * Math.cos(a), cy + rHub * 1.1 * Math.sin(a),
      cx + rBowlInner * 0.88 * Math.cos(a), cy + rBowlInner * 0.88 * Math.sin(a));
    sg.addColorStop(0, '#fff8c0'); sg.addColorStop(0.35, '#ffd700');
    sg.addColorStop(0.7, '#c8960c'); sg.addColorStop(1, '#8a6000');
    g.beginPath();
    g.moveTo(cx + rHub * 1.1 * Math.cos(a), cy + rHub * 1.1 * Math.sin(a));
    g.lineTo(cx + rBowlInner * 0.88 * Math.cos(a), cy + rBowlInner * 0.88 * Math.sin(a));
    g.strokeStyle = sg; g.lineWidth = R * 0.02; g.lineCap = 'round'; g.stroke();
  }

  // Hub disc
  const hg = g.createRadialGradient(cx - rHub*0.28, cy - rHub*0.32, rHub*0.04, cx, cy, rHub);
  hg.addColorStop(0, '#fffacc'); hg.addColorStop(0.2, '#ffd700');
  hg.addColorStop(0.6, '#c8960c'); hg.addColorStop(1, '#6a4800');
  g.beginPath(); g.arc(cx, cy, rHub, 0, Math.PI * 2);
  g.fillStyle = hg; g.fill();
  g.strokeStyle = '#8a6000'; g.lineWidth = R * 0.007; g.stroke();

  // Hub knob
  const kg = g.createRadialGradient(cx - rHub*0.18, cy - rHub*0.22, 1, cx, cy, rHub*0.42);
  kg.addColorStop(0, '#ffffff'); kg.addColorStop(0.3, '#ffd700'); kg.addColorStop(1, '#c8960c');
  g.beginPath(); g.arc(cx, cy, rHub * 0.42, 0, Math.PI * 2);
  g.fillStyle = kg; g.fill();

  // Specular
  g.beginPath(); g.arc(cx - rHub*0.11, cy - rHub*0.14, rHub*0.11, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.65)'; g.fill();

  // ── 9. Sheen ─────────────────────────────────────────────────────────────
  const sheen = g.createRadialGradient(cx - R*0.18, cy - R*0.22, 0, cx, cy, R);
  sheen.addColorStop(0, 'rgba(255,255,255,0.13)');
  sheen.addColorStop(0.35, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.28)');
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

  // Ball — orbits outer track during spin, settles into plain pocket ring
  if (_ball.visible) {
    // During spin: centre of ball track groove
    const trackOrbitR  = R * 0.930; // (rTrackOuter+rTrackInner)/2 = (0.965+0.895)/2
    // Settled: centre of plain pocket ring (rPlainOuter+rPlainInner)/2 = (0.715+0.590)/2
    const pocketOrbitR = R * 0.652;

    // Smoothly interpolate inward when settling
    let orbitR = trackOrbitR;
    if (_ball.settling) {
      const t = Math.min(_ball.settleT / 0.4, 1.0);
      orbitR = trackOrbitR + (pocketOrbitR - trackOrbitR) * (1 - Math.pow(1 - t, 2));
    }

    // Settle pulse: tiny radial shimmer
    let bounceOffset = 0;
    if (_ball.settling && _ball.settleT < 0.5) {
      const t = _ball.settleT / 0.5;
      bounceOffset = Math.sin(t * Math.PI * 2.5) * R * 0.012 * (1 - t);
    }

    const bx = cx + (orbitR + bounceOffset) * Math.cos(-_ball.angle - Math.PI / 2);
    const by = cy + (orbitR + bounceOffset) * Math.sin(-_ball.angle - Math.PI / 2);
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
  if (_spinAnimationTimer) { clearTimeout(_spinAnimationTimer); _spinAnimationTimer = null; }
  stopWheelRenderLoop();
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  clearSession();
  roomCode = null;
  firebaseSnapshot = {};
  _resultsShown = false;
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
