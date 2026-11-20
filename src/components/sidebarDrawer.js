/* ============================================================
   NOVA // OS — collapsible navigation drawer
   Primary navigation, pinned/recent conversations, system
   HUD entries, a focus-audio mini player and the profile bar.
   ============================================================ */
import { store, escapeHtml, relTime } from '../services/store.js';

const NAV = [
  { id: 'new', icon: '📝', label: 'New chat' },
  { id: 'library', icon: '🖼️', label: 'Library' },
  { id: 'vision', icon: '🎨', label: 'Vision & Ad Studio' },
  { id: 'scheduled', icon: '🕒', label: 'Scheduled', tag: 'PRO' },
  { id: 'study', icon: '🎓', label: 'Study & Research' },
  { id: 'notebooks', icon: '📓', label: 'Notebooks' },
  { id: 'hub', icon: '🔌', label: 'Connected apps' }
];

const HUDS = [
  { id: 'storage', icon: '💾', label: 'Storage Map' },
  { id: 'radar', icon: '📡', label: 'Network Radar' }
];

/* ── focus audio: a soft generated pad, no external files ── */
function createPad() {
  let ctx = null;
  let gain = null;
  let nodes = [];
  let playing = false;

  const start = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = ctx || new AC();
    gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 620;
    gain.connect(filter).connect(ctx.destination);
    nodes = [110, 164.8, 220.5].map((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 2 ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      osc.detune.value = i * 6 - 6;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.5 : 0.22;
      osc.connect(g).connect(gain);
      osc.start();
      return osc;
    });
    gain.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 1.2);
    playing = true;
    return true;
  };

  const stop = () => {
    if (!ctx || !gain) return;
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
    const old = nodes;
    setTimeout(() => old.forEach((o) => { try { o.stop(); } catch { /* noop */ } }), 420);
    nodes = [];
    playing = false;
  };

  return { toggle: () => (playing ? (stop(), false) : (start(), true)), isPlaying: () => playing };
}

export function mountSidebar(app) {
  const root = document.getElementById('sidebar');
  if (!root) return { refresh() {} };
  const pad = createPad();
  let filter = '';
  let playing = false;

  const chatRow = (chat) => `
    <button class="chat-item${chat.id === store.get('activeChatId') ? ' is-active' : ''}" data-chat="${chat.id}" type="button">
      <span class="chat-item__title">${escapeHtml(chat.title || 'Untitled')}</span>
      ${chat.pinned ? '<span class="chat-item__pin" title="Pinned">●</span>' : ''}
      <span class="chat-item__more" data-more="${chat.id}" role="button" tabindex="0" aria-label="Chat options">⋯</span>
    </button>`;

  const render = () => {
    const chats = store.get('chats', []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
    const needle = filter.trim().toLowerCase();
    const visible = needle ? chats.filter((c) => c.title.toLowerCase().includes(needle)) : chats;
    const pinned = visible.filter((c) => c.pinned);
    const recent = visible.filter((c) => !c.pinned);
    const notebooks = store.get('notebooks', []);
    const user = escapeHtml(store.get('lock.user', 'Master Drippy Dee'));

    root.innerHTML = `
      <div class="sidebar__head">
        <span class="sb-brand"><span class="brand-dot"></span> Nova <small>// OS</small></span>
        <span class="sb-head__spacer"></span>
        <button class="icon-btn icon-btn--sm" id="sbCollapse" type="button" aria-label="Collapse navigation">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </button>
      </div>

      <label class="sb-search">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <input id="sbSearch" type="search" placeholder="Search chats" value="${escapeHtml(filter)}" aria-label="Search chats" />
        <kbd>⌘K</kbd>
      </label>

      <div class="sb-scroll">
        <div class="chat-list">
          ${NAV.map((n) => `
            <button class="nav-item${n.id === 'new' ? ' nav-item--new' : ''}" data-nav="${n.id}" type="button">
              <span class="nav-item__icon">${n.icon}</span>
              <span class="nav-item__label">${n.label}</span>
              ${n.tag ? `<span class="nav-item__tag">${n.tag}</span>` : ''}
            </button>`).join('')}
        </div>

        <div class="sb-section"><span class="sb-section__title">System</span></div>
        <div class="sb-hud">
          ${HUDS.map((h) => `
            <button class="nav-item" data-nav="${h.id}" type="button">
              <span class="nav-item__icon">${h.icon}</span>
              <span class="nav-item__label">${h.label}</span>
            </button>`).join('')}
        </div>

        <button class="sb-player" id="sbPlayer" type="button" aria-pressed="false">
          <span class="sb-player__art">${playing ? 'Ⅱ' : '▶'}</span>
          <span class="sb-player__meta">
            <b>${playing ? 'Deep focus — playing' : 'Deep focus'}</b>
            <span>Generated ambient · 60 min</span>
          </span>
          <span aria-hidden="true">${playing ? '❚❚' : '▷'}</span>
        </button>

        ${pinned.length ? `
          <div class="sb-section"><span class="sb-section__title">Pinned</span></div>
          <div class="chat-list">${pinned.map(chatRow).join('')}</div>` : ''}

        <div class="sb-section">
          <span class="sb-section__title">Recent</span>
          <button class="sb-add" data-nav="new" type="button" aria-label="New chat">+</button>
        </div>
        <div class="chat-list">
          ${recent.length ? recent.map(chatRow).join('') : `<p class="sb-empty">${needle ? 'No chats match that.' : 'No conversations yet.'}</p>`}
        </div>

        ${notebooks.length ? `
          <div class="sb-section"><span class="sb-section__title">Notebooks</span></div>
          <div class="chat-list">
            ${notebooks.map((n) => `
              <button class="chat-item" data-notebook="${n.id}" type="button">
                <span class="chat-item__title">${escapeHtml(n.title)}</span>
                <span class="chat-item__pin" style="color:var(--mute)">${n.entries}</span>
              </button>`).join('')}
          </div>` : ''}
      </div>

      <div class="sb-user">
        <span class="sb-avatar">DD</span>
        <span class="sb-user__name">${user}<small>Workspace owner</small></span>
        <span class="pro-badge">PRO</span>
        <button class="icon-btn icon-btn--sm" data-nav="settings" type="button" aria-label="Settings" style="margin-left:auto">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>`;
  };

  const openChatMenu = (id, anchor) => {
    const chat = store.get('chats', []).find((c) => c.id === id);
    if (!chat) return;
    document.querySelectorAll('.menu--chat').forEach((m) => m.remove());
    const menu = document.createElement('div');
    menu.className = 'menu menu--chat';
    menu.style.position = 'fixed';
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 220)}px`;
    menu.innerHTML = `
      <button class="menu__item" data-cm="share" type="button">Share transcript</button>
      <button class="menu__item" data-cm="pin" type="button">${chat.pinned ? 'Unpin' : 'Pin'} conversation</button>
      <button class="menu__item" data-cm="rename" type="button">Rename</button>
      <div class="menu__sep"></div>
      <button class="menu__item" data-cm="delete" type="button" style="color:#ffb4bf">Delete</button>`;
    document.body.appendChild(menu);
    const away = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', away); }
    };
    setTimeout(() => document.addEventListener('mousedown', away), 0);

    menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-cm]')?.dataset.cm;
      if (!act) return;
      menu.remove();
      if (act === 'pin') { store.pinChat(id); render(); app.refreshChats(); }
      if (act === 'delete') {
        app.confirm({
          title: 'Delete conversation?',
          sub: escapeHtml(chat.title),
          body: '<p class="dim" style="font-size:13px">This removes it from local history. Files in the workspace are untouched.</p>',
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => { store.deleteChat(id); render(); app.refreshChats(); app.toast('Conversation deleted'); }
        });
      }
      if (act === 'rename') {
        app.promptText({
          title: 'Rename conversation',
          value: chat.title,
          confirmLabel: 'Save',
          onConfirm: (v) => { store.renameChat(id, v); render(); app.refreshChats(); }
        });
      }
      if (act === 'share') {
        const text = `NOVA // OS — ${chat.title}\n\n` + chat.messages.map((m) => `${m.role === 'user' ? 'You' : 'Nova'}: ${m.text}`).join('\n\n');
        app.copy(text, 'Transcript copied');
      }
    });
  };

  render();

  root.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) {
      e.stopPropagation();
      openChatMenu(more.dataset.more, more);
      return;
    }
    const chat = e.target.closest('[data-chat]');
    if (chat) { app.openChat(chat.dataset.chat); render(); return; }
    const notebook = e.target.closest('[data-notebook]');
    if (notebook) { app.openNotebook(notebook.dataset.notebook); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { app.navigate(nav.dataset.nav); return; }
    if (e.target.closest('#sbCollapse')) { app.toggleNav(false); return; }
    if (e.target.closest('#sbPlayer')) {
      playing = pad.toggle();
      app.toast(playing ? 'Focus audio on — generated locally' : 'Focus audio off');
      render();
    }
  });

  root.addEventListener('input', (e) => {
    if (e.target.id !== 'sbSearch') return;
    filter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const next = document.getElementById('sbSearch');
    if (next) { next.focus(); next.setSelectionRange(pos, pos); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      app.toggleNav(true);
      setTimeout(() => document.getElementById('sbSearch')?.focus(), 120);
    }
  });

  return { refresh: render, relTime };
}
