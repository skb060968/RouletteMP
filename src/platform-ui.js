/* Shared UI helpers: screen switcher, toast, modal confirm. */

export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.setAttribute('hidden', ''));
  const target = document.getElementById(screenId);
  if (target) target.removeAttribute('hidden');
}

let _toastTimer = null;
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
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>${escapeHtml(title)}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <div class="modal-actions">
          <button class="btn primary" data-act="ok">${escapeHtml(okLabel)}</button>
          <button class="btn secondary" data-act="cancel">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'ok') { document.body.removeChild(overlay); resolve(true); }
      if (act === 'cancel' || e.target === overlay) {
        document.body.removeChild(overlay); resolve(false);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
