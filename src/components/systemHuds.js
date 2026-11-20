/* ============================================================
   NOVA // OS — system HUDs
   1. Storage & workspace treemap with a real byte breakdown.
   2. Live network radar that pings every bridge and connector.
   ============================================================ */
import { store, escapeHtml } from '../services/store.js';
import { api, apiSafe, smartFetch, describeError } from '../services/net.js';
import { enabledConnectors } from '../services/toolsEngine.js';
import { openPanel, closePanel, toast, bytesLabel } from '../services/ui.js';

const byteLen = (v) => {
  try { return new Blob([typeof v === 'string' ? v : JSON.stringify(v)]).size; } catch { return 0; }
};

function storageSnapshot() {
  const files = store.get('files', {});
  const chats = store.get('chats', []);
  const notebooks = store.get('notebooks', []);
  const library = store.get('library', []);
  const connectors = store.get('connectors', []);

  const workspace = Object.entries(files).reduce((n, [p, c]) => n + byteLen(p) + byteLen(c), 0);
  const chatBytes = chats.reduce(
    (n, c) => n + byteLen(c.title) + c.messages.reduce((m, msg) => m + byteLen(msg.text) + byteLen(msg.steps || []) + byteLen(msg.blocks || []), 0),
    0
  );
  const notebookBytes = notebooks.reduce((n, b) => n + byteLen(b.title) + byteLen(b.note || ''), 0);
  const media = library.filter((i) => i.kind === 'media').length;
  const mediaBytes = media * 180 * 1024; // index entries only — uploads are not stored as blobs
  const settingsBytes = byteLen({ prefs: store.get('prefs'), memory: store.get('memory'), skills: store.get('skills') });
  const connectorBytes = connectors.reduce((n, c) => n + byteLen(c.values || {}), 0);
  const total = workspace + chatBytes + notebookBytes + mediaBytes + settingsBytes + connectorBytes;

  return { workspace, chatBytes, notebookBytes, mediaBytes, media, settingsBytes, connectorBytes, total, files: Object.keys(files).length, chats: chats.length, notebooks: notebooks.length };
}

export function openStoragePanel(app) {
  const renderBody = () => {
    const s = storageSnapshot();
    const localBytes = byteLen(store.get());
    const quota = 5 * 1024 * 1024;
    const pct = Math.min(100, Math.round((localBytes / quota) * 100));
    const cells = [
      { k: 'Workspace', v: bytesLabel(s.workspace), sub: `${s.files} files`, cls: 'tm-cell--lg tm-cell--accent' },
      { k: 'Conversations', v: bytesLabel(s.chatBytes), sub: `${s.chats} threads` },
      { k: 'Notebooks', v: bytesLabel(s.notebookBytes), sub: `${s.notebooks} notebooks` },
      { k: 'Media index', v: bytesLabel(s.mediaBytes), sub: `${s.media} assets` },
      { k: 'Prefs & memory', v: bytesLabel(s.settingsBytes), sub: 'settings' },
      { k: 'Connectors', v: bytesLabel(s.connectorBytes), sub: 'credentials' }
    ];
    return `
      <div class="gauge-row">
        <div class="gauge" style="--pct:${pct}">
          <div class="gauge__inner">
            <div class="gauge__num">${pct}%</div>
            <div class="gauge__unit">of 5 MB</div>
          </div>
        </div>
        <div class="gauge-legend">
          <div><i style="background:#8b9cff"></i> Workspace <b>${bytesLabel(s.workspace)}</b></div>
          <div><i style="background:#c084fc"></i> Conversations <b>${bytesLabel(s.chatBytes)}</b></div>
          <div><i style="background:#34d399"></i> Media index <b>${bytesLabel(s.mediaBytes)}</b></div>
          <div><i style="background:rgba(255,255,255,.2)"></i> Free of 5 MB <b>${bytesLabel(Math.max(0, quota - localBytes))}</b></div>
        </div>
      </div>

      <div class="treemap">
        ${cells.map((c) => `<button class="tm-cell ${c.cls || ''}" type="button" title="${c.k} · ${c.v}">
          <span class="tm-cell__k">${c.k}</span>
          <span><span class="tm-cell__v">${c.v}</span><br><span class="tm-cell__sub">${c.sub}</span></span>
        </button>`).join('')}
      </div>

      <div class="disk-list">
        <div class="disk-row">
          <span class="disk-row__icon">💾</span>
          <span class="disk-row__name">Local document<small>single localStorage key</small></span>
          <span class="bar"><i style="width:${pct}%"></i></span>
          <span class="disk-row__size">${bytesLabel(localBytes)}</span>
        </div>
        <div class="disk-row">
          <span class="disk-row__icon">📁</span>
          <span class="disk-row__name">Virtual workspace<small>editable files served to the preview iframe</small></span>
          <span class="bar"><i style="width:${Math.min(100, Math.round((s.workspace / 200000) * 100))}%"></i></span>
          <span class="disk-row__size">${bytesLabel(s.workspace)}</span>
        </div>
        <div class="disk-row">
          <span class="disk-row__icon">🧠</span>
          <span class="disk-row__name">Chat &amp; notebook cache<small>plain text, trimmed history</small></span>
          <span class="bar"><i style="width:${Math.min(100, Math.round(((s.chatBytes + s.notebookBytes) / 500000) * 100))}%"></i></span>
          <span class="disk-row__size">${bytesLabel(s.chatBytes + s.notebookBytes)}</span>
        </div>
        <div class="disk-row">
          <span class="disk-row__icon">📱</span>
          <span class="disk-row__name">Device storage<small id="devQuota">readable through the Storage API</small></span>
          <span class="bar"><i id="devBar" style="width:0%"></i></span>
          <span class="disk-row__size" id="devSize">—</span>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn--primary" id="cleanBtn" type="button">🧹 Clear temp &amp; cache</button>
        <button class="btn" id="recountBtn" type="button">Recount</button>
      </div>
      <p class="vision-note">Clearing removes the media index and resets the session counter. Conversations, files and connector credentials are kept.</p>`;
  };

  const panel = openPanel({
    id: 'storage',
    title: 'Storage map',
    sub: 'DISK MAP · BROWSER RESIDENCY',
    icon: '💾',
    wide: true,
    body: renderBody,
    onMount: ({ body, refresh }) => {
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then((est) => {
          const bar = body.querySelector('#devBar');
          const size = body.querySelector('#devSize');
          const note = body.querySelector('#devQuota');
          if (!bar || !size) return;
          const used = est.usage || 0;
          const quota = est.quota || 0;
          bar.style.width = `${quota ? Math.min(100, Math.round((used / quota) * 100)) : 0}%`;
          size.textContent = `${bytesLabel(used)} / ${bytesLabel(quota)}`;
          if (note) note.textContent = 'origin quota reported by the browser';
        }).catch(() => {});
      }
      body.addEventListener('click', (e) => {
        if (e.target.closest('#cleanBtn')) {
          store.clearCaches();
          toast('Temp & cache cleared — library media index emptied', 'ok');
          refresh();
          app.syncUsage();
        }
        if (e.target.closest('#recountBtn')) {
          if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then((est) => {
              const bar = body.querySelector('#devBar');
              const size = body.querySelector('#devSize');
              const note = body.querySelector('#devQuota');
              if (!bar || !size) return;
              const used = est.usage || 0;
              const quota = est.quota || 0;
              bar.style.width = `${quota ? Math.min(100, Math.round((used / quota) * 100)) : 0}%`;
              size.textContent = `${bytesLabel(used)} / ${bytesLabel(quota)}`;
              if (note) note.textContent = 'origin quota reported by the browser';
            }).catch(() => {});
          }
          refresh();
          toast('Recounted');
        }
      });
    }
  });

  return panel;
}

/* ── network radar ────────────────────────────────────────── */

async function probe(name, detail, fn, limitMs = 8000) {
  const started = performance.now();
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ state: 'warn', note: 'timed out' }), limitMs));
  try {
    const res = await Promise.race([fn(), timeout]);
    const ms = Math.round(performance.now() - started);
    return { name, detail, ms, state: res.state || 'ok', note: res.note || '' };
  } catch (err) {
    return { name, detail, ms: Math.round(performance.now() - started), state: 'bad', note: describeError(err) };
  }
}

async function collectNodes(onNode) {
  const searxng = (store.get('prefs.searxng', '') || '').replace(/\/+$/, '');
  const conns = enabledConnectors();

  const jobs = [
    probe('Council bridge', '/api/council?status=1', async () => {
      const res = await api('/api/council?status=1', { method: 'GET', timeout: 6000 });
      return res && res.configured
        ? { state: 'ok', note: 'env keys live' }
        : { state: 'warn', note: 'reachable · demo keys' };
    }),
    probe('Workers AI', '/api/workers-ai', async () => {
      try {
        const res = await api('/api/workers-ai', { method: 'POST', timeout: 6000, body: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 } });
        return { state: 'ok', note: res && res.text ? 'binding answered' : 'reachable' };
      } catch (err) {
        if (err.status === 503) return { state: 'warn', note: 'bridge up · no AI binding' };
        throw err;
      }
    }, 7000),
    probe('GitHub proxy', '/api/github-proxy?status=1', async () => {
      const res = await api('/api/github-proxy?status=1', { method: 'GET', timeout: 6000 });
      return res && res.configured
        ? { state: 'ok', note: 'PAT present' }
        : { state: 'warn', note: 'bridge up · no PAT' };
    }, 7000),
    probe('SearXNG', 'searxng-6mmb.onrender.com', async () => {
      const res = await smartFetch('https://searxng-6mmb.onrender.com/search?q=ping&format=json', { headers: { accept: 'application/json' }, timeout: 7000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => null);
      return { state: 'ok', note: `${(data && data.results && data.results.length) || 0} results` };
    }, 7500),
    probe('Jina reader', 'r.jina.ai', async () => {
      const res = await smartFetch('https://r.jina.ai/', { timeout: 7000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { state: 'ok', note: 'reader reachable' };
    }, 7500)
  ];

  for (const c of conns.slice(0, 4)) {
    jobs.push(probe(c.name, 'connected app', async () => ({ state: 'ok', note: 'configured' }), 1200));
  }

  return Promise.all(jobs.map((job) => job.then((node) => { if (onNode) onNode(node); return node; })));
}

export function openRadarPanel(app) {
  let timer = null;

  const panel = openPanel({
    id: 'radar',
    title: 'Network radar',
    sub: 'LIVE ENDPOINT TELEMETRY',
    icon: '📡',
    wide: true,
    body: `<div class="radar-meta"><span id="radarScan">scanning…</span><span id="radarAvg">—</span></div>
      <div class="radar-scope" id="radarScope">
        <div class="radar-sweep"></div>
      </div>
      <div class="node-list" id="nodeList"><div class="node"><span class="node__dot"></span><span class="node__name">Measuring endpoints…</span></div></div>
      <p class="vision-note">Every probe is same-origin where possible. Failed probes report the real status instead of a green dot.</p>`,
    onMount: ({ body, wrap }) => {
      const scope = body.querySelector('#radarScope');
      const list = body.querySelector('#nodeList');
      const scan = body.querySelector('#radarScan');
      const avg = body.querySelector('#radarAvg');

      const run = async () => {
        scan.textContent = 'scanning…';
        list.innerHTML = `<div class="node"><span class="node__dot"></span><span class="node__name">Measuring endpoints<small>council · workers ai · github · search</small></span><span class="node__ms">—</span></div>`;
        const nodes = await collectNodes((node) => {
          const badge = node.state === 'ok' ? 'CONNECTED' : node.state === 'warn' ? 'REACHABLE - ENV NOT SET' : 'OFFLINE';
          list.insertAdjacentHTML('beforeend', `<div class="node"><span class="node__dot ${node.state === 'ok' ? 'is-ok' : node.state === 'warn' ? 'is-warn' : 'is-bad'}"></span><span class="node__name">${escapeHtml(node.name)}<small>${escapeHtml(node.detail)}${node.note ? ` · ${escapeHtml(node.note)}` : ''}</small></span><span class="node__ms" data-slow="${node.ms > 700 ? 1 : 0}" data-fail="${node.state === 'bad' ? 1 : 0}">${node.ms}ms</span><span class="badge ${node.state === 'ok' ? 'badge--ok' : node.state === 'warn' ? 'badge--demo' : ''}">${badge}</span></div>`);
          scan.textContent = 'measuring…';
        });
        list.innerHTML = '';
        const worst = Math.max(...nodes.map((n) => n.ms), 1);
        scope.querySelectorAll('.radar-blip').forEach((b) => b.remove());
        nodes.forEach((n, i) => {
          const angle = (i / nodes.length) * Math.PI * 2 + 0.4;
          const radius = 18 + ((i * 37) % 30);
          const x = 50 + Math.cos(angle) * radius;
          const y = 50 + Math.sin(angle) * radius;
          const blip = document.createElement('span');
          blip.className = 'radar-blip';
          blip.dataset.bad = n.state === 'bad' ? '1' : '0';
          blip.dataset.warn = n.state === 'warn' ? '1' : '0';
          blip.style.left = `${x}%`;
          blip.style.top = `${y}%`;
          scope.appendChild(blip);
        });
        list.innerHTML = nodes.map((n) => {
          const badge = n.state === 'ok' ? 'CONNECTED' : n.state === 'warn' ? 'REACHABLE - ENV NOT SET' : 'OFFLINE';
          return `
          <div class="node">
            <span class="node__dot ${n.state === 'ok' ? 'is-ok' : n.state === 'warn' ? 'is-warn' : 'is-bad'}"></span>
            <span class="node__name">${escapeHtml(n.name)}<small>${escapeHtml(n.detail)}${n.note ? ` · ${escapeHtml(n.note)}` : ''}</small></span>
            <span class="node__ms" data-slow="${n.ms > 700 ? 1 : 0}" data-fail="${n.state === 'bad' ? 1 : 0}">${n.ms}ms</span>
            <span class="badge ${n.state === 'ok' ? 'badge--ok' : n.state === 'warn' ? 'badge--demo' : ''}">${badge}</span>
          </div>`;
        }).join('');
        const healthy = nodes.filter((n) => n.state === 'ok').length;
        scan.textContent = `${nodes.length} nodes · ${healthy} healthy · sweep ${(worst / 1000).toFixed(1)}s`;
        avg.textContent = `avg ${Math.round(nodes.reduce((s, n) => s + n.ms, 0) / nodes.length)}ms`;
      };

      run();
      timer = setInterval(() => {
        if (!document.body.contains(wrap)) { clearInterval(timer); return; }
        run();
      }, 12000);

      body.addEventListener('click', (e) => {
        if (e.target.closest('#rescanBtn')) run();
      });
    }
  });

  panel.wrap.addEventListener('transitionend', () => {
    if (!panel.wrap.classList.contains('is-open') && timer) clearInterval(timer);
  });

  return panel;
}
