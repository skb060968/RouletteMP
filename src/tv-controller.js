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
import { initAudio, playSound, stopSpinSound, isMuted, toggleMute } from './sound-manager.js';
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
 * winning segment's centre lands at a given ball position angle.
 *
 * ballFinalAngle: where the ball ends up, in radians CCW from top (0 = top).
 * The ball drawn at angle A CCW from top sits at A clockwise from top on screen.
 * The wheel segment idx has its centre at (idx+0.5)*segRad CW from top at rest.
 * After wheel rotates CW by W, segment centre is at (idx+0.5)*segRad - W from top.
 * We need that to equal ballFinalAngle:
 *   W = (idx+0.5)*segRad - ballFinalAngle  (mod 2π, positive)
 */
function targetAngleForWinning(winningNumber, extraSpins, ballFinalAngle) {
  const idx = WHEEL_SEQUENCE.indexOf(winningNumber);
  if (idx < 0) return extraSpins * Math.PI * 2;
  const segRad = (Math.PI * 2) / WHEEL_SEQUENCE.length;
  const segCenter = (idx + 0.5) * segRad;
  const target = ((segCenter - ballFinalAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  return extraSpins * Math.PI * 2 + target;
}

/**
 * Launch a physics-based spin.
 * Wheel: clockwise, decelerates with exponential friction to land winning number at top.
 * Ball: counter-clockwise, faster start, decelerates independently, drops inward near stop.
 * Total duration matches the 5s sound file.
 */
function startPhysicsSpin(winningNumber) {
  const SPIN_DURATION = 5.0; // seconds — matches spin-loop.mp3

  // Pick a random final ball position (avoid exactly top/bottom for realism)
  // ballFinalAngle is CCW from top in radians — this is where the ball visually stops.
  const ballFinalAngle = (Math.PI * 0.15) + Math.random() * (Math.PI * 1.7);

  // Compute wheel final angle so the winning pocket lands exactly under the ball
  const finalWheelAngle = targetAngleForWinning(winningNumber, 5, ballFinalAngle);

  // Physics: exponential deceleration  angle(T) = v0/k * (1 - e^(-kT))
  // Solve for v0 given desired total angle and duration T.
  const k      = 1.1;
  const k_ball = 0.85;
  const T      = SPIN_DURATION;

  // Ball total travel = 7 full CCW turns + random final offset
  const ballTotalAngle = 7 * Math.PI * 2 + ballFinalAngle;
  const v0_wheel = finalWheelAngle  * k      / (1 - Math.exp(-k      * T));
  const v0_ball  = ballTotalAngle   * k_ball / (1 - Math.exp(-k_ball * T));

  // Reset state
  _wheel.angle   = 0;
  _wheel.angVel  = v0_wheel;
  _wheel.spinning = true;
  _ball.angle    = 0;
  _ball.angVel   = v0_ball;
  _ball.radius   = _ball.outerR;
  _ball.dropped  = false;
  _ball.settling = false;
  _ball.settleT  = 0;
  _ball.visible  = true;

  let elapsed = 0;
  let lastTime = performance.now();
  let settled = false;

  // Drop threshold: ball drops when angVel falls to this fraction of v0
  const DROP_VEL = v0_ball * 0.07;

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    elapsed += dt;

    if (!settled) {
      // Exponential deceleration: vel *= e^(-k*dt)
      _wheel.angVel = v0_wheel * Math.exp(-k * elapsed);
      _ball.angVel  = v0_ball  * Math.exp(-k_ball * elapsed);

      // Integrate angles
      _wheel.angle += _wheel.angVel * dt;
      _ball.angle  += _ball.angVel  * dt;

      // Drop ball inward when it slows enough
      if (!_ball.dropped && _ball.angVel < DROP_VEL) {
        _ball.dropped = true;
      }

      // Smoothly move ball radius inward once dropped
      if (_ball.dropped) {
        _ball.radius += (_ball.pocketR - _ball.radius) * Math.min(1, dt * 8);
      }

      // After SPIN_DURATION snap to exact final positions and trigger settle
      if (elapsed >= T) {
        settled = true;
        _wheel.angle   = finalWheelAngle % (Math.PI * 2);
        _wheel.angVel  = 0;
        _wheel.spinning = false;
        _ball.angle    = ballFinalAngle; // ball ends at its random position
        _ball.angVel   = 0;
        _ball.radius   = _ball.pocketR;
        _ball.dropped  = true;
        _ball.settling = true;
        _ball.settleT  = 0;
        drawWheelFrame();
        onSpinSettled(winningNumber);
        return;
      }
    }

    // Settle bounce animation
    if (_ball.settling) {
      _ball.settleT += dt;
      if (_ball.settleT > 0.6) _ball.settling = false;
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
 * Pre-render the static wheel face (segments + numbers + rim + turret)
 * onto an offscreen canvas at the given pixel size. Re-built only when
 * the canvas size changes.
 */
function buildOffscreenWheel(size) {
  if (_offscreenCanvas && _canvasSize === size) return _offscreenCanvas;
  _canvasSize = size;

  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const g = oc.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const R = size / 2;

  // ── Outer rim rings ──────────────────────────────────────────────────
  const rimColors = ['#2a1f08','#ffe27a','#c69511','#6a4d04','#ffd966','#8a6a13','#c69511','#3a2800'];
  const rimWidths = [2, 2, 2, 1.5, 1.5, 1.5, 1.5, 1.5];
  let rimR = R;
  for (let i = 0; i < rimColors.length; i++) {
    g.beginPath();
    g.arc(cx, cy, rimR, 0, Math.PI * 2);
    g.fillStyle = rimColors[i];
    g.fill();
    rimR -= rimWidths[i] * (R / 200);
  }

  // ── Segment face (inner playing area) ────────────────────────────────
  const playR = rimR;          // radius of coloured segments
  const segRad = (Math.PI * 2) / WHEEL_SEQUENCE.length;

  WHEEL_SEQUENCE.forEach((n, i) => {
    const startA = i * segRad - Math.PI / 2;
    const endA   = startA + segRad;

    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, playR, startA, endA);
    g.closePath();

    const c = colorOf(n);
    g.fillStyle = c === 'red' ? '#c0392b' : c === 'black' ? '#1a1a1a' : '#27ae60';
    g.fill();

    // Divider lines in gold
    g.strokeStyle = '#ffd700';
    g.lineWidth = 0.5 * (R / 150);
    g.stroke();
  });

  // ── Number labels ─────────────────────────────────────────────────────
  const labelR = playR * 0.78;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';

  WHEEL_SEQUENCE.forEach((n, i) => {
    const midA = i * segRad - Math.PI / 2 + segRad / 2;
    const lx = cx + labelR * Math.cos(midA);
    const ly = cy + labelR * Math.sin(midA);

    g.save();
    g.translate(lx, ly);
    g.rotate(midA + Math.PI / 2);
    g.font = `800 ${Math.round(R * 0.068)}px 'Segoe UI', Arial, sans-serif`;
    g.fillText(String(n), 0, 0);
    g.restore();
  });

  // ── Ball track groove ─────────────────────────────────────────────────
  const trackR = playR + (R - playR) * 0.45;
  g.beginPath();
  g.arc(cx, cy, trackR, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255, 230, 150, 0.4)';
  g.lineWidth = 2 * (R / 200);
  g.stroke();

  // ── Turret (center hub + arms + bulbs) ────────────────────────────────
  const hubR = R * 0.10;

  // Arms
  const armLen = R * 0.26;
  const armW   = R * 0.035;
  const armGrad = g.createLinearGradient(cx, cy - armLen, cx, cy);
  armGrad.addColorStop(0, '#fff5c4');
  armGrad.addColorStop(0.5, '#ffd700');
  armGrad.addColorStop(1, '#a07700');
  for (let a = 0; a < 4; a++) {
    g.save();
    g.translate(cx, cy);
    g.rotate(a * Math.PI / 2);
    g.beginPath();
    g.roundRect(-armW / 2, -armLen, armW, armLen, armW / 3);
    g.fillStyle = armGrad;
    g.fill();
    g.strokeStyle = '#3a2800';
    g.lineWidth = 0.5;
    g.stroke();
    // Bulb at tip
    g.beginPath();
    g.arc(0, -armLen, R * 0.028, 0, Math.PI * 2);
    const bulbGrad = g.createRadialGradient(-1, -armLen - 2, 1, 0, -armLen, R * 0.028);
    bulbGrad.addColorStop(0, '#fff5c4');
    bulbGrad.addColorStop(0.4, '#ffd700');
    bulbGrad.addColorStop(1, '#4a3500');
    g.fillStyle = bulbGrad;
    g.fill();
    g.restore();
  }

  // Base disc
  g.beginPath();
  g.arc(cx, cy, hubR, 0, Math.PI * 2);
  g.fillStyle = '#1f1500';
  g.fill();
  g.strokeStyle = '#ffd700';
  g.lineWidth = 1;
  g.stroke();

  // Spindle
  const spindleGrad = g.createRadialGradient(cx - R*0.02, cy - R*0.02, 1, cx, cy, hubR * 0.7);
  spindleGrad.addColorStop(0, '#fff5c4');
  spindleGrad.addColorStop(0.4, '#ffd700');
  spindleGrad.addColorStop(1, '#4a3500');
  g.beginPath();
  g.arc(cx, cy, hubR * 0.7, 0, Math.PI * 2);
  g.fillStyle = spindleGrad;
  g.fill();

  // Cap knob
  g.beginPath();
  g.arc(cx, cy, hubR * 0.3, 0, Math.PI * 2);
  g.fillStyle = '#fff5c4';
  g.fill();

  // Sheen overlay — top-left highlight for depth
  const sheen = g.createRadialGradient(cx - R * 0.15, cy - R * 0.2, 0, cx, cy, R * 0.9);
  sheen.addColorStop(0, 'rgba(255,255,255,0.15)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = sheen;
  g.fill();

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

  // Ball
  if (_ball.visible) {
    const trackR  = (R * 0.875) * (_ball.outerR + (R > 0 ? 0 : 0)); // use actual radius
    const ballOrbitR = R * _ball.radius;

    // Settle bounce: small radial oscillation
    let bounceOffset = 0;
    if (_ball.settling && _ball.settleT < 0.6) {
      const t = _ball.settleT / 0.6;
      bounceOffset = Math.sin(t * Math.PI * 3) * R * 0.03 * (1 - t);
    }

    const bx = cx + (ballOrbitR + bounceOffset) * Math.cos(-_ball.angle - Math.PI / 2);
    const by = cy + (ballOrbitR + bounceOffset) * Math.sin(-_ball.angle - Math.PI / 2);
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
  stopSpinSound(200);
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
