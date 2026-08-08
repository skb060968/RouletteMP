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
import { initAudio, playSound, isMuted, toggleMute } from './sound-manager.js';
import { showScreen, showToast, dismissConfirmModals } from './platform-ui.js';
import { ROOM_CODE_PATTERN } from './deep-link-handler.js';

const SESSION_KEY = 'roulette_mp_session';
const CHIP_DENOMINATIONS = [1, 5, 25, 100];

let roomCode = null;
let playerIndex = null;
let unsubscribe = null;
let cancelPlayerDisconnect = null;
let firebaseSnapshot = {};
let previousPlayers = {};
let selectedDenom = 25;
let activeBetAuthority = null;
let lastPhaseKey = null;
let lastRoundKey = null;
let shownPayoutKey = null;
let _joinInFlight = false;
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
/** Firebase bet mutations are serialized so an older absolute write cannot win last. */
let _betWriteChain = Promise.resolve();
let _betWriteGeneration = 0;
const _pendingBetWrites = new Map();
let _clearWritePending = 0;

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
  cancelPlayerDisconnect = setupPlayerDisconnectHandler(roomCode, playerIndex);
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
    if (_joinInFlight) return;
    const code = (document.getElementById('phone-join-code')?.value || '').trim().toUpperCase();
    const name = (document.getElementById('phone-join-name')?.value || '').trim();
    if (!ROOM_CODE_PATTERN.test(code)) { showToast('Enter a valid 4-letter room code'); return; }
    if (!name) { showToast('Enter your name'); return; }
    const sel = document.querySelector('.phone-emoji-picker .emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '🤵';
    _joinInFlight = true;
    submit.disabled = true;
    if (back) back.disabled = true;
    try {
      const result = await joinRoomAsPlayer(code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code;
      playerIndex = result.playerIndex;
      saveSession();
      cancelPlayerDisconnect = setupPlayerDisconnectHandler(roomCode, playerIndex);
      attachRoomListener();
      showScreen('phone-lobby');
      renderPhoneLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to join.');
    } finally {
      _joinInFlight = false;
      submit.disabled = false;
      if (back) back.disabled = false;
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
    onRoomChange: (room) => {
      firebaseSnapshot = room;
    },
    onMetaChange: (meta) => {
      firebaseSnapshot.meta = meta;
      const game = firebaseSnapshot.game || {};
      const status = game.phase || meta.status;
      const phaseKey = `${status}:${game.roundNumber ?? -1}:${game.revision ?? -1}`;
      if (status !== 'betting') {
        cancelPendingBetWrites();
        activeBetAuthority = null;
      }
      if (phaseKey === lastPhaseKey) return;
      lastPhaseKey = phaseKey;

      if (status === 'lobby') {
        localBets = {};
        lastRoundBets = {};
        lastRoundBetObjects = [];
        showScreen('phone-lobby');
        renderPhoneLobby();
      } else if (status === 'betting') {
        activeBetAuthority = { roundNumber: game.roundNumber, revision: game.revision };
        localBets = {};
        lastRoundBets = {};
        lastRoundBetObjects = [];
        lastRoundKey = null;
        showScreen('phone-game');
        renderBetBoard();
        renderResultPanel();
        renderHeader();
        startCountdownDisplay();
      } else if (status === 'spinning') {
        snapshotLastRoundBets();
        renderHeader();
        renderBetBoard();
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
      const oldPlayers = previousPlayers;
      previousPlayers = players;
      firebaseSnapshot.players = players;
      const myKey = `player_${playerIndex}`;
      if (!players?.[myKey]) {
        showToast('Removed from room.');
        cleanupAndGoHome();
        return;
      }
      
      // Fix: If player was broke and now has chips during payout phase,
      // clear result screen so they can see the bet board (disabled until betting opens)
      const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
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
      if (_clearWritePending === 0) {
        Object.keys(myBets).forEach((key) => {
          merged[key] = myBets[key]?.chips || 0;
        });
      }
      // Preserve only optimistic values that still have a timer or serialized
      // Firebase mutation pending; all other values follow server truth.
      Object.entries(localBets).forEach(([key, chips]) => {
        if (chips > 0 && isBetWritePending(key)) merged[key] = chips;
      });
      if (firebaseSnapshot.game?.phase === 'betting') {
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
      const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
      if (status === 'payout' && payouts && playerIndex != null) {
        const my = payouts[`player_${playerIndex}`];
        const payoutKey = my ? `${my.roundNumber}:${my.revision}` : null;
        if (my && payoutKey !== shownPayoutKey) {
          shownPayoutKey = payoutKey;
          if (my.netDelta > 0) {
            showToast(`🏆 You won ${my.netDelta} chips!`, 2400);
            playSound('win');
            burstPhoneConfetti();
          } else if (my.netDelta < 0) {
            const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
            if (me && (me.broke || (me.chips ?? 0) <= 0)) playSound('error', 0.7);
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
      try {
        await cancelPlayerDisconnect?.();
        cancelPlayerDisconnect = null;
        await leaveRoom(roomCode, playerIndex);
      } catch (_) {}
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

  // Wire help button
  const helpBtn = document.getElementById('btn-phone-help');
  if (helpBtn) {
    helpBtn.addEventListener('click', () => {
      showHelpModal();
    });
  }

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
    if ((firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status) !== 'betting' || !activeBetAuthority) return;
    const authority = { ...activeBetAuthority };
    const targetRoom = roomCode;
    const targetPlayer = playerIndex;
    clearBetWriteTimers();
    localBets = {};
    renderBetBoard();
    if (targetRoom == null || targetPlayer == null) return;
    try {
      await enqueueBetMutation(null, async () => {
        const result = await clearPlayerBets(targetRoom, targetPlayer, authority);
        if (activeBetAuthority?.roundNumber === authority.roundNumber &&
            activeBetAuthority?.revision === authority.revision) {
          reconcileLocalBets(result.playerBets, true);
        }
      });
    } catch (_) {
      const stillCurrent = activeBetAuthority?.roundNumber === authority.roundNumber &&
        activeBetAuthority?.revision === authority.revision;
      if (!stillCurrent) return;
      reconcileLocalBets((firebaseSnapshot.bets || {})[`player_${targetPlayer}`] || {}, true);
      showToast('Bets changed before they could be cleared.');
    }
  });

  document.querySelectorAll('.chip-btn[data-denom]').forEach((btn) => {
    btn.addEventListener('click', () => selectChipDenomination(Number(btn.dataset.denom)));
  });
}

function selectChipDenomination(value) {
  if (!CHIP_DENOMINATIONS.includes(value)) return;
  selectedDenom = value;
  document.querySelectorAll('.chip-btn[data-denom]').forEach((button) => {
    const selected = Number(button.dataset.denom) === value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
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
  const game = firebaseSnapshot.game || {};
  if (game.phase !== 'betting' || !activeBetAuthority ||
      game.roundNumber !== activeBetAuthority.roundNumber || game.revision !== activeBetAuthority.revision) return;
  const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
  if (!me || me.broke || (me.chips ?? 0) <= 0) return;

  const type = cell.dataset.betType;
  const targetRaw = cell.dataset.betTarget;
  const target = targetRaw == null || targetRaw === '' ? null : parseInt(targetRaw, 10);
  const key = betKey(type, target);
  if (!key) return;
  const denom = CHIP_DENOMINATIONS.includes(selectedDenom) ? selectedDenom : 0;
  if (!denom) return;

  // Check we're not over-betting
  const currentTotal = totalLocal();
  if (currentTotal + denom > (Number(me.chips) || 0)) {
    showToast('Not enough chips for that bet');
    playSound('error', 0.4);
    if (navigator.vibrate) try { navigator.vibrate(40); } catch (_) {}
    return;
  }

  localBets[key] = (localBets[key] || 0) + denom;
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
  return Object.values(localBets).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
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

function clearBetWriteTimers() {
  _betWriteTimers.forEach((timer) => clearTimeout(timer));
  _betWriteTimers.clear();
}

function cancelPendingBetWrites() {
  clearBetWriteTimers();
  _betWriteGeneration += 1;
  _pendingBetWrites.clear();
  _clearWritePending = 0;
}

function isBetWritePending(key) {
  return _betWriteTimers.has(key) || (_pendingBetWrites.get(key) || 0) > 0;
}

function enqueueBetMutation(key, operation) {
  const generation = _betWriteGeneration;
  if (key == null) {
    _clearWritePending += 1;
  } else {
    _pendingBetWrites.set(key, (_pendingBetWrites.get(key) || 0) + 1);
  }

  const run = () => generation === _betWriteGeneration ? operation() : undefined;
  const task = _betWriteChain.then(run, run);
  _betWriteChain = task.catch(() => {});
  return task.finally(() => {
    if (generation !== _betWriteGeneration) return;
    if (key == null) {
      _clearWritePending = Math.max(0, _clearWritePending - 1);
    } else {
      const remaining = (_pendingBetWrites.get(key) || 1) - 1;
      if (remaining > 0) _pendingBetWrites.set(key, remaining);
      else _pendingBetWrites.delete(key);
    }
  });
}

function reconcileLocalBets(serverBook, preservePending = false) {
  const reconciled = {};
  if (_clearWritePending === 0) {
    Object.entries(serverBook || {}).forEach(([key, bet]) => {
      if (Number.isSafeInteger(bet?.chips) && bet.chips > 0) reconciled[key] = bet.chips;
    });
  }
  if (preservePending) {
    Object.entries(localBets).forEach(([key, chips]) => {
      if (chips > 0 && isBetWritePending(key)) reconciled[key] = chips;
    });
  }
  localBets = reconciled;
  renderBetBoard();
}

function scheduleBetWrite(key, type, target) {
  if (!activeBetAuthority) return;
  if (_betWriteTimers.has(key)) clearTimeout(_betWriteTimers.get(key));
  const authority = { ...activeBetAuthority };
  const timer = setTimeout(() => {
    _betWriteTimers.delete(key);
    const targetRoom = roomCode;
    const targetPlayer = playerIndex;
    const chips = localBets[key] || 0;
    if (targetRoom == null || targetPlayer == null) return;

    void enqueueBetMutation(key, async () => {
      const game = firebaseSnapshot.game || {};
      if (game.phase !== 'betting' || game.roundNumber !== authority.roundNumber ||
          game.revision !== authority.revision) {
        reconcileLocalBets((firebaseSnapshot.bets || {})[`player_${targetPlayer}`] || {}, true);
        return;
      }
      try {
        const result = await writeBet(
          targetRoom, targetPlayer, key,
          chips > 0 ? { type, target, chips } : null,
          authority,
        );
        if (activeBetAuthority?.roundNumber === authority.roundNumber &&
            activeBetAuthority?.revision === authority.revision) {
          reconcileLocalBets(result.playerBets, true);
        }
      } catch (err) {
        const stillCurrent = activeBetAuthority?.roundNumber === authority.roundNumber &&
          activeBetAuthority?.revision === authority.revision;
        if (!stillCurrent) return;
        cancelPendingBetWrites();
        reconcileLocalBets((firebaseSnapshot.bets || {})[`player_${targetPlayer}`] || {});
        showToast('Bet was rejected; your chips were reconciled.');
        console.warn('writeBet rejected:', err.message);
      }
    });
  }, 220);
  _betWriteTimers.set(key, timer);
}

/**
 * Renders chip stacks on each felt cell, plus disabled overlay when not betting.
 */
function renderBetBoard() {
  const board = document.getElementById('phone-bet-board');
  if (!board || !board.dataset._built) return;

  const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
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
    const balance = Number(me?.chips) || 0;
    const total = totalLocal();
    const left = Math.max(0, balance - total);
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
        <span class="ledger-summary">Bet ${total} · Left ${left}</span>`;
    }
  }
}

/** Snapshots local bets to a parallel store so the result panel can keep
 *  showing them after the round transitions or Firebase clears them. Called
 *  the moment the meta status flips to 'spinning'. */
function snapshotLastRoundBets() {
  const game = firebaseSnapshot.game || {};
  const roundKey = `${game.roundNumber}:${game.revision}`;
  if (lastRoundKey === roundKey) return;
  lastRoundKey = roundKey;
  const myKey = `player_${playerIndex}`;
  const locked = game.lockedBets?.[myKey] || {};
  lastRoundBets = {};
  lastRoundBetObjects = [];
  Object.entries(locked).forEach(([key, bet]) => {
    if (!Number.isSafeInteger(bet?.chips) || bet.chips <= 0) return;
    lastRoundBets[key] = bet.chips;
    lastRoundBetObjects.push({ type: bet.type, target: bet.target ?? null, chips: bet.chips });
  });
  localBets = { ...lastRoundBets };
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

  const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
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
    const balance = Number(me?.chips) || 0;
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
  const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
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
    const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
    if (status !== 'betting') {
      clearInterval(_phoneCountdownTimer);
      _phoneCountdownTimer = null;
      return;
    }
    renderHeader();
  }, 250);
}

/* ======= HELP MODAL ======= */
function showHelpModal() {
  const modal = document.getElementById('help-modal');
  if (!modal) return;
  
  modal.hidden = false;
  
  // Wire close button (only once)
  const closeBtn = document.getElementById('btn-help-close');
  if (closeBtn && !closeBtn.dataset._wired) {
    closeBtn.dataset._wired = '1';
    closeBtn.addEventListener('click', () => {
      modal.hidden = true;
    });
  }
  
  // Close on overlay click
  if (!modal.dataset._wired) {
    modal.dataset._wired = '1';
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.hidden = true;
      }
    });
  }
}

/* ======= CLEANUP ======= */
function cleanupAndGoHome() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (_phoneCountdownTimer) { clearInterval(_phoneCountdownTimer); _phoneCountdownTimer = null; }
  cancelPendingBetWrites();
  if (cancelPlayerDisconnect) { void cancelPlayerDisconnect(); cancelPlayerDisconnect = null; }
  dismissConfirmModals();
  const helpModal = document.getElementById('help-modal');
  if (helpModal) helpModal.hidden = true;
  clearSession();
  roomCode = null;
  playerIndex = null;
  firebaseSnapshot = {};
  previousPlayers = {};
  localBets = {};
  lastRoundBets = {};
  lastRoundBetObjects = [];
  activeBetAuthority = null;
  lastPhaseKey = null;
  lastRoundKey = null;
  shownPayoutKey = null;
  _joinInFlight = false;
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
