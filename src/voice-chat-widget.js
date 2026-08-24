/**
 * Standard voice-chat widget — a self-contained control you drop anywhere in a
 * game screen. Given a mount container, it injects its own Join button + mute
 * toggle (and its own styles), and wires them to the shared LiveKit client.
 *
 * Reuse across every game unchanged; only the mount point and the small config
 * differ per game. Never blocks gameplay — any failure just updates the button.
 *
 * Integration (per game):
 *   1. Place an empty container in the game screen, e.g. <div id="voice-widget"></div>
 *   2. mountVoiceChat({
 *        mount: '#voice-widget',
 *        game: 'roulette',               // per-game id (namespaces the LiveKit room)
 *        getRoomCode: () => roomCode,     // current 4-letter code
 *        getIdentity: () => `player_${playerIndex}`,
 *        getDisplayName: () => playerName,
 *        getIdToken: async () => (await authReady).getIdToken(),
 *        onSpeakers: (slotKeys) => {},    // optional: highlight speaking players
 *        notify: (msg) => showToast(msg), // optional: surface errors/prompts
 *      });
 *   3. Prereqs: VITE_LIVEKIT_URL env, livekit-client dep, /api/livekit-token,
 *      vercel.json Permissions-Policy `microphone=(self)`, SW bypass for /api/.
 */

import { createLiveKitVoice } from './voice-livekit.js';

const STYLE_ID = 'voice-chat-widget-styles';
const STYLES = `
.vcw {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.28);
}
.vcw-join {
  border: 0; border-radius: 999px; padding: 7px 12px;
  background: #fff; color: #14213d; font: inherit; font-size: 0.82rem;
  font-weight: 800; cursor: pointer; white-space: nowrap; line-height: 1;
  box-shadow: 0 2px 6px rgba(20,33,61,0.18);
}
.vcw-join.active { background: #16a34a; color: #fff; }
.vcw-join:disabled { opacity: 0.7; cursor: wait; }
.vcw-mute {
  width: 34px; height: 34px; border: 0; border-radius: 50%;
  background: #fff; color: #14213d; font-size: 1.05rem; cursor: pointer;
  line-height: 1; box-shadow: 0 2px 6px rgba(20,33,61,0.18);
}
.vcw-mute.muted { background: #f59e0b; color: #451a03; }
.vcw-mute[hidden] { display: none !important; }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

export function mountVoiceChat(config = {}) {
  const {
    mount, game, getRoomCode, getIdentity, getDisplayName,
    getIdToken, onSpeakers, notify,
  } = config;
  const container = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!container) return null;

  injectStyles();
  container.classList.add('vcw');
  container.innerHTML = '<button type="button" class="vcw-join" aria-pressed="false">🎙️ Voice</button>'
    + '<button type="button" class="vcw-mute" aria-label="Mute microphone" hidden>🎤</button>';
  const joinBtn = container.querySelector('.vcw-join');
  const muteBtn = container.querySelector('.vcw-mute');

  let voice = null;
  let busy = false;

  function render(status) {
    const joined = Boolean(status?.joined);
    const state = status?.state || 'idle';
    joinBtn.setAttribute('aria-pressed', String(joined));
    joinBtn.classList.toggle('active', joined);
    muteBtn.hidden = !joined;
    joinBtn.textContent = !joined
      ? '🎙️ Voice'
      : state === 'connecting' ? '🎙️ …' : '🎧 Leave';
    const muted = Boolean(status?.muted);
    muteBtn.textContent = muted ? '🤐' : '🎤';
    muteBtn.classList.toggle('muted', muted);
    if (state === 'error' && status.message) notify?.(status.message);
    else if (state === 'needs-audio-unlock') notify?.('Tap 🎤 to enable voice audio');
  }

  function ensureVoice() {
    if (voice) return voice;
    const roomCode = getRoomCode?.();
    const identity = getIdentity?.();
    if (!roomCode || !identity) return null;
    voice = createLiveKitVoice({
      game,
      roomCode,
      identity,
      displayName: getDisplayName?.() || identity,
      getIdToken,
      onStatus: render,
      onSpeakers: (ids) => { try { onSpeakers?.(ids); } catch (_) {} },
    });
    return voice;
  }

  joinBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    joinBtn.disabled = true;
    try {
      const active = ensureVoice();
      if (!active) { notify?.('Voice unavailable — join a room first.'); return; }
      if (active.isJoined()) await active.leave();
      else await active.join();
    } catch (_) {
      notify?.('Voice unavailable — try again.');
    } finally {
      busy = false;
      joinBtn.disabled = false;
    }
  });
  muteBtn.addEventListener('click', () => { if (voice?.isJoined()) voice.toggleMute(); });

  render({ state: 'idle', joined: false, muted: false });

  return {
    isJoined: () => Boolean(voice?.isJoined()),
    stop() {
      try { voice?.destroy(); } catch (_) {}
      voice = null;
      try { onSpeakers?.([]); } catch (_) {}
      render({ state: 'idle', joined: false, muted: false });
    },
    destroy() {
      try { voice?.destroy(); } catch (_) {}
      voice = null;
      try { onSpeakers?.([]); } catch (_) {}
      container.innerHTML = '';
    },
  };
}
