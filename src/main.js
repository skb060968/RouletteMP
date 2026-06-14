/**
 * Roulette MP — entry point
 *
 * - Boots the home screen
 * - Restores a saved session if present (TV or phone)
 * - Otherwise wires Home buttons to dispatch into TV or Phone controller
 */

import './firebase-config.js';
import { showScreen } from './platform-ui.js';
import { startTvFlow, resumeTvSession } from './tv-controller.js';
import { startPhoneFlow, resumePhoneSession } from './phone-controller.js';
import { initDeepLinkHandler } from './deep-link-handler.js';

const SESSION_KEY = 'roulette_mp_session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function getQueryParam(name) {
  const m = new URL(location.href).searchParams.get(name);
  return m || null;
}

async function init() {
  const btnTv = document.getElementById('btn-home-tv');
  const btnPlayer = document.getElementById('btn-home-player');
  if (btnTv) btnTv.addEventListener('click', () => startTvFlow());
  if (btnPlayer) btnPlayer.addEventListener('click', () => {
    const code = getQueryParam('code');
    startPhoneFlow(code);
  });

  // Check for deep link with room code (?room=ABCD)
  const roomCode = initDeepLinkHandler({
    roomInputId: 'phone-join-code',
    joinScreenId: 'phone-join',
    gameName: 'Roulette MP'
  });
  
  if (roomCode) {
    startPhoneFlow(roomCode);
    return;
  }

  // Auto-route via ?code=&action=join (legacy support)
  const queryCode = getQueryParam('code');
  const action = getQueryParam('action');
  if (queryCode && action === 'join') {
    startPhoneFlow(queryCode);
    return;
  }

  // Resume
  const session = loadSession();
  if (session && session.roomCode) {
    if (session.role === 'tv') {
      try { await resumeTvSession(session.roomCode); return; } catch (_) {}
    } else if (session.role === 'phone' && session.playerIndex != null) {
      try { await resumePhoneSession(session.roomCode, session.playerIndex); return; } catch (_) {}
    }
  }

  showScreen('home');
}

/* ======= SERVICE WORKER ======= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if (reg.waiting) showUpdateToast(reg);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (installing) {
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(reg);
            }
          });
        }
      });
    } catch (err) {
      console.warn('SW register failed:', err.message);
    }
  });
}

function showUpdateToast(reg) {
  const toast = document.getElementById('update-toast');
  const btn = document.getElementById('update-refresh-btn');
  if (!toast || !btn) return;
  toast.hidden = false;
  btn.addEventListener('click', () => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    location.reload();
  }, { once: true });
}

init();
