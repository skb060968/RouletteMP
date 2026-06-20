/**
 * Sound Manager — Roulette MP
 *
 * AudioContext-first with HTML Audio fallback.
 * Mute toggle persisted in localStorage.
 *
 * iOS / iPad notes:
 *   - AudioContext can be suspended after inactivity. We resume on every
 *     user gesture and kick a silent buffer to keep it alive.
 *   - Pre-warmed HTML <audio> elements (created during a real gesture) are
 *     iOS's most reliable fallback when the AudioContext is busy/suspended.
 */

const SOUND_FILES = {
  chip: '/sounds/chip-click.mp3',
  betClose: '/sounds/bet-close.mp3',
  spin: '/sounds/spin-loop.mp3',
  win: '/sounds/win.mp3',
  error: '/sounds/error.mp3',
  music: '/sounds/music.mp3',
};

const MUTE_KEY = 'roulette_mp_muted';

let audioCtx = null;
const soundBuffers = {};
/** Pre-warmed HTML audio elements (created on first gesture). */
const audioEls = {};
let initialized = false;
let warmedHtmlAudio = false;
let silentBuffer = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function kickSilent() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (!silentBuffer) silentBuffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = silentBuffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch (_) {}
}

async function loadBuffer(url) {
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  } catch (_) {
    return null;
  }
}

function preloadSounds() {
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    loadBuffer(url).then((buf) => { if (buf) soundBuffers[name] = buf; });
  });
}

/** Pre-create HTML <audio> elements during a real user gesture so iOS
 *  treats them as authorised and they remain playable as a fallback. */
function warmHtmlAudio() {
  if (warmedHtmlAudio) return;
  warmedHtmlAudio = true;
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    try {
      const a = new Audio(url);
      a.preload = 'auto';
      a.load();
      audioEls[name] = a;
    } catch (_) {}
  });
}

export function initAudio() {
  getAudioContext();
  if (!initialized) preloadSounds();
  const handler = () => {
    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        try { ctx.resume(); } catch (_) {}
      }
      kickSilent();
    }
    warmHtmlAudio();
    if (!initialized) {
      initialized = true;
      preloadSounds();
    }
  };
  ['click', 'touchstart', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, handler, { passive: true });
  });
}

export function isMuted() {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    return v === '1' || v === 'true';
  } catch (_) { return false; }
}

function setMuted(muted) {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) {}
}

export function toggleMute() {
  const next = !isMuted();
  setMuted(next);
  return next;
}

export function playSound(name, volume = 1.0) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { ctx.resume(); } catch (_) {}
  }
  // Path 1: AudioContext buffer source (best quality, lowest latency)
  if (ctx && ctx.state === 'running' && soundBuffers[name]) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = soundBuffers[name];
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }
  // Path 2: pre-warmed HTML <audio> element (survives ctx suspension on iOS)
  const warmed = audioEls[name];
  if (warmed) {
    try {
      warmed.currentTime = 0;
      warmed.volume = volume;
      const p = warmed.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return;
    } catch (_) {}
  }
  // Path 3: fresh Audio element (last resort)
  try {
    const a = new Audio(url);
    a.volume = volume;
    a.play().catch(() => {});
  } catch (_) {}
}

/* ======= BACKGROUND MUSIC ======= */

let bgMusicAudio = null;
let bgMusicSourceNode = null;
let bgMusicGainNode = null;
let bgMusicStartTime = 0;
let bgMusicPausedAt = 0;

/**
 * Starts looping background music at specified volume (0.0 - 1.0).
 * Uses HTML Audio element for reliable looping across all platforms.
 */
export function startBackgroundMusic(volume = 0.3) {
  if (isMuted()) return;
  
  // Stop any existing music first
  stopBackgroundMusic();
  
  const url = SOUND_FILES.music;
  if (!url) return;
  
  try {
    bgMusicAudio = new Audio(url);
    bgMusicAudio.loop = true;
    bgMusicAudio.volume = volume;
    bgMusicAudio.preload = 'auto';
    
    const playPromise = bgMusicAudio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // If autoplay is blocked, music will start on next user interaction
        console.log('Background music autoplay blocked - will start on next interaction');
      });
    }
  } catch (err) {
    console.error('Failed to start background music:', err);
  }
}

/**
 * Stops the background music.
 */
export function stopBackgroundMusic() {
  if (bgMusicAudio) {
    try {
      bgMusicAudio.pause();
      bgMusicAudio.currentTime = 0;
      bgMusicAudio = null;
    } catch (_) {}
  }
  if (bgMusicSourceNode) {
    try {
      bgMusicSourceNode.stop();
      bgMusicSourceNode.disconnect();
      bgMusicSourceNode = null;
    } catch (_) {}
  }
  if (bgMusicGainNode) {
    try {
      bgMusicGainNode.disconnect();
      bgMusicGainNode = null;
    } catch (_) {}
  }
}

/**
 * Sets background music volume (0.0 - 1.0).
 */
export function setBackgroundMusicVolume(volume) {
  if (bgMusicAudio) {
    try {
      bgMusicAudio.volume = Math.max(0, Math.min(1, volume));
    } catch (_) {}
  }
  if (bgMusicGainNode) {
    try {
      bgMusicGainNode.gain.value = Math.max(0, Math.min(1, volume));
    } catch (_) {}
  }
}

/**
 * Pauses background music (can be resumed).
 */
export function pauseBackgroundMusic() {
  if (bgMusicAudio) {
    try {
      bgMusicAudio.pause();
    } catch (_) {}
  }
}

/**
 * Resumes paused background music.
 */
export function resumeBackgroundMusic() {
  if (bgMusicAudio && bgMusicAudio.paused && !isMuted()) {
    try {
      const playPromise = bgMusicAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } catch (_) {}
  }
}
