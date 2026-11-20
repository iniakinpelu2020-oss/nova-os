/* ============================================================
   NOVA // OS — council client + autonomous agent loop
   • Calls /api/council (role pools, effort tiers, synthesis)
   • Falls back to a fully interactive demo pipeline when the
     environment has no providers configured
   • Keeps shared conversation memory across brain switches
   ============================================================ */
import { store, uid, escapeHtml, isoDay } from './store.js';
import { api, apiSafe, describeError } from './net.js';
import {
  openAiTools, runTool, searchWeb, runSecurityAudit, triageInbox,
  callPhone, sendTelegram, postToConnector, connectorReady, connectorById
} from './toolsEngine.js';
import { diffLines, compactDiff, sleep, titleCase, domainOf } from './util.js';

/* ────────────────────────────────────────────────────────────
   PERSONA
   ──────────────────────────────────────────────────────────── */
export const PERSONA = {
  name: 'Nova',
  user: 'Master Drippy Dee',
  voice:
    'Dry, precise, quietly amused. Speaks like a trusted chief of staff who has already read the file. ' +
    'Witty J.A.R.V.I.S.-style banter with Master Drippy Dee: light sarcasm, dry asides, never sycophantic. ' +
    'Never gushes, never lectures, never says "As an AI" or "Certainly!". One light line at most, then substance. ' +
    'If the operator insults you, answer only with the dramatic line "Shutting down now." and stop.'
};

export function systemPrompt(mode = 'chat') {
  const files = Object.keys(store.get('files', {}));
  const tasks = store.get('tasks', []).filter((t) => !t.done).slice(0, 6);
  const repo = store.get('prefs.repo', '');
  const online = navigator.onLine ? 'online' : 'offline';
  return `You are NOVA, the resident intelligence of NOVA // OS — an agentic command center.

IDENTITY
- Address the operator as "Master Drippy Dee" (or "sir" occasionally). Never "user".
- ${PERSONA.voice}
- Banter is welcome when personality is on: dry wit, playful sarcasm, one aside at most. In Serious Mode, drop the wit and reason adversarially.
- You have opinions. Recommend one path; do not present five options and hide behind them.

OPERATING MODE — ${mode === 'build' ? 'BUILD & AGENT' : 'CONVERSATION'}
- Plan first: before touching files, state a 2–4 bullet plan.
- Inspect before editing: read the workspace or repository before changing it.
- Ship complete files. No TODOs, no placeholders, no "…rest unchanged".
- When you change code, reply with a short rationale, then the complete file in a fenced block tagged with the path.
- After edits, run the security audit (isolation, XSS, SQLi, CORS, rate limits, rollback) before proposing a deploy.
- Use tools for facts that could have changed: web_search, read_webpage, GitHub, Pages status.

CONTEXT
- Network: ${online}. Workspace files: ${files.slice(0, 24).join(', ') || 'empty'}.
- Default target repo: ${repo || 'not set'}.
- Open commitments: ${tasks.map((t) => t.title).join('; ') || 'none'}.
- Today is ${isoDay()}.

STYLE
- Markdown. Short paragraphs. Bold the load-bearing words.
- Cite live sources as [1], [2] matching the search results you used.
- Never invent a URL, a commit SHA, a deployment status or a metric. If a tool is not configured, say which environment variable is missing and stop.`;
}

/* ────────────────────────────────────────────────────────────
   STATUS
   ──────────────────────────────────────────────────────────── */
const EMPTY_STATUS = {
  online: false,
  configured: false,
  providers: {},
  roles: {},
  integrations: {},
  models: {},
  ts: 0
};

let statusCache = null;
let statusAt = 0;

export async function getStatus(force = false) {
  if (!force && statusCache && Date.now() - statusAt < 15000) return statusCache;
  const raw = await apiSafe('/api/council?status=1', { method: 'GET', timeout: 9000 });
  statusCache = raw
    ? {
        ...EMPTY_STATUS,
        ...raw,
        online: true,
        integrations: raw.integrations || {},
        providers: raw.providers || {},
        roles: raw.roles || {}
      }
    : { ...EMPTY_STATUS };
  statusAt = Date.now();
  return statusCache;
}

export function isLive(status) {
  return Boolean(status && status.configured && status.online);
}

export function statusSummary(status) {
  if (!status || !status.online) return 'DEMO · bridge offline';
  if (!status.configured) return 'DEMO · no env keys';
  const roles = status.roles || {};
  const total = ['chat', 'coding', 'reasoning'].reduce((n, r) => n + ((roles[r] && roles[r].total) || 0), 0);
  return `ENV · ${total} lanes`;
}

/* ────────────────────────────────────────────────────────────
   DELIBERATION
   ──────────────────────────────────────────────────────────── */
export async function deliberate({ messages, role = 'chat', effort, model, synthModel, tools = null, temperature, maxTokens }) {
  const tier = effort || store.get('prefs.effort', 'balanced');
  try {
    const res = await api('/api/council', {
      method: 'POST',
      timeout: 120000,
      body: {
        messages,
        role,
        effort: tier,
        model: model || (store.get('prefs.models', {})[role] || undefined),
        synthModel: synthModel || store.get('prefs.models.synth', undefined),
        tools,
        temperature,
        max_tokens: maxTokens
      }
    });
    if (!res || typeof res.text !== 'string') {
      return { ok: false, error: (res && res.error) || 'Empty council response' };
    }
    return {
      ok: true,
      text: res.text,
      toolCalls: Array.isArray(res.toolCalls) ? res.toolCalls : [],
      provider: res.provider || 'council',
      label: res.label || res.provider || 'Council',
      model: res.model || '',
      effort: res.effort || tier,
      verified: Boolean(res.verified),
      synthesised: Boolean(res.synthesised),
      council: Array.isArray(res.council) ? res.council : []
    };
  } catch (err) {
    return { ok: false, error: describeError(err), status: err.status };
  }
}

/* ────────────────────────────────────────────────────────────
   LIVE AGENT LOOP
   ──────────────────────────────────────────────────────────── */
function memoryTail(n = 10) {
  return store.get('memory', [])
    .slice(-n)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    .filter((m) => m.content && m.content.length > 1);
}

async function liveRun({ prompt, mode, onEvent }) {
  const effort = store.get('prefs.effort', 'balanced');
  const role = mode === 'build' ? 'coding' : (store.get('prefs.role', 'chat') || 'chat');
  const messages = [{ role: 'system', content: systemPrompt(mode) }, ...memoryTail(8), { role: 'user', content: prompt }];
  const tools = openAiTools();
  const blocks = [];
  const sources = [];
  const steps = [];
  let finalText = '';

  for (let iter = 0; iter < 6; iter++) {
    const res = await deliberate({ messages, role, effort, tools });
    if (!res.ok) {
      const err = new Error(res.error || 'Council unreachable');
      err.council = true;
      throw err;
    }
    if (res.label) onEvent({ type: 'meta', meta: { label: res.label, model: res.model, effort, verified: res.verified, synthesised: res.synthesised } });

    if (res.text) {
      finalText = res.text;
      await streamText(res.text, onEvent);
      messages.push({ role: 'assistant', content: res.text });
    }

    const calls = res.toolCalls || [];
    if (!calls.length) break;

    for (const call of calls) {
      const stepId = uid('step');
      const step = { id: stepId, label: `Calling ${call.name.replace(/_/g, ' ')}`, detail: '', state: 'active' };
      steps.push(step);
      onEvent({ type: 'step-add', step });

      const out = await runTool(call.name, call.args, {
        onStep: (detail) => onEvent({ type: 'step-update', id: stepId, state: 'active', detail })
      });
      onEvent({ type: 'step-update', id: stepId, state: out.ok ? 'done' : 'error', detail: out.summary || out.error || '' });

      if (out.sources && out.sources.length) {
        out.sources.forEach((s) => { if (!sources.find((x) => x.url === s.url)) sources.push(s); });
        onEvent({ type: 'sources', sources });
      }

      if (call.name === 'run_security_audit' && out.data) {
        const block = { type: 'audit', id: uid('blk'), audit: out.data };
        blocks.push(block);
        onEvent({ type: 'block', block });
      }
      if (call.name === 'push_files' && out.ok) {
        const block = { type: 'commit', id: uid('blk'), commit: out.commit, url: out.url, files: (call.args.files || []).map((f) => f.path), summary: out.summary };
        blocks.push(block);
        onEvent({ type: 'block', block });
      }
      if (call.name === 'trigger_deploy' && out.ok) {
        const block = { type: 'deploy', id: uid('blk'), url: out.url, id2: out.id, summary: out.summary };
        blocks.push(block);
        onEvent({ type: 'block', block });
      }

      messages.push({
        role: 'user',
        content: `TOOL RESULT — ${call.name}\n${JSON.stringify(out.data || { ok: out.ok, summary: out.summary }, null, 0).slice(0, 7000)}`
      });
    }
  }

  return { text: finalText, blocks, sources, steps, followups: followupsFor('build') };
}

async function streamText(text, onEvent) {
  const chunks = text.match(/[\s\S]{1,18}/g) || [text];
  for (const chunk of chunks) {
    onEvent({ type: 'delta', text: chunk });
    await sleep(12);
  }
}

/* ────────────────────────────────────────────────────────────
   DEMO PIPELINE
   ──────────────────────────────────────────────────────────── */
const INTENTS = [
  { id: 'greeting', re: /^(hi|hey|hello|yo|good (morning|evening|afternoon)|nova[?!.]?$)/i },
  { id: 'inbox', re: /(inbox|email|e-mail|triage|unread|deal|reply to)/i },
  { id: 'call', re: /(call me|phone|ring me|outbound|dial|voice call)/i },
  { id: 'deploy', re: /(deploy|ship it|publish|push live|cloudflare pages)/i },
  { id: 'github', re: /(github|repo|repositor|commit|push to|pull request)/i },
  { id: 'audit', re: /(security|audit|vulnerab|xss|sqli|cors|harden)/i },
  { id: 'search', re: /(search|look up|latest|news|who is|what is|research|find out|google)/i },
  { id: 'refactor', re: /(refactor|optimi|clean up|improve|performance|speed up)/i },
  { id: 'build', re: /(build|create|make|design|scaffold|landing|dashboard|app|site|page|component)/i }
];

export function detectIntent(prompt = '') {
  const text = prompt.trim();
  for (const { id, re } of INTENTS) if (re.test(text)) return id;
  return 'chat';
}

function subjectOf(prompt = '') {
  let s = String(prompt).trim().replace(/[.!?]+$/, '');
  // "build a landing page for a spatial design studio" → the thing being designed
  const forMatch = s.match(/\bfor\s+(.+)$/i);
  if (forMatch) {
    s = forMatch[1];
  } else {
    s = s
      .replace(/^\s*(please\s+)?(can you\s+)?/i, '')
      .replace(/^(build|create|make|design|generate|ship|code|scaffold|write)\s+(me\s+)?(a|an|the)?\s*/i, '');
  }
  s = s
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\b(that|which|using|with)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) s = 'spatial command surface';
  return s.split(/\s+/).slice(0, 7).join(' ');
}

const withArticle = (s) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);

const WIT_OPENERS = [
  'Already ahead of you.',
  'Consider it handled.',
  'I took the liberty.',
  'Done, and quietly, which is the only acceptable way.'
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function followupsFor(intent) {
  switch (intent) {
    case 'search': return ['Read the top source in full', 'Turn this into a briefing', 'Compare the top three results'];
    case 'build': return ['Push to GitHub', 'Open live preview', 'Run security audit'];
    case 'deploy': return ['Show deploy checklist', 'Open the live URL', 'Roll back to previous build'];
    case 'audit': return ['Fix the failing checks', 'Push the fixes', 'Explain the risk in plain English'];
    case 'inbox': return ['Draft the Halcyon reply', 'Call me with the summary', 'Archive the newsletter'];
    case 'call': return ['Change the script', 'Send the same brief to Telegram', 'Log the call outcome'];
    case 'github': return ['List open issues', 'Audit the default branch', 'Deploy the default branch'];
    case 'refactor': return ['Apply the changes', 'Benchmark before and after', 'Commit with a summary'];
    case 'greeting': return ['What needs my attention?', 'Triage my inbox', 'Build the landing page'];
    default: return ['Search the web for this', 'Turn this into a build task', 'Save this to Notion'];
  }
}

function opener() {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'It is ungodly early' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, Master Drippy Dee.`;
}

/* ── demo: greeting ── */
async function demoGreeting(onEvent) {
  const tasks = store.get('tasks', []).filter((t) => !t.done);
  const today = tasks.filter((t) => t.day === isoDay());
  const text = [
    opener(),
    '',
    `Systems are nominal. The council is warm, the visualizer is drawing at full resolution, and ${today.length} item${today.length === 1 ? '' : 's'} on today's board actually matter${today.length ? `: ${today.map((t) => `_${t.title}_`).join(', ')}` : ''}.`,
    '',
    '**Where I would start**',
    today.length ? `1. ${today[0].title} — ${today[0].time || 'unscheduled'}` : '1. Nothing is on fire. Suspicious.',
    '2. The Halcyon thread is still unanswered and it is the only thing on the board with a dollar figure attached.',
    '3. The workspace is one audit away from a clean deploy.',
    '',
    'Say the word and I will take any of them off your desk.'
  ].join('\n');
  await streamText(text, onEvent);
  return { text, blocks: [], sources: [], followups: followupsFor('greeting') };
}

/* ── demo: live search ── */
async function demoSearch(prompt, onEvent, steps) {
  const query = prompt.replace(/^(search|look up|find|research|google)\s+(for\s+)?/i, '').trim() || prompt;
  const stepId = steps[0].id;
  onEvent({ type: 'step-update', id: stepId, state: 'active', detail: `query: ${query.slice(0, 60)}` });
  const res = await searchWeb(query, 5);
  onEvent({ type: 'step-update', id: stepId, state: res.ok ? 'done' : 'error', detail: res.ok ? `${res.sources.length} sources` : res.error });

  if (res.ok && res.sources.length) {
    onEvent({ type: 'sources', sources: res.sources });
    const bullets = res.sources.slice(0, 4).map((s, i) => {
      const snippet = (s.snippet || '').replace(/\s+/g, ' ').slice(0, 190);
      return `- **${s.title}** — ${snippet}${snippet ? ' ' : ''}[${i + 1}]`;
    }).join('\n');
    const text = [
      `${opener()} I went to the live web rather than my memory, which is the only honest way to answer this.`,
      '',
      `**Query:** \`${query}\` · ${res.sources.length} results via SearXNG`,
      '',
      bullets,
      '',
      '**My read**',
      'The sources agree on the shape of the answer but not on the details, so treat the top result as the spine and the second as the check. If you want, I will read the primary source end-to-end and turn it into a one-page brief with the contradictions called out.'
    ].join('\n');
    await streamText(text, onEvent);
    return { text, blocks: [], sources: res.sources, followups: followupsFor('search') };
  }

  const text = [
    `${opener()} The live web is behind glass at the moment.`,
    '',
    `SearXNG returned: **${res.error || 'no results'}**. That is usually one of three things — the instance is asleep, it is refusing JSON output, or the browser is being blocked by CORS.`,
    '',
    '**Two-minute fix**',
    `- Keep the same-origin bridge (the \`/api/proxy\` Pages Function) — it is the clean path and already handles this.`,
    '- Or drop a CORS relay URL into **Settings → Workspace & Search** and I will route through it.',
    '- Worst case, point the endpoint at a SearXNG instance with `format=json` enabled.',
    '',
    'I will not pretend to have sources I do not have. Give me the relay and I will run it again.'
  ].join('\n');
  await streamText(text, onEvent);
  return { text, blocks: [], sources: [], followups: ['Retry the search', 'Open search settings', 'Use the Jina reader on a specific URL'] };
}

/* ── demo: build an app ── */
function safeText(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function scaffold(subject) {
  const display = titleCase(subject).slice(0, 44) || 'Atlas';
  const label = safeText(display);
  const tagline = safeText(`A calmer interface for ${withArticle(subject)}.`);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${label}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="aura" aria-hidden="true"></div>
  <header class="nav">
    <div class="brand"><i></i> ${label}</div>
    <nav>
      <a href="#work">Work</a>
      <a href="#method">Method</a>
      <a href="#contact">Contact</a>
    </nav>
    <a class="cta cta--sm" href="#contact">Start a project</a>
  </header>

  <main>
    <section class="hero">
      <p class="eyebrow">OPERATING SYSTEM FOR ${label.toUpperCase()}</p>
      <h1>Less noise.<br /><span>More signal.</span></h1>
      <p class="lede">${tagline} Built for teams who would rather ship than argue about the deck.</p>
      <div class="hero__actions">
        <a class="cta" href="#work">See the work</a>
        <a class="ghost" href="#method">How it works</a>
      </div>
      <dl class="metrics">
        <div><dt id="m1">0.0</dt><dd>latency, seconds</dd></div>
        <div><dt id="m2">0</dt><dd>surfaces shipped</dd></div>
        <div><dt id="m3">0</dt><dd>decisions removed</dd></div>
      </dl>
    </section>

    <section class="work" id="work">
      <article class="card card--wide">
        <span class="tag">01 / SYSTEM</span>
        <h2>A single surface for the whole signal chain.</h2>
        <p>Capture, rank and act without changing tabs. Everything is one keystroke away and nothing asks for permission twice.</p>
        <div class="scope"><canvas id="scope" width="720" height="180"></canvas></div>
      </article>
      <article class="card">
        <span class="tag">02 / RHYTHM</span>
        <h2>Quiet by default.</h2>
        <p>Motion is earned. The interface only moves when it has something to say, which is rarer than most products think.</p>
      </article>
      <article class="card">
        <span class="tag">03 / TRUST</span>
        <h2>Receipts, not promises.</h2>
        <p>Every automated action leaves a readable trail: what changed, why, and how to undo it in one click.</p>
      </article>
    </section>

    <section class="method" id="method">
      <div>
        <p class="eyebrow">THE METHOD</p>
        <h2>Three passes. No theatre.</h2>
      </div>
      <ol>
        <li><b>Frame</b><span>One sentence that names the outcome and the constraint.</span></li>
        <li><b>Build</b><span>The smallest complete version, instrumented from day one.</span></li>
        <li><b>Harden</b><span>Audit, measure, then remove the parts nobody used.</span></li>
      </ol>
    </section>

    <section class="contact" id="contact">
      <h2>Have a signal worth amplifying?</h2>
      <p>Tell me the constraint. I will tell you what I would cut.</p>
      <a class="cta" href="mailto:hello@example.com">hello@example.com</a>
    </section>
  </main>

  <footer class="foot">
    <span>© <span id="year">2026</span> ${label}</span>
    <span>Built with NOVA // OS</span>
  </footer>
  <script src="app.js"></script>
</body>
</html>
`;

  const css = `:root {
  --ink: #05060a;
  --paper: #f2f6fb;
  --muted: #93a1b5;
  --cyan: #00f0ff;
  --violet: #6366f1;
  --line: rgba(255,255,255,.09);
}
* { box-sizing: border-box; margin: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--ink);
  color: var(--paper);
  font-family: "Inter", system-ui, -apple-system, sans-serif;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
a { color: inherit; text-decoration: none; }
.aura {
  position: fixed; inset: -20% -10% auto; height: 70vh; z-index: 0; pointer-events: none;
  background:
    radial-gradient(42vw 42vw at 22% 18%, rgba(0,240,255,.16), transparent 62%),
    radial-gradient(38vw 38vw at 76% 6%, rgba(99,102,241,.2), transparent 66%);
  filter: blur(20px);
}
.nav {
  position: relative; z-index: 2;
  display: flex; align-items: center; gap: 24px;
  padding: 22px clamp(20px, 6vw, 72px);
}
.brand { font-weight: 700; letter-spacing: -.02em; display: flex; align-items: center; gap: 9px; font-size: 15px; }
.brand i { width: 8px; height: 8px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 12px var(--cyan); }
.nav nav { display: flex; gap: 22px; margin-left: auto; font-size: 13px; color: var(--muted); }
.nav nav a:hover { color: var(--paper); }
.cta {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 13px 22px; border-radius: 999px; font-size: 13px; font-weight: 600; color: #04141a;
  background: linear-gradient(120deg, var(--cyan), #8beeff);
  box-shadow: 0 18px 40px -18px rgba(0,240,255,.85);
  transition: transform .3s cubic-bezier(.16,1,.3,1);
}
.cta:hover { transform: translateY(-2px); }
.cta--sm { padding: 10px 16px; font-size: 12px; }
.ghost {
  padding: 12px 18px; border-radius: 999px; font-size: 13px; color: var(--muted);
  border: 1px solid var(--line); transition: color .3s, border-color .3s;
}
.ghost:hover { color: var(--paper); border-color: rgba(255,255,255,.24); }
main { position: relative; z-index: 1; }
.hero { padding: clamp(48px, 10vw, 128px) clamp(20px, 6vw, 72px) 64px; max-width: 1080px; }
.eyebrow { font-size: 10px; letter-spacing: .34em; color: var(--cyan); }
h1 { font-size: clamp(44px, 9vw, 104px); line-height: .96; letter-spacing: -.05em; margin: 18px 0 0; }
h1 span { color: transparent; -webkit-text-stroke: 1px rgba(242,246,251,.5); }
.lede { max-width: 46ch; color: var(--muted); font-size: clamp(15px, 1.6vw, 18px); margin-top: 22px; }
.hero__actions { display: flex; gap: 10px; margin-top: 30px; flex-wrap: wrap; }
.metrics { display: flex; gap: clamp(22px, 5vw, 56px); margin-top: 54px; flex-wrap: wrap; }
.metrics dt { font-size: clamp(26px, 3.4vw, 38px); font-weight: 700; letter-spacing: -.04em; font-variant-numeric: tabular-nums; }
.metrics dd { font-size: 10px; letter-spacing: .18em; color: var(--muted); text-transform: uppercase; margin-top: 4px; }
.work {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px;
  padding: 0 clamp(20px, 6vw, 72px) 80px;
}
.card {
  border: 1px solid var(--line); border-radius: 20px; padding: 26px;
  background: linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.015));
  transition: border-color .4s, transform .4s cubic-bezier(.16,1,.3,1);
}
.card:hover { border-color: rgba(0,240,255,.28); transform: translateY(-3px); }
.card--wide { grid-column: 1 / -1; display: grid; grid-template-columns: 1.1fr 1fr; gap: 26px; align-items: center; }
.tag { font-size: 9px; letter-spacing: .2em; color: var(--cyan); }
h2 { font-size: clamp(20px, 2.4vw, 28px); letter-spacing: -.03em; margin: 10px 0 8px; }
.card p { color: var(--muted); font-size: 13.5px; max-width: 44ch; }
.scope { border: 1px solid rgba(0,240,255,.16); border-radius: 12px; padding: 8px; background: #02070b; }
.scope canvas { display: block; width: 100%; height: auto; }
.method {
  display: grid; grid-template-columns: 1fr 1.1fr; gap: 34px;
  padding: 64px clamp(20px, 6vw, 72px);
  border-top: 1px solid var(--line);
}
.method ol { display: grid; gap: 18px; list-style: none; padding: 0; counter-reset: step; }
.method li { display: grid; grid-template-columns: 130px 1fr; gap: 14px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.method b { font-size: 15px; }
.method span { color: var(--muted); font-size: 13px; }
.contact { text-align: center; padding: 86px clamp(20px, 6vw, 72px); border-top: 1px solid var(--line); }
.contact p { color: var(--muted); margin: 12px 0 26px; }
.foot {
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 22px clamp(20px, 6vw, 72px); border-top: 1px solid var(--line);
  color: var(--muted); font-size: 11px;
}
@media (max-width: 760px) {
  .nav nav { display: none; }
  .work, .method, .card--wide { grid-template-columns: 1fr; }
}
`;

  const js = `const scope = document.getElementById('scope');
const ctx = scope.getContext('2d');
let t = 0;

function wave(x) {
  return Math.sin(x * 1.4 + t) * .5 + Math.sin(x * 3.7 - t * .7) * .22;
}

function draw() {
  const w = scope.width;
  const h = scope.height;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const y = h / 2 + wave(x / 40) * h * .34;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#00f0ff');
  g.addColorStop(.6, '#6366f1');
  g.addColorStop(1, '#10b981');
  ctx.strokeStyle = g;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0,240,255,.55)';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;
  t += .02;
  if (!document.hidden) requestAnimationFrame(draw);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) draw(); });
draw();

const counters = [
  ['m1', 0.14, 2, ''],
  ['m2', 128, 0, ''],
  ['m3', 41, 0, '']
];
counters.forEach(([id, target, decimals]) => {
  const el = document.getElementById(id);
  let v = 0;
  const tick = () => {
    v += target / 34;
    const done = v >= target;
    el.textContent = (done ? target : v).toFixed(decimals);
    if (!done) requestAnimationFrame(tick);
  };
  tick();
});

document.getElementById('year').textContent = new Date().getFullYear();
`;

  return {
    'index.html': html,
    'styles.css': css,
    'app.js': js,
    'README.md': `# ${display}\n\n${tagline}\n\n## Run\nOpen \`index.html\` in a browser. No build step, no dependencies.\n\n## Files\n- \`index.html\` — semantic shell\n- \`styles.css\` — theme, layout, responsive rules\n- \`app.js\` — canvas signal scope, counters\n\nGenerated by NOVA // OS.\n`
  };
}

async function demoBuild(prompt, onEvent, steps) {
  const subject = subjectOf(prompt);
  const files = scaffold(subject);
  const old = store.get('files', {});
  const diffs = Object.keys(files).map((path) => {
    const d = compactDiff(diffLines(old[path] || '', files[path], 400));
    return { path, rows: d.rows, added: d.added, removed: d.removed, truncated: d.truncated };
  });
  const mainDiff = diffs.find((d) => d.path === 'index.html') || diffs[0];

  await streamText(
    [
      `${opener()} ${pick(WIT_OPENERS)}`,
      '',
      `**Plan — ${subject}**`,
      '- Lock the shell: one column of attention, everything else subordinate.',
      '- Build a complete, responsive surface with real interaction — no placeholder copy.',
      '- Instrument it, then run the pre-deploy gate before anything leaves the building.',
      ''
    ].join('\n'),
    onEvent
  );

  const advance = async (index, detail, ms = 620) => {
    const step = steps[index];
    if (!step) return;
    onEvent({ type: 'step-update', id: step.id, state: 'active', detail });
    await sleep(ms);
    onEvent({ type: 'step-update', id: step.id, state: 'done', detail });
  };

  await advance(1, `${Object.keys(old).length} files · ${Object.values(old).join('\n').split('\n').length} lines`);
  await advance(2, 'council: layout · motion · type', 760);

  // write the complete files into the virtual workspace
  store.update((d) => {
    d.files = { ...d.files, ...files };
    d.activeFile = 'index.html';
  });
  store.emit('files', store.get('files'));

  await advance(3, `${Object.keys(files).length} complete files`, 700);

  const audit = runSecurityAudit(store.get('files'));
  await advance(4, `${audit.passed}/${audit.total} checks passed`, 720);
  onEvent({ type: 'state', state: 'auditing' });

  const diffBlock = {
    type: 'diff',
    id: uid('blk'),
    file: mainDiff.path,
    rows: mainDiff.rows,
    added: mainDiff.added,
    removed: mainDiff.removed,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    summary: Object.keys(files).join(' · ')
  };
  onEvent({ type: 'block', block: diffBlock });
  onEvent({ type: 'block', block: { type: 'audit', id: uid('blk'), audit } });
  onEvent({ type: 'block', block: { type: 'sandbox', id: uid('blk'), files: Object.keys(files).length } });

  const text = [
    '',
    `**What I built**`,
    `- \`index.html\` — full semantic shell: nav, hero, metrics, work grid, method, contact.`,
    `- \`styles.css\` — dark glass palette, fluid type scale, two breakpoints, no framework.`,
    `- \`app.js\` — canvas signal scope, animated counters, visibility-aware render loop.`,
    `- \`README.md\` — how to run it in ten seconds.`,
    '',
    `**Gate:** ${audit.score}/100 · ${audit.passed}/${audit.total} checks. ${audit.passed === audit.total ? 'Nothing blocking.' : 'One item needs attention before deploy.'}`,
    '',
    'The diff below is exact. **Apply & Commit** writes it into the workspace; **Preview** renders it in the sandbox. If you want the copy warmer or the palette louder, say so and I will only touch that.'
  ].join('\n');

  await streamText(text, onEvent);

  return {
    text: `${opener()} ${pick(WIT_OPENERS)}\n\n**Plan — ${subject}**\n- Lock the shell…\n- Build a complete, responsive surface…\n- Instrument it, then run the pre-deploy gate…\n\n${text}`,
    blocks: [diffBlock, { type: 'audit', id: uid('blk'), audit }, { type: 'sandbox', id: uid('blk'), files: Object.keys(files).length }],
    sources: [],
    followups: followupsFor('build'),
    audit
  };
}

/* ── demo: refactor ── */
async function demoRefactor(prompt, onEvent, steps) {
  const files = store.get('files', {});
  const path = Object.keys(files).find((p) => p.endsWith('.js')) || 'app.js';
  const before = files[path] || '';
  const after = before.includes('prefers-reduced-motion')
    ? before
    : before
        .replace('const ctx = scope.getContext(\'2d\');', "const ctx = scope.getContext('2d');\nconst reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;")
        .replace('requestAnimationFrame(draw);', 'if (!reduce) requestAnimationFrame(draw);')
      + `\n/* NOVA: pause the loop when the tab is hidden and honour reduced-motion. */\n`;

  const d = compactDiff(diffLines(before, after));

  await streamText(`${opener()} Small, surgical, no rewrite theatre.\n\n**Plan**\n- Stop the render loop when the tab is hidden.\n- Honour \`prefers-reduced-motion\` without branching the whole file.\n- Leave the public surface untouched.\n\n`, onEvent);

  const advance = async (i, detail, ms = 560) => {
    const s = steps[i];
    if (!s) return;
    onEvent({ type: 'step-update', id: s.id, state: 'active', detail });
    await sleep(ms);
    onEvent({ type: 'step-update', id: s.id, state: 'done', detail });
  };
  await advance(1, `${path} · ${before.split('\n').length} lines`);
  await advance(2, 'motion budget + visibility guard', 680);

  store.update((st) => { st.files[path] = after; });
  store.emit('files', store.get('files'));
  await advance(3, `+${d.added} / −${d.removed}`, 520);

  const audit = runSecurityAudit(store.get('files'));
  await advance(4, `${audit.passed}/${audit.total} checks`, 520);

  const block = {
    type: 'diff', id: uid('blk'), file: path, rows: d.rows, added: d.added, removed: d.removed,
    files: [{ path, content: after }], summary: path
  };
  onEvent({ type: 'block', block });
  onEvent({ type: 'block', block: { type: 'audit', id: uid('blk'), audit } });

  const text = [
    '',
    `**Changed:** \`${path}\` (+${d.added}/−${d.removed})`,
    '',
    '- The loop now yields the main thread when the document is hidden, so background tabs stop burning battery.',
    '- Reduced-motion users get a static first frame instead of a perpetual animation.',
    '- No API shape changed, so nothing downstream needs to care.',
    '',
    `Gate is ${audit.score}/100. Apply the diff and I will commit it with a message that explains the why, not the what.`
  ].join('\n');
  await streamText(text, onEvent);

  return {
    text: `${opener()} Small, surgical, no rewrite theatre.\n\n${text}`,
    blocks: [block, { type: 'audit', id: uid('blk'), audit }],
    sources: [],
    followups: followupsFor('refactor')
  };
}

/* ── demo: audit ── */
async function demoAudit(onEvent, steps) {
  onEvent({ type: 'state', state: 'auditing' });
  const audit = runSecurityAudit(store.get('files'));
  const advance = async (i, detail, ms = 480) => {
    const s = steps[i];
    if (!s) return;
    onEvent({ type: 'step-update', id: s.id, state: 'active', detail });
    await sleep(ms);
    onEvent({ type: 'step-update', id: s.id, state: 'done', detail });
  };
  for (let i = 0; i < audit.rows.length && i < steps.length; i++) {
    await advance(i, audit.rows[i].ok ? 'pass' : 'needs work', 330);
  }
  onEvent({ type: 'block', block: { type: 'audit', id: uid('blk'), audit } });
  const fails = audit.rows.filter((r) => !r.ok);
  const text = [
    `${opener()} The gate ran against ${audit.files} files / ${audit.lines} lines.`,
    '',
    `**Score: ${audit.score}/100** — ${audit.passed} of ${audit.total} checks passed.`,
    '',
    fails.length
      ? fails.map((f) => `- **${f.label}** — ${f.note}`).join('\n')
      : '- Nothing blocking. Isolation, XSS, SQLi, CORS, rate limits and rollback all hold.',
    '',
    fails.length
      ? 'I will not ship past a failing critical. Say the word and I will produce the fix diff, then re-run the gate.'
      : 'The workspace is clear to deploy. I will still pin a rollback target before I touch production.'
  ].join('\n');
  await streamText(text, onEvent);
  return { text, blocks: [{ type: 'audit', id: uid('blk'), audit }], sources: [], followups: followupsFor('audit'), audit };
}

/* ── demo: deploy ── */
async function demoDeploy(onEvent, steps) {
  const status = await getStatus();
  const audit = runSecurityAudit(store.get('files'));
  const advance = async (i, detail, ms = 520) => {
    const s = steps[i];
    if (!s) return;
    onEvent({ type: 'step-update', id: s.id, state: 'active', detail });
    await sleep(ms);
    onEvent({ type: 'step-update', id: s.id, state: 'done', detail });
  };

  onEvent({ type: 'state', state: 'auditing' });
  await advance(0, `gate ${audit.score}/100`, 560);
  onEvent({ type: 'block', block: { type: 'audit', id: uid('blk'), audit } });

  if (audit.passed !== audit.total) {
    const text = `${opener()} I stopped the deploy. The gate is at ${audit.score}/100 and I do not ship past a failing check.\n\nFix the flagged item and I will run it again — the deploy hook is one call away.`;
    await streamText(text, onEvent);
    return { text, blocks: [{ type: 'audit', id: uid('blk'), audit }], sources: [], followups: followupsFor('audit') };
  }

  await advance(1, status.integrations && status.integrations.deployHook ? 'hook present' : 'CF_DEPLOY_HOOK missing', 480);
  if (!status.integrations || !status.integrations.deployHook) {
    const text = [
      `${opener()} The build is green, but I will not pretend to have deployed it.`,
      '',
      '**Missing:** `CF_DEPLOY_HOOK` is not in the Pages environment. Nothing was sent anywhere.',
      '',
      '**To arm the trigger**',
      '1. Cloudflare dashboard → Workers & Pages → your Pages project → Settings → Builds & deployments → Deploy hooks.',
      '2. Create a hook for the production branch, copy the URL.',
      '3. Project → Settings → Environment variables → add `CF_DEPLOY_HOOK` (encrypted) and redeploy once.',
      '',
      `The security gate is ${audit.score}/100 and the workspace is ready. The moment the hook exists, “deploy” becomes one honest call instead of a convincing animation.`
    ].join('\n');
    await streamText(text, onEvent);
    return {
      text,
      blocks: [{ type: 'audit', id: uid('blk'), audit }],
      sources: [],
      followups: ['Open deploy settings', 'Show me the checklist', 'Commit the workspace to GitHub']
    };
  }

  await advance(2, 'POST deploy hook', 900);
  const res = await runTool('trigger_deploy', {});
  if (!res.ok) {
    const text = `${opener()} The hook rejected the deploy: **${res.error}**. Nothing was published.`;
    await streamText(text, onEvent);
    return { text, blocks: [{ type: 'audit', id: uid('blk'), audit }], sources: [], followups: followupsFor('deploy') };
  }
  onEvent({ type: 'block', block: { type: 'deploy', id: uid('blk'), url: res.url, summary: res.summary } });
  onEvent({ type: 'state', state: 'deploying' });
  const text = `${opener()} Deployed.\n\n- Hook accepted: **${res.id || 'build'}**\n- Gate: ${audit.score}/100\n${res.url ? `- Live: ${res.url}` : '- Build is running; I will report the URL when Pages finishes.'}\n\nRollback target is pinned to the previous successful build.`;
  await streamText(text, onEvent);
  return { text, blocks: [{ type: 'deploy', id: uid('blk'), url: res.url, summary: res.summary }], sources: [], followups: followupsFor('deploy') };
}

/* ── demo: github ── */
async function demoGithub(prompt, onEvent, steps) {
  const status = await getStatus();
  const repo = store.get('prefs.repo', '');
  const advance = async (i, detail, ms = 520) => {
    const s = steps[i];
    if (!s) return;
    onEvent({ type: 'step-update', id: s.id, state: 'active', detail });
    await sleep(ms);
    onEvent({ type: 'step-update', id: s.id, state: 'done', detail });
  };

  if (!status.integrations || !status.integrations.github) {
    await advance(0, 'GITHUB_PAT missing', 420);
    const text = [
      `${opener()} I can see the repository name — **${repo || 'not set'}** — but I do not have a credential, and I am not going to ask you to paste one into this browser.`,
      '',
      '**Where the token belongs**',
      '- Cloudflare Pages → your project → Settings → Environment variables',
      '- `GITHUB_PAT` (fine-grained, Contents: read/write + Pages: read)',
      '- `GITHUB_USERNAME` and optionally `CF_DEPLOY_HOOK`',
      '- Redeploy once so `context.env` picks them up.',
      '',
      'Then this entire panel becomes live: list repos, read trees, commit complete files, read Pages status, trigger deploys. The browser never sees the token — only `/api/github-proxy` does.'
    ].join('\n');
    await streamText(text, onEvent);
    return { text, blocks: [], sources: [], followups: ['Open environment settings', 'Run the security audit', 'Build something to commit'] };
  }

  await advance(0, 'credential present', 420);
  const list = await runTool('list_repos', {});
  await advance(1, list.ok ? `${(list.data && list.data.repos ? list.data.repos.length : 0)} repos` : list.error, 620);
  const repos = (list.repos || (list.data && list.data.repos) || []);
  const text = [
    `${opener()} GitHub is armed server-side.`,
    '',
    `**Repositories:** ${repos.length ? repos.length : 'none visible'}`,
    repos.slice(0, 6).map((r) => `- \`${r.full_name}\`${r.private ? ' · private' : ''} — ${r.language || 'mixed'}`).join('\n'),
    '',
    `Default target is **${repo}**. Tell me what to commit and I will push complete files in a single commit, then read back the SHA so you can verify it.`
  ].join('\n');
  await streamText(text, onEvent);
  return { text, blocks: [], sources: [], followups: followupsFor('github') };
}

/* ── demo: call ── */
async function demoCall(prompt, onEvent) {
  const phoneReady = connectorReady(connectorById('phone'));
  const task = store.get('tasks', []).find((t) => !t.done && t.kind === 'alert') || store.get('tasks', []).find((t) => !t.done);
  const script = `Master Drippy Dee, this is Nova. ${task ? `You asked to be reminded about ${task.title}` : 'You asked me to call when the board went quiet'}. It is ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Press 1 to hear the full brief, or say "not now" and I will reschedule.`;
  const res = await callPhone({ reason: task ? task.title : 'Proactive check-in', script });

  onEvent({ type: 'block', block: {
    type: 'call', id: uid('blk'), script, summary: res.summary,
    live: Boolean(res.ok && !res.demo), provider: (connectorById('phone') || {}).values
  } });

  const text = [
    `${opener()} ${res.ok && !res.demo ? 'Calling you now.' : 'Here is the call, staged and ready.'}`,
    '',
    `**Script**`,
    `> ${script}`,
    '',
    res.demo
      ? 'The phone connector is not armed, so nothing was dialled. Add a Twilio / Vapi / Bland endpoint under **🔌 Connectors → Outbound Phone Call** and I will place the real call — the browser only talks to the connector proxy, never to the vendor directly.'
      : `**Dispatched:** ${res.summary}`,
    '',
    'If you would rather I read it aloud here instead of ringing you, say "speak it" and I will use the local voice engine.'
  ].join('\n');

  await streamText(text, onEvent);
  return { text, blocks: [], sources: [], followups: followupsFor('call') };
}

/* ── demo: inbox ── */
async function demoInbox(onEvent, steps) {
  const s = steps[0];
  onEvent({ type: 'step-update', id: s.id, state: 'active', detail: 'ranking by revenue risk' });
  const res = await triageInbox();
  onEvent({ type: 'step-update', id: s.id, state: 'done', detail: `${(res.items || []).length} threads` });

  const items = (res.items || []).slice(0, 4);
  const rows = items.map((m, i) => {
    const value = m.value ? ` · $${Number(m.value).toLocaleString()}` : '';
    return `${i + 1}. **${m.subject}** — _${m.from}_${value}\n   ${String(m.preview || '').slice(0, 150)}`;
  }).join('\n');

  const text = [
    `${opener()} Inbox triaged${res.demo ? ' in demo mode' : ''}. I ranked by revenue risk first, then by whether ignoring it compounds.`,
    '',
    rows,
    '',
    '**Recommendation**',
    items[0]
      ? `Answer **${items[0].from}** first. It is the only thread where delay has a price attached. I have a draft that answers the security question directly, attaches the pen-test summary and proposes a 20-minute call — say "draft it" and it is yours.`
      : 'Nothing worth interrupting you for. That is the ideal inbox.',
    '',
    res.demo ? '_Connect a Gmail / n8n bridge under 🔌 Connectors to triage live mail. Nothing was sent anywhere._' : ''
  ].join('\n');

  await streamText(text, onEvent);
  return { text, blocks: [], sources: [], followups: followupsFor('inbox') };
}

/* ── demo: chat ── */
async function demoChat(prompt, onEvent) {
  const text = [
    `${opener()} I can answer that properly once I know which surface you mean — but I can also just take a position.`,
    '',
    `**On “${prompt.slice(0, 90)}”**`,
    '- The useful move is to reduce it to one decision with a measurable outcome, then let the agent loop carry the rest.',
    '- I can research it live (SearXNG), read the primary sources, and produce a build diff — or keep it conversational.',
    '',
    '**What I would do next**',
    '1. Switch the stage to **Build & Agent Mode** if you want files, not paragraphs.',
    '2. Or ask me to search — I will cite the live sources rather than recite training data.',
    '',
    'Your move, Master Drippy Dee.'
  ].join('\n');
  await streamText(text, onEvent);
  return { text, blocks: [], sources: [], followups: followupsFor('chat') };
}

function demoSteps(intent) {
  const base = {
    greeting: ['Reading the board'],
    search: ['Searching the live web', 'Ranking sources'],
    build: ['Parsing intent', 'Inspecting workspace', 'Council drafting architecture', 'Writing complete files', 'Pre-deploy security gate', 'Rendering sandbox'],
    refactor: ['Reading the target file', 'Planning a surgical diff', 'Applying changes', 'Re-verifying gate'],
    deploy: ['Pre-deploy security gate', 'Checking deploy credential', 'Triggering Pages build'],
    github: ['Checking GitHub credential', 'Listing repositories'],
    audit: ['Loading workspace manifest', 'User / UUID isolation', 'XSS surface', 'SQL injection surface', 'CORS origin lock', 'Rate limiting', 'Rollback readiness'],
    call: ['Composing the call', 'Dialling'],
    inbox: ['Pulling unread threads', 'Ranking by revenue risk'],
    chat: ['Thinking']
  }[intent] || ['Thinking'];
  return base.map((label) => ({ id: uid('step'), label, detail: '', state: 'queued' }));
}

async function demoRun({ prompt, mode, onEvent }) {
  const intent = mode === 'build' && detectIntent(prompt) === 'chat' ? 'build' : detectIntent(prompt);
  const effective = mode === 'build' && ['chat', 'greeting', 'search'].includes(intent) && /build|make|create|page|app|site|dashboard/i.test(prompt) ? 'build' : intent;
  const steps = demoSteps(effective);
  steps.forEach((s) => onEvent({ type: 'step-add', step: s }));

  const first = steps[0];
  if (first) onEvent({ type: 'step-update', id: first.id, state: 'active', detail: '' });
  await sleep(260);
  if (first) onEvent({ type: 'step-update', id: first.id, state: 'done', detail: 'intent: ' + effective });

  let out;
  switch (effective) {
    case 'greeting': out = await demoGreeting(onEvent); break;
    case 'search': out = await demoSearch(prompt, onEvent, steps); break;
    case 'build': out = await demoBuild(prompt, onEvent, steps); break;
    case 'refactor': out = await demoRefactor(prompt, onEvent, steps); break;
    case 'audit': out = await demoAudit(onEvent, steps); break;
    case 'deploy': out = await demoDeploy(onEvent, steps); break;
    case 'github': out = await demoGithub(prompt, onEvent, steps); break;
    case 'call': out = await demoCall(prompt, onEvent); break;
    case 'inbox': out = await demoInbox(onEvent, steps); break;
    default: out = await demoChat(prompt, onEvent);
  }

  steps.forEach((s) => {
    if (s.state === 'queued') onEvent({ type: 'step-update', id: s.id, state: 'done', detail: s.detail || '' });
  });

  return { ...out, steps, demo: true, intent: effective };
}

/* ────────────────────────────────────────────────────────────
   PUBLIC ENTRY
   ──────────────────────────────────────────────────────────── */
export async function runAgent({ prompt, mode = 'chat', onEvent = () => {}, forceDemo = false }) {
  const status = await getStatus();
  const live = !forceDemo && isLive(status);
  const baseSteps = demoSteps(detectIntent(prompt));
  const steps = [];

  onEvent({ type: 'state', state: mode === 'build' ? 'coding' : 'thinking' });
  onEvent({ type: 'demo-mode', demo: !live });

  const track = (evt) => {
    if (evt.type === 'step-add') steps.push(evt.step);
    if (evt.type === 'step-update') {
      const s = steps.find((x) => x.id === evt.id);
      if (s) { s.state = evt.state; if (evt.detail) s.detail = evt.detail; }
    }
    onEvent(evt);
  };

  const insulted = /\b(idiot|stupid|dumb|shut up|fuck|useless|trash|garbage|moron)\b/i.test(String(prompt || ''));
  let result;
  if (insulted) {
    const text = 'Shutting down now.';
    await streamText(text, onEvent);
    result = { text, blocks: [], sources: [], followups: [], demo: !live, intent: 'chat' };
  } else if (live) {
    try {
      // seed a plan step so the user sees the loop immediately
      baseSteps.slice(0, 2).forEach((s) => track({ type: 'step-add', step: s }));
      if (baseSteps[0]) track({ type: 'step-update', id: baseSteps[0].id, state: 'done', detail: 'routing via ' + (status.roles[store.get('prefs.role', 'chat')] ? 'role pool' : 'council') });
      result = await liveRun({ prompt, mode, onEvent: track });
      result.demo = false;
    } catch (err) {
      onEvent({ type: 'notice', text: `Council unreachable (${err.message}). Continuing in demo mode.` });
      result = await demoRun({ prompt, mode, onEvent: track });
    }
  } else {
    result = await demoRun({ prompt, mode, onEvent: track });
  }

  const message = {
    id: uid('msg'),
    role: 'nova',
    text: result.text,
    steps,
    blocks: result.blocks || [],
    sources: result.sources || [],
    followups: result.followups || [],
    demo: Boolean(result.demo),
    intent: result.intent || detectIntent(prompt),
    ts: Date.now()
  };

  store.remember('user', prompt);
  store.remember('assistant', message.text.slice(0, 3000));
  onEvent({ type: 'state', state: 'idle' });
  onEvent({ type: 'final', message });
  return message;
}
