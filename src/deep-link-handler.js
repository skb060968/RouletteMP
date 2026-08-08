import { showToast } from './platform-ui.js';
import QRCode from 'qrcode';

export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

let deferredInstallPrompt = null;
let deepLinkConsumed = false;
let bannerTimer = null;
let activeQrCleanup = null;
let qrGeneration = 0;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  dismissAppBanner();
});

export function normalizeRoomCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

function shareUrlFor(roomCode) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

export function initDeepLinkHandler({ roomInputId, joinScreenId, gameName }) {
  if (deepLinkConsumed) return null;

  const url = new URL(window.location.href);
  const room = normalizeRoomCode(url.searchParams.get('room'));
  const legacy = url.searchParams.get('action')?.toLowerCase() === 'join'
    ? normalizeRoomCode(url.searchParams.get('code'))
    : null;
  const roomCode = room || legacy;
  if (!roomCode) return null;

  deepLinkConsumed = true;
  if (room) {
    url.searchParams.delete('room');
  } else {
    url.searchParams.delete('code');
    url.searchParams.delete('action');
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);

  const roomInput = document.getElementById(roomInputId);
  if (roomInput) roomInput.value = roomCode;
  const screen = joinScreenId ? document.getElementById(joinScreenId) : null;
  if (screen) screen.removeAttribute('hidden');

  showToast('Room code filled from link!');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (!isStandalone) {
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      bannerTimer = null;
      showAppBanner(gameName);
    }, 800);
  }
  return roomCode;
}

export function createShareHandler(roomCode, gameName) {
  return async function handleShare() {
    const validRoomCode = normalizeRoomCode(roomCode);
    if (!validRoomCode) {
      showToast('Cannot share an invalid room code');
      return;
    }

    const shareUrl = shareUrlFor(validRoomCode);
    const text = `Join my ${gameName} room! Code: ${validRoomCode}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: gameName, text, url: shareUrl });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(`${text}\n${shareUrl}`);
      showToast('Room link copied!');
    } catch (_) {
      showToast(`Room code: ${validRoomCode}`);
    }
  };
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function showAppBanner(gameName) {
  try {
    if (sessionStorage.getItem('app-banner-dismissed')) return;
  } catch (_) {}
  document.getElementById('app-banner')?.remove();

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const banner = makeElement('aside', 'app-banner');
  banner.id = 'app-banner';
  banner.setAttribute('aria-label', `${gameName} app options`);
  const content = makeElement('div', 'app-banner-content');
  const icon = makeElement('span', 'app-banner-icon', '📱');
  icon.setAttribute('aria-hidden', 'true');
  const message = makeElement('span', 'app-banner-text', deferredInstallPrompt
    ? `Install ${gameName} for a better experience`
    : `Keep playing ${gameName} securely in this browser`);
  const actions = makeElement('div', 'app-banner-actions');
  const install = makeElement('button', 'app-banner-btn primary', deferredInstallPrompt ? 'Install App' : 'How to Install');
  install.type = 'button';
  const continueButton = makeElement('button', 'app-banner-btn secondary', 'Continue Here');
  continueButton.type = 'button';
  const close = makeElement('button', 'app-banner-btn close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss app options');

  actions.append(install, continueButton, close);
  content.append(icon, message, actions);
  banner.append(content);
  document.body.append(banner);
  requestAnimationFrame(() => banner.classList.add('show'));

  install.addEventListener('click', () => handleInstall(gameName, isMobile), { once: true });
  continueButton.addEventListener('click', dismissAppBanner, { once: true });
  close.addEventListener('click', dismissAppBanner, { once: true });
}

function dismissAppBanner() {
  if (bannerTimer) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  const banner = document.getElementById('app-banner');
  if (banner) {
    banner.classList.remove('show');
    banner.addEventListener('transitionend', () => banner.remove(), { once: true });
    setTimeout(() => banner.remove(), 350);
  }
  try { sessionStorage.setItem('app-banner-dismissed', 'true'); } catch (_) {}
}

async function handleInstall(gameName, isMobile) {
  if (deferredInstallPrompt) {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      showToast(result.outcome === 'accepted' ? `${gameName} is installing…` : 'Installation cancelled');
      if (result.outcome === 'accepted') dismissAppBanner();
    } catch (_) {
      showInstallInstructions(isMobile);
    }
    return;
  }
  showInstallInstructions(isMobile);
}

function showInstallInstructions(isMobile) {
  showToast(isMobile
    ? 'Use your browser menu, then choose “Install app” or “Add to Home Screen”.'
    : 'Use the install icon in the address bar or your browser’s app menu.', 5000);
}

export function closeActiveQRCode(restoreFocus = false) {
  qrGeneration += 1;
  if (activeQrCleanup) activeQrCleanup(restoreFocus);
  else document.getElementById('qr-modal')?.remove();
}

export async function showQRCode(roomCode, gameName) {
  const validRoomCode = normalizeRoomCode(roomCode);
  if (!validRoomCode) {
    showToast('Cannot create a QR code for an invalid room code');
    return;
  }

  const generation = ++qrGeneration;
  activeQrCleanup?.(false);
  const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = makeElement('div', 'qr-modal');
  modal.id = 'qr-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'qr-modal-title');

  const overlay = makeElement('div', 'qr-modal-overlay');
  const content = makeElement('div', 'qr-modal-content');
  content.tabIndex = -1;
  const close = makeElement('button', 'qr-modal-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close QR code dialog');
  const title = makeElement('h2', 'qr-modal-title', 'Scan to Join');
  title.id = 'qr-modal-title';
  const game = makeElement('p', 'qr-modal-game', gameName);
  const codeDisplay = makeElement('div', 'qr-modal-code-display');
  codeDisplay.append(makeElement('span', 'qr-code-label', 'Room Code:'), makeElement('span', 'qr-code-value', validRoomCode));
  const canvasContainer = makeElement('div', 'qr-canvas-container');
  const canvas = document.createElement('canvas');
  canvas.id = 'qr-canvas';
  canvas.setAttribute('aria-label', `QR code for room ${validRoomCode}`);
  canvasContainer.append(canvas);
  const hint = makeElement('p', 'qr-modal-hint', 'Scan with a camera to join instantly');
  const actions = makeElement('div', 'qr-modal-actions');
  const share = makeElement('button', 'qr-modal-btn qr-share-btn', '📱 Share Link');
  share.type = 'button';
  const download = makeElement('button', 'qr-modal-btn qr-download-btn', '💾 Save QR');
  download.type = 'button';
  actions.append(share, download);
  content.append(close, title, game, codeDisplay, canvasContainer, hint, actions);
  modal.append(overlay, content);
  document.body.append(modal);

  const shareUrl = shareUrlFor(validRoomCode);
  try {
    await QRCode.toCanvas(canvas, shareUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#1a1a1a', light: '#ffffff' },
    });
  } catch (_) {
    modal.remove();
    if (generation !== qrGeneration) return;
    showToast('Failed to generate QR code');
    restoreFocusTo?.focus();
    return;
  }
  if (generation !== qrGeneration || !modal.isConnected) {
    modal.remove();
    return;
  }

  let removalTimer = null;
  let closing = false;
  let closed = false;
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) {
      event.preventDefault();
      content.focus();
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
  };
  const cleanup = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    if (removalTimer) clearTimeout(removalTimer);
    modal.remove();
    if (activeQrCleanup === cleanup) activeQrCleanup = null;
    if (restoreFocus) restoreFocusTo?.focus();
  };
  const closeModal = () => {
    if (closed || closing) return;
    closing = true;
    modal.classList.remove('show');
    removalTimer = setTimeout(() => cleanup(true), 300);
  };
  activeQrCleanup = cleanup;
  document.addEventListener('keydown', onKeyDown);
  close.addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal);
  share.addEventListener('click', createShareHandler(validRoomCode, gameName));
  download.addEventListener('click', () => {
    try {
      const link = document.createElement('a');
      const safeGameName = String(gameName).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'game';
      link.download = `${safeGameName}-Room-${validRoomCode}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      showToast('QR code saved!');
    } catch (_) {
      showToast('Failed to save QR code');
    }
  });

  requestAnimationFrame(() => {
    modal.classList.add('show');
    close.focus();
  });
}
