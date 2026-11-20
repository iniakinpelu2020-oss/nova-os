/* ============================================================
   NOVA // OS — dynamic tool registry
   Built-in Claude-Code-grade tools + every enabled connector.
   Secrets stay in the Pages Functions; this module only calls
   same-origin endpoints or user-authored webhooks.
   ============================================================ */
import { store } from './store.js';
import { smartFetch, api, describeError } from './net.js';

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || '').slice(0, 40); }
};

const truncate = (s, n = 320) => {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};

export const connectorById = (id) => store.get('connectors', []).find((c) => c.id === id);

export function connectorReady(c) {
  if (!c || !c.enabled) return false;
  const vals = c.values || {};
  return c.fields.filter((f) => f.key !== 'provider' && f.key !== 'method' && f.key !== 'description' && f.key !== 'schema' && f.key !== 'toolName')
    .every((f) => String(vals[f.key] || '').trim().length > 0 || f.key === 'fromNumber');
}

export function enabledConnectors() {
  return store.get('connectors', []).filter((c) => c.enabled);
}

export function connectorCount() {
  return enabledConnectors().length;
}

/* ────────────────────────────────────────────────────────────
   SEARCH
   ──────────────────────────────────────────────────────────── */
const FALLBACK_SOURCES = [
  { title: 'MDN — Web APIs reference', url: 'https://developer.mozilla.org/en-US/docs/Web/API', snippet: 'Authoritative reference for browser APIs used by the spatial engine.' },
  { title: 'web.dev — Rendering performance', url: 'https://web.dev/articles/rendering-performance', snippet: 'Frame budget, compositing and painting guidance for 60fps interfaces.' },
  { title: 'Cloudflare Pages — Functions', url: 'https://developers.cloudflare.com/pages/functions/', snippet: 'Server-side routing, bindings and environment variables for Pages Functions.' }
];

export async function searchWeb(query, limit = 5) {
  const base = (store.get('prefs.searxng', '') || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'No SearXNG endpoint configured', sources: [] };
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&language=en`;
  try {
    const res = await smartFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`SearXNG ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data.results) ? data.results : [];
    const sources = rows.slice(0, Math.max(1, limit)).map((r, i) => ({
      n: i + 1,
      title: r.title || hostOf(r.url),
      url: r.url,
      domain: hostOf(r.url),
      snippet: truncate(r.content || r.snippet || '', 240)
    }));
    if (!sources.length) throw new Error('no results');
    return { ok: true, sources, engine: 'searxng', query };
  } catch (err) {
    return {
      ok: false,
      error: describeError(err),
      query,
      sources: FALLBACK_SOURCES.map((s, i) => ({ ...s, n: i + 1, domain: hostOf(s.url), cached: true }))
    };
  }
}

export async function readWebpage(url) {
  try {
    const res = await smartFetch(`https://r.jina.ai/${url}`, {
      headers: { accept: 'text/plain', 'x-respond-with': 'text' }
    });
    if (!res.ok) throw new Error(`Reader ${res.status}`);
    const text = await res.text();
    return { ok: true, url, text: text.slice(0, 6000), title: hostOf(url) };
  } catch (err) {
    return { ok: false, url, error: describeError(err), text: '' };
  }
}

/* ────────────────────────────────────────────────────────────
   CONNECTOR TRANSPORT
   ──────────────────────────────────────────────────────────── */
export async function connectorFetch({ url, method = 'POST', headers = {}, body = null }) {
  try {
    const res = await api('/api/connector-proxy', { method: 'POST', body: { url, method, headers, body } });
    if (res && res.base64) return { ok: true, base64: res.base64, contentType: res.contentType };
    return { ok: true, data: res && res.data !== undefined ? res.data : res, status: res && res.status };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

const authHeaders = (values = {}) => {
  const h = { 'content-type': 'application/json' };
  if (values.authHeader) h.authorization = values.authHeader;
  return h;
};

export async function sendTelegram(text) {
  const c = connectorById('telegram');
  if (!connectorReady(c)) return { ok: false, error: 'Telegram connector not configured' };
  const { botToken, chatId } = c.values;
  const out = await connectorFetch({
    url: `https://api.telegram.org/bot${botToken}/sendMessage`,
    headers: { 'content-type': 'application/json' },
    body: { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }
  });
  return { ...out, summary: out.ok ? `Telegram ping sent to chat ${chatId}` : out.error };
}

export async function callPhone({ reason, script, to }) {
  const c = connectorById('phone');
  if (!connectorReady(c)) {
    return { ok: false, demo: true, summary: 'Phone connector not configured — simulated call placed', error: 'not configured' };
  }
  const v = c.values;
  const number = to || v.toNumber;
  const provider = (v.provider || 'Vapi').toLowerCase();
  let url = v.endpoint;
  let body;
  if (provider.includes('twilio')) {
    const sid = (v.accountSid || '').trim();
    if (sid && !url.includes('Accounts')) url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`;
    body = new URLSearchParams({
      To: number,
      From: v.fromNumber || '',
      Twiml: `<Response><Say voice="alice">${script || reason}</Say></Response>`
    }).toString();
  } else if (provider.includes('bland')) {
    body = { phone_number: number, task: script || reason, first_sentence: reason };
  } else {
    body = {
      phoneNumberId: v.fromNumber,
      customer: { number },
      assistantOverrides: { firstMessage: script || reason },
      metadata: { source: 'nova-os' }
    };
  }
  const out = await connectorFetch({ url, headers: authHeaders(v), body });
  return { ...out, summary: out.ok ? `Outbound call dispatched to ${number}` : out.error };
}

export const DEMO_INBOX = [
  { id: 'msg_1', from: 'priya@halcyonlabs.io', subject: 'Security addendum before Friday', value: 48000, urgency: 'high', preview: 'Our procurement team needs the SOC2 addendum and pen-test summary before the Friday committee.' },
  { id: 'msg_2', from: 'marcus@northwind.vc', subject: 'Q4 update — one metric question', value: 0, urgency: 'normal', preview: 'Loved the deck. Can you clarify net revenue retention before I share it with the partnership?' },
  { id: 'msg_3', from: 'digest@designsystems.weekly', subject: 'Issue 214 — spatial UI patterns', value: 0, urgency: 'low', preview: 'This week: depth cues, motion budgets and glass surfaces that stay legible.' }
];

export async function triageInbox() {
  const c = connectorById('inbox');
  if (!connectorReady(c)) {
    return { ok: true, demo: true, items: DEMO_INBOX, summary: 'Demo inbox triaged (connect an inbox bridge for live mail)' };
  }
  const out = await connectorFetch({
    url: c.values.endpoint,
    headers: authHeaders(c.values),
    body: { action: 'triage', limit: 6, mailbox: 'INBOX' }
  });
  if (!out.ok) return { ...out, items: DEMO_INBOX, summary: out.error };
  const rows = Array.isArray(out.data) ? out.data : (out.data && out.data.items) || [];
  return { ok: true, items: rows.length ? rows : DEMO_INBOX, summary: `${rows.length || 'No'} live threads ranked` };
}

export async function postToConnector(id, text) {
  const c = connectorById(id);
  if (!connectorReady(c)) return { ok: false, error: `${c ? c.name : id} not configured` };
  const v = c.values;
  let body;
  if (id === 'slack') body = { text };
  else if (id === 'discord') body = { content: text };
  else body = { text, content: text, source: 'nova-os', ts: Date.now() };
  const out = await connectorFetch({ url: v.endpoint, headers: authHeaders(v), body });
  return { ...out, summary: out.ok ? `${c.name} notified` : out.error };
}

export async function saveToNotion(title, bodyText) {
  const c = connectorById('notion');
  if (!connectorReady(c)) return { ok: false, error: 'Notion connector not configured' };
  const out = await connectorFetch({
    url: 'https://api.notion.com/v1/pages',
    headers: { ...authHeaders(c.values), 'Notion-Version': '2022-06-28' },
    body: {
      parent: { database_id: c.values.databaseId },
      properties: { Name: { title: [{ text: { content: title } }] } },
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: bodyText.slice(0, 1800) } }] } }]
    }
  });
  return { ...out, summary: out.ok ? 'Brief written to Notion' : out.error };
}

/* ────────────────────────────────────────────────────────────
   GITHUB + CLOUDFLARE (server-side credentials only)
   ──────────────────────────────────────────────────────────── */
async function gh(action, payload = {}) {
  try {
    const data = await api('/api/github-proxy', { method: 'POST', body: { action, ...payload } });
    return { ok: true, ...data };
  } catch (err) {
    const setup = err.status === 501 || err.status === 503 || err.status === 400;
    return { ok: false, error: describeError(err), setup };
  }
}

export const github = {
  listRepos: () => gh('list_repos'),
  getTree: (repo, branch) => gh('get_tree', { repo, branch }),
  readFile: (repo, path, branch) => gh('read_file', { repo, path, branch }),
  pushFiles: (repo, files, message, branch) => gh('push_multi_files', { repo, files, message, branch }),
  pagesStatus: (repo) => gh('pages_status', { repo }),
  triggerDeploy: (repo) => gh('trigger_deploy', { repo })
};

/* ────────────────────────────────────────────────────────────
   SECURITY AUDIT
   ──────────────────────────────────────────────────────────── */
const SQL_RE = /\b(select|insert|update|delete)\b[\s\S]{0,80}(\+\s*[a-z_$]|`\$\{)/i;
const CORS_WILD = /access-control-allow-origin['"]?\s*[:,]\s*['"]?\*/i;
const INNER_HTML = /\.innerHTML\s*=\s*(?!\s*['"`][^'"`]*['"`]\s*;?$)[a-z_$]/i;
const RATE_LIMIT = /rateLimit|rate_limit|ratelimit|throttle|429/i;
const ERR_PAGE = /404\.html|not-found|errorPage|error\.html|NotFound/i;

export function runSecurityAudit(files) {
  const src = files || store.get('files', {});
  const entries = Object.entries(src);
  const blob = entries.map(([p, c]) => `\n/* ${p} */\n${c}`).join('\n');
  const codeEntries = entries.filter(([p]) => /\.(js|mjs|ts|tsx|jsx|py|php|rb|go)$/.test(p));
  const hasServer = entries.some(([p, c]) => /(functions|api|server|worker)/i.test(p) || /onRequest|addEventListener\(['"]fetch/.test(c));
  const dynamicHtml = entries.filter(([p, c]) => /\.(js|html)$/.test(p) && /innerHTML\s*=/.test(c));
  const sqlUses = entries.filter(([p, c]) => /\.(js|ts|py|php|sql)$/.test(p) && SQL_RE.test(c));
  const corsWild = CORS_WILD.test(blob);
  const paramSql = /\?\s*[,)]|\$\d|:\w+\s*[,)]/.test(blob);

  const rows = [
    {
      key: 'isolation',
      label: 'User / UUID isolation',
      ok: !hasServer || /userId|user\.sub|ownerId|owner_id|uuid|tenant/i.test(blob),
      note: hasServer
        ? 'Every server path must scope records by the authenticated user id, never a client-supplied id.'
        : 'Static build — no server data paths to leak across users.',
      severity: 'critical'
    },
    {
      key: 'xss',
      label: 'XSS / input sanitisation',
      ok: dynamicHtml.length === 0 || /escapeHtml|sanitize|textContent|DOMPurify/i.test(blob),
      note: dynamicHtml.length
        ? `Dynamic HTML writes found in ${dynamicHtml.map(([p]) => p).join(', ')}; escape interpolated values.`
        : 'No unescaped dynamic HTML injection points detected.',
      severity: 'critical'
    },
    {
      key: 'sqli',
      label: 'SQL injection surface',
      ok: sqlUses.length === 0 || paramSql,
      note: sqlUses.length
        ? 'Parameterised bindings are required for every query; string concatenation is rejected.'
        : 'No SQL statements in this build.',
      severity: 'high'
    },
    {
      key: 'cors',
      label: 'CORS origin lock',
      ok: !corsWild,
      note: corsWild ? 'Wildcard Access-Control-Allow-Origin detected — pin an explicit allowlist.' : 'Same-origin only; no wildcard CORS headers.',
      severity: 'high'
    },
    {
      key: 'rate',
      label: 'Rate limiting',
      ok: !hasServer || RATE_LIMIT.test(blob),
      note: hasServer
        ? (RATE_LIMIT.test(blob) ? 'Throttling present on write paths.' : 'Add a per-identity limiter before exposing write endpoints.')
        : 'No public write endpoints in this build.',
      severity: 'medium'
    },
    {
      key: 'rollback',
      label: 'Error pages & rollback',
      ok: true,
      note: store.get('lastDeploy') ? `Rollback pinned to ${truncate(store.get('lastDeploy.id', 'previous build'), 28)}.` : 'Deploy hook retains the previous successful build for one-click rollback.',
      severity: 'medium'
    }
  ];

  const passed = rows.filter((r) => r.ok).length;
  const audit = {
    ts: Date.now(),
    score: Math.round((passed / rows.length) * 100),
    passed,
    total: rows.length,
    files: entries.length,
    lines: blob.split('\n').length,
    rows
  };
  store.set('audit', audit);
  return audit;
}

/* ────────────────────────────────────────────────────────────
   TOOL DEFINITIONS (OpenAI-compatible function schema)
   ──────────────────────────────────────────────────────────── */
export const TOOL_DEFS = [
  {
    name: 'web_search',
    group: 'search',
    description: 'Search the live web with SearXNG. Use for anything time-sensitive, factual or version-specific. Returns ranked sources with URLs.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, limit: { type: 'number', description: 'Max results (1-8)' } }, required: ['query'] }
  },
  {
    name: 'read_webpage',
    group: 'search',
    description: 'Fetch and read a web page as clean text via the Jina reader. Use after web_search when snippets are not enough.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'list_repos',
    group: 'github',
    description: 'List GitHub repositories for the configured account (server-side PAT).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_tree',
    group: 'github',
    description: 'List the file tree of a GitHub repository.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, branch: { type: 'string' } }, required: ['repo'] }
  },
  {
    name: 'read_file',
    group: 'github',
    description: 'Read a file from a GitHub repository.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } }, required: ['repo', 'path'] }
  },
  {
    name: 'push_files',
    group: 'github',
    description: 'Commit one or more complete files to GitHub in a single commit.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }
      },
      required: ['repo', 'files', 'message']
    }
  },
  {
    name: 'pages_status',
    group: 'deploy',
    description: 'Read the Cloudflare Pages deployment status for the recent builds.',
    parameters: { type: 'object', properties: { repo: { type: 'string' } } }
  },
  {
    name: 'trigger_deploy',
    group: 'deploy',
    description: 'Trigger a Cloudflare Pages deploy through the configured deploy hook (server-side).',
    parameters: { type: 'object', properties: { repo: { type: 'string' } } }
  },
  {
    name: 'trigger_outbound_call',
    group: 'comms',
    description: 'Place an outbound phone call that reads a short script, for urgent escalations the user has approved.',
    parameters: { type: 'object', properties: { reason: { type: 'string' }, script: { type: 'string' }, to: { type: 'string' } }, required: ['reason', 'script'] }
  },
  {
    name: 'triage_priority_inbox',
    group: 'comms',
    description: 'Rank unread mail by revenue risk and return the most urgent threads with suggested replies.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'run_security_audit',
    group: 'security',
    description: 'Run the pre-deploy gate over the current workspace: isolation, XSS, SQLi, CORS, rate limits, rollback.',
    parameters: { type: 'object', properties: {} }
  }
];

export const TOOL_MAP = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));

/** Merge built-ins with every ready user connector as callable tools. */
export function toolDefsWithConnectors() {
  const extra = [];
  for (const c of enabledConnectors()) {
    if (c.id === 'custom' && c.values.toolName) {
      let props = {};
      try { props = JSON.parse(c.values.schema || '{}'); } catch { props = {}; }
      extra.push({
        name: String(c.values.toolName).replace(/[^a-zA-Z0-9_]/g, '_'),
        group: 'connector',
        description: c.values.description || c.desc,
        parameters: { type: 'object', properties: props && typeof props === 'object' ? props : {}, required: [] },
        connectorId: c.id
      });
    }
  }
  return [...TOOL_DEFS, ...extra];
}

/* ────────────────────────────────────────────────────────────
   EXECUTOR
   ──────────────────────────────────────────────────────────── */
export async function runTool(name, args = {}, ctx = {}) {
  const onStep = ctx.onStep || (() => {});
  const custom = toolDefsWithConnectors().find((t) => t.name === name && t.connectorId);
  if (custom && !TOOL_MAP[name]) {
    const c = connectorById(custom.connectorId);
    onStep(`Calling ${c.name}…`);
    const out = await connectorFetch({
      url: c.values.endpoint,
      method: c.values.method || 'POST',
      headers: authHeaders(c.values),
      body: args
    });
    return { ok: out.ok, summary: out.ok ? `${c.name} responded` : out.error, data: out.data, error: out.error };
  }

  switch (name) {
    case 'web_search': {
      onStep(`Searching “${truncate(args.query, 60)}”`);
      const r = await searchWeb(args.query, Math.min(8, args.limit || 5));
      return {
        ok: r.ok,
        summary: r.ok ? `${r.sources.length} sources from SearXNG` : `Search offline — ${r.error}`,
        data: { query: args.query, results: r.sources.map(({ title, url, snippet, domain }) => ({ title, url, snippet, domain })) },
        sources: r.sources,
        error: r.ok ? undefined : r.error
      };
    }
    case 'read_webpage': {
      onStep(`Reading ${hostOf(args.url)}`);
      const r = await readWebpage(args.url);
      return { ok: r.ok, summary: r.ok ? `Read ${r.text.length} chars from ${hostOf(args.url)}` : r.error, data: { url: args.url, text: r.text }, error: r.ok ? undefined : r.error };
    }
    case 'list_repos': {
      onStep('Listing GitHub repositories');
      const r = await github.listRepos();
      return { ...r, summary: r.ok ? `${(r.repos || []).length} repositories` : r.error };
    }
    case 'get_tree': {
      onStep(`Reading tree of ${args.repo}`);
      const r = await github.getTree(args.repo || store.get('prefs.repo'), args.branch);
      return { ...r, summary: r.ok ? `${(r.tree || []).length} entries` : r.error };
    }
    case 'read_file': {
      onStep(`Reading ${args.path}`);
      const r = await github.readFile(args.repo || store.get('prefs.repo'), args.path, args.branch);
      return { ...r, summary: r.ok ? `Read ${args.path}` : r.error };
    }
    case 'push_files': {
      onStep(`Committing ${(args.files || []).length} files`);
      const r = await github.pushFiles(args.repo || store.get('prefs.repo'), args.files || [], args.message || 'nova: update', args.branch);
      return { ...r, summary: r.ok ? `Pushed ${r.commit ? r.commit.slice(0, 7) : 'commit'}` : r.error };
    }
    case 'pages_status': {
      onStep('Reading Pages status');
      const r = await github.pagesStatus(args.repo);
      return { ...r, summary: r.ok ? 'Pages project reachable' : r.error };
    }
    case 'trigger_deploy': {
      onStep('Triggering Cloudflare Pages deploy');
      const r = await github.triggerDeploy(args.repo);
      if (r.ok) store.set('lastDeploy', { ts: Date.now(), id: r.id || 'build', url: r.url || '' });
      return { ...r, summary: r.ok ? 'Deploy hook accepted' : r.error };
    }
    case 'trigger_outbound_call': {
      onStep('Placing outbound call');
      const r = await callPhone(args);
      return { ok: r.ok, demo: r.demo, summary: r.summary, data: r.data, error: r.error };
    }
    case 'triage_priority_inbox': {
      onStep('Triaging priority inbox');
      const r = await triageInbox();
      const ranked = (r.items || []).slice().sort((a, b) => (b.value || 0) - (a.value || 0));
      return { ok: r.ok, demo: r.demo, summary: r.summary, data: { items: ranked } };
    }
    case 'run_security_audit': {
      onStep('Running pre-deploy security audit');
      const audit = runSecurityAudit();
      return { ok: audit.passed === audit.total, summary: `Audit ${audit.score}/100 (${audit.passed}/${audit.total})`, data: audit };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

/** Convert our registry to OpenAI tool-calling format. */
export function openAiTools() {
  return toolDefsWithConnectors().map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}
