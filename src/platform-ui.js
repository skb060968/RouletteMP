/* Shared UI helpers: screen switcher, toast, modal confirm. */

export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.setAttribute('hidden', ''));
  const target = document.getElementById(screenId);
  if (target) target.removeAttribute('hidden');
}

let _toastTimer = null;
const _activeConfirmClosers = new Set();
let _confirmSequence = 0;

export function showToast(message, durationMs = 1800) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    t.className = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.remove('fade-out');
  void t.offsetWidth;
  t.classList.add('fade-out');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (t.parentNode) t.parentNode.removeChild(t);
  }, durationMs);
}

export function confirmModal(title, message, okLabel = 'OK', cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    const titleId = `confirm-title-${++_confirmSequence}`;
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', titleId);
    overlay.innerHTML = `
      <div class="modal-box">
        <h3 id="${titleId}">${escapeHtml(title)}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <div class="modal-actions">
          <button class="btn primary" type="button" data-act="ok">${escapeHtml(okLabel)}</button>
          <button class="btn secondary" type="button" data-act="cancel">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>`;

    let closed = false;
    const close = (result, restoreFocus = true) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown);
      _activeConfirmClosers.delete(close);
      overlay.remove();
      if (restoreFocus) restoreFocusTo?.focus();
      resolve(result);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const buttons = [...overlay.querySelectorAll('button:not([disabled])')];
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    _activeConfirmClosers.add(close);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', (event) => {
      const act = event.target instanceof Element ? event.target.closest('[data-act]')?.dataset.act : null;
      if (act === 'ok') close(true);
      if (act === 'cancel' || event.target === overlay) close(false);
    });
    overlay.querySelector('[data-act="ok"]')?.focus();
  });
}

export function dismissConfirmModals() {
  [..._activeConfirmClosers].forEach((close) => close(false, false));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
