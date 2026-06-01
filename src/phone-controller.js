/**
 * Roulette MP — Phone controller
 *
 * Player flow: home → phone-join → phone-lobby → phone-bet → phone-spin → phone-result
 *
 * The phone writes only its own bets (debounced ~200ms) and reads everything
 * else from Firebase.
 */

import {
  joinRoomAsPlayer, listenRoom, setupPlayerDisconnectHandler,
  writeBet, clearPlayerBets, leaveRoom, rejoinRoom,
  serverNow, MAX_PLAYERS,
} from './firebase-sync.js';
import { BET_TYPES, betKey, payoutMultiplier, resolveBets } from './bet-validator.js';
import { colorOf } from './wheel.js';
import { totalCommitted } from './game-engine.js';
import { initAudio, playSound, isMuted, toggleMute } from './sound-manager.js';
import { showScreen, showToast } from './platform-ui.js';

const SESSION_KEY = 'roulette_mp_session';
const CHIP_DENOMINATIONS = [1, 5, 25, 100];

let roomCode = null;
let playerIndex = null;
let unsubscribe = null;
let firebaseSnapshot = {};
let selectedDenom = 25;
/** Local pending bets — keyed by betKey, value is the chip count. Mirrors
 *  what's written to Firebase but allows instant UI feedback before round-trip. */
let localBets = {};
/** Snapshot of bets taken at spin time so the result panel can keep showing
 *  what the player wagered even after lobby/round reset wipes localBets. */
let lastRoundBets = {};
/** Snapshot of full bet objects {type, target, chips} so we can reuse the
 *  bet-validator's resolveBets() to compute per-bet outcome on the phone. */
let lastRoundBetObjects = [];
/** Debounced bet-write timers keyed by betKey. */
const _betWriteTimers = new Map();

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        role: 'phone', roomCode, playerIndex,
      }));
    } catch (_) {}
  }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

/* ======= ENTRY ======= */
export function startPhoneFlow(prefilledCode) {
  document.body.dataset.mode = 'phone';
  initAudio();
  if (prefilledCode) {
    const input = document.getElementById('phone-join-code');
    if (input) input.value = prefilledCode.toUpperCase();
  }
  showScreen('phone-join');
  wirePhoneJoin();
  wirePhoneLobby();
  wirePhoneGame();
}

export async function resumePhoneSession(savedRoomCode, savedPlayerIndex) {
  document.body.dataset.mode = 'phone';
  initAudio();
  roomCode = savedRoomCode;
  playerIndex = savedPlayerIndex;
  const result = await rejoinRoom(savedRoomCode, savedPlayerIndex, 'phone');
  if (!result.success) { clearSession(); showScreen('home'); return; }
  setupPlayerDisconnectHandler(roomCode, playerIndex);
  attachRoomListener();
  if (result.status === 'lobby') showScreen('phone-lobby');
  else showScreen('phone-game');
  wirePhoneJoin();
  wirePhoneLobby();
  wirePhoneGame();
}

/* ======= JOIN ======= */
function wirePhoneJoin() {
  const screen = document.getElementById('phone-join');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const emojiPicker = document.querySelector('.phone-emoji-picker');
  if (emojiPicker) {
    emojiPicker.querySelectorAll('.emoji-btn').forEach((b) => {
      b.addEventListener('click', () => {
        emojiPicker.querySelectorAll('.emoji-btn').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    });
  }
  const submit = document.getElementById('btn-phone-join-submit');
  const back = document.getElementById('btn-phone-join-back');
  if (submit) submit.addEventListener('click', async () => {
    const code = (document.getElementById('phone-join-code')?.value || '').trim().toUpperCase();
    const name = (document.getElementById('phone-join-name')?.value || '').trim();
    if (!code || code.length !== 4) { showToast('Enter a 4-letter room code'); return; }
    if (!name) { showToast('Enter your name'); return; }
    const sel = document.querySelector('.phone-emoji-picker .emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '😀';
    try {
      const result = await joinRoomAsPlayer(code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code;
      playerIndex = result.playerIndex;
      saveSession();
      setupPlayerDisconnectHandler(roomCode, playerIndex);
      attachRoomListener();
      showScreen('phone-lobby');
      renderPhoneLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to join.');
    }
  });
  if (back) back.addEventListener('click', () => {
    showScreen('home');
    delete document.body.dataset.mode;
  });
}

/* ======= ROOM LISTENER ======= */
function attachRoomListener() {
  if (unsubscribe) unsubscribe();
  unsubscribe = listenRoom(roomCode, {
    onMetaChange: (meta) => {
      firebaseSnapshot.meta = meta;
      const status = meta.status;
      if (status === 'lobby') {
        // Round just reset — clear local bet state
        localBets = {};
        lastRoundBets = {};
        lastRoundBetObjects = [];
        showScreen('phone-lobby');
        renderPhoneLobby();
      } else if (status === 'betting') {
        // New round opened — clear all bet state so players start fresh
        localBets = {};
        lastRoundBets = {};
        lastRoundBetObjects = [];
        showScreen('phone-game');
        renderBetBoard();
        renderResultPanel();
        renderHeader();
        startCountdownDisplay();
      } else if (status === 'spinning') {
        // Snapshot bets the moment betting closes — Firebase may clear them
        // before the result phase finishes rendering.
        snapshotLastRoundBets();
        renderHeader();
        renderBetBoard(); // disabled overlay
        renderResultPanel();
      } else if (status === 'payout') {
        renderHeader();
        renderBetBoard();
        renderResultPanel();
      } else if (status === 'ended') {
        showToast('Host closed the room.');
        cleanupAndGoHome();
      }
    },
    onPlayersChange: (players) => {
      const oldPlayers = firebaseSnapshot.players;
      firebaseSnapshot.players = players;
      const myKey = `player_${playerIndex}`;
      if (players && Object.keys(players).length > 0 && !players[myKey]) {
        showToast('Removed from room.');
        cleanupAndGoHome();
        return;
      }
      
      // Fix: If player was broke and now has chips during payout phase,
      // clear result screen so they can see the bet board (disabled until betting opens)
      const status = firebaseSnapshot.meta?.status;
      const me = players?.[myKey];
      const oldMe = oldPlayers?.[myKey];
      if (status === 'payout' && me && oldMe) {
        const wasBroke = oldMe.broke || (oldMe.chips ?? 0) <= 0;
        const nowHasChips = !me.broke && (me.chips ?? 0) > 0;
        if (wasBroke && nowHasChips) {
          // Player received bonus/reset — clear result screen state
          lastRoundBets = {};
          lastRoundBetObjects = [];
          showToast(`💰 Received ${me.chips} chips!`, 2000);
          renderResultPanel(); // Will hide result panel and show bet board
        }
      }
      
      renderPhoneLobby();
      renderHeader();
      renderBetBoard();
    },
    onBetsChange: (bets) => {
      firebaseSnapshot.bets = bets;
      // Sync local bets from Firebase if a round just opened (localBets may
      // have stale entries from previous round during a refresh).
      const myKey = `player_${playerIndex}`;
      const myBets = (bets && bets[myKey]) || {};
      // Merge: prefer local pending writes if present, else use server.
      const merged = {};
      Object.keys(myBets).forEach((k) => {
        merged[k] = myBets[k]?.chips || 0;
      });
      // If local has entries not yet written, keep them
      Object.keys(localBets).forEach((k) => {
        if (localBets[k] > 0 && !merged[k]) merged[k] = localBets[k];
      });
      // Don't override local if a write is in flight for that key
      _betWriteTimers.forEach((_, k) => { merged[k] = localBets[k]; });
      // Apply only if room status is betting (else we want server truth)
      if (firebaseSnapshot.meta?.status === 'betting') {
        localBets = merged;
      }
      renderBetBoard();
    },
    onWheelChange: (wheel) => {
      firebaseSnapshot.wheel = wheel;
      renderHeader();
      renderResultPanel();
    },
    onGameChange: (game) => {
      firebaseSnapshot.game = game;
      renderHeader();
    },
    onPayoutsChange: (payouts) => {
      firebaseSnapshot.payouts = payouts;
      renderResultPanel();
      // Show "you won X" toast on payout — winner only celebrates with
      // confetti + win sound; loser hears a soft error chime; player
      // who just went broke gets a louder error to mark the moment.
      const status = firebaseSnapshot.meta?.status;
      if (status === 'payout' && payouts && playerIndex != null) {
        const my = payouts[`player_${playerIndex}`];
        if (my && !my._shown) {
          my._shown = true;
          if (my.netDelta > 0) {
            showToast(`🏆 You won ${my.netDelta} chips!`, 2400);
            playSound('win');
            burstPhoneConfetti();
          } else if (my.netDelta < 0) {
            // Result panel below shows the loss in detail; only flag the
            // moment a player actually goes broke with the louder error.
            const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
            if (me && (me.broke || (me.chips ?? 0) <= 0)) {
              playSound('error', 0.7);
            }
          }
        }
      }
    },
    onRoomDeleted: () => {
      showToast('Host closed the room.');
      cleanupAndGoHome();
    },
  });
}

/* ======= LOBBY ======= */
function wirePhoneLobby() {
  const screen = document.getElementById('phone-lobby');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const leave = document.getElementById('btn-phone-leave-lobby');
  if (leave) leave.addEventListener('click', async () => {
    if (roomCode != null && playerIndex != null) {
      try { await leaveRoom(roomCode, playerIndex); } catch (_) {}
    }
    cleanupAndGoHome();
  });
  const muteBtn = document.getElementById('btn-phone-lobby-mute');
  if (muteBtn) {
    muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }
}

function renderPhoneLobby() {
  const codeEl = document.getElementById('phone-lobby-code');
  if (codeEl) codeEl.textContent = roomCode || '----';
  const list = document.getElementById('phone-lobby-players');
  if (!list) return;
  const players = firebaseSnapshot.players || {};
  // Skip ghost slots (see firebase-sync joinRoomAsPlayer for context).
  const keys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
  list.innerHTML = '';
  keys.forEach((k) => {
    const p = players[k] || {};
    const li = document.createElement('li');
    li.className = 'phone-lobby-player';
    const isMe = k === `player_${playerIndex}`;
    li.innerHTML = `<span class="emoji">${escapeHtml(p.emoji || '😀')}</span><span class="name">${escapeHtml(p.name || 'Player')}${isMe ? ' (you)' : ''}</span><span class="chips">💰 ${p.chips ?? 0}</span>`;
    if (!p.connected) li.classList.add('disconnected');
    if (p.broke) li.classList.add('broke');
    list.appendChild(li);
  });
  const countEl = document.getElementById('phone-lobby-count');
  if (countEl) countEl.textContent = `${keys.length} / ${MAX_PLAYERS}`;
}

/* ======= GAME / BET BOARD ======= */
function wirePhoneGame() {
  const screen = document.getElementById('phone-game');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  buildBetBoard();

  const muteBtn = document.getElementById('btn-phone-game-mute');
  if (muteBtn) {
    muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }
  const clearBtn = document.getElementById('btn-phone-clear-bets');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (firebaseSnapshot.meta?.status !== 'betting') return;
    localBets = {};
    if (roomCode != null && playerIndex != null) {
      try { await clearPlayerBets(roomCode, playerIndex); } catch (_) {}
    }
    renderBetBoard();
  });

  // Wire chip denomination row
  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedDenom = parseInt(btn.dataset.denom, 10);
      document.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('selected', b === btn));
    });
  });
}

/**
 * Builds the betting felt: numbers grid 0-36 plus dozens / outside / columns.
 * Built once, then renderBetBoard() updates chip stacks and disabled state.
 */
function buildBetBoard() {
  const board = document.getElementById('phone-bet-board');
  if (!board || board.dataset._built) return;
  board.dataset._built = '1';

  // Felt structure:
  // .felt-zero (0) | .felt-numbers (3 rows × 12 cols) | .felt-columns (3 cells)
  // .felt-dozens (3 cells)
  // .felt-outside (6 cells: 1-18, EVEN, RED, BLACK, ODD, 19-36)
  const html = [];
  html.push('<div class="felt-row felt-row-numbers">');
  // Zero cell
  html.push(`<div class="felt-cell felt-zero" data-bet-type="${BET_TYPES.STRAIGHT}" data-bet-target="0">0</div>`);
  // Number columns 1-12 going up: each column has 3 numbers (top→bottom: 3, 2, 1; 6,5,4; etc)
  html.push('<div class="felt-numbers">');
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 3; row++) {
      const n = (col * 3) + (3 - row);
      const c = colorOf(n);
      html.push(`<div class="felt-cell felt-num ${c}" data-bet-type="${BET_TYPES.STRAIGHT}" data-bet-target="${n}">${n}</div>`);
    }
  }
  html.push('</div>');
  // Column 2:1 cells (one per row, same right side)
  html.push('<div class="felt-columns">');
  html.push(`<div class="felt-cell felt-col" data-bet-type="${BET_TYPES.COLUMN}" data-bet-target="3">2:1</div>`);
  html.push(`<div class="felt-cell felt-col" data-bet-type="${BET_TYPES.COLUMN}" data-bet-target="2">2:1</div>`);
  html.push(`<div class="felt-cell felt-col" data-bet-type="${BET_TYPES.COLUMN}" data-bet-target="1">2:1</div>`);
  html.push('</div>');
  html.push('</div>'); // /.felt-row-numbers

  // Dozens row
  html.push('<div class="felt-row felt-row-dozens">');
  html.push(`<div class="felt-cell felt-dozen" data-bet-type="${BET_TYPES.DOZEN}" data-bet-target="1">1st 12</div>`);
  html.push(`<div class="felt-cell felt-dozen" data-bet-type="${BET_TYPES.DOZEN}" data-bet-target="2">2nd 12</div>`);
  html.push(`<div class="felt-cell felt-dozen" data-bet-type="${BET_TYPES.DOZEN}" data-bet-target="3">3rd 12</div>`);
  html.push('</div>');

  // Outside row
  html.push('<div class="felt-row felt-row-outside">');
  html.push(`<div class="felt-cell felt-outside" data-bet-type="${BET_TYPES.LOW}">1-18</div>`);
  html.push(`<div class="felt-cell felt-outside" data-bet-type="${BET_TYPES.EVEN}">EVEN</div>`);
  html.push(`<div class="felt-cell felt-outside red" data-bet-type="${BET_TYPES.RED}">RED</div>`);
  html.push(`<div class="felt-cell felt-outside black" data-bet-type="${BET_TYPES.BLACK}">BLACK</div>`);
  html.push(`<div class="felt-cell felt-outside" data-bet-type="${BET_TYPES.ODD}">ODD</div>`);
  html.push(`<div class="felt-cell felt-outside" data-bet-type="${BET_TYPES.HIGH}">19-36</div>`);
  html.push('</div>');

  board.innerHTML = html.join('');

  // Wire bet taps
  board.querySelectorAll('.felt-cell').forEach((cell) => {
    cell.addEventListener('click', () => onBetCellTap(cell));
  });
}

function onBetCellTap(cell) {
  if (firebaseSnapshot.meta?.status !== 'betting') return;
  const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
  if (!me || me.broke || (me.chips ?? 0) <= 0) return;

  const type = cell.dataset.betType;
  const targetRaw = cell.dataset.betTarget;
  const target = targetRaw == null || targetRaw === '' ? null : parseInt(targetRaw, 10);
  const key = betKey(type, target);
  if (!key) return;

  // Check we're not over-betting
  const currentTotal = totalLocal();
  if (currentTotal + selectedDenom > (me.chips ?? 0)) {
    showToast('Not enough chips for that bet');
    playSound('error', 0.4);
    if (navigator.vibrate) try { navigator.vibrate(40); } catch (_) {}
    return;
  }

  localBets[key] = (localBets[key] || 0) + selectedDenom;
  playSound('chip', 0.5);
  // Subtle haptic + press-in animation for tactile feedback.
  if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {}
  cell.classList.remove('press');
  void cell.offsetWidth;
  cell.classList.add('press');
  renderBetBoard();
  scheduleBetWrite(key, type, target);
}

function totalLocal() {
  return Object.values(localBets).reduce((s, n) => s + n, 0);
}

/** Phone-side confetti for the winner. Bursts colors matching the winning
 *  number's color (red/black/green) so it feels themed. */
function burstPhoneConfetti() {
  if (typeof window.confetti !== 'function') return;
  const win = firebaseSnapshot.wheel?.winningNumber;
  const c = win == null ? 'green' : colorOf(win);
  const palette = c === 'red'   ? ['#ff6b6b', '#c0392b', '#fff', '#ffd700'] :
                  c === 'black' ? ['#34495e', '#2c3e50', '#fff', '#ffd700'] :
                                  ['#2ecc71', '#27ae60', '#fff', '#ffd700'];
  try {
    window.confetti({
      particleCount: 140,
      spread: 80,
      origin: { y: 0.4 },
      colors: palette,
    });
  } catch (_) {}
}

function scheduleBetWrite(key, type, target) {
  // Debounce per-key so rapid taps batch into one Firebase write.
  if (_betWriteTimers.has(key)) clearTimeout(_betWriteTimers.get(key));
  const t = setTimeout(async () => {
    _betWriteTimers.delete(key);
    if (roomCode == null || playerIndex == null) return;
    const chips = localBets[key] || 0;
    try {
      await writeBet(roomCode, playerIndex, key, chips > 0 ? { type, target, chips } : null);
    } catch (err) {
      console.warn('writeBet failed:', err.message);
    }
  }, 220);
  _betWriteTimers.set(key, t);
}

/**
 * Renders chip stacks on each felt cell, plus disabled overlay when not betting.
 */
function renderBetBoard() {
  const board = document.getElementById('phone-bet-board');
  if (!board || !board.dataset._built) return;

  const status = firebaseSnapshot.meta?.status;
  const isBetting = status === 'betting';
  board.classList.toggle('locked', !isBetting);
  // Player tag
  renderPlayerTag();

  // Per-cell chip stacks
  board.querySelectorAll('.felt-cell').forEach((cell) => {
    const type = cell.dataset.betType;
    const targetRaw = cell.dataset.betTarget;
    const target = targetRaw == null || targetRaw === '' ? null : parseInt(targetRaw, 10);
    const key = betKey(type, target);
    const chips = key ? (localBets[key] || 0) : 0;
    const existingTag = cell.querySelector('.felt-chip-stack');
    if (chips > 0) {
      const html = `<span class="felt-chip-stack">${chips}</span>`;
      if (!existingTag) cell.insertAdjacentHTML('beforeend', html);
      else existingTag.textContent = chips;
      cell.classList.add('has-bet');
    } else {
      if (existingTag) existingTag.remove();
      cell.classList.remove('has-bet');
    }

    // Highlight winning cells on payout
    if (status === 'payout' && firebaseSnapshot.wheel?.winningNumber != null) {
      const win = firebaseSnapshot.wheel.winningNumber;
      const wins = isWinningCell(type, target, win);
      cell.classList.toggle('winning', wins);
    } else {
      cell.classList.remove('winning');
    }
  });

  // Tray
  const tray = document.getElementById('phone-bet-tray');
  if (tray) {
    const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
    const balance = me?.chips ?? 0;
    const total = totalLocal();
    // Itemized ledger: short label per bet + chip count, plus total/balance
    // pinned to the right. Empty state shows just the balance. The bet count
    // pill shows N bets at a glance so the player always knows their action.
    const items = [];
    let count = 0;
    Object.keys(localBets).forEach((k) => {
      const chips = localBets[k];
      if (!chips) return;
      count += 1;
      items.push(`<span class="ledger-item">${labelForBetKey(k)} <strong>${chips}</strong></span>`);
    });
    if (items.length === 0) {
      tray.innerHTML = `<span class="ledger-balance">💰 ${balance}</span>`;
    } else {
      tray.innerHTML = `
        <span class="ledger-count">${count} bet${count === 1 ? '' : 's'}</span>
        <span class="ledger-items">${items.join('')}</span>
        <span class="ledger-summary">Bet ${total} · Left ${balance - total}</span>`;
    }
  }
}

/** Snapshots local bets to a parallel store so the result panel can keep
 *  showing them after the round transitions or Firebase clears them. Called
 *  the moment the meta status flips to 'spinning'. */
function snapshotLastRoundBets() {
  lastRoundBets = { ...localBets };
  // Also keep the full bet objects so resolveBets() can compute outcomes.
  lastRoundBetObjects = [];
  Object.keys(lastRoundBets).forEach((k) => {
    const chips = lastRoundBets[k];
    if (!chips) return;
    const { type, target } = parseBetKey(k);
    if (type) lastRoundBetObjects.push({ type, target, chips });
  });
}

/** Reverses betKey() — returns {type, target} for a stored bet key. */
function parseBetKey(key) {
  if (key.startsWith('s-')) return { type: BET_TYPES.STRAIGHT, target: parseInt(key.slice(2), 10) };
  if (key.startsWith('d-')) return { type: BET_TYPES.DOZEN,    target: parseInt(key.slice(2), 10) };
  if (key.startsWith('c-')) return { type: BET_TYPES.COLUMN,   target: parseInt(key.slice(2), 10) };
  switch (key) {
    case 'red':   return { type: BET_TYPES.RED,   target: null };
    case 'black': return { type: BET_TYPES.BLACK, target: null };
    case 'even':  return { type: BET_TYPES.EVEN,  target: null };
    case 'odd':   return { type: BET_TYPES.ODD,   target: null };
    case 'low':   return { type: BET_TYPES.LOW,   target: null };
    case 'high':  return { type: BET_TYPES.HIGH,  target: null };
    default:      return { type: null, target: null };
  }
}

/**
 * Result panel — shown during spinning + payout phases. Lists every bet the
 * player placed for this round, marks each as won/lost with chips returned,
 * and totals up the net outcome. Hidden during betting and lobby phases (the
 * bet board takes the foreground then).
 */
function renderResultPanel() {
  const panel = document.getElementById('phone-result-panel');
  const board = document.getElementById('phone-bet-board');
  if (!panel || !board) return;

  const status = firebaseSnapshot.meta?.status;
  const isResultPhase = (status === 'spinning' || status === 'payout');
  // No round to show — hide and restore the bet board.
  if (!isResultPhase || lastRoundBetObjects.length === 0) {
    panel.hidden = true;
    panel.innerHTML = '';
    board.hidden = false;
    return;
  }

  // Show the panel instead of the board for the duration of the round result.
  panel.hidden = false;
  board.hidden = true;

  const win = firebaseSnapshot.wheel?.winningNumber;
  const totalStaked = lastRoundBetObjects.reduce((s, b) => s + b.chips, 0);

  // Header: spin in progress vs settled result.
  let headerHtml;
  if (status === 'spinning' || win == null) {
    headerHtml = `
      <div class="rp-header rp-spinning">
        <span class="rp-title">Wheel Spinning…</span>
        <span class="rp-sub">${lastRoundBetObjects.length} bet${lastRoundBetObjects.length === 1 ? '' : 's'} · staked ${totalStaked}</span>
      </div>`;
  } else {
    const c = colorOf(win);
    headerHtml = `
      <div class="rp-header rp-settled">
        <span class="rp-result-label">Winning Number</span>
        <span class="rp-result-num ${c}">${win}</span>
        <span class="rp-result-color ${c}">${c.toUpperCase()}</span>
      </div>`;
  }

  // Per-bet outcome list. During spin we don't know the result yet, so we
  // just list bets with their stake. After reveal we mark won/lost and show
  // chips returned.
  const itemsHtml = lastRoundBetObjects.map((b) => {
    const label = labelForBetKey(betKey(b.type, b.target));
    if (status === 'spinning' || win == null) {
      return `<li class="rp-bet rp-pending">
        <span class="rp-bet-label">${label}</span>
        <span class="rp-bet-stake">${b.chips}</span>
      </li>`;
    }
    const won = (function () {
      const r = resolveBets([b], win);
      return r.totalReturn > 0;
    })();
    const returned = won ? b.chips * (payoutMultiplier(b.type) + 1) : 0;
    const profit   = won ? (returned - b.chips) : -b.chips;
    return `<li class="rp-bet ${won ? 'won' : 'lost'}">
      <span class="rp-bet-label">${label}</span>
      <span class="rp-bet-stake">${b.chips}</span>
      <span class="rp-bet-outcome">${won ? `+${profit}` : `−${b.chips}`}</span>
    </li>`;
  }).join('');

  // Footer: net delta from this round (server is authoritative once payouts
  // arrive — fall back to local computation while spinning).
  let footerHtml = '';
  if (status === 'payout' && win != null) {
    const myPayout = (firebaseSnapshot.payouts || {})[`player_${playerIndex}`];
    const net = myPayout?.netDelta ?? 0;
    const cls = net > 0 ? 'won' : net < 0 ? 'lost' : 'flat';
    const sign = net > 0 ? '+' : net < 0 ? '−' : '';
    const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
    const balance = me?.chips ?? 0;
    footerHtml = `
      <div class="rp-footer ${cls}">
        <span class="rp-net-label">Round Net</span>
        <span class="rp-net-value">${sign}${Math.abs(net)}</span>
        <span class="rp-balance">Balance: ${balance}</span>
      </div>
      <div class="rp-next">Next round opening soon…</div>`;
  } else {
    footerHtml = `
      <div class="rp-footer flat">
        <span class="rp-net-label">Total Staked</span>
        <span class="rp-net-value">${totalStaked}</span>
      </div>`;
  }

  panel.innerHTML = `
    ${headerHtml}
    <ul class="rp-bet-list">${itemsHtml}</ul>
    ${footerHtml}`;
}

/** Short human label for a bet key — used in the bet ledger on phone. */
function labelForBetKey(key) {
  if (key.startsWith('s-')) return `🎯${key.slice(2)}`;
  if (key.startsWith('d-')) {
    const n = key.slice(2);
    return n === '1' ? '1st 12' : n === '2' ? '2nd 12' : '3rd 12';
  }
  if (key.startsWith('c-')) return `Col${key.slice(2)}`;
  switch (key) {
    case 'red':   return '🔴RED';
    case 'black': return '⚫BLACK';
    case 'even':  return 'EVEN';
    case 'odd':   return 'ODD';
    case 'low':   return '1-18';
    case 'high':  return '19-36';
    default:      return key;
  }
}

function isWinningCell(type, target, n) {
  switch (type) {
    case BET_TYPES.STRAIGHT: return n === target;
    case BET_TYPES.RED:      return colorOf(n) === 'red';
    case BET_TYPES.BLACK:    return colorOf(n) === 'black';
    case BET_TYPES.EVEN:     return n !== 0 && n % 2 === 0;
    case BET_TYPES.ODD:      return n !== 0 && n % 2 === 1;
    case BET_TYPES.LOW:      return n >= 1 && n <= 18;
    case BET_TYPES.HIGH:     return n >= 19 && n <= 36;
    case BET_TYPES.DOZEN:
      if (n < 1 || n > 36) return false;
      if (target === 1) return n <= 12;
      if (target === 2) return n >= 13 && n <= 24;
      return n >= 25;
    case BET_TYPES.COLUMN:
      if (n < 1 || n > 36) return false;
      return ((n - 1) % 3) + 1 === target;
    default: return false;
  }
}

/* ======= HEADER ======= */
function renderPlayerTag() {
  const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
  if (!me) return;
  const emojiEl = document.getElementById('phone-player-emoji');
  const nameEl = document.getElementById('phone-player-name');
  const chipsEl = document.getElementById('phone-player-chips');
  if (emojiEl) emojiEl.textContent = me.emoji || '😀';
  if (nameEl) nameEl.textContent = me.name || 'Player';
  if (chipsEl) chipsEl.textContent = `💰 ${me.chips ?? 0}`;
  if (me.broke) document.getElementById('phone-game')?.classList.add('player-broke');
  else document.getElementById('phone-game')?.classList.remove('player-broke');
}

function renderHeader() {
  const status = firebaseSnapshot.meta?.status;
  const headerEl = document.getElementById('phone-header-status');
  if (!headerEl) return;
  if (status === 'betting') {
    const closeAt = firebaseSnapshot.game?.betsCloseAt;
    if (closeAt) {
      // Use server-aligned time so the phone's countdown matches the TV's
      // regardless of device clock drift.
      const sec = Math.max(0, Math.ceil((closeAt - serverNow()) / 1000));
      headerEl.innerHTML = `<span class="status-betting">BETS OPEN · ${sec}s</span>`;
    } else {
      headerEl.innerHTML = `<span class="status-betting">BETS OPEN</span>`;
    }
  } else if (status === 'spinning') {
    headerEl.innerHTML = `<span class="status-spinning">SPINNING…</span>`;
  } else if (status === 'payout') {
    const w = firebaseSnapshot.wheel?.winningNumber;
    if (w != null) {
      const c = colorOf(w);
      headerEl.innerHTML = `<span class="status-result"><span class="num ${c}">${w}</span> · ${c.toUpperCase()}</span>`;
    } else {
      headerEl.innerHTML = `<span class="status-result">RESULT</span>`;
    }
  } else {
    const last = firebaseSnapshot.game?.lastResults || [];
    if (last.length > 0) {
      const w = last[last.length - 1];
      const c = colorOf(w);
      headerEl.innerHTML = `<span class="status-idle">Last: <span class="num ${c}">${w}</span></span>`;
    } else {
      headerEl.innerHTML = `<span class="status-idle">Waiting…</span>`;
    }
  }
  // Round number
  const roundEl = document.getElementById('phone-round');
  if (roundEl) roundEl.textContent = `Round ${firebaseSnapshot.game?.roundNumber || 0}`;
}

let _phoneCountdownTimer = null;
function startCountdownDisplay() {
  if (_phoneCountdownTimer) { clearInterval(_phoneCountdownTimer); _phoneCountdownTimer = null; }
  _phoneCountdownTimer = setInterval(() => {
    const status = firebaseSnapshot.meta?.status;
    if (status !== 'betting') {
      clearInterval(_phoneCountdownTimer);
      _phoneCountdownTimer = null;
      return;
    }
    renderHeader();
  }, 250);
}

/* ======= CLEANUP ======= */
function cleanupAndGoHome() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (_phoneCountdownTimer) { clearInterval(_phoneCountdownTimer); _phoneCountdownTimer = null; }
  _betWriteTimers.forEach((t) => clearTimeout(t));
  _betWriteTimers.clear();
  clearSession();
  roomCode = null;
  playerIndex = null;
  firebaseSnapshot = {};
  localBets = {};
  lastRoundBets = {};
  lastRoundBetObjects = [];
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
