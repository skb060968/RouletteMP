import { authReady } from './firebase-config.js';
import { showScreen } from './platform-ui.js';
import { startTvFlow, resumeTvSession } from './tv-controller.js';
import { startPhoneFlow, resumePhoneSession } from './phone-controller.js';
import { initDeepLinkHandler } from './deep-link-handler.js';

const SESSION_KEY = 'roulette_mp_session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function showStartupFailure(error) {
  showScreen('home');
  const status = document.getElementById('app-status');
  if (status) {
    status.textContent = error?.message || 'Roulette MP could not connect. Check your connection and reload.';
    status.hidden = false;
  }
  ['btn-home-tv', 'btn-home-player'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = true;
  });
}

async function runAuthenticated(action) {
  try {
    await authReady;
    await action();
  } catch (error) {
    showStartupFailure(error);
  }
}

function syncPressedStates(root = document) {
  root.querySelectorAll?.('.emoji-btn').forEach((button) => {
    button.setAttribute('aria-pressed', button.classList.contains('selected') ? 'true' : 'false');
  });
  root.querySelectorAll?.('.chip-btn[data-denom]').forEach((button) => {
    button.setAttribute('aria-pressed', button.classList.contains('selected') ? 'true' : 'false');
  });
  root.querySelectorAll?.('[id*="mute"].icon-btn').forEach((button) => {
    const muted = button.textContent.includes('🔇');
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.setAttribute('aria-label', muted ? 'Unmute sounds' : 'Mute sounds');
    button.title = muted ? 'Unmute' : 'Mute';
  });
  const pauseButton = document.getElementById('btn-tv-pause-auto');
  if (pauseButton) pauseButton.setAttribute('aria-pressed', pauseButton.classList.contains('paused') ? 'true' : 'false');
}

function setupAccessibleControls() {
  syncPressedStates();
  const pressedStateObserver = new MutationObserver(() => syncPressedStates());
  document.querySelectorAll('[id*="mute"].icon-btn, #btn-tv-pause-auto').forEach((button) => {
    pressedStateObserver.observe(button, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  let helpRestoreFocus = null;
  const helpModal = document.getElementById('help-modal');
  const helpDialog = helpModal?.querySelector('.help-modal-box');

  const closeHelp = () => {
    if (!helpModal || helpModal.hidden) return;
    helpModal.hidden = true;
    const restore = helpRestoreFocus;
    helpRestoreFocus = null;
    restore?.focus();
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.id === 'btn-phone-help') {
      helpRestoreFocus = target;
      queueMicrotask(() => document.getElementById('btn-help-close')?.focus());
    } else if (target.id === 'btn-help-close') {
      queueMicrotask(() => {
        const restore = helpRestoreFocus;
        helpRestoreFocus = null;
        restore?.focus();
      });
    }
    queueMicrotask(() => syncPressedStates());
  });

  helpModal?.addEventListener('click', (event) => {
    if (event.target !== helpModal) return;
    queueMicrotask(() => {
      const restore = helpRestoreFocus;
      helpRestoreFocus = null;
      restore?.focus();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (!helpModal || helpModal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHelp();
      return;
    }
    if (event.key !== 'Tab' || !helpDialog) return;
    const focusable = [...helpDialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) {
      event.preventDefault();
      helpDialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

async function init() {
  setupAccessibleControls();

  try {
    await authReady;
  } catch (error) {
    showStartupFailure(error);
    return;
  }

  const btnTv = document.getElementById('btn-home-tv');
  const btnPlayer = document.getElementById('btn-home-player');
  btnTv?.addEventListener('click', () => runAuthenticated(startTvFlow));
  btnPlayer?.addEventListener('click', () => runAuthenticated(() => startPhoneFlow()));

  const roomCode = initDeepLinkHandler({
    roomInputId: 'phone-join-code',
    joinScreenId: 'phone-join',
    gameName: 'Roulette MP',
  });
  if (roomCode) {
    await runAuthenticated(() => startPhoneFlow(roomCode));
    return;
  }

  const session = loadSession();
  if (session?.roomCode) {
    try {
      if (session.role === 'tv') {
        await authReady;
        await resumeTvSession(session.roomCode);
        return;
      }
      if (session.role === 'phone' && session.playerIndex != null) {
        await authReady;
        await resumePhoneSession(session.roomCode, session.playerIndex);
        return;
      }
    } catch (_) {
      const status = document.getElementById('app-status');
      if (status) {
        status.textContent = 'Your previous room could not be resumed. You can create or join another room.';
        status.hidden = false;
      }
    }
  }

  showScreen('home');
}

function setupConfettiFallback() {
  const primary = document.getElementById('confetti-script');
  if (!primary) return;
  primary.addEventListener('error', () => {
    if (document.getElementById('confetti-fallback-script')) return;
    const fallback = document.createElement('script');
    fallback.id = 'confetti-fallback-script';
    fallback.src = 'https://unpkg.com/canvas-confetti@1.9.3/dist/confetti.browser.min.js';
    fallback.async = true;
    document.head.appendChild(fallback);
  }, { once: true });
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let waitingWorker = null;
  let updateApproved = false;
  let reloadStarted = false;
  const toast = document.getElementById('updateToast');
  const reloadButton = document.getElementById('btn-update-reload');
  const laterButton = document.getElementById('btn-update-later');

  const showUpdateToast = (worker) => {
    waitingWorker = worker;
    if (toast) toast.hidden = false;
  };
  const hideUpdateToast = () => {
    if (toast) toast.hidden = true;
  };

  reloadButton?.addEventListener('click', () => {
    if (!waitingWorker || updateApproved) return;
    updateApproved = true;
    reloadButton.disabled = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  laterButton?.addEventListener('click', hideUpdateToast);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateApproved || reloadStarted) return;
    reloadStarted = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      if (registration.waiting) showUpdateToast(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(registration.waiting || worker);
          }
        });
      });
      window.setInterval(() => registration.update().catch(() => {}), 5 * 60 * 1000);
    } catch (_) {
      // The app remains usable online when service worker registration fails.
    }
  }, { once: true });
}

setupConfettiFallback();
setupServiceWorker();
init();
