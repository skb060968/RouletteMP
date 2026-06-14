/**
 * Deep Link & App Banner Handler
 * 
 * Reusable module for handling:
 * - URL parameters for room codes
 * - Smart app banner (Open/Install PWA)
 * - Share functionality with deep links
 * 
 * Usage:
 *   import { initDeepLinkHandler, createShareHandler } from './deep-link-handler.js';
 *   
 *   // In your init function:
 *   const roomCode = initDeepLinkHandler({
 *     roomInputId: 'phone-join-code',
 *     joinScreenId: 'phone-join',
 *     gameName: 'Roulette MP'
 *   });
 *   
 *   // For share button:
 *   shareButton.addEventListener('click', createShareHandler(roomCode, 'Roulette MP'));
 */

import { showToast } from './platform-ui.js';

let deferredInstallPrompt = null;

// Capture the install prompt event
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

/**
 * Initialize deep link handling on page load
 * @param {Object} options - Configuration options
 * @param {string} options.roomInputId - ID of the room code input element
 * @param {string} options.joinScreenId - ID of the join screen element
 * @param {string} options.gameName - Name of the game for toast messages
 * @returns {string|null} - Room code from URL if present, null otherwise
 */
export function initDeepLinkHandler({ roomInputId, joinScreenId, gameName }) {
  // Check for room code in URL (e.g., ?room=ABCD)
  const urlParams = new URLSearchParams(window.location.search);
  const urlRoomCode = urlParams.get('room');
  
  if (!urlRoomCode) return null;
  
  // Clean URL after extracting room code
  window.history.replaceState({}, '', window.location.pathname);
  
  // Auto-fill room code
  const roomInput = document.getElementById(roomInputId);
  if (roomInput) {
    roomInput.value = urlRoomCode.toUpperCase();
  }
  
  // Show join screen if provided
  if (joinScreenId) {
    const screen = document.getElementById(joinScreenId);
    if (screen) {
      screen.removeAttribute('hidden');
    }
  }
  
  showToast('Room code filled from link!');
  
  // Check if opened in browser (not PWA) and show app banner
  const isPWA = window.matchMedia('(display-mode: standalone)').matches;
  if (!isPWA) {
    // Show banner after a short delay so user sees the screen first
    setTimeout(() => showAppBanner(gameName), 800);
  }
  
  return urlRoomCode.toUpperCase();
}

/**
 * Create a share handler function for share buttons
 * @param {string} roomCode - The room code to share
 * @param {string} gameName - Name of the game
 * @returns {Function} - Async function to handle sharing
 */
export function createShareHandler(roomCode, gameName) {
  return async function handleShare() {
    if (!roomCode) return;
    
    // Include room code in URL for direct joining
    const shareUrl = `${location.origin}${location.pathname}?room=${roomCode}`;
    const text = `Join my ${gameName} room! Code: ${roomCode}`;
    
    // Try native share API first (mobile)
    if (navigator.share) {
      try {
        await navigator.share({
          title: gameName,
          text,
          url: shareUrl
        });
        return;
      } catch (err) {
        // User cancelled or share failed
        if (err.name !== 'AbortError') {
          console.warn('Share failed:', err);
        }
      }
    }
    
    // Fallback to clipboard
    try {
      await navigator.clipboard.writeText(`${text}\n${shareUrl}`);
      showToast('Room link copied!');
    } catch (err) {
      // Clipboard failed, just show the code
      showToast(`Room code: ${roomCode}`);
    }
  };
}

/**
 * Show the app banner with Open/Install options
 * @param {string} gameName - Name of the game
 */
function showAppBanner(gameName) {
  // Check if already shown in this session
  if (sessionStorage.getItem('app-banner-dismissed')) return;
  
  // Remove existing banner if any
  const existing = document.getElementById('app-banner');
  if (existing) existing.remove();
  
  // Detect device type
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const bannerText = isMobile 
    ? 'Better experience in app' 
    : 'Have the app installed?';
  const buttonText = isMobile 
    ? 'Open/Install App' 
    : 'Using App';
  
  // Create banner HTML
  const banner = document.createElement('div');
  banner.id = 'app-banner';
  banner.className = 'app-banner';
  banner.innerHTML = `
    <div class="app-banner-content">
      <span class="app-banner-icon">📱</span>
      <span class="app-banner-text">${bannerText}</span>
      <div class="app-banner-actions">
        <button id="app-banner-open" class="app-banner-btn primary">${buttonText}</button>
        <button id="app-banner-continue" class="app-banner-btn secondary">Continue Here</button>
        <button id="app-banner-close" class="app-banner-btn close" aria-label="Close">×</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(banner);
  
  // Animate in
  setTimeout(() => banner.classList.add('show'), 100);
  
  // Wire buttons
  document.getElementById('app-banner-open')?.addEventListener('click', () => handleOpenApp(gameName, isMobile));
  document.getElementById('app-banner-continue')?.addEventListener('click', dismissAppBanner);
  document.getElementById('app-banner-close')?.addEventListener('click', dismissAppBanner);
}

/**
 * Dismiss the app banner
 */
function dismissAppBanner() {
  const banner = document.getElementById('app-banner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 300);
  }
  sessionStorage.setItem('app-banner-dismissed', 'true');
}

/**
 * Handle Open/Install App button click
 * @param {string} gameName - Name of the game
 * @param {boolean} isMobile - Whether user is on mobile device
 */
async function handleOpenApp(gameName, isMobile) {
  try {
    // If install prompt is available, show it
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const result = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      
      if (result.outcome === 'accepted') {
        showToast('App installing...');
        dismissAppBanner();
      } else {
        showToast('Continue in browser');
      }
      return;
    }
    
    // Desktop: Different message since we can't auto-open
    if (!isMobile) {
      dismissAppBanner();
      showToast('💡 Tip: Open the app separately from your desktop/start menu', 4000);
      return;
    }
    
    // Mobile: Try to open PWA (may work if already installed)
    const currentUrl = window.location.href;
    window.location.href = currentUrl.replace('https://', 'web+app://');
    
    // Wait to see if app opened
    setTimeout(() => {
      // Still here? App didn't open or not installed
      showToast('Install app: Browser menu (⋮) → "Install app"', 3500);
    }, 1000);
    
  } catch (err) {
    console.warn('Failed to open app:', err);
    showToast('Install app: Browser menu (⋮) → "Install app"', 3500);
  }
}
