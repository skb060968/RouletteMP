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
import { WHEEL_SEQUENCE, colorOf, rotationForWinning } from './wheel.js';
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
      renderRecentResults();
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
  const keys = Object.keys(players).sort();
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
  renderRecentResults();
  renderPlayerStrip();
  renderTotalBets();
  // Reset wheel rotation (preserving the perspective tilt)
  const wheel = document.getElementById('tv-wheel');
  if (wheel) wheel.style.transform = 'rotateX(14deg) rotate(0deg)';
  // Reset ball orbit
  const ballOrbit = document.getElementById('tv-ball-orbit');
  if (ballOrbit) {
    ballOrbit.classList.remove('spinning', 'settled');
    ballOrbit.style.transition = 'none';
    ballOrbit.style.transform = `rotateX(14deg) rotate(0deg)`;
  }
  // Hide winning-number tag and rien flash
  const tag = document.getElementById('tv-winning-tag');
  if (tag) { tag.classList.remove('show'); tag.innerHTML = ''; }
  const rien = document.getElementById('tv-rien');
  if (rien) rien.classList.remove('show');
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
  if (firebaseSnapshot.meta?.status !== 'betting') return; // already spinning

  stopCountdown();
  await fbCloseBets(roomCode);

  // Pick the winning number locally
  const winningNumber = Math.floor(Math.random() * 37);

  // "Rien ne va plus" flash — adds the casino-call moment between bets
  // closing and the wheel spinning.
  const rien = document.getElementById('tv-rien');
  if (rien) {
    rien.classList.remove('show');
    void rien.offsetWidth;
    rien.classList.add('show');
  }
  playSound('betClose', 0.6);

  // After the flash (1s), start the wheel spin
  setTimeout(() => {
    const wheel = document.getElementById('tv-wheel');
    const tag = document.getElementById('tv-winning-tag');
    if (tag) {
      tag.innerHTML = `<span class="spinning">SPINNING…</span>`;
      tag.classList.add('show');
    }
    if (wheel) {
      const deg = rotationForWinning(winningNumber, 5);
      wheel.style.transition = 'transform 5s cubic-bezier(0.2, 0.85, 0.3, 1)';
      // Preserve the perspective tilt during the rotation.
      wheel.style.transform = `rotateX(14deg) rotate(${deg}deg)`;
    }
    // Ball orbits opposite direction at decreasing speed. We rotate the
    // ball-orbit wrapper from 0 to -7 full turns over 5s. End position is
    // 0deg (i.e. ball lands at the 12 o'clock pointer, which by then has
    // the winning segment under it after the wheel has turned).
    const ballOrbit = document.getElementById('tv-ball-orbit');
    if (ballOrbit) {
      ballOrbit.classList.remove('settled');
      ballOrbit.classList.add('spinning');
      ballOrbit.style.transition = 'none';
      ballOrbit.style.transform = `rotateX(14deg) rotate(0deg)`;
      void ballOrbit.offsetWidth;
      ballOrbit.style.transition = 'transform 5s cubic-bezier(0.15, 0.7, 0.3, 1)';
      ballOrbit.style.transform = `rotateX(14deg) rotate(-2520deg)`;  // 7 full opposite turns
    }
    playSound('spin', 0.5);

    // Ball-drop "tink" right at the moment the wheel settles. ~4.7s into
    // the 5s easing, the rotation is essentially done. Using error.mp3 as
    // a stand-in until a proper SFX is sourced.
    setTimeout(() => playSound('error', 0.6), 4700);

    if (_spinAnimationTimer) clearTimeout(_spinAnimationTimer);
    _spinAnimationTimer = setTimeout(async () => {
      // Trigger the settle bounce on the ball
      if (ballOrbit) {
        ballOrbit.classList.remove('spinning');
        ballOrbit.classList.add('settled');
      }
      await onSpinSettled(winningNumber);
    }, 5000);
  }, 1000);
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

  // Only celebrate with a win chime if at least one player actually won.
  // Otherwise the round end is silent on TV — players' phones will
  // celebrate themselves via their own win toast + sound.
  const anyoneWon = Object.values(payouts).some((p) => (p?.netDelta || 0) > 0);
  if (anyoneWon) playSound('win');

  // Build a single update bundle
  const updates = {};
  Object.keys(newBalances).forEach((k) => {
    updates[`players/${k}/chips`] = newBalances[k];
    updates[`players/${k}/broke`] = !!newBroke[k];
    updates[`payouts/${k}`] = payouts[k];
  });
  await applyPayouts(roomCode, updates);
  await pushResult(roomCode, winningNumber, firebaseSnapshot.game?.lastResults || []);

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
  burstConfetti(color);

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

function burstConfetti(color) {
  if (typeof window.confetti !== 'function') return;
  const palette = color === 'red'   ? ['#ff6b6b', '#c0392b', '#fff'] :
                  color === 'black' ? ['#34495e', '#2c3e50', '#fff'] :
                                      ['#2ecc71', '#27ae60', '#fff'];
  try {
    window.confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 }, colors: palette });
  } catch (_) {}
}

/* ======= WHEEL CONSTRUCTION ======= */
function buildWheel() {
  // Rendered once with inline SVG so we don't need a wheel.png asset.
  const wheel = document.getElementById('tv-wheel');
  if (!wheel || wheel.dataset._built) return;
  wheel.dataset._built = '1';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '-100 -100 200 200');
  svg.setAttribute('class', 'wheel-svg');

  const cx = 0, cy = 0, r = 90;
  const segDeg = 360 / WHEEL_SEQUENCE.length;
  WHEEL_SEQUENCE.forEach((n, i) => {
    const startA = (i * segDeg - 90) * Math.PI / 180;
    const endA = ((i + 1) * segDeg - 90) * Math.PI / 180;
    const x1 = cx + r * Math.cos(startA);
    const y1 = cy + r * Math.sin(startA);
    const x2 = cx + r * Math.cos(endA);
    const y2 = cy + r * Math.sin(endA);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2} Z`);
    const c = colorOf(n);
    path.setAttribute('fill', c === 'red' ? '#c0392b' : c === 'black' ? '#1a1a1a' : '#27ae60');
    path.setAttribute('stroke', '#ffd700');
    path.setAttribute('stroke-width', '0.4');
    svg.appendChild(path);

    // Number label
    const labelA = ((i + 0.5) * segDeg - 90) * Math.PI / 180;
    const lr = r * 0.78;
    const lx = cx + lr * Math.cos(labelA);
    const ly = cy + lr * Math.sin(labelA);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', lx);
    text.setAttribute('y', ly);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', '#fff');
    text.setAttribute('font-size', '7');
    text.setAttribute('font-weight', '800');
    text.setAttribute('transform', `rotate(${i * segDeg + segDeg / 2}, ${lx}, ${ly})`);
    text.textContent = String(n);
    svg.appendChild(text);
  });
  // Center hub — layered gradient for chrome/gold metallic depth
  const svgNS_def = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(svgNS_def, 'defs');
  defs.innerHTML = `
    <radialGradient id="hub-grad" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#fff5c4"/>
      <stop offset="35%" stop-color="#ffd700"/>
      <stop offset="80%" stop-color="#a07700"/>
      <stop offset="100%" stop-color="#4a3500"/>
    </radialGradient>`;
  svg.insertBefore(defs, svg.firstChild);
  const hub = document.createElementNS(svgNS, 'circle');
  hub.setAttribute('cx', cx);
  hub.setAttribute('cy', cy);
  hub.setAttribute('r', '14');
  hub.setAttribute('fill', 'url(#hub-grad)');
  hub.setAttribute('stroke', '#3a2800');
  hub.setAttribute('stroke-width', '0.6');
  svg.appendChild(hub);
  // Inner highlight on hub for extra polish
  const hubShine = document.createElementNS(svgNS, 'ellipse');
  hubShine.setAttribute('cx', cx - 3);
  hubShine.setAttribute('cy', cy - 4);
  hubShine.setAttribute('rx', '5');
  hubShine.setAttribute('ry', '2.5');
  hubShine.setAttribute('fill', 'rgba(255,255,255,0.6)');
  svg.appendChild(hubShine);

  wheel.appendChild(svg);
}

/* ======= RENDER HELPERS ======= */
function renderRecentResults() {
  const strip = document.getElementById('tv-recent');
  if (!strip) return;
  const last = (firebaseSnapshot.game?.lastResults || []).slice(-10);
  strip.innerHTML = last.length
    ? last.map((n) => {
        const c = colorOf(n);
        return `<span class="recent-chip ${c}">${n}</span>`;
      }).join('')
    : '<span class="recent-empty">No spins yet</span>';
}

function renderPlayerStrip() {
  const strip = document.getElementById('tv-player-strip');
  if (!strip) return;
  const players = firebaseSnapshot.players || {};
  const keys = Object.keys(players).sort();
  strip.innerHTML = '';
  keys.forEach((k) => {
    const p = players[k] || {};
    const card = document.createElement('div');
    card.className = 'tv-player-card';
    if (p.broke || (p.chips ?? 0) <= 0) card.classList.add('broke');
    if (!p.connected) card.classList.add('disconnected');
    card.innerHTML = `
      <span class="pc-emoji">${escapeHtml(p.emoji || '😀')}</span>
      <span class="pc-name">${escapeHtml(p.name || 'Player')}</span>
      <span class="pc-chips">💰 ${p.chips ?? 0}</span>`;
    strip.appendChild(card);
  });
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
