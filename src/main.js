/* ============================================================
   NOVA // OS — application shell
   Boots the security gate, mounts the drawer + chat canvas,
   routes every HUD panel, and runs the voice overlay.
   ============================================================ */
import { store, escapeHtml } from './services/store.js';
import { getStatus, isLive } from './services/aiCouncil.js';
import { api } from './services/net.js';
import { speak, cancel as cancelSpeech, listen, stopListening } from './services/voiceEngine.js';
import { $, toast, openModal, copyText, currentPanel } from './services/ui.js';
import { mountBiometricGate } from './components/biometricGate.js';
import { mountSidebar } from './components/sidebarDrawer.js';
import { mountChatCanvas } from './components/chatCanvas.js';
import { openStoragePanel, openRadarPanel } from './components/systemHuds.js';
import { openVisionPanel } from './components/visionModal.js';
import { searchWeb } from './services/toolsEngine.js';
import { openCustomizeHub } from './components/customizeHub.js';
import { openSettingsPanel } from './components/settingsView.js';
import { openWorkspacePanel } from './components/codeWorkspace.js';
import { openLibraryPanel, openScheduledPanel, openStudyPanel, openNotebooksPanel } from './components/workspaceViews.js';
import { mountOrb, createMicMeter } from './components/neuralOrb.js';

/* ── theme before first paint ─────────────────────────────── */
document.body.classList.toggle('theme-slate', store.get('prefs.theme', 'oled') === 'slate');
document.body.classList.toggle('serious', Boolean(store.get('prefs.serious', false)));
if (window.innerWidth > 1024) document.body.classList.add('nav-open');

let status = store.get('councilStatus', null);
let chat = null;
let sidebar = null;
let watchdogTimer = null;
let watchdogFired = false;

/* ── app façade handed to every component ─────────────────── */
const app = {
  toast,
  copy: copyText,
  isDemo: () => !isLive(status),
  autoSpeak: () => false,

  toggleNav(force) {
    const open = typeof force === 'boolean' ? force : !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open', open);
    const scrim = $('#scrim');
    const drawerBtn = $('#drawerBtn');
    if (drawerBtn) drawerBtn.setAttribute('aria-expanded', String(open));
    if (scrim) {
      scrim.hidden = !(open && window.innerWidth < 1024);
      scrim.classList.toggle('is-on', open && window.innerWidth < 1024);
    }
  },

  refreshChats() { if (sidebar) sidebar.refresh(); },
  syncUsage() { /* meters read the store on open */ },
  syncStatus() { if (chat) chat.refresh(); },

  openChat(id) {
    store.openChat(id);
    if (chat) chat.refresh();
    app.toggleNav(false);
  },

  navigate(id) {
    if (id === 'new') {
      store.newChat();
      if (chat) chat.refresh();
      app.toggleNav(false);
      setTimeout(() => chat && chat.focus(), 120);
      return;
    }
    if (id === 'notebooks') { openNotebooksPanel(app); app.toggleNav(false); return; }
    if (id === 'settings') { openSettingsPanel(app); app.toggleNav(false); return; }
    app.openPanel(id);
    app.toggleNav(false);
  },

  openNotebook(id) { openNotebooksPanel(app, id); },

  openPanel(name, opts = {}) {
    switch (name) {
      case 'workspace': return openWorkspacePanel(app, opts);
      case 'vision': return openVisionPanel(app, opts);
      case 'storage': return openStoragePanel(app);
      case 'radar': return openRadarPanel(app);
      case 'hub': return openCustomizeHub(app, opts.tab || 'discover');
      case 'settings': return openSettingsPanel(app);
      case 'library': return openLibraryPanel(app);
      case 'scheduled': return openScheduledPanel(app);
      case 'study': return openStudyPanel(app);
      case 'notebooks': return openNotebooksPanel(app);
      case 'memory': return openSettingsPanel(app);
      default: return null;
    }
  },

  confirm({ title, sub = '', body = '', confirmLabel = 'Confirm', danger = false, onConfirm }) {
    openModal({
      title, sub, body,
      actions: [
        { label: 'Cancel' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { onConfirm && onConfirm(); } }
      ]
    });
  },

  promptText({ title, sub = '', value = '', placeholder = '', confirmLabel = 'Save', onConfirm }) {
    openModal({
      title, sub,
      body: `<div class="field"><input id="promptTextInput" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" /></div>`,
      actions: [
        { label: 'Cancel' },
        { label: confirmLabel, kind: 'primary', onClick: (el) => { onConfirm && onConfirm(el.querySelector('#promptTextInput').value.trim()); } }
      ],
      onMount: (el) => { const i = el.querySelector('#promptTextInput'); i.focus(); i.select(); }
    });
  },

  openVoice: () => openVoiceOverlay()
};

/* ── mode menu ────────────────────────────────────────────── */
const MODES = [
  { id: 'chat', label: 'Chat Only', sub: 'Efficient', group: 'Mode', desc: 'One model, a direct answer' },
  { id: 'build', label: 'Build & Agent Mode', sub: 'Coding', group: 'Mode', desc: 'Plan, edit, audit and ship' },
  { id: 'conversation', label: 'Conversation Mode', sub: 'Voice', group: 'Mode', desc: 'Voice-first, spoken replies' }
];
const EFFORTS = [
  { id: 'efficient', label: 'Efficient', desc: 'Single model, fastest' },
  { id: 'balanced', label: 'Balanced', desc: 'Primary answer, self-verified' },
  { id: 'powerful', label: 'Powerful Council', desc: 'Parallel models, one synthesis' },
  { id: 'uncensored', label: '🔓 Uncensored (Venice)', desc: 'Venice AI, no filters' }
];

function syncModePill() {
  const mode = store.get('prefs.mode', 'chat');
  const effort = store.get('prefs.effort', 'balanced');
  const serious = store.get('prefs.serious', false);
  const m = MODES.find((x) => x.id === mode) || MODES[0];
  const name = $('#modeName');
  const sub = $('#modeSub');
  if (name) name.textContent = serious ? 'Serious Mode' : m.label;
  if (sub) sub.textContent = `${effort}${serious ? ' · serious' : ''}`;
}

function buildModeMenu() {
  const menu = $('#modeMenu');
  if (!menu) return;
  const mode = store.get('prefs.mode', 'chat');
  const effort = store.get('prefs.effort', 'balanced');
  const serious = store.get('prefs.serious', false);
  menu.innerHTML = `
    <div class="menu__label">Mode</div>
    ${MODES.map((m) => `<button class="menu__item ${mode === m.id && !serious ? 'is-active' : ''}" data-mode="${m.id}" type="button">
      <span><b style="font-weight:450">${m.label}</b><small>${m.desc}</small></span>
      ${mode === m.id && !serious ? '<span class="menu__check">✓</span>' : ''}
    </button>`).join('')}
    <div class="menu__sep"></div>
    <div class="menu__label">Effort</div>
    ${EFFORTS.map((e) => `<button class="menu__item ${effort === e.id ? 'is-active' : ''}" data-effort="${e.id}" type="button">
      <span><b style="font-weight:450">${e.label}</b><small>${e.desc}</small></span>
      ${effort === e.id ? '<span class="menu__check">✓</span>' : ''}
    </button>`).join('')}
    <div class="menu__sep"></div>
    <button class="menu__item ${serious ? 'is-active' : ''}" data-serious type="button">
      <span><b style="font-weight:450">🎯 Serious Mode</b><small>Crimson-gold accent, adversarial reasoning</small></span>
      ${serious ? '<span class="menu__check">✓</span>' : ''}
    </button>`;
}

function wireModeMenu() {
  const btn = $('#modeBtn');
  const menu = $('#modeMenu');
  if (!btn || !menu) return;

  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = menu.hidden;
    buildModeMenu();
    menu.hidden = !next;
    btn.setAttribute('aria-expanded', String(next));
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
  });

  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode],[data-effort],[data-serious]');
    if (!b) return;
    if (b.dataset.mode) {
      store.set('prefs.mode', b.dataset.mode);
      if (b.dataset.mode === 'conversation') app.openVoice();
      store.set('prefs.serious', false);
      document.body.classList.remove('serious');
      toast(`${MODES.find((m) => m.id === b.dataset.mode).label} armed`);
    }
    if (b.dataset.effort) {
      store.set('prefs.effort', b.dataset.effort);
      if (b.dataset.effort === 'uncensored') {
        store.set('prefs.serious', false);
        document.body.classList.remove('serious');
      }
      toast(`Effort: ${b.dataset.effort}`);
    }
    if (b.hasAttribute('data-serious')) {
      const next = !store.get('prefs.serious', false);
      store.set('prefs.serious', next);
      document.body.classList.toggle('serious', next);
      toast(next ? 'Serious Mode on — accent shifted' : 'Persona restored');
    }
    close();
    syncModePill();
    if (chat) chat.setMode();
  });
}

/* ── voice overlay ────────────────────────────────────────── */
async function captureAndInspect() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 1280 }, audio: false });
    const v = document.createElement('video');
    v.srcObject = stream;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.8);
    stream.getTracks().forEach((t) => t.stop());
    toast('Scanning frame…');
    const res = await api('/api/council', {
      method: 'POST',
      timeout: 60000,
      body: { messages: [{ role: 'user', content: 'Look at this image. Describe what you see, especially any object in hand or code on screen. Be specific and brief.' }], images: [dataUrl], role: 'chat', effort: 'efficient' }
    });
    const text = (res && res.text) || 'I could not read the frame.';
    document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text } }));
  } catch (err) {
    toast('Camera unavailable', 'bad');
  }
}

async function morningBrief() {
  const parts = [];
  // weather
  try {
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no geo'));
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 6000 });
    });
    const { latitude, longitude } = pos.coords;
    const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m`).then((r) => r.json());
    const cur = w && w.current;
    if (cur) parts.push(`Weather: ${Math.round(cur.temperature_2m)}°C, wind ${Math.round(cur.wind_speed_10m)} km/h.`);
  } catch { parts.push('Weather: unavailable (location blocked).'); }
  // github repos
  try {
    const gh = await api('/api/github', { method: 'GET', timeout: 6000 });
    if (gh && gh.username) parts.push(`GitHub target: ${gh.username}/nova-os.`);
  } catch { /* ignore */ }
  // headlines
  try {
    const r = await searchWeb('top headlines today', 5);
    if (r && r.ok && r.sources && r.sources.length) {
      parts.push('Headlines:');
      r.sources.slice(0, 4).forEach((s, i) => parts.push(`${i + 1}. ${s.title}`));
    }
  } catch { /* ignore */ }
  const text = `Good morning, Master Drippy Dee.\n\n${parts.join('\n')}\n\nThat is the board. Say the word and I will take the first item off your desk.`;
  document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text } }));
}

function openVoiceOverlay() {
  const overlay = $('#voiceOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  cancelSpeech();

  const orb = mountOrb($('#orbCanvas'));
  const stateEl = $('#voiceState');
  const caption = $('#voiceCaption');
  const orbBtn = $('#voiceOrbBtn');
  const hint = $('#voiceHint');
  const agentSelect = $('#agentModeSelect');
  if (agentSelect) {
    agentSelect.value = store.get('prefs.agentMode', 'orchestrator');
    agentSelect.addEventListener('change', () => store.set('prefs.agentMode', agentSelect.value));
  }
  let meter = null;
  let meterRaf = 0;
  let listening = false;
  let state = 'idle';

  const setState = (s, text) => {
    state = s;
    orb.setState(s);
    if (stateEl) stateEl.textContent = s === 'listening' ? 'LISTENING' : s === 'thinking' ? 'THINKING' : s === 'speaking' ? 'SPEAKING' : 'VOICE MODE';
    if (text) {
      caption.textContent = text;
      caption.classList.remove('is-interim');
    }
    orbBtn.classList.toggle('is-live', s === 'listening' || s === 'speaking');
  };

  const onReply = (e) => {
    if (overlay.hidden) return;
    const text = e.detail && e.detail.text;
    if (!text) return;
    setState('speaking', text.replace(/[#*_`>]/g, '').slice(0, 220));
    speak(text).finally(() => {
      if (!overlay.hidden) setState('idle', 'Anything else?');
    });
  };
  document.addEventListener('nova:reply', onReply);

  const startListening = () => {
    if (listening) { stopListening(); listening = false; setState('idle', 'Tap the orb to speak.'); return; }
    listening = true;
    setState('listening', 'Listening… say “wake up, Nova” or just talk.');
    listen({
      onInterim: (t) => { caption.textContent = t; caption.classList.add('is-interim'); },
      onFinal: async (t) => {
        listening = false;
        caption.classList.remove('is-interim');
        const raw = String(t || '').trim();
        // Close / lock commands
        if (/close (yourself|hud)|go to sleep|lock (the )?hud/i.test(raw)) {
          close();
          toast('Locking HUD…');
          setTimeout(() => { try { location.reload(); } catch { /* noop */ } }, 400);
          return;
        }
        // Wake words activate listening
        const wake = raw.match(/^(?:hey |ok |okay )?(?:wake up,? (?:nova|jarvis)|hey (?:nova|jarvis)|jarvis)[,:]?\s*(.*)$/i);
        let query = wake ? wake[1].trim() : raw;
        // Real UI action intents
        if (/open (live )?preview|show preview/i.test(raw)) { close(); app.openPanel('workspace', { tab: 'preview' }); toast('Preview opened'); setState('idle', 'Anything else?'); return; }
        if (/open (code|files)|show (code|files)/i.test(raw)) { close(); app.openPanel('workspace', { tab: 'files' }); toast('Files opened'); setState('idle', 'Anything else?'); return; }
        if (/open (vision|camera)|show (vision|camera)/i.test(raw)) { close(); app.openPanel('vision'); toast('Vision opened'); setState('idle', 'Anything else?'); return; }
        if (/open (memory)|catch up/i.test(raw)) { close(); app.openPanel('memory'); toast('Memory opened'); setState('idle', 'Anything else?'); return; }
        if (/check (my )?mail|read (my )?mail/i.test(raw)) {
          close();
          setState('thinking', 'Pulling inbox…');
          try {
            const gh = await api('/api/gmail?action=inbox&max=6', { method: 'GET', timeout: 15000 });
            const msgs = (gh && gh.messages) || [];
            const text = msgs.length ? `You have ${msgs.length} unread threads. Top: ${msgs[0].from} — ${msgs[0].subject}` : 'Inbox is clear.';
            document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text } }));
            speak(text).catch(() => {});
          } catch (err) { document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text: `Mail unavailable: ${err.message || err}` } })); }
          setState('idle', 'Anything else?');
          return;
        }
        // Vision commands
        if (/look at this|what(?:'s| is) in my hand|scan (this|my hand)/i.test(raw)) {
          setState('thinking', 'Opening camera…');
          await captureAndInspect();
          setState('idle', 'Anything else?');
          return;
        }
        // Catch up / read past conversations
        if (/catch up|read (our |our past |past )?conversations|read (our )?history/i.test(raw)) {
          setState('thinking', 'Recalling sessions…');
          const chats = store.get('chats', []).slice(0, 5);
          const tasks = store.get('tasks', []).filter((t) => !t.done).slice(0, 5);
          const facts = (store.get('memory.facts') || []).slice(-6);
          const text = `Master Drippy Dee, here is where we left off.\n\n**Recent sessions**\n${chats.map((c) => `- ${c.title}`).join('\n') || '- none'}\n\n**Pending tasks**\n${tasks.map((t) => `- ${t.title} (${t.when})`).join('\n') || '- none'}\n\n**Memory**\n${facts.map((f) => `- ${f}`).join('\n') || '- none'}`;
          document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text } }));
          setState('idle', 'Anything else?');
          return;
        }
        // Check my mail
        if (/check (my )?mail|check (my )?inbox|read (latest |my )?email/i.test(raw)) {
          setState('thinking', 'Pulling inbox…');
          try {
            const gh = await api('/api/gmail?action=inbox&max=6', { method: 'GET', timeout: 15000 });
            const msgs = (gh && gh.messages) || [];
            if (!msgs.length) {
              document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text: 'Inbox is clear, Master Drippy Dee. Nothing unread.' } }));
            } else {
              const top = msgs.slice(0, 5);
              const text = `You have ${msgs.length} unread thread${msgs.length === 1 ? '' : 's'}.\n\n${top.map((m, i) => `${i + 1}. **${m.from}** — ${m.subject}\n   ${String(m.snippet || m.body || '').slice(0, 120)}`).join('\n\n')}`;
              document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text } }));
              speak(`You have ${msgs.length} unread emails. Top sender: ${top[0].from}.`).catch(() => {});
            }
          } catch (err) {
            document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text: `Mail unavailable: ${err.message || err}` } }));
          }
          setState('idle', 'Anything else?');
          return;
        }
        // Read This / Inspect Screen or Link
        if (/read this|inspect (screen|link|page)|read what'?s (on|in)/i.test(raw)) {
          const urlMatch = raw.match(/https?:\/\/[^\s]+/);
          if (urlMatch) {
            setState('thinking', 'Reading page…');
            try {
              const r = await api('/api/reader', { method: 'POST', timeout: 20000, body: { url: urlMatch[0] } });
              const text = r && r.text ? r.text.slice(0, 1500) : 'Could not read that page.';
              document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text: `Here is what I found:\n\n${text}` } }));
            } catch (err) {
              document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text: `Reader failed: ${err.message || err}` } }));
            }
            setState('idle', 'Anything else?');
            return;
          }
          // screen capture
          setState('thinking', 'Capturing screen…');
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const v = document.createElement('video');
            v.srcObject = stream;
            await v.play().catch(() => {});
            await new Promise((r) => setTimeout(r, 400));
            const c = document.createElement('canvas');
            c.width = v.videoWidth || 1280;
            c.height = v.videoHeight || 720;
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
            const dataUrl = c.toDataURL('image/jpeg', 0.8);
            stream.getTracks().forEach((t) => t.stop());
            const res = await api('/api/council', { method: 'POST', timeout: 60000, body: { messages: [{ role: 'user', content: 'Read and explain what is on this screen. Be specific and brief.' }], images: [dataUrl], role: 'chat', effort: 'efficient' } });
            const text = (res && res.text) || 'I could not read the screen.';
            document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text } }));
          } catch (err) {
            // fallback to camera
            await captureAndInspect();
          }
          setState('idle', 'Anything else?');
          return;
        }
        // Morning brief
        if (/morning brief/i.test(raw)) {
          setState('thinking', 'Assembling briefing…');
          await morningBrief();
          setState('idle', 'Anything else?');
          return;
        }
        // App launcher
        const openMatch = raw.match(/^open\s+(.+)$/i);
        if (openMatch) {
          const target = openMatch[1].trim().toLowerCase();
          const sites = {
            youtube: 'https://www.youtube.com',
            github: 'https://github.com',
            whatsapp: 'https://web.whatsapp.com',
            google: 'https://www.google.com',
            twitter: 'https://x.com',
            x: 'https://x.com',
            reddit: 'https://www.reddit.com',
            gmail: 'https://mail.google.com',
            gemini: 'https://gemini.google.com',
            'apex ai': 'https://apex-ai.example.com',
            'apex studio': 'https://apex-studio.example.com',
            apex: 'https://apex-ai.example.com'
          };
          // Local OS bridge for native app commands (optional)
          if (/^(open|launch)\s+(app|native)/i.test(raw)) {
            try { await fetch('http://127.0.0.1:8765/open', { method: 'POST', body: JSON.stringify({ target }) }).catch(() => {}); } catch { /* noop */ }
          }
          const url = sites[target] || (target.includes('.') ? `https://${target}` : `https://www.google.com/search?q=${encodeURIComponent(target)}`);
          window.open(url, '_blank', 'noopener');
          setState('idle', `Opened ${target}.`);
          speak(`Opening ${target}.`).catch(() => {});
          return;
        }
        if (!query) { setState('idle', 'I am here. Go ahead.'); return; }
        setState('thinking', query);
        document.dispatchEvent(new CustomEvent('nova:send', { detail: { text: query } }));
        if (overlay.hidden) return;
        setTimeout(() => { if (state === 'thinking') setState('thinking', 'Working on it…'); }, 1200);
      },
      onEnd: () => { listening = false; },
      onError: (err) => {
        listening = false;
        setState('idle', `Microphone: ${err}`);
      }
    });
  };

  orbBtn.addEventListener('click', startListening);

  const close = () => {
    stopListening();
    cancelSpeech();
    document.removeEventListener('nova:reply', onReply);
    cancelAnimationFrame(meterRaf);
    if (meter) meter.stop();
    orb.destroy();
    overlay.hidden = true;
  };
  $('#voiceClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);

  setState('idle', store.get('prefs.wakeWord') ? 'Say “wake up, Nova”, or tap the orb.' : 'Tap the orb and talk.');
  if (hint) hint.textContent = 'Tap the orb to speak · Esc to close';

  createMicMeter().then((m) => {
    meter = m;
    if (!m) return;
    const loop = () => {
      orb.setLevel(m.read());
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  });

  setTimeout(startListening, 400);
}

/* ── bootstrap ────────────────────────────────────────────── */
function start() {
  sidebar = mountSidebar(app);
  chat = mountChatCanvas(app);
  wireModeMenu();
  syncModePill();

  $('#drawerBtn')?.addEventListener('click', () => app.toggleNav());
  $('#scrim')?.addEventListener('click', () => app.toggleNav(false));
  $('#profileBtn')?.addEventListener('click', () => openSettingsPanel(app));
  $('#jarvisHudBtn')?.addEventListener('click', () => app.openVoice());

  // PWA install prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const b = $('#installAppBtn');
    if (b) b.hidden = false;
  });
  $('#installAppBtn')?.addEventListener('click', async () => {
    if (!deferredPrompt) { toast('Use your browser menu → Install app'); return; }
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch { /* noop */ }
    deferredPrompt = null;
    const b = $('#installAppBtn');
    if (b) b.hidden = true;
  });

  // service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/public/sw.js').catch(() => {});
  }

  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => app.openPanel(btn.dataset.open));
  });

  document.addEventListener('nova:panel', (e) => {
    const id = e.detail && e.detail.id;
    document.querySelectorAll('[data-open]').forEach((b) => b.classList.toggle('is-on', b.dataset.open === id));
  });

  document.addEventListener('nova:send', () => {
    if (window.innerWidth < 1024) app.toggleNav(false);
  });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if ((e.altKey && e.code === 'Space') || (meta && e.key.toLowerCase() === 'k')) { e.preventDefault(); app.openVoice(); return; }
    if (meta && e.key.toLowerCase() === 'j') { e.preventDefault(); app.navigate('new'); }
    if (meta && e.key === '/') { e.preventDefault(); chat && chat.focus(); }
    if (e.key === 'Escape' && !currentPanel() && document.body.classList.contains('nav-open') && window.innerWidth < 1024) {
      app.toggleNav(false);
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1024) {
      const scrim = $('#scrim');
      if (scrim) { scrim.hidden = true; scrim.classList.remove('is-on'); }
    }
  });

  /* live status → demo flag, composer meta */
  getStatus(true).then((st) => {
    status = st;
    store.set('councilStatus', st);
    if (chat) chat.refresh();
    document.body.dataset.bridge = st.online ? (st.configured ? 'live' : 'demo') : 'offline';
  }).catch(() => {});

  /* live GitHub username from server env → default repo target */
  (async () => {
    try {
      const gh = await api('/api/github?status=1', { method: 'GET', timeout: 6000 });
      if (gh && gh.username) {
        const repo = `${gh.username}/nova-os`;
        const current = store.get('prefs.repo', '');
        if (!current || current === 'drippy-dee/nova-os' || current === 'iniakinpelu2020-oss/nova-os') store.set('prefs.repo', repo);
      }
    } catch { /* ignore */ }
  })();

  /* deadline watchdog: one honest nudge, never a storm */
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (watchdogFired || !store.get('prefs.notifications', true)) return;
    const hour = new Date().getHours();
    if (hour < 17) return;
    const pending = store.get('scheduled', []).filter((t) => !t.done && /today/i.test(t.when));
    if (!pending.length) return;
    watchdogFired = true;
    toast(`${pending[0].title} is due today — say “watch the board” for a plan`);
  }, 60000);

  /* first-run nudge */
  if (!localStorage.getItem('nova.welcomed')) {
    localStorage.setItem('nova.welcomed', '1');
    setTimeout(() => toast('NOVA is online. Try “build a landing page”.', 'ok'), 1400);
  }
}

/* ── native boot sequence splash ──────────────────────── */
(function bootSplash() {
  const splash = document.getElementById('bootSplash');
  if (!splash) return;
  const checks = splash.querySelectorAll('.boot-splash__checks li');
  [350, 700, 1100].forEach((t, i) => {
    if (checks[i]) setTimeout(() => checks[i].classList.add('is-ok'), t);
  });
  setTimeout(() => splash.classList.add('is-done'), 1500);
  setTimeout(() => { try { splash.remove(); } catch { /* noop */ } }, 2000);
})();

/* the gate decides when the workspace appears */
const gate = mountBiometricGate({
  onUnlock: () => {
    start();
    if (store.get('prefs.mode') === 'conversation') setTimeout(() => openVoiceOverlay(), 500);
  }
});

window.addEventListener('beforeunload', () => store.flush());

export { app, gate };
