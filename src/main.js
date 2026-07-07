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
// Update notification functions
window.reloadForUpdate = function() {
  window.location.reload();
};

window.dismissUpdate = function() {
  document.getElementById('updateToast').style.display = 'none';
};

function showUpdateToast() {
  const toast = document.getElementById('updateToast');
  if (!toast) return;
  toast.style.display = 'block';
  toast.style.animation = 'slideUp 0.4s ease-out';
}

// Register Service Worker for PWA with update detection
if ('serviceWorker' in navigator) {
  let refreshing = false;
  
  // Detect controller change and reload
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    console.log('[App] Controller changed, reloading...');
  });
  
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('✅ Service Worker registered:', registration);
        
        // Check for updates periodically (every 5 minutes)
        setInterval(() => {
          registration.update();
        }, 5 * 60 * 1000);
        
        // Listen for waiting service worker
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          console.log('[App] New service worker found');
          
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[App] New service worker installed, update available');
              showUpdateToast();
            }
          });
        });
      })
      .catch((error) => {
        console.log('❌ Service Worker registration failed:', error);
      });
    
    // Listen for messages from service worker
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'UPDATE_AVAILABLE') {
        console.log(`[App] Update available: ${event.data.version}`);
        showUpdateToast();
      }
    });
  });
}
  }, { once: true });
}

init();
