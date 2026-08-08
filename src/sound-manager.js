const SOUND_FILES = {
  chip: '/sounds/chip-click.mp3',
  betClose: '/sounds/bet-close.mp3',
  spin: '/sounds/spin-loop.mp3',
  win: '/sounds/win.mp3',
  error: '/sounds/error.mp3',
  music: '/sounds/music.mp3',
};

const MUTE_KEY = 'roulette_mp_muted';
const GESTURE_EVENTS = ['pointerdown', 'touchstart', 'keydown'];

let audioCtx = null;
const soundBuffers = {};
const audioEls = {};
let listenersAttached = false;
let preloadStarted = false;
let warmedHtmlAudio = false;
let silentBuffer = null;
let bgMusicAudio = null;
let bgMusicWanted = false;
let bgMusicVolume = 0.3;
let musicWasPlayingBeforeHidden = false;

function getAudioContext() {
  if (!audioCtx) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) audioCtx = new Context();
  }
  return audioCtx;
}

function resumeContext() {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'suspended') return;
  const result = ctx.resume();
  result?.catch?.(() => {});
}

function kickSilent() {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'running') return;
  try {
    if (!silentBuffer) silentBuffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (_) {}
}

async function loadBuffer(url) {
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const response = await fetch(url);
    if (!response.ok || response.status !== 200) return null;
    return await ctx.decodeAudioData(await response.arrayBuffer());
  } catch (_) {
    return null;
  }
}

function preloadSounds() {
  if (preloadStarted) return;
  preloadStarted = true;
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    loadBuffer(url).then((buffer) => {
      if (buffer) soundBuffers[name] = buffer;
    });
  });
}

function warmHtmlAudio() {
  if (warmedHtmlAudio) return;
  warmedHtmlAudio = true;
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    try {
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.load();
      audioEls[name] = audio;
    } catch (_) {}
  });
}

function handleUserGesture() {
  if (!isMuted()) {
    resumeContext();
    kickSilent();
  }
  warmHtmlAudio();
  preloadSounds();
  if (bgMusicWanted && bgMusicAudio?.paused && !isMuted() && document.visibilityState === 'visible') {
    bgMusicAudio.play().catch(() => {});
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    musicWasPlayingBeforeHidden = Boolean(bgMusicAudio && !bgMusicAudio.paused);
    bgMusicAudio?.pause();
    return;
  }
  if (!isMuted()) resumeContext();
  if (musicWasPlayingBeforeHidden && bgMusicWanted && bgMusicAudio && !isMuted()) {
    bgMusicAudio.play().catch(() => {});
  }
  musicWasPlayingBeforeHidden = false;
}

function handlePageShow() {
  if (!isMuted()) resumeContext();
}

export function initAudio() {
  getAudioContext();
  preloadSounds();
  if (listenersAttached) return;
  listenersAttached = true;
  GESTURE_EVENTS.forEach((eventName) => {
    document.addEventListener(eventName, handleUserGesture, { passive: true });
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handlePageShow);
}

export function disposeAudio() {
  if (!listenersAttached) return;
  listenersAttached = false;
  GESTURE_EVENTS.forEach((eventName) => {
    document.removeEventListener(eventName, handleUserGesture);
  });
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('pageshow', handlePageShow);
}

export function isMuted() {
  try {
    const value = localStorage.getItem(MUTE_KEY);
    return value === '1' || value === 'true';
  } catch (_) {
    return false;
  }
}

function setMuted(muted) {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) {}
}

export function toggleMute() {
  const muted = !isMuted();
  setMuted(muted);
  if (muted) {
    bgMusicAudio?.pause();
  } else {
    resumeContext();
    if (bgMusicWanted) {
      if (bgMusicAudio) bgMusicAudio.play().catch(() => {});
      else startBackgroundMusic(bgMusicVolume);
    }
  }
  return muted;
}

export function playSound(name, volume = 1) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  const ctx = getAudioContext();
  if (ctx?.state === 'suspended') resumeContext();

  if (ctx?.state === 'running' && soundBuffers[name]) {
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = soundBuffers[name];
      gain.gain.value = Math.max(0, Math.min(1, volume));
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      return;
    } catch (_) {}
  }

  const warmed = audioEls[name];
  if (warmed) {
    try {
      warmed.currentTime = 0;
      warmed.volume = Math.max(0, Math.min(1, volume));
      warmed.play().catch(() => {});
      return;
    } catch (_) {}
  }

  try {
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.play().catch(() => {});
  } catch (_) {}
}

function destroyBackgroundMusic() {
  if (!bgMusicAudio) return;
  try {
    bgMusicAudio.pause();
    bgMusicAudio.currentTime = 0;
  } catch (_) {}
  bgMusicAudio = null;
}

export function startBackgroundMusic(volume = 0.3) {
  bgMusicWanted = true;
  bgMusicVolume = Math.max(0, Math.min(1, volume));
  destroyBackgroundMusic();
  if (isMuted()) return;

  try {
    bgMusicAudio = new Audio(SOUND_FILES.music);
    bgMusicAudio.loop = true;
    bgMusicAudio.volume = bgMusicVolume;
    bgMusicAudio.preload = 'auto';
    bgMusicAudio.play().catch(() => {});
  } catch (_) {
    bgMusicAudio = null;
  }
}

export function stopBackgroundMusic() {
  bgMusicWanted = false;
  musicWasPlayingBeforeHidden = false;
  destroyBackgroundMusic();
}

export function setBackgroundMusicVolume(volume) {
  bgMusicVolume = Math.max(0, Math.min(1, volume));
  if (bgMusicAudio) bgMusicAudio.volume = bgMusicVolume;
}

export function pauseBackgroundMusic() {
  bgMusicAudio?.pause();
}

export function resumeBackgroundMusic() {
  if (!bgMusicAudio || !bgMusicWanted || isMuted()) return;
  bgMusicAudio.play().catch(() => {});
}
