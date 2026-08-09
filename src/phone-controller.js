/**
 * Roulette MP — Phone controller
 *
 * Player flow: home → phone-join → phone-lobby → phone-bet → phone-spin → phone-result
 *
 * Phone bets stay in memory as a local draft until the player explicitly
 * confirms the complete book in one Firebase transaction.
 */

import {
  joinRoomAsPlayer, listenRoom, setupPlayerDisconnectHandler,
  replacePlayerBets, leaveRoom, rejoinRoom,
  serverNow, MAX_PLAYERS,
} from './firebase-sync.js';
import {
  BET_INCREMENT, MAX_BET_CHIPS, BET_TYPES, betKey, payoutMultiplier, resolveBets,
} from './bet-validator.js';
import { colorOf } from './wheel.js';
import { initAudio, playSound, isMuted, toggleMute } from './sound-manager.js';
import { showScreen, showToast, dismissConfirmModals } from './platform-ui.js';
import { ROOM_CODE_PATTERN } from './deep-link-handler.js';

const SESSION_KEY = 'roulette_mp_session';

let roomCode = null;
let playerIndex = null;
let unsubscribe = null;
let cancelPlayerDisconnect = null;
let firebaseSnapshot = {};
let previousPlayers = {};
let activeBetAuthority = null;
let lastPhaseKey = null;
let lastRoundKey = null;
let shownPayoutKey = null;
let _joinInFlight = false;
/** Server-confirmed book for the active round. */
let committedBets = {};
/** In-memory-only editable book. It is never persisted until confirmation. */
let draftBets = {};
let draftDirty = false;
let betsConfirmed = false;
let submitInFlight = false;
let submitError = '';
let draftGeneration = 0;
/** Snapshot of bets taken at spin time so the result panel remains stable. */
let lastRoundBets = {};
let lastRoundBetObjects = [];

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
      if (phaseKey === lastPhaseKey) return;
      lastPhaseKey = phaseKey;

      if (status === 'lobby') {
        discardDraftState();
        lastRoundBets = {};
        lastRoundBetObjects = [];
        showScreen('phone-lobby');
        renderPhoneLobby();
      } else if (status === 'betting') {
        activeBetAuthority = { roundNumber: game.roundNumber, revision: game.revision };
        initializeBettingBook((firebaseSnapshot.bets || {})[`player_${playerIndex}`] || {});
        lastRoundBets = {};
        lastRoundBetObjects = [];
        lastRoundKey = null;
        showScreen('phone-game');
        renderBetBoard();
        renderResultPanel();
        renderHeader();
        startCountdownDisplay();
      } else if (status === 'spinning') {
        discardDraftState();
        snapshotLastRoundBets();
        renderHeader();
        renderBetBoard();
        renderResultPanel();
      } else if (status === 'payout') {
        discardDraftState();
        renderHeader();
        renderBetBoard();
        renderResultPanel();
      } else if (status === 'ended') {
        discardDraftState();
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

      const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
      const me = players?.[myKey];
      const oldMe = oldPlayers?.[myKey];
      if (status === 'payout' && me && oldMe) {
        const wasBroke = oldMe.broke || (oldMe.chips ?? 0) <= 0;
        const nowHasChips = !me.broke && (me.chips ?? 0) > 0;
        if (wasBroke && nowHasChips) {
          lastRoundBets = {};
          lastRoundBetObjects = [];
          showToast(`💰 Received ${me.chips} chips!`, 2000);
          renderResultPanel();
        }
      }

      renderPhoneLobby();
      renderHeader();
      renderBetBoard();
    },
    onBetsChange: (bets) => {
      firebaseSnapshot.bets = bets;
      if (firebaseSnapshot.game?.phase === 'betting') {
        const serverBook = normalizeBetBook((bets || {})[`player_${playerIndex}`] || {});
        committedBets = serverBook;
        // A snapshot may refresh committed truth, but never clobbers an edited draft.
        if (!draftDirty && !submitInFlight) {
          draftBets = cloneBetBook(serverBook);
          betsConfirmed = Object.keys(serverBook).length > 0;
        }
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
      renderBetBoard();
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
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!canEditDraft()) return;
    draftBets = {};
    draftDirty = !betBooksEqual(draftBets, committedBets);
    submitError = '';
    renderBetBoard();
  });

  const confirmBtn = document.getElementById('btn-phone-confirm-bets');
  if (confirmBtn) confirmBtn.addEventListener('click', () => {
    void confirmDraftBets();
  });
}

async function confirmDraftBets() {
  if (!canConfirmDraft()) return;
  const authority = { ...activeBetAuthority };
  const targetRoom = roomCode;
  const targetPlayer = playerIndex;
  const submittedDraft = cloneBetBook(draftBets);
  const generation = draftGeneration;

  submitInFlight = true;
  submitError = '';
  renderBetBoard();
  try {
    const result = await replacePlayerBets(
      targetRoom, targetPlayer, submittedDraft, authority,
    );
    if (generation !== draftGeneration || !authorityMatches(authority)) return;
    committedBets = normalizeBetBook(result.playerBets);
    draftBets = cloneBetBook(committedBets);
    draftDirty = false;
    betsConfirmed = true;
    playSound('chip', 0.6);
  } catch (err) {
    if (generation !== draftGeneration || !authorityMatches(authority)) return;
    submitError = bettingIsOpen() ? 'Failed — check connection and try again' : 'Failed/closed — draft not submitted';
    console.warn('replacePlayerBets rejected:', err.message);
  } finally {
    if (generation === draftGeneration) {
      submitInFlight = false;
      renderBetBoard();
    }
  }
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
  if (!canEditDraft()) return;
  const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
  const type = cell.dataset.betType;
  const targetRaw = cell.dataset.betTarget;
  const target = targetRaw == null || targetRaw === '' ? null : parseInt(targetRaw, 10);
  const key = betKey(type, target);
  if (!key) return;

  const current = draftBets[key];
  if ((current?.chips || 0) + BET_INCREMENT > MAX_BET_CHIPS) {
    showToast(`Maximum ${MAX_BET_CHIPS} chips per bet`);
    playSound('error', 0.4);
    return;
  }
  const currentTotal = totalDraft();
  if (currentTotal + BET_INCREMENT > (Number(me?.chips) || 0)) {
    showToast('Not enough chips for that bet');
    playSound('error', 0.4);
    if (navigator.vibrate) try { navigator.vibrate(40); } catch (_) {}
    return;
  }

  draftBets[key] = {
    type,
    target,
    chips: (current?.chips || 0) + BET_INCREMENT,
  };
  draftDirty = !betBooksEqual(draftBets, committedBets);
  submitError = '';
  playSound('chip', 0.5);
  if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {}
  cell.classList.remove('press');
  void cell.offsetWidth;
  cell.classList.add('press');
  renderBetBoard();
}

function totalDraft() {
  return Object.values(draftBets).reduce((sum, bet) => {
    const chips = bet?.chips;
    return sum + (Number.isSafeInteger(chips) ? chips : 0);
  }, 0);
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

function normalizeBetBook(book) {
  const normalized = {};
  Object.entries(book || {}).forEach(([key, bet]) => {
    if (!bet || betKey(bet.type, bet.target ?? null) !== key ||
        !Number.isSafeInteger(bet.chips) || bet.chips <= 0 ||
        bet.chips % BET_INCREMENT !== 0) return;
    normalized[key] = {
      type: bet.type,
      target: bet.target ?? null,
      chips: bet.chips,
      ...(Number.isSafeInteger(bet.roundNumber) ? { roundNumber: bet.roundNumber } : {}),
      ...(Number.isSafeInteger(bet.revision) ? { revision: bet.revision } : {}),
    };
  });
  return normalized;
}

function cloneBetBook(book) {
  return Object.fromEntries(Object.entries(book || {}).map(([key, bet]) => [key, { ...bet }]));
}

function betBooksEqual(left, right) {
  const leftEntries = Object.entries(left || {});
  const rightKeys = Object.keys(right || {});
  if (leftEntries.length !== rightKeys.length) return false;
  return leftEntries.every(([key, bet]) => {
    const other = right?.[key];
    return other && bet.type === other.type && (bet.target ?? null) === (other.target ?? null) &&
      bet.chips === other.chips;
  });
}

function initializeBettingBook(serverBook) {
  draftGeneration += 1;
  committedBets = normalizeBetBook(serverBook);
  draftBets = cloneBetBook(committedBets);
  draftDirty = false;
  betsConfirmed = Object.keys(committedBets).length > 0;
  submitInFlight = false;
  submitError = '';
}

function discardDraftState() {
  draftGeneration += 1;
  committedBets = {};
  draftBets = {};
  draftDirty = false;
  betsConfirmed = false;
  submitInFlight = false;
  submitError = '';
  activeBetAuthority = null;
}

function authorityMatches(authority) {
  const game = firebaseSnapshot.game || {};
  return !!authority && !!activeBetAuthority && game.phase === 'betting' &&
    authority.roundNumber === activeBetAuthority.roundNumber &&
    authority.revision === activeBetAuthority.revision &&
    game.roundNumber === authority.roundNumber && game.revision === authority.revision;
}

function bettingIsOpen() {
  if (!authorityMatches(activeBetAuthority)) return false;
  const closeAt = firebaseSnapshot.game?.betsCloseAt;
  return closeAt == null || serverNow() < closeAt;
}

function canEditDraft() {
  const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
  return bettingIsOpen() && !betsConfirmed && !submitInFlight && !!me &&
    !me.broke && Number.isSafeInteger(me.chips) && me.chips > 0;
}

function canConfirmDraft() {
  return canEditDraft() && draftDirty && totalDraft() > 0;
}

/**
 * Renders chip stacks on each felt cell, plus disabled overlay when not betting.
 */
function renderBetBoard() {
  const board = document.getElementById('phone-bet-board');
  if (!board || !board.dataset._built) return;

  const status = firebaseSnapshot.game?.phase || firebaseSnapshot.meta?.status;
  const editable = canEditDraft();
  board.classList.toggle('locked', !editable);
  board.setAttribute('aria-disabled', editable ? 'false' : 'true');
  // Player tag
  renderPlayerTag();

  // Per-cell chip stacks
  board.querySelectorAll('.felt-cell').forEach((cell) => {
    const type = cell.dataset.betType;
    const targetRaw = cell.dataset.betTarget;
    const target = targetRaw == null || targetRaw === '' ? null : parseInt(targetRaw, 10);
    const key = betKey(type, target);
    const chips = key ? (draftBets[key]?.chips || 0) : 0;
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
    const total = totalDraft();
    const left = Math.max(0, balance - total);
    const items = [];
    let count = 0;
    Object.keys(draftBets).forEach((key) => {
      const chips = draftBets[key]?.chips;
      if (!chips) return;
      count += 1;
      items.push(`<span class="ledger-item">${labelForBetKey(key)} <strong>${chips}</strong></span>`);
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
  renderBetControls();
}

function renderBetControls() {
  const clearButton = document.getElementById('btn-phone-clear-bets');
  const confirmButton = document.getElementById('btn-phone-confirm-bets');
  const statusElement = document.getElementById('phone-bet-status');
  if (!clearButton || !confirmButton || !statusElement) return;

  clearButton.disabled = !canEditDraft() || totalDraft() === 0;
  confirmButton.disabled = !canConfirmDraft();
  confirmButton.classList.toggle('submitting', submitInFlight);
  confirmButton.classList.toggle('confirmed', betsConfirmed);
  confirmButton.textContent = submitInFlight ? 'Submitting…' : betsConfirmed ? 'Confirmed' : 'Confirm Bets';

  let message = 'Draft not submitted — tap the felt to add +100';
  let state = 'draft';
  if (submitInFlight) {
    message = 'Submitting…';
    state = 'submitting';
  } else if (betsConfirmed) {
    message = 'Confirmed — bets locked for this round';
    state = 'confirmed';
  } else if (submitError) {
    message = submitError;
    state = 'failed';
  } else if (!bettingIsOpen()) {
    message = 'Failed/closed — betting is closed';
    state = 'failed';
  } else if (draftDirty) {
    message = 'Draft not submitted';
  }
  statusElement.textContent = message;
  statusElement.className = `phone-bet-status ${state}`;
}

/** Snapshots only host-locked bets for the result panel. */
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
    renderBetBoard();
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
  discardDraftState();
  if (cancelPlayerDisconnect) { void cancelPlayerDisconnect(); cancelPlayerDisconnect = null; }
  dismissConfirmModals();
  const helpModal = document.getElementById('help-modal');
  if (helpModal) helpModal.hidden = true;
  clearSession();
  roomCode = null;
  playerIndex = null;
  firebaseSnapshot = {};
  previousPlayers = {};
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
