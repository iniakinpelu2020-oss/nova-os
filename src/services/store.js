/* ============================================================
   NOVA // OS — shared workspace store
   One localStorage document for chats, notebooks, library,
   memory, connectors, skills and UI preferences. Core AI and
   GitHub credentials never enter this store — they stay in
   Cloudflare Pages environment variables.
   ============================================================ */

const KEY = 'nova.workspace.v4';

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

export const isoDay = (d = new Date()) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const timeLabel = (d = new Date()) =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const relTime = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/* ── starter workspace ── */
export const STARTER_FILES = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fieldnote</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main>
    <p class="kicker">FIELDNOTE / 01</p>
    <h1>A quieter place to think.</h1>
    <p class="lede">A one-page note surface with a live word count and nothing else competing for attention.</p>
    <textarea id="note" placeholder="Start writing…"></textarea>
    <footer><span id="count">0 words</span><button id="clear" type="button">Clear</button></footer>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
  'styles.css': `* { box-sizing: border-box; margin: 0; }
body {
  min-height: 100vh;
  background: #0a0b0f;
  color: #eef1f7;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  display: grid;
  place-items: center;
  padding: 40px 20px;
}
main { width: min(680px, 100%); display: grid; gap: 16px; }
.kicker { font-size: 10px; letter-spacing: .28em; color: #8b9cff; }
h1 { font-size: clamp(28px, 5vw, 44px); letter-spacing: -.03em; line-height: 1.1; }
.lede { color: #9aa3b2; line-height: 1.6; font-size: 15px; }
textarea {
  width: 100%; min-height: 280px; resize: vertical;
  background: #13161f; color: inherit; font: inherit; line-height: 1.7;
  border: 1px solid rgba(255,255,255,.08); border-radius: 18px; padding: 20px;
}
textarea:focus { outline: 2px solid rgba(139,156,255,.5); border-color: transparent; }
footer { display: flex; align-items: center; justify-content: space-between; }
#count { font-size: 11px; letter-spacing: .12em; color: #6b7280; text-transform: uppercase; }
button {
  font: inherit; font-size: 12px; padding: 9px 18px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,.12); background: transparent; color: #cfd5e3; cursor: pointer;
}
button:hover { border-color: #8b9cff; color: #fff; }
`,
  'app.js': `const note = document.getElementById('note');
const count = document.getElementById('count');
const clear = document.getElementById('clear');

function render() {
  const words = note.value.trim() ? note.value.trim().split(/\\s+/).length : 0;
  count.textContent = words + (words === 1 ? ' word' : ' words');
}

note.addEventListener('input', render);
clear.addEventListener('click', () => { note.value = ''; render(); note.focus(); });
render();
`,
  'README.md': `# Fieldnote

A starter workspace NOVA ships with.

- \`index.html\` — note surface
- \`styles.css\` — dark card styling
- \`app.js\` — live word count
`
};

/* ── connector directory ── */
const CONNECTORS = [
  { id: 'github', name: 'GitHub', icon: '🐙', group: 'builtin', desc: 'Read trees, push files and open the repo trail.', fields: [] },
  { id: 'cloudflare', name: 'Cloudflare Pages', icon: '⚡', group: 'builtin', desc: 'Deploy status and hook-triggered builds.', fields: [] },
  { id: 'searxng', name: 'SearXNG Web Scout', icon: '🔎', group: 'builtin', desc: 'Private metasearch used for every live citation.', fields: [] },
  {
    id: 'telegram', name: 'Telegram Bot', icon: '✈️', group: 'app', enabled: false,
    desc: 'Proactive alerts, briefings and approval pings.',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: '123456789:AA…' },
      { key: 'chatId', label: 'Chat ID', placeholder: '487210993' }
    ]
  },
  {
    id: 'n8n', name: 'n8n / Make', icon: '🪢', group: 'app', enabled: false,
    desc: 'Fan any result out to your automation fabric.',
    fields: [{ key: 'endpoint', label: 'Webhook URL', placeholder: 'https://n8n.example.com/webhook/nova' }]
  },
  {
    id: 'social', name: 'Social Autopilot', icon: '📣', group: 'app', enabled: false,
    desc: 'Stage and publish posts to Instagram, TikTok and X.',
    fields: [
      { key: 'endpoint', label: 'Publish webhook', placeholder: 'https://n8n.example.com/webhook/publish' },
      { key: 'authHeader', label: 'Auth header', secret: true, placeholder: 'Bearer …' },
      { key: 'platforms', label: 'Platforms', placeholder: 'instagram,tiktok,x' }
    ]
  },
  {
    id: 'video', name: 'AI Video & Image Studio', icon: '🎬', group: 'app', enabled: false,
    desc: 'Render cinematic ad scenes and stills from prompts.',
    fields: [
      { key: 'endpoint', label: 'Render webhook', placeholder: 'https://api.example.com/render' },
      { key: 'authHeader', label: 'Auth header', secret: true, placeholder: 'Bearer …' }
    ]
  },
  {
    id: 'phone', name: 'Outbound Call', icon: '📞', group: 'app', enabled: false,
    desc: 'Twilio / Vapi / Bland escalation calls with a spoken brief.',
    fields: [
      { key: 'provider', label: 'Provider', type: 'select', options: ['Twilio', 'Vapi', 'Bland AI'] },
      { key: 'endpoint', label: 'Call URL', placeholder: 'https://api.vapi.ai/call' },
      { key: 'authHeader', label: 'Auth header', secret: true, placeholder: 'Bearer …' },
      { key: 'toNumber', label: 'Your number', placeholder: '+15550002222' }
    ]
  },
  {
    id: 'inbox', name: 'Priority Inbox', icon: '📬', group: 'app', enabled: false,
    desc: 'Gmail / IMAP bridge that ranks deals and drafts replies.',
    fields: [
      { key: 'endpoint', label: 'Bridge webhook', placeholder: 'https://n8n.example.com/webhook/inbox' },
      { key: 'authHeader', label: 'Auth header', secret: true, placeholder: 'Bearer …' }
    ]
  },
  {
    id: 'voice', name: 'ElevenLabs / Fish Audio', icon: '🎙️', group: 'app', enabled: false,
    desc: 'Studio-grade speech instead of the browser voice.',
    fields: [
      { key: 'provider', label: 'Engine', type: 'select', options: ['ElevenLabs', 'Fish Audio'] },
      { key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk_…' },
      { key: 'voiceId', label: 'Voice ID', placeholder: '21m00Tcm4TlvDq8ikWAM' }
    ]
  },
  {
    id: 'notion', name: 'Notion', icon: '🗂️', group: 'app', enabled: false,
    desc: 'Write briefs and research dossiers into a database.',
    fields: [
      { key: 'apiKey', label: 'Integration token', secret: true, placeholder: 'secret_…' },
      { key: 'databaseId', label: 'Database ID', placeholder: '8a2f…' }
    ]
  },
  {
    id: 'discord', name: 'Discord', icon: '🎮', group: 'app', enabled: false,
    desc: 'Post build receipts and incident alerts to a channel.',
    fields: [{ key: 'endpoint', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' }]
  },
  {
    id: 'slack', name: 'Slack', icon: '💬', group: 'app', enabled: false,
    desc: 'Ship reports and research summaries in your workspace.',
    fields: [{ key: 'endpoint', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…' }]
  },
  {
    id: 'custom', name: 'Custom REST / MCP Tool', icon: '🧩', group: 'app', enabled: false,
    desc: 'Any endpoint becomes a tool Nova can call mid-task.',
    fields: [
      { key: 'toolName', label: 'Tool name', placeholder: 'get_inventory' },
      { key: 'description', label: 'Description', placeholder: 'Returns live stock levels' },
      { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'endpoint', label: 'Endpoint', placeholder: 'https://api.example.com/inventory' },
      { key: 'authHeader', label: 'Auth header', secret: true, placeholder: 'Bearer …' }
    ]
  },
  {
    id: 'deeplinks', name: 'App Deep Links', icon: '🔗', group: 'bridge', enabled: true,
    desc: 'Hand off to WhatsApp, X or mail with the draft pre-filled.',
    fields: []
  },
  {
    id: 'termux', name: 'Termux Local Bridge', icon: '📱', group: 'bridge', enabled: false,
    desc: 'Optional companion for local device storage and ADB control.',
    fields: [{ key: 'endpoint', label: 'Companion URL', placeholder: 'http://127.0.0.1:8099' }]
  },
  {
    id: 'bookmarklet', name: 'Page Clipper', icon: '✂️', group: 'bridge', enabled: false,
    desc: 'One-click bookmarklet that clips the page you are reading.',
    fields: []
  }
];

const CONNECTOR_VALUES = Object.fromEntries(CONNECTORS.map((c) => [c.id, {}]));

const seedChat = (title, userText, novaText, pinned = false) => ({
  id: uid('chat'),
  title,
  pinned,
  ts: Date.now() - Math.floor(Math.random() * 6) * 36e5,
  messages: [
    { id: uid('msg'), role: 'user', text: userText, ts: Date.now() - 72e5 },
    { id: uid('msg'), role: 'nova', text: novaText, steps: [], blocks: [], sources: [], followups: [], demo: true, ts: Date.now() - 71e5 }
  ]
});

const DEFAULTS = {
  version: 4,
  lock: { locked: true, enabled: true, biometric: true, pinEnabled: true, pin: '2026', user: 'Master Drippy Dee', webauthnCredentialId: null, faceDescriptor: null, faceEnrolledAt: null },
  prefs: {
    theme: 'oled',
    personality: true,
    serious: false,
    voice: { muted: false, rate: 1, pitch: 1, voiceURI: '', engine: 'browser' },
    wakeWord: true,
    notifications: true,
    alerts: true,
    biometric: true,
    searxng: 'https://searxng-6mmb.onrender.com',
    repo: 'iniakinpelu2020-oss/nova-os',
    corsProxy: '',
    effort: 'balanced',
    mode: 'chat',
    models: {
      chat: '@cf/zhipuai/glm-4.7-flash',
      coding: '@cf/openai/gpt-oss-120b',
      reasoning: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      synth: 'gemini-2.5-pro',
      uncensored: 'venice-uncensored'
    }
  },
  chats: [
    seedChat(
      'Spatial studio landing page',
      'Build a landing page for a spatial design studio.',
      'It is built — four files, a clean security gate and a live preview waiting in the workspace.\n\n**What shipped**\n- `index.html` — hero, work grid, contact strip\n- `styles.css` — depth cues and a restrained type scale\n- `app.js` — scroll reveal and metric counters\n\nOpen **</> Workspace** to walk the diff before you commit it.',
      true
    ),
    seedChat(
      'Screen co-pilot walkthrough',
      'What is on my screen right now?',
      'Share a screen and I will read it. On a still frame I look for the active window, the error text if there is one, and the two controls you most likely need next.\n\nNothing is captured until you press **Share screen** — the frames go to the vision model and are never written to storage.',
      true
    ),
    seedChat(
      'Q4 pricing research',
      'Deep research: what are teams paying for AI workspace tools in Q4?',
      '**Short answer:** list prices cluster around $20–30 per seat, but the effective rate depends on whether inference is bundled.\n\n1. Seat-plus-credits is the dominant model.\n2. Enterprise floors sit near $40k annually.\n3. Buyers increasingly ask for usage dashboards before signing.\n\nI can turn this into a PDF dossier with the source table attached.'
    )
  ],
  activeChatId: null,
  notebooks: [
    { id: uid('nb'), title: 'NOVA // OS launch', note: 'Ship checklist, copy bank and open questions.', ts: Date.now() - 86e5, entries: 4 },
    { id: uid('nb'), title: 'Spatial studio brief', note: 'Client notes, references and the type scale.', ts: Date.now() - 172e5, entries: 2 }
  ],
  library: [
    { id: uid('lib'), kind: 'code', title: 'Spatial studio landing page', meta: '4 files · HTML/CSS/JS', ts: Date.now() - 36e5 },
    { id: uid('lib'), kind: 'report', title: 'Q4 AI workspace pricing', meta: 'PDF dossier · 6 sources', ts: Date.now() - 90e5 },
    { id: uid('lib'), kind: 'media', title: 'Cinematic ad — 3 scenes', meta: 'Storyboard · 9:16', ts: Date.now() - 172e5 }
  ],
  scheduled: [
    { id: uid('task'), title: 'Ship NOVA // OS to Pages', when: 'Today · 18:00', kind: 'block', done: false, call: false },
    { id: uid('task'), title: 'Halcyon Labs — renewal call', when: 'Today · 11:30', kind: 'alert', done: false, call: true },
    { id: uid('task'), title: 'Weekly security attestation', when: 'Tomorrow · 09:15', kind: 'auto', done: false, call: false }
  ],
  connectors: CONNECTORS.map((c) => ({ ...c, values: { ...CONNECTOR_VALUES[c.id] } })),
  skills: [
    { id: uid('skill'), name: 'Full-Stack App Builder', desc: 'Plan, scaffold and ship a complete app.', builtin: true, prompt: 'Build a complete, production-shaped app for: ' },
    { id: uid('skill'), name: 'Pre-Deploy Security Audit', desc: 'Six checks before anything ships.', builtin: true, prompt: 'Run the pre-deploy security audit over the workspace and explain every finding.' },
    { id: uid('skill'), name: 'Serious Mode Strategist', desc: 'Slow, structured, adversarial reasoning.', builtin: true, prompt: 'Serious Mode: give me the strongest case against my plan, then the version that survives it.' },
    { id: uid('skill'), name: 'Screen Co-Pilot', desc: 'Read a screen and call out the next move.', builtin: true, prompt: 'Look at my screen and tell me what to fix first.' },
    { id: uid('skill'), name: 'Research Dossier', desc: 'Deep research with citations and a PDF.', builtin: false, prompt: 'Research this deeply, cite every claim, then produce a dossier: ' }
  ],
  memory: {
    facts: [
      'Prefers terse answers unless the topic is architecture.',
      'Ships on Cloudflare Pages; avoids vendor lock-in.',
      'Calls the assistant Nova and expects the occasional dry remark.'
    ],
    updated: 0
  },
  usage: { session: 1840, daily: 12480, dailyCap: 100000, sessionCap: 25000, started: Date.now() },
  files: { ...STARTER_FILES },
  activeFile: 'index.html',
  audit: null,
  lastDeploy: null,
  councilStatus: null
};

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}

const clone = (v) => {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
};

class NovaStore {
  constructor() {
    this.data = this._hydrate();
    this._subs = new Map();
    this._timer = null;
    this._save();
  }

  _hydrate() {
    let stored = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) stored = JSON.parse(raw);
    } catch { stored = null; }
    const base = clone(DEFAULTS);
    if (!stored) return base;
    const merged = deepMerge(base, stored);
    merged.lock.locked = true;
    if (merged.lock && merged.lock.pin === '2468') merged.lock.pin = '2026';
    if (merged.lock && merged.lock.enabled === undefined) merged.lock.enabled = true;
    if (merged.lock && merged.lock.biometric === undefined) merged.lock.biometric = true;
    if (!Array.isArray(merged.lock.faceDescriptor)) merged.lock.faceDescriptor = merged.lock.faceDescriptor || null;
    if (!Array.isArray(merged.chats)) merged.chats = base.chats;
    if (!Array.isArray(merged.connectors) || !merged.connectors.length) merged.connectors = base.connectors;
    if (!merged.files || !Object.keys(merged.files).length) merged.files = clone(STARTER_FILES);
    if (!merged.memory || !Array.isArray(merged.memory.facts)) merged.memory = { facts: [], updated: 0 };
    return merged;
  }

  _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 120);
  }

  flush() {
    clearTimeout(this._timer);
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* quota */ }
  }

  get(path, fallback) {
    if (!path) return this.data;
    const out = path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), this.data);
    return out === undefined ? fallback : out;
  }

  set(path, value) {
    const keys = path.split('.');
    let node = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    this._save();
    this.emit('change', { path, value });
    return value;
  }

  patch(partial) {
    this.data = deepMerge(this.data, partial);
    this._save();
    this.emit('change', { path: '*', value: partial });
    return this.data;
  }

  update(fn) {
    fn(this.data);
    this._save();
    this.emit('change', { path: '*', value: null });
  }

  on(topic, fn) {
    if (!this._subs.has(topic)) this._subs.set(topic, new Set());
    this._subs.get(topic).add(fn);
    return () => this.off(topic, fn);
  }

  off(topic, fn) {
    const set = this._subs.get(topic);
    if (set) set.delete(fn);
  }

  emit(topic, payload) {
    const set = this._subs.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error('[store] listener failed', err); }
    }
  }

  /* ── chats ── */
  activeChat() {
    const id = this.data.activeChatId;
    return this.data.chats.find((c) => c.id === id) || null;
  }

  ensureChat(title = 'New conversation') {
    if (this.activeChat()) return this.activeChat();
    const chat = { id: uid('chat'), title, pinned: false, ts: Date.now(), messages: [] };
    this.data.chats.unshift(chat);
    this.data.activeChatId = chat.id;
    this._save();
    return chat;
  }

  addMessage(message) {
    const chat = this.ensureChat(String(message.text || '').slice(0, 48) || 'New conversation');
    chat.messages.push(message);
    chat.ts = Date.now();
    if (chat.title === 'New conversation' && message.role === 'user') {
      chat.title = String(message.text).replace(/\s+/g, ' ').trim().slice(0, 52);
    }
    this._save();
    this.emit('change', { path: 'chats', value: null });
    return chat;
  }

  newChat() {
    const chat = { id: uid('chat'), title: 'New conversation', pinned: false, ts: Date.now(), messages: [] };
    this.data.chats.unshift(chat);
    this.data.activeChatId = chat.id;
    this._save();
    this.emit('change', { path: 'chats', value: null });
    return chat;
  }

  openChat(id) {
    this.data.activeChatId = id;
    this._save();
    this.emit('change', { path: 'activeChatId', value: id });
    return this.activeChat();
  }

  deleteChat(id) {
    this.data.chats = this.data.chats.filter((c) => c.id !== id);
    if (this.data.activeChatId === id) this.data.activeChatId = null;
    this._save();
    this.emit('change', { path: 'chats', value: null });
  }

  renameChat(id, title) {
    const chat = this.data.chats.find((c) => c.id === id);
    if (chat) { chat.title = title.slice(0, 80); this._save(); this.emit('change', { path: 'chats', value: null }); }
  }

  pinChat(id) {
    const chat = this.data.chats.find((c) => c.id === id);
    if (chat) { chat.pinned = !chat.pinned; this._save(); this.emit('change', { path: 'chats', value: null }); }
  }

  /* ── memory ── */
  remember(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const mem = this.data.memory;
    if (!mem.facts.includes(t)) mem.facts.push(t.slice(0, 400));
    while (mem.facts.length > 60) mem.facts.shift();
    mem.updated = Date.now();
    this._save();
    this.emit('change', { path: 'memory', value: mem });
  }

  /* ── usage ── */
  trackUsage(tokens = 0) {
    const u = this.data.usage;
    u.session += tokens;
    u.daily += tokens;
    this._save();
    this.emit('usage', u);
    return u;
  }

  resetWorkspace() {
    this.data.files = clone(STARTER_FILES);
    this.data.activeFile = 'index.html';
    this.flush();
    this.emit('files', this.data.files);
  }

  clearCaches() {
    const u = this.data.usage;
    u.session = 0;
    this.data.library = this.data.library.filter((i) => i.kind !== 'media');
    this.flush();
    this.emit('change', { path: 'usage', value: u });
  }
}

export const store = new NovaStore();
export { CONNECTORS, DEFAULTS, KEY };
