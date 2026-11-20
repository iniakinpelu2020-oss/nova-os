/* ============================================================
   NOVA // OS — chat canvas
   Empty state, streaming thread, markdown + code blocks, trace
   accordions, diff/audit/sandbox blocks and the floating pill
   composer with @mention autocomplete and message queueing.
   ============================================================ */
import { store, escapeHtml, uid, isoDay } from '../services/store.js';
import { runAgent, detectIntent } from '../services/aiCouncil.js';
import { connectorCount, enabledConnectors, github } from '../services/toolsEngine.js';
import { speak, cancel as cancelSpeech, isSpeaking, listen, stopListening, sttSupported } from '../services/voiceEngine.js';
import { $, copyText, toast, openModal } from '../services/ui.js';
import { compactDiff, downloadText } from '../services/util.js';
import { mountOrb, createMicMeter } from './neuralOrb.js';

/* ── markdown ─────────────────────────────────────────────── */

const KEYWORDS = 'const|let|var|function|return|if|else|for|while|new|class|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|of|in|true|false|null|undefined|this|switch|case|break|continue|delete|extends|super|static|void|yield|do|with|enum';

export function highlight(code = '', lang = '') {
  const esc = escapeHtml;
  if (lang === 'html' || lang === 'markup') {
    return esc(code)
      .replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="tok-tag">$2</span>')
      .replace(/([a-zA-Z-]+)=(&quot;.*?&quot;)/g, '<span class="tok-attr">$1</span>=<span class="tok-str">$2</span>')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>');
  }
  if (lang === 'css') {
    return esc(code)
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-com">$1</span>')
      .replace(/(^|\n)([^{}\n]+)(?=\{)/g, '$1<span class="tok-fn">$2</span>')
      .replace(/(#[0-9a-f]{3,8}\b)/gi, '<span class="tok-num">$1</span>')
      .replace(/(:\s*)([^;{}\n]+)/g, '$1<span class="tok-str">$2</span>');
  }
  const out = [];
  const re = new RegExp(
    `(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)` +
    `|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b|([A-Za-z_$][\\w$]*)(?=\\()`,
    'g'
  );
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out.push(esc(code.slice(last, m.index)));
    const [full, comment, str, kw, num, fn] = m;
    if (comment) out.push(`<span class="tok-com">${esc(comment)}</span>`);
    else if (str) out.push(`<span class="tok-str">${esc(str)}</span>`);
    else if (kw) out.push(`<span class="tok-key">${esc(kw)}</span>`);
    else if (num) out.push(`<span class="tok-num">${esc(num)}</span>`);
    else if (fn) out.push(`<span class="tok-fn">${esc(fn)}</span>`);
    else out.push(esc(full));
    last = m.index + full.length;
  }
  out.push(esc(code.slice(last)));
  return out.join('');
}

const inline = (text = '') =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

export function renderMarkdown(text = '') {
  const src = String(text || '');
  const out = [];
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(src))) {
    if (m.index > last) out.push(blocksToHtml(src.slice(last, m.index)));
    const lang = (m[1] || 'text').toLowerCase();
    const code = m[2].replace(/\n$/, '');
    out.push(`<div class="codeblock">
      <div class="codeblock__head">
        <span class="codeblock__file">${lang === 'text' ? 'code' : `.${lang}`}</span>
        <span class="codeblock__actions">
          <button class="icon-btn icon-btn--sm" data-copy-code type="button" title="Copy">⧉</button>
          <button class="icon-btn icon-btn--sm" data-preview-code type="button" title="Open in preview">▷</button>
          <button class="icon-btn icon-btn--sm" data-push-code type="button" title="Push to GitHub">↥</button>
        </span>
      </div>
      <pre><code data-lang="${lang}" data-raw="${escapeHtml(code)}">${highlight(code, lang)}</code></pre>
    </div>`);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(blocksToHtml(src.slice(last)));
  return out.join('');
}

function blocksToHtml(chunk = '') {
  const lines = chunk.split('\n');
  const html = [];
  let list = null;
  let quote = [];

  const closeList = () => { if (list) { html.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { html.push(`<blockquote>${quote.map(inline).join('<br />')}</blockquote>`); quote = []; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); flushQuote(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); flushQuote(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^>\s?/.test(line)) { closeList(); quote.push(line.replace(/^>\s?/, '')); continue; }
    flushQuote();

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); html.push('<hr />'); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { closeList(); list = { tag, items: [] }; }
      list.items.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  flushQuote();
  return html.join('');
}

/* ── blocks ───────────────────────────────────────────────── */

function auditBlock(b) {
  const a = b.audit || {};
  const rows = (a.rows || []).map((r) => `
    <div class="audit-row" data-fail="${r.ok ? 0 : 1}" title="${escapeHtml(r.note || '')}">
      <span class="audit-row__icon">${r.ok ? '✓' : '!'}</span>
      <span>${escapeHtml(r.label)}</span>
      <span class="audit-row__note">${r.ok ? 'pass' : 'review'}</span>
    </div>`).join('');
  return `<div class="block">
    <div class="block__head">🛡 <b>Pre-deploy security gate</b><span class="right"><span class="badge ${a.score === 100 ? 'badge--ok' : 'badge--demo'}">${a.score ?? 0}/100</span></span></div>
    <div class="block__body"><div class="audit-list">${rows}</div></div>
    ${a.score === 100 ? `<div class="ship-bar"><p>Gate clear · ${a.files || 0} files · rollback pinned</p><button class="btn btn--sm btn--primary" data-cmd="ship" type="button">🚀 Ship it</button></div>` : ''}
  </div>`;
}

function diffBlock(b) {
  const rows = compactDiff({ rows: b.rows || [], added: b.added || 0, removed: b.removed || 0 }).rows;
  const body = rows.length
    ? rows.map((r, i) => `<div class="diff__row diff__row--${r.t}"><span>${i + 1}</span><span>${escapeHtml(r.text !== undefined ? `${r.s}${r.text}` : (r.s || ''))}</span></div>`).join('')
    : '<div class="diff__empty">No textual changes.</div>';
  return `<div class="block">
    <div class="block__head">◧ <b>${escapeHtml(b.file || b.path || 'diff')}</b>
      <span class="right"><span class="badge badge--ok">+${b.added || 0}</span><span class="badge">−${b.removed || 0}</span></span>
    </div>
    <div class="diff">${body}</div>
    <div class="block__foot">
      <span class="dim" style="font-size:11px">Unified diff · nothing is written until you apply</span>
      <span style="flex:1"></span>
      <button class="btn btn--sm btn--primary" data-cmd="apply" type="button">Apply &amp; commit</button>
    </div>
  </div>`;
}

function blockHtml(b) {
  switch (b.type) {
    case 'audit': return auditBlock(b);
    case 'diff': return diffBlock(b);
    case 'sandbox': return `<div class="block">
      <div class="block__head">▣ <b>Sandbox ready</b><span class="right"><span class="badge">${b.files || 0} files</span></span></div>
      <div class="block__foot"><span class="dim" style="font-size:11px">Rendered in an isolated iframe — no network access.</span><span style="flex:1"></span><button class="btn btn--sm" data-cmd="preview" type="button">Open live preview</button></div>
    </div>`;
    case 'deploy': return `<div class="block">
      <div class="block__head">🚀 <b>Deployment</b><span class="right"><span class="badge badge--ok">accepted</span></span></div>
      <div class="block__body"><p style="font-size:12.5px;color:#cdd4e2">${escapeHtml(b.summary || 'Deploy hook accepted')}</p>
      ${b.url ? `<a class="src-pill" href="${escapeHtml(b.url)}" target="_blank" rel="noopener" style="margin-top:8px"><span class="src-pill__domain">${escapeHtml(b.url)}</span></a>` : ''}</div>
    </div>`;
    case 'call': return `<div class="block">
      <div class="block__head">📞 <b>Outbound call</b><span class="right"><span class="badge ${b.live ? 'badge--ok' : 'badge--demo'}">${b.live ? 'dispatched' : 'staged'}</span></span></div>
      <div class="block__body"><p style="font-size:12.5px;color:#cdd4e2;line-height:1.65">${escapeHtml(b.script || '')}</p></div>
    </div>`;
    default: return '';
  }
}

function councilHtml(msg) {
  const c = msg.council;
  if (!Array.isArray(c) || !c.length) return '';
  return `<div class="council">
    <div class="council__title">Council drafts · ${c.length} models</div>
    <div class="council__grid">${c.map((d) => `
      <div class="council__card">
        <b>${escapeHtml(d.label || d.provider || 'model')}</b>
        <span>${escapeHtml(d.model || '')} · ${d.ms || 0}ms</span>
        <p>${escapeHtml(String(d.excerpt || d.text || (d.ok === false ? d.error || 'failed' : '')).slice(0, 220))}</p>
      </div>`).join('')}
    </div>
  </div>`;
}

/* ── message rendering ────────────────────────────────────── */

function stepsHtml(steps = [], duration = 0, open = false, live = false) {
  if (!steps.length) return '';
  const done = steps.filter((s) => s.state === 'done').length;
  const active = live || steps.some((s) => s.state === 'active');
  const secs = duration ? `for ${Math.max(1, Math.round(duration / 1000))}s` : '';
  return `<div class="trace${open ? ' is-open' : ''}" data-trace>
    <button class="trace__head" type="button" data-trace-toggle>
      <span>${active ? '<span class="spin" style="display:inline-block">◌</span>' : '✓'}</span>
      <b>${active ? 'Working' : `Worked ${secs}`.trim()}</b>
      <span>· ${done}/${steps.length} steps</span>
      <span class="trace__chev">›</span>
    </button>
    <div class="trace__body">
      <div class="steps">
        ${steps.map((s) => `<div class="step" data-state="${s.state}">
          <span class="step__dot">${s.state === 'done' ? '✓' : s.state === 'error' ? '!' : ''}</span>
          <span><span class="step__label">${escapeHtml(s.label)}</span>${s.detail ? ` <span class="step__detail">${escapeHtml(s.detail)}</span>` : ''}</span>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function sourcesHtml(sources = []) {
  if (!sources.length) return '';
  return `<div class="srcs">${sources.map((s, i) => `
    <a class="src-pill" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title || '')}">
      <span class="src-pill__n">${s.n || i + 1}</span>
      <span class="src-pill__domain">${escapeHtml(s.domain || s.title || 'source')}</span>
    </a>`).join('')}</div>`;
}

function messageHtml(msg) {
  if (msg.role === 'user') {
    return `<div class="msg msg--user" data-msg="${msg.id || ''}"><div class="msg__bubble">${escapeHtml(msg.text)}</div></div>`;
  }
  const blocks = (msg.blocks || []).map(blockHtml).join('');
  return `<div class="msg msg--nova" data-msg="${msg.id || ''}">
    <div class="msg__head"><span class="nova-mark"></span><b>Nova</b>${msg.demo ? '<span class="demo-tag">demo</span>' : ''}</div>
    ${stepsHtml(msg.steps, msg.duration, false)}
    <div class="msg__body md">${renderMarkdown(msg.text)}</div>
    ${sourcesHtml(msg.sources)}
    ${councilHtml(msg)}
    ${blocks}
    ${(msg.followups || []).length ? `<div class="followups">${msg.followups.map((f) => `<button class="chip" data-prompt="${escapeHtml(f)}" type="button">${escapeHtml(f)}</button>`).join('')}</div>` : ''}
    <div class="msg__pills">
      <button class="chip" data-act="export-pdf" type="button">📄 Export PDF</button>
      <button class="chip" data-act="speak" type="button">🔊 Speak</button>
      <button class="chip" data-act="copy-msg" type="button">📋 Copy</button>
      ${String(msg.text || '').includes('```') ? '<button class="chip" data-act="ship-workspace" type="button">🚀 Ship to Workspace</button>' : ''}
    </div>
  </div>`;
}

/* ── component ────────────────────────────────────────────── */

export function mountChatCanvas(app) {
  const canvas = $('#canvas');
  const host = $('#composerHost');
  if (!canvas || !host) return { send() {}, focus() {}, refresh() {} };

  let busy = false;
  let queue = [];
  let pending = null;        // { steps, text, sources, blocks, notice, started }
  let liveEl = null;
  let attachment = null;
  let mentionState = { open: false, items: [], index: 0, query: '' };
  let listening = false;
  let voiceOrb = null;
  let voiceMeter = null;
  let voiceMeterRaf = 0;
  let voiceCardListening = false;

  /* composer markup */
  host.innerHTML = `
    <div class="voice-card" id="voiceCard" hidden>
      <div class="voice-card__head">
        <span>Voice mode</span>
        <button class="orb-btn" id="voiceCardOrb" type="button" aria-label="Listen"><span style="width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#cfd8ff,#8b9cff)"></span></button>
        <button class="icon-btn icon-btn--sm" id="voiceCardClose" type="button" aria-label="Close">✕</button>
      </div>
      <canvas id="voiceCardCanvas" height="120" style="width:100%;height:120px;border-radius:12px;background:rgba(255,255,255,.02)"></canvas>
      <div class="voice-card__caption" id="voiceCardCaption">Say “wake up, Nova”, or tap the orb.</div>
    </div>
    <div class="queue-bar" id="queueBar" hidden></div>
    <div class="composer" id="composer">
      <div class="composer__row" style="position:relative">
        <button class="icon-btn" id="plusBtn" type="button" aria-label="Add context" aria-haspopup="menu" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </button>
        <textarea class="composer__input" id="promptInput" rows="1" placeholder="Ask Nova…  @ to mention an app" aria-label="Message Nova"></textarea>
        <div class="composer__tools">
          <button class="icon-btn" id="micBtn" type="button" aria-label="Microphone" title="Dictate">🎙</button>
          <button class="orb-btn" id="orbBtn" type="button" aria-label="Voice mode" title="Voice mode"><span style="width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#cfd8ff,#8b9cff)"></span></button>
          <button class="send-btn" id="sendBtn" type="button" aria-label="Send" title="Send">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="composer__meta" id="composerMeta"></div>
    </div>`;

  const input = $('#promptInput');
  const sendBtn = $('#sendBtn');
  const meta = $('#composerMeta');
  const queueBar = $('#queueBar');
  const voiceCard = $('#voiceCard');
  const voiceCanvas = $('#voiceCardCanvas');
  const voiceCaption = $('#voiceCardCaption');
  const voiceCardOrb = $('#voiceCardOrb');
  const voiceCardClose = $('#voiceCardClose');

  const closeVoiceCard = () => {
    if (voiceCardListening) { stopListening(); voiceCardListening = false; }
    cancelSpeech();
    if (voiceMeter) { voiceMeter.stop(); voiceMeter = null; }
    cancelAnimationFrame(voiceMeterRaf);
    if (voiceOrb) { voiceOrb.destroy(); voiceOrb = null; }
    if (voiceCard) voiceCard.hidden = true;
  };

  const startVoiceCardListening = () => {
    if (voiceCardListening) return;
    voiceCardListening = true;
    voiceOrb?.setState('listening');
    if (voiceCaption) voiceCaption.textContent = 'Listening…';
    listen({
      onInterim: (t) => { if (voiceCaption) { voiceCaption.textContent = t; voiceCaption.classList.add('is-interim'); } },
      onFinal: (t) => {
        voiceCardListening = false;
        voiceCaption?.classList.remove('is-interim');
        const wake = t.match(/^(?:hey |ok |okay )?wake up,? nova[:,]?\s*(.*)$/i);
        const query = wake ? wake[1].trim() : t.trim();
        if (!query) { voiceOrb?.setState('idle'); if (voiceCaption) voiceCaption.textContent = 'I am here. Go ahead.'; return; }
        voiceOrb?.setState('thinking');
        if (voiceCaption) voiceCaption.textContent = query;
        document.dispatchEvent(new CustomEvent('nova:send', { detail: { text: query } }));
      },
      onEnd: () => { voiceCardListening = false; },
      onError: (err) => {
        voiceCardListening = false;
        voiceOrb?.setState('idle');
        if (voiceCaption) voiceCaption.textContent = `Microphone: ${err}`;
      }
    });
  };

  const openVoiceCard = () => {
    if (!voiceCard) return;
    voiceCard.hidden = false;
    if (!voiceOrb) {
      voiceOrb = mountOrb(voiceCanvas);
      createMicMeter().then((m) => {
        voiceMeter = m;
        if (!m) return;
        const loop = () => {
          if (voiceOrb && voiceMeter) voiceOrb.setLevel(voiceMeter.read());
          voiceMeterRaf = requestAnimationFrame(loop);
        };
        loop();
      });
    }
    voiceOrb?.setState('idle');
    if (voiceCaption) voiceCaption.textContent = store.get('prefs.wakeWord') ? 'Say “wake up, Nova”, or tap the orb.' : 'Tap the orb and talk.';
    startVoiceCardListening();
  };

  const modelFor = () => {
    const last = store.get('lastModel', '');
    if (last) return last;
    const mode = store.get('prefs.mode', 'chat');
    const effort = store.get('prefs.effort', 'balanced');
    if (effort === 'uncensored') return store.get('prefs.models.uncensored', 'venice-uncensored');
    const role = mode === 'build' ? 'coding' : mode === 'serious' ? 'reasoning' : 'chat';
    return store.get(`prefs.models.${role}`, 'glm-4.7-flash');
  };

  const renderMeta = () => {
    if (!meta) return;
    const mode = store.get('prefs.mode', 'chat');
    const effort = store.get('prefs.effort', 'balanced');
    const demo = app.isDemo();
    const conns = connectorCount();
    meta.innerHTML = `
      <span class="dot ${demo ? 'is-demo' : ''}"></span>
      <span>${demo ? 'Demo bridge' : 'ENV connected'}</span>
      <span class="sep">·</span>
      <span class="mono">${escapeHtml(modelFor())}</span>
      <span class="sep">·</span>
      <span>${escapeHtml(effort === 'uncensored' ? 'Uncensored' : mode === 'build' ? 'Build' : mode === 'serious' ? 'Serious' : mode === 'conversation' ? 'Conversation' : 'Chat')} / ${escapeHtml(effort)}</span>
      <span class="right">
        ${conns ? `<span>${conns} connected</span><span class="sep">·</span>` : ''}
        <span><kbd>↵</kbd> send</span>
      </span>`;
  };

  const renderQueue = () => {
    if (!queueBar) return;
    if (!queue.length) { queueBar.hidden = true; queueBar.innerHTML = ''; return; }
    queueBar.hidden = false;
    queueBar.innerHTML = `<b>${queue.length} queued</b><span>· sent when Nova finishes</span><button type="button" id="queueClear">Clear</button>`;
    $('#queueClear').addEventListener('click', () => { queue = []; renderQueue(); });
  };

  /* empty state */
  const cards = [
    { icon: '⌘', title: 'Build & preview an app', sub: 'Plan, scaffold, audit and preview in one pass', prompt: 'Build a landing page for a spatial design studio and open the live preview.' },
    { icon: '◉', title: 'Screen co-pilot', sub: 'Share a screen or summarize a long video', action: () => app.openPanel('vision') },
    { icon: '◫', title: 'Deep research dossier', sub: 'Cited sources, then a PDF report', prompt: 'Deep research: browser-native AI in 2026 — cite sources and produce a dossier.' },
    { icon: '◎', title: 'Network & storage HUD', sub: 'Latency, nodes and where the bytes live', action: () => app.openPanel('radar') }
  ];

  const emptyHtml = () => `
    <div class="empty">
      <div>
        <p class="empty__cap">${isoDay()}</p>
        <h1 class="empty__hello">Hello, ${escapeHtml(store.get('lock.user', 'Master Drippy Dee'))}
          <span>What are we building today?</span>
        </h1>
      </div>
      <div class="action-grid">
        ${cards.map((c, i) => `
          <button class="action-card" data-card="${i}" type="button">
            <span class="action-card__icon">${c.icon}</span>
            <b>${c.title}</b>
            <span>${c.sub}</span>
          </button>`).join('')}
      </div>
    </div>`;

  const threadHtml = (chat) => {
    const msgs = chat.messages || [];
    if (!msgs.length && !pending) return emptyHtml();
    return `<div class="thread">
      ${msgs.map(messageHtml).join('')}
      <div id="liveSlot"></div>
    </div>`;
  };

  function render() {
    const chat = store.activeChat();
    canvas.innerHTML = threadHtml(chat || { messages: [] });
    if (pending) renderLive();
    bindThread();
  }

  function scrollToBottom(smooth = true) {
    canvas.scrollTo({ top: canvas.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  /* live streaming bubble */
  function ensureLive() {
    if (liveEl) return liveEl;
    const slot = document.getElementById('liveSlot');
    if (!slot) return null;
    slot.innerHTML = messageHtml({
      id: 'live',
      role: 'nova',
      text: '',
      steps: pending.steps,
      blocks: pending.blocks,
      sources: pending.sources,
      demo: true,
      followups: []
    });
    liveEl = slot.firstElementChild;
    return liveEl;
  }

  function renderLive() {
    const el = ensureLive();
    if (!el) return;
    const body = el.querySelector('.msg__body');
    if (body) body.innerHTML = pending.text ? renderMarkdown(pending.text) : '<span class="typing"><i></i><i></i><i></i></span>';
    const trace = el.querySelector('[data-trace]');
    const fresh = stepsHtml(pending.steps, 0, true, true);
    if (trace) {
      const wrap = document.createElement('div');
      wrap.innerHTML = fresh;
      trace.replaceWith(wrap.firstElementChild);
    } else if (fresh) {
      const head = el.querySelector('.msg__head');
      head.insertAdjacentHTML('afterend', fresh);
    }
    // re-render blocks and sources when they arrive
    const oldBlocks = el.querySelectorAll('.block, .srcs');
    if (pending.dirtyBlocks) {
      oldBlocks.forEach((n) => n.remove());
      const body = el.querySelector('.msg__body');
      body.insertAdjacentHTML('afterend', sourcesHtml(pending.sources));
      body.insertAdjacentHTML('afterend', pending.blocks.map(blockHtml).join(''));
      pending.dirtyBlocks = false;
    }
  }

  function resetLive() {
    pending = null;
    liveEl = null;
    const slot = document.getElementById('liveSlot');
    if (slot) slot.innerHTML = '';
  }

  /* ── sending ───────────────────────────────────────────── */
  async function send(rawText) {
    let text = String(rawText || '').trim();
    if (!text && !attachment) return;

    if (busy) {
      queue.push({ text, attachment });
      attachment = null;
      renderQueue();
      renderAttachments();
      return;
    }

    const mode = store.get('prefs.mode', 'chat');
    const chat = store.ensureChat();
    const att = attachment;
    attachment = null;

    if (att) {
      if (att.kind === 'file' && att.text != null) {
        store.set(`files.${att.name}`, att.text);
        text += `${text ? '\n\n' : ''}[Attached ${att.name} — added to the workspace]`;
      } else if (att.kind === 'image') {
        store.update((d) => d.library.unshift({ id: uid('lib'), kind: 'media', title: att.name, meta: 'Uploaded image', ts: Date.now() }));
        text += `${text ? '\n\n' : ''}[Attached image "${att.name}" — available in the Vision studio]`;
      }
    }

    const userMsg = { id: uid('msg'), role: 'user', text, ts: Date.now() };
    store.addMessage(userMsg);
    app.refreshChats();
    renderAttachments();

    // ── Real UI action intents: execute before hitting the LLM ──
    const low = text.toLowerCase();
    const finishAction = (msgText) => {
      const novaMsg = { id: uid('msg'), role: 'nova', text: msgText, steps: [], blocks: [], sources: [], followups: [], demo: false, ts: Date.now() };
      store.addMessage(novaMsg);
      app.refreshChats();
      render();
      if (app.autoSpeak()) speak(novaMsg.text).catch(() => {});
    };
    if (/open (live )?preview|show preview/.test(low)) { app.openPanel('workspace', { tab: 'preview' }); finishAction('Opened the Workspace on the **Preview** tab.'); return; }
    if (/open (code|files)|show (code|files)/.test(low)) { app.openPanel('workspace', { tab: 'files' }); finishAction('Opened the Workspace on the **Files** tab.'); return; }
    if (/open (vision|camera)|show (vision|camera)/.test(low)) { app.openPanel('vision'); finishAction('Opened the **Vision & Ad Studio**.'); return; }
    if (/open (memory)|catch up|read (our |past )?conversations/.test(low)) { app.openPanel('memory'); finishAction('Opened the **Persistent Memory** drawer.'); return; }
    if (/check (my )?mail|read (my )?mail|read (latest )?email/.test(low)) {
      (async () => {
        try {
          const gh = await api('/api/gmail?action=inbox&max=6', { method: 'GET', timeout: 15000 });
          const msgs = (gh && gh.messages) || [];
          const txt = msgs.length ? `You have ${msgs.length} unread thread${msgs.length === 1 ? '' : 's'}.\n\n${msgs.slice(0, 5).map((m, i) => `${i + 1}. **${m.from}** — ${m.subject}`).join('\n')}` : 'Inbox is clear.';
          finishAction(txt);
        } catch (e) { finishAction(`Mail unavailable: ${e && e.message}`); }
      })();
      return;
    }
    if (/^(lock|go to sleep|close yourself)$/.test(low.trim()) || /\b(lock|go to sleep|close yourself)\b/.test(low)) {
      finishAction('Locking the HUD…');
      store.set('lock.locked', true);
      setTimeout(() => { try { location.reload(); } catch { /* noop */ } }, 400);
      return;
    }

    busy = true;
    pending = { steps: [], text: '', sources: [], blocks: [], started: Date.now(), dirtyBlocks: false };
    render();
    scrollToBottom();
    setActivity(mode === 'build' ? 'working' : 'thinking');

    const onEvent = (evt) => {
      switch (evt.type) {
        case 'step-add':
          pending.steps.push(evt.step);
          pending.steps = pending.steps.map((s) => ({ ...s }));
          break;
        case 'step-update': {
          const s = pending.steps.find((x) => x.id === evt.id);
          if (s) { s.state = evt.state; if (evt.detail) s.detail = evt.detail; }
          break;
        }
        case 'sources':
          pending.sources = evt.sources || [];
          pending.dirtyBlocks = true;
          break;
        case 'block':
          if (evt.block) pending.blocks.push(evt.block);
          pending.dirtyBlocks = true;
          break;
        case 'text':
        case 'delta':
          pending.text = evt.text || (pending.text + (evt.delta || ''));
          break;
        case 'notice':
          pending.notice = evt.text;
          break;
        case 'meta':
          if (evt.meta) {
            if (evt.meta.label) store.set('lastProvider', evt.meta.label);
            if (evt.meta.model) store.set('lastModel', evt.meta.model);
          }
          break;
        default:
          break;
      }
      renderLive();
      scrollToBottom(false);
    };

    let result = null;
    try {
      result = await runAgent({ prompt: text, mode, onEvent });
      if (pending && pending.text && !result.text) result.text = pending.text;
    } catch (err) {
      result = {
        id: uid('msg'), role: 'nova', demo: false,
        text: `**I could not complete that run.**\n\n\`${err.message || 'unknown fault'}\`\n\nNothing was written and no deploy was attempted. Try again, or check the council status under Settings.`,
        steps: [], blocks: [], sources: [], followups: ['Check council status', 'Retry the request']
      };
    }

    const duration = Date.now() - (pending ? pending.started : Date.now());
    const novaMsg = {
      id: uid('msg'),
      role: 'nova',
      text: result.text || '',
      steps: result.steps || (pending ? pending.steps : []),
      blocks: result.blocks || (pending ? pending.blocks : []),
      sources: result.sources || (pending ? pending.sources : []),
      followups: result.followups || [],
      demo: result.demo !== false,
      duration,
      ts: Date.now()
    };
    if (pending && pending.notice) novaMsg.notice = pending.notice;

    store.addMessage(novaMsg);
    document.dispatchEvent(new CustomEvent('nova:reply', { detail: { text: novaMsg.text } }));
    store.trackUsage(Math.max(120, Math.round((text.length + novaMsg.text.length) * 1.4)));
    app.refreshChats();
    resetLive();
    renderMeta();
    app.syncUsage();

    busy = false;
    setActivity('idle');

    if (app.autoSpeak()) speak(novaMsg.text).catch(() => {});
    render();

    if (queue.length) {
      const next = queue.shift();
      renderQueue();
      if (next.attachment) attachment = next.attachment;
      send(next.text);
    }
  }

  /* ── attachments ───────────────────────────────────────── */
  function renderAttachments() {
    const existing = document.getElementById('attChip');
    if (existing) existing.remove();
    if (!attachment) return;
    const row = document.createElement('div');
    row.id = 'attChip';
    row.className = 'queue-bar';
    row.innerHTML = `<span class="badge badge--accent">${escapeHtml(attachment.name)}</span><span>${attachment.kind === 'image' ? 'image' : 'text file'} ready to attach</span><button type="button" id="attClear">Remove</button>`;
    host.insertBefore(row, host.firstChild);
    $('#attClear').addEventListener('click', () => { attachment = null; renderAttachments(); });
  }

  /* ── thread interactions ───────────────────────────────── */
  function bindThread() {
    canvas.querySelectorAll('[data-card]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = cards[Number(btn.dataset.card)];
        if (card.action) card.action();
        else send(card.prompt);
      });
    });

    canvas.querySelectorAll('[data-prompt]').forEach((chip) => {
      chip.addEventListener('click', () => send(chip.dataset.prompt));
    });

    canvas.querySelectorAll('[data-trace-toggle]').forEach((head) => {
      head.addEventListener('click', () => head.closest('[data-trace]').classList.toggle('is-open'));
    });

    canvas.querySelectorAll('[data-copy-code]').forEach((btn) => {
      btn.addEventListener('click', () => copyText(btn.closest('.codeblock').querySelector('code').dataset.raw || '', 'Code copied'));
    });

    canvas.querySelectorAll('[data-preview-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.closest('.codeblock').querySelector('code').dataset.raw || '';
        const isHtml = /<\w+[\s>]/.test(raw) && /<\/\w+>/.test(raw);
        app.openPanel('workspace', { snippet: isHtml ? raw : null });
        if (!isHtml) toast('Snippet opened in the workspace tree');
      });
    });

    canvas.querySelectorAll('[data-push-code]').forEach((btn) => {
      btn.addEventListener('click', () => pushSnippet(btn.closest('.codeblock').querySelector('code').dataset.raw || ''));
    });

    canvas.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (cmd === 'preview') app.openPanel('workspace');
        if (cmd === 'apply') app.openPanel('workspace', { tab: 'diff' });
        if (cmd === 'ship') send('Run the pre-deploy security audit, then deploy the current workspace and report the live URL.');
      });
    });

    canvas.querySelectorAll('[data-act="copy-msg"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const body = btn.closest('.msg').querySelector('.msg__body');
        copyText(body ? body.innerText : '', 'Answer copied');
      });
    });

    canvas.querySelectorAll('[data-act="speak"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (isSpeaking()) { cancelSpeech(); return; }
        const body = btn.closest('.msg').querySelector('.msg__body');
        speak(body ? body.innerText : '').catch(() => {});
      });
    });

    canvas.querySelectorAll('[data-act="export-pdf"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const body = btn.closest('.msg')?.querySelector('.msg__body');
        const text = body ? body.innerText : '';
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>NOVA dossier</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#111}pre{white-space:pre-wrap}</style></head><body><h1>NOVA // OS dossier</h1><pre>${escapeHtml(text)}</pre></body></html>`;
        downloadText(`nova-dossier-${Date.now().toString(36)}.html`, html, 'text/html');
        toast('Dossier downloaded — open and print to PDF', 'ok');
      });
    });

    canvas.querySelectorAll('[data-act="ship-workspace"]').forEach((btn) => {
      btn.addEventListener('click', () => app.openPanel('workspace'));
    });
  }

  async function pushSnippet(code) {
    const repo = store.get('prefs.repo', 'iniakinpelu2020-oss/nova-os');
    const name = `snippets/nova-${Date.now().toString(36)}.js`;
    const res = await github.pushFiles(repo, [{ path: name, content: code }], 'nova: add snippet from chat');
    if (res.ok) toast(`Committed to ${repo}`, 'ok');
    else {
      openModal({
        title: 'GitHub is not connected',
        sub: escapeHtml(res.error || 'The server has no GITHUB_PAT'),
        body: `<p style="font-size:12.5px;color:var(--dim);line-height:1.65">Core GitHub access uses a server-side token in <span class="mono">context.env.GITHUB_PAT</span> — it is never collected in the browser. The snippet is still in your workspace and can be copied.</p>
          <div class="field" style="margin-top:12px"><label>Target repository</label><input type="text" value="${escapeHtml(repo)}" readonly /></div>`,
        actions: [{ label: 'Copy snippet', onClick: () => { copyText(code, 'Snippet copied'); return true; } }, { label: 'Close', kind: 'primary' }]
      });
    }
  }

  /* ── composer behaviour ────────────────────────────────── */
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(168, input.scrollHeight)}px`;
  };

  function setActivity(state) {
    app.setActivity && app.setActivity(state);
    const send = $('#sendBtn');
    if (send) send.disabled = state !== 'idle';
  }

  /* plus menu */
  function openPlusMenu() {
    document.querySelectorAll('.plus-menu').forEach((m) => m.remove());
    const btn = $('#plusBtn');
    const menu = document.createElement('div');
    menu.className = 'menu plus-menu';
    menu.innerHTML = `
      <button class="menu__item" data-plus="file" type="button">＋ Upload file</button>
      <button class="menu__item" data-plus="image" type="button">🖼 Upload image</button>
      <button class="menu__item" data-plus="screen" type="button">🖥 Share screen co-pilot</button>
      <button class="menu__item" data-plus="camera" type="button">📷 Open live camera</button>
      <button class="menu__item" data-plus="notebook" type="button">📓 Attach notebook</button>
      <div class="menu__sep"></div>
      <button class="menu__item" data-plus="audit" type="button">🛡 Run security audit</button>`;
    btn.parentElement.appendChild(menu);
    btn.setAttribute('aria-expanded', 'true');
    const close = (e) => {
      if (!menu.contains(e.target) && !btn.contains(e.target)) { menu.remove(); btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', close); }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);

    menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-plus]')?.dataset.plus;
      if (!act) return;
      menu.remove();
      if (act === 'file' || act === 'image') pickFile(act);
      if (act === 'screen') app.openPanel('vision', { share: true });
      if (act === 'camera') app.openPanel('vision', { camera: true });
      if (act === 'notebook') attachNotebook();
      if (act === 'audit') send('Run the pre-deploy security audit over the workspace and explain every finding in plain English.');
    });
  }

  function pickFile(kind) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = kind === 'image' ? 'image/*' : '.txt,.md,.js,.css,.html,.json,.csv,.yml,.yaml,.toml';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (kind === 'image') {
        attachment = { kind: 'image', name: file.name };
        renderAttachments();
        toast(`${file.name} attached — visible in the Vision studio`);
        return;
      }
      if (file.size > 200000) { toast('That file is over 200 KB — paste the relevant part instead', 'bad'); return; }
      const text = await file.text();
      attachment = { kind: 'file', name: file.name, text };
      renderAttachments();
      toast(`${file.name} will be added to the workspace`);
    });
    fileInput.click();
  }

  function attachNotebook() {
    const notebooks = store.get('notebooks', []);
    if (!notebooks.length) { toast('No notebooks yet — create one from the sidebar'); return; }
    openModal({
      title: 'Attach a notebook',
      sub: 'Its context is added to your next message',
      body: `<div class="memory-list">${notebooks.map((n) => `<button class="memory-item" data-nb="${n.id}" type="button"><span><b style="font-weight:500">${escapeHtml(n.title)}</b><br><small class="dim">${escapeHtml(n.note || '')}</small></span></button>`).join('')}</div>`,
      onMount: (el, close) => {
        el.querySelectorAll('[data-nb]').forEach((b) => b.addEventListener('click', () => {
          const nb = notebooks.find((n) => n.id === b.dataset.nb);
          input.value = `${input.value}${input.value ? '\n\n' : ''}[Notebook: ${nb.title} — ${nb.note}]`;
          autosize();
          close();
          input.focus();
        }));
      },
      actions: [{ label: 'Cancel' }]
    });
  }

  /* @mention autocomplete */
  function mentionCandidates(query) {
    const q = query.toLowerCase();
    const conns = enabledConnectors().map((c) => ({ icon: c.icon, name: c.name, kind: 'app', hint: 'connected app' }));
    const builtin = [
      { icon: '🐙', name: 'GitHub', kind: 'builtin', hint: 'env' },
      { icon: '⚡', name: 'Cloudflare Pages', kind: 'builtin', hint: 'env' },
      { icon: '🔎', name: 'SearXNG', kind: 'builtin', hint: 'env' }
    ];
    const skills = store.get('skills', []).map((s) => ({ icon: '✦', name: s.name, kind: 'skill', hint: 'skill' }));
    return [...builtin, ...conns, ...skills].filter((c) => c.name.toLowerCase().includes(q)).slice(0, 7);
  }

  function showMention(query) {
    document.querySelectorAll('.mention').forEach((m) => m.remove());
    const items = mentionCandidates(query);
    if (!items.length) return;
    mentionState = { open: true, items, index: 0, query };
    const box = document.createElement('div');
    box.className = 'mention';
    box.innerHTML = items.map((it, i) => `
      <button class="mention__item${i === 0 ? ' is-active' : ''}" data-mention="${i}" type="button">
        <span class="mention__icon">${it.icon}</span>
        <span>${escapeHtml(it.name)}</span>
        <small>${it.hint}</small>
      </button>`).join('');
    $('.composer__row').appendChild(box);
    box.addEventListener('mousedown', (e) => {
      const b = e.target.closest('[data-mention]');
      if (!b) return;
      e.preventDefault();
      applyMention(items[Number(b.dataset.mention)]);
    });
  }

  function hideMention() {
    document.querySelectorAll('.mention').forEach((m) => m.remove());
    mentionState.open = false;
  }

  function applyMention(item) {
    const value = input.value;
    const caret = input.selectionStart;
    const before = value.slice(0, caret).replace(/@[\w .-]*$/, '');
    const next = `${before}@${item.name} ${value.slice(caret)}`;
    input.value = next;
    hideMention();
    input.focus();
    input.setSelectionRange(before.length + item.name.length + 2, before.length + item.name.length + 2);
    autosize();
  }

  input.addEventListener('input', () => {
    autosize();
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const m = before.match(/@([\w .-]*)$/);
    if (m) showMention(m[1]);
    else hideMention();
  });

  input.addEventListener('keydown', (e) => {
    if (mentionState.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        mentionState.index = (mentionState.index + dir + mentionState.items.length) % mentionState.items.length;
        document.querySelectorAll('.mention__item').forEach((el, i) => el.classList.toggle('is-active', i === mentionState.index));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(mentionState.items[mentionState.index]);
        return;
      }
      if (e.key === 'Escape') { hideMention(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  function submit() {
    const text = input.value.trim();
    if (!text && !attachment) return;
    input.value = '';
    autosize();
    hideMention();
    send(text);
  }

  sendBtn.addEventListener('click', submit);
  $('#plusBtn').addEventListener('click', openPlusMenu);

  /* mic */
  $('#micBtn').addEventListener('click', () => {
    if (!sttSupported()) { toast('Speech recognition is unavailable in this browser', 'bad'); return; }
    if (listening) { stopListening(); listening = false; return; }
    listening = true;
    toast('Listening…');
    listen({
      onInterim: (t) => { input.value = t; autosize(); },
      onFinal: (t) => { listening = false; input.value = t; autosize(); submit(); },
      onEnd: () => { listening = false; },
      onError: (err) => { listening = false; toast(String(err), 'bad'); }
    });
  });

  $('#orbBtn').addEventListener('click', () => {
    if (voiceCard && !voiceCard.hidden) closeVoiceCard();
    else openVoiceCard();
  });
  voiceCardOrb?.addEventListener('click', () => {
    if (voiceCardListening) {
      stopListening();
      voiceCardListening = false;
      voiceOrb?.setState('idle');
      if (voiceCaption) voiceCaption.textContent = 'Tap the orb to speak.';
    } else {
      startVoiceCardListening();
    }
  });
  voiceCardClose?.addEventListener('click', closeVoiceCard);

  /* document-level: send from other modules */
  document.addEventListener('nova:send', (e) => send(e.detail && e.detail.text));

  /* initial paint */
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMention(); input.blur(); } });
  renderMeta();
  render();
  app.onDemoChange = renderMeta;

  return {
    send,
    focus: () => input && input.focus(),
    refresh: () => { render(); renderMeta(); },
    setMode: () => { renderMeta(); },
    get busy() { return busy; }
  };
}
