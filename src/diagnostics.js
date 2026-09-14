/**
 * On-device diagnostics ring buffer + viewer.
 *
 * Field failures on a player's phone are otherwise invisible: a Firebase
 * `permission_denied`, a revision conflict and a transient network drop all reach
 * the player as the same friendly toast. This records the precise classification
 * and context of each failure to localStorage, so anyone can open the on-screen
 * viewer on any device and copy exactly what went wrong — no console, no cable.
 *
 * Ported from CardGamesMP, with four additions:
 *   1. console.error / console.warn are intercepted, so every existing error
 *      log in the game is captured without touching a single call site.
 *   2. Each entry carries a context snapshot (room, player, screen).
 *   3. The copied report has a header naming the build, so a stale bundle is
 *      obvious at a glance.
 *   4. 'permission_denied' is normalised into the codes list wherever it appears
 *      in the error chain, so rules failures are greppable.
 *
 * Self-installing: importing this module is the entire integration. It is
 * dependency-free and must never throw into the app.
 */

const GAME_ID = 'roulette';
const STORAGE_KEY = `${GAME_ID}-diagnostics`;
const MAX_ENTRIES = 80;
const MAX_DETAIL = 400;

let contextProvider = null;

function readEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeEntries(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch (_) {
    // Storage full or unavailable — diagnostics must never break the app.
  }
}

/** Any session record the game persisted, so entries carry room/player without
 *  the module needing to know this game's variable names. */
function sessionSnapshot() {
  try {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !/session/i.test(key)) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (value && typeof value === 'object') Object.assign(out, value);
      } catch (_) { /* not JSON — ignore */ }
    }
    return out;
  } catch (_) {
    return {};
  }
}

/** Whichever screen is visible right now — the cheapest "where was I" signal. */
function visibleScreen() {
  try {
    const screens = document.querySelectorAll('.screen, section[id]');
    for (const el of screens) {
      if (el.id && !el.hasAttribute('hidden') && el.offsetParent !== null) return el.id;
    }
  } catch (_) { /* ignore */ }
  return '';
}

/** Lets a game contribute its own live state (turn, phase, host flag). Optional. */
export function setDiagnosticsContext(fn) {
  contextProvider = typeof fn === 'function' ? fn : null;
}

function contextSnapshot() {
  const ctx = { ...sessionSnapshot(), screen: visibleScreen() };
  try {
    if (contextProvider) Object.assign(ctx, contextProvider() || {});
  } catch (_) { /* a broken provider must not lose the entry */ }
  return ctx;
}

/**
 * Records one diagnostic entry.
 * @param {{label?: string, codes?: string[], detail?: string, context?: object}} entry
 */
export function recordDiagnostic(entry = {}) {
  try {
    const entries = readEntries();
    entries.push({
      t: new Date().toISOString(),
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      label: entry.label || '',
      codes: Array.isArray(entry.codes) ? entry.codes.slice(0, 12) : [],
      detail: typeof entry.detail === 'string' ? entry.detail.slice(0, MAX_DETAIL) : '',
      ctx: { ...contextSnapshot(), ...(entry.context || {}) },
    });
    writeEntries(entries);
  } catch (_) {
    // Never propagate diagnostics failures.
  }
}

export function getDiagnostics() { return readEntries(); }
export function clearDiagnostics() { writeEntries([]); }

/** Walks an error's `cause` chain so wrapped Firebase errors keep their codes. */
function errorChain(error) {
  const chain = [];
  let cursor = error;
  let guard = 0;
  while (cursor && typeof cursor === 'object' && guard < 6) {
    chain.push(cursor);
    cursor = cursor.cause;
    guard += 1;
  }
  return chain;
}

function codesFrom(error) {
  const chain = errorChain(error);
  const codes = chain
    .map((e) => (typeof e?.code === 'string' ? e.code : null))
    .filter(Boolean);
  if (error?.name && !codes.includes(error.name)) codes.unshift(error.name);
  const blob = chain
    .flatMap((e) => [e?.code, e?.message])
    .filter((v) => typeof v === 'string')
    .join(' ');
  // Rules failures arrive with wildly different shapes; normalise so they grep.
  if (/permission(?:_|-|\s)denied/i.test(blob) && !codes.includes('permission_denied')) {
    codes.push('permission_denied');
  }
  return codes;
}

export function formatDiagnostics() {
  const entries = readEntries();
  const header = [
    `game    : ${GAME_ID}`,
    `when    : ${new Date().toISOString()}`,
    `build   : ${document.querySelector('script[type=module][src*=assets]')?.getAttribute('src') || 'dev'}`,
    `url     : ${location.origin}${location.pathname}`,
    `agent   : ${navigator.userAgent}`,
    `network : ${navigator.onLine ? 'online' : 'OFFLINE'}`,
    `entries : ${entries.length}`,
  ].join('\n');
  if (!entries.length) return `${header}\n\nNo diagnostics recorded yet.`;
  const body = entries
    .slice()
    .reverse()
    .map((entry) => {
      const net = entry.online === false ? 'OFFLINE' : entry.online === true ? 'online' : 'net?';
      const codes = (entry.codes || []).join(' / ') || '-';
      const ctx = Object.entries(entry.ctx || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      const detail = entry.detail ? `\n  ${entry.detail}` : '';
      return `${entry.t || '?'} [${net}] ${entry.label || ''} :: ${codes}${ctx ? `\n  (${ctx})` : ''}${detail}`;
    })
    .join('\n\n');
  return `${header}\n\n${body}`;
}

/**
 * Global capture. Three nets:
 *   - window 'error'            → render-time crashes
 *   - window 'unhandledrejection' → stray async failures
 *   - console.error / .warn     → every existing log site in the game, which is
 *     what makes this worth having: no call site has to be edited, and helpers
 *     like logError() or `console.error('Leave failed:', err)` are captured as-is.
 */
export function installGlobalErrorCapture() {
  if (typeof window === 'undefined' || window.__diagCapture) return;
  window.__diagCapture = true;

  window.addEventListener('error', (event) => {
    const error = event?.error;
    const where = event?.filename
      ? `${event.filename}:${event.lineno ?? '?'}:${event.colno ?? '?'}`
      : '';
    recordDiagnostic({
      label: 'uncaught-error',
      codes: codesFrom(error),
      detail: (error && (error.stack || error.message)) || event?.message || where,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    recordDiagnostic({
      label: 'unhandled-rejection',
      codes: codesFrom(reason),
      detail: (reason && (reason.stack || reason.message)) || String(reason),
    });
  });

  for (const level of ['error', 'warn']) {
    const original = console[level]?.bind(console);
    if (!original) continue;
    console[level] = (...args) => {
      try {
        const err = args.find((a) => a instanceof Error);
        const text = args
          .map((a) => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
            return String(a);
          })
          .join(' ');
        // Skip our own viewer noise and empty calls.
        if (text.trim()) {
          recordDiagnostic({ label: `console.${level}`, codes: codesFrom(err), detail: text });
        }
      } catch (_) { /* recording must never break logging */ }
      original(...args);
    };
  }
}

/** Builds the on-device viewer so the log can be read or copied on any phone. */
export function showDiagnosticsOverlay() {
  if (document.getElementById('diagnostics-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'diagnostics-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Diagnostics log');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '10000', display: 'flex',
    flexDirection: 'column', gap: '10px', padding: '16px',
    background: 'rgba(8, 13, 20, 0.92)', color: '#f8fafc',
    font: '13px/1.4 ui-monospace, Menlo, Consolas, monospace',
  });

  const title = document.createElement('strong');
  title.textContent = `Diagnostics — ${GAME_ID}`;
  title.style.fontSize = '15px';

  const area = document.createElement('textarea');
  area.readOnly = true;
  area.value = formatDiagnostics();
  Object.assign(area.style, {
    flex: '1', width: '100%', resize: 'none', borderRadius: '10px',
    border: '1px solid #334155', padding: '10px', background: '#0f172a',
    color: '#e2e8f0', font: 'inherit', whiteSpace: 'pre', overflow: 'auto',
  });

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
  const makeButton = (label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      flex: '1', minWidth: '90px', padding: '11px 14px', borderRadius: '10px',
      border: '0', fontWeight: '700', cursor: 'pointer',
    });
    return button;
  };
  const copyButton = makeButton('Copy');
  copyButton.style.background = '#38bdf8';
  copyButton.style.color = '#082f49';
  const clearButton = makeButton('Clear');
  clearButton.style.background = '#f59e0b';
  clearButton.style.color = '#451a03';
  const closeButton = makeButton('Close');
  closeButton.style.background = '#334155';
  closeButton.style.color = '#f8fafc';

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(area.value);
      copyButton.textContent = 'Copied';
    } catch (_) {
      // Clipboard is blocked on insecure origins and some in-app browsers.
      area.focus();
      area.select();
      copyButton.textContent = 'Select + copy';
    }
    setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
  });
  clearButton.addEventListener('click', () => {
    clearDiagnostics();
    area.value = formatDiagnostics();
  });
  closeButton.addEventListener('click', () => overlay.remove());

  row.append(copyButton, clearButton, closeButton);
  overlay.append(title, area, row);
  document.body.appendChild(overlay);
}

/**
 * Discreet 5-tap gesture (within 2s) that opens the viewer. Bound at document
 * level so it works on EVERY screen — including mid-game and results — because
 * the log matters most right after a failure. Taps on interactive controls are
 * ignored so it can never interfere with play; an accidental open is harmless.
 */
function installDiagnosticsGesture() {
  const interactive = 'button, a, input, textarea, select, label, [role="button"],'
    + ' svg, canvas, [data-action], [data-card-index], [data-hand-index],'
    + ' .card, .cell, .pick, .emoji-btn, .color-btn, .avatar-choice';
  let taps = 0;
  let timer = null;
  document.addEventListener('click', (event) => {
    if (document.getElementById('diagnostics-overlay')) return;
    if (event.target instanceof Element && event.target.closest(interactive)) return;
    taps += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { taps = 0; }, 2000);
    if (taps >= 5) {
      taps = 0;
      clearTimeout(timer);
      showDiagnosticsOverlay();
    }
  }, true);
}

// Self-install on import: capture as early as possible so startup failures are
// recorded too. Importing this module is the whole integration.
installGlobalErrorCapture();
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDiagnosticsGesture, { once: true });
  } else {
    installDiagnosticsGesture();
  }
}
