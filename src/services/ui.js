/* ============================================================
   NOVA // OS — shared UI plumbing
   Toasts, slide-over panels, modal sheets, clipboard.
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const host = () => document.getElementById('panelHost');
const modalHost = () => document.getElementById('modalHost');

let activePanel = null;

/* ── toasts ───────────────────────────────────────────────── */
export function toast(text, kind = '') {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` toast--${kind}` : ''}`;
  el.innerHTML = `<span class="toast__icon">${kind === 'bad' ? '⚠' : kind === 'ok' ? '✓' : '·'}</span><span>${text}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 240);
  }, 3400);
}

/* ── clipboard ────────────────────────────────────────────── */
export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(label, 'ok'); return true; }
    catch { toast('Clipboard blocked by the browser', 'bad'); return false; }
    finally { ta.remove(); }
  }
}

/* ── slide-over panels ────────────────────────────────────── */
/**
 * openPanel({ id, title, sub, icon, wide, full, body, onMount })
 * body may be an HTML string or a function returning one.
 * onMount receives { body, close, refresh, panel }.
 */
export function openPanel({ id, title, sub = '', icon = '', wide = false, full = false, body = '', onMount = null }) {
  closePanel(true);
  const wrap = document.createElement('div');
  wrap.className = 'panel-wrap';
  wrap.dataset.panel = id;
  wrap.innerHTML = `
    <div class="panel-scrim" data-close></div>
    <aside class="panel${full ? ' panel--full' : wide ? ' panel--wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <header class="panel__head">
        ${icon ? `<span class="icon">${icon}</span>` : ''}
        <div class="panel__titles">
          <div class="panel__title">${title}</div>
          ${sub ? `<div class="panel__sub">${sub}</div>` : ''}
        </div>
        <span class="spacer"></span>
        <button class="icon-btn" data-close type="button" aria-label="Close panel">✕</button>
      </header>
      <div class="panel__body"></div>
    </aside>`;
  host().appendChild(wrap);
  const bodyEl = wrap.querySelector('.panel__body');

  const api = {
    id,
    wrap,
    body: bodyEl,
    close: () => closePanel(),
    refresh: () => {
      const next = typeof body === 'function' ? body() : body;
      if (typeof next === 'string') bodyEl.innerHTML = next;
    }
  };

  bodyEl.innerHTML = typeof body === 'function' ? body() : body;
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel()));
  if (onMount) onMount(api);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  activePanel = api;
  document.body.classList.add('panel-open');
  document.dispatchEvent(new CustomEvent('nova:panel', { detail: { id, open: true } }));
  return api;
}

export function closePanel(instant = false) {
  if (!activePanel) return;
  const { wrap } = activePanel;
  wrap.classList.remove('is-open');
  activePanel = null;
  document.body.classList.remove('panel-open');
  document.dispatchEvent(new CustomEvent('nova:panel', { detail: { id: null, open: false } }));
  if (instant) wrap.remove();
  else setTimeout(() => wrap.remove(), 320);
}

export function currentPanel() {
  return activePanel;
}

/* keep Escape closing the top-most layer */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modalHost().childElementCount) {
    const top = modalHost().lastElementChild;
    top.dispatchEvent(new CustomEvent('nova:modal-close'));
  } else if (activePanel) {
    closePanel();
  }
});

/* ── modal sheet ──────────────────────────────────────────── */
/**
 * openModal({ title, sub, body, actions:[{label, kind, onClick}] })
 * Returns { close }. Escape or scrim click closes.
 */
export function openModal({ title, sub = '', body = '', actions = [], onMount = null }) {
  const back = document.createElement('div');
  back.className = 'modal';
  back.innerHTML = `
    <div class="modal__card" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal__head">
        <div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</div>
        <button class="icon-btn" data-x type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal__body">${body}</div>
      ${actions.length ? `<div class="modal__foot">${actions
        .map((a, i) => `<button class="btn ${a.kind === 'primary' ? 'btn--primary' : a.kind === 'danger' ? 'btn--danger' : ''}" data-act="${i}" type="button">${a.label}</button>`)
        .join('')}</div>` : ''}
    </div>`;
  modalHost().appendChild(back);

  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-x]').addEventListener('click', close);
  back.addEventListener('nova:modal-close', close);
  back.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = actions[Number(btn.dataset.act)];
      if (!action) return;
      const keep = action.onClick && action.onClick(back, close);
      if (!keep) close();
    });
  });
  if (onMount) onMount(back, close);
  const focusable = back.querySelector('input, textarea, select, button');
  if (focusable) setTimeout(() => focusable.focus(), 40);
  return { close, el: back };
}

/* ── misc ─────────────────────────────────────────────────── */
export const pct = (n, total) => `${Math.max(0, Math.min(100, Math.round((n / (total || 1)) * 100)))}%`;

export const bytesLabel = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};
