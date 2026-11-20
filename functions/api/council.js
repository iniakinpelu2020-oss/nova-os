/* ============================================================
   NOVA // OS — Multi-Model Council
   POST /api/council          { messages, role, effort, model, tools }
   GET  /api/council?status=1 connection + key-pool status

   Role-based key pools live ONLY in Cloudflare Pages environment
   variables. Keys are never returned to the browser.
   ============================================================ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });

export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

/* ── catalog ── */
const MODELS = {
  vertex: {
    chat: 'gemini-3.5-flash',
    coding: 'gemini-2.5-pro',
    reasoning: 'gemini-2.5-pro',
    synth: 'gemini-2.5-pro',
    options: ['gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-2.5-flash']
  },
  groq: {
    chat: 'llama-3.3-70b-versatile',
    coding: 'openai/gpt-oss-120b',
    reasoning: 'openai/gpt-oss-120b',
    options: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile']
  },
  zai: {
    chat: 'GLM-4.7-Flash',
    coding: 'GLM-4.7-Flash',
    reasoning: 'GLM-4.7-Flash',
    options: ['GLM-4.7-Flash']
  },
  'workers-ai': {
    chat: '@cf/zhipuai/glm-4.7-flash',
    coding: '@cf/qwen/qwen3.8-27b',
    reasoning: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    options: [
      '@cf/zhipuai/glm-4.7-flash',
      '@cf/openai/gpt-oss-120b',
      '@cf/qwen/qwen3.8-27b',
      '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
    ]
  },
  venice: {
    chat: 'venice-uncensored',
    coding: 'venice-uncensored',
    reasoning: 'venice-uncensored',
    synth: 'venice-uncensored',
    options: ['venice-uncensored', 'dolphin-2.9.2-qwen2-72b']
  }
};

const ROLES = ['chat', 'coding', 'reasoning'];

const splitKeys = (raw) => {
  if (!raw || typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[,\s;]+/).map((k) => k.trim()).filter((k) => k.length > 3))];
};

function poolsFor(env, role) {
  env = env || {};
  const R = role.toUpperCase();
  const pick = (...names) => {
    for (const n of names) {
      const keys = splitKeys(env[n]);
      if (keys.length) return keys;
    }
    return [];
  };
  return {
    vertex: pick(`VERTEX_${R}_KEYS`, 'VERTEX_API_KEYS', 'VERTEX_KEY'),
    groq: pick(`GROQ_${R}_KEYS`, 'GROQ_API_KEYS', 'GROQ_API_KEY'),
    zai: pick(`ZAI_${R}_KEYS`, 'ZAI_API_KEYS', 'ZAI_API_KEY'),
    venice: splitKeys(env.VENICE_API_KEYS || env.VENICE_API_KEY)
  };
}

const hasAI = (env) => Boolean(env && env.AI && typeof env.AI.run === 'function');

function candidatesFor(env, role, effort = 'balanced') {
  const pools = poolsFor(env, role);
  const out = [];
  if (effort === 'uncensored') {
    if (pools.venice.length) {
      out.push({ provider: 'venice', label: 'Venice AI', keys: pools.venice, model: MODELS.venice[role] || MODELS.venice.chat });
    }
    return out;
  }
  if (role !== 'reasoning' && pools.groq.length) {
    out.push({ provider: 'groq', label: 'GroqCloud', keys: pools.groq, model: MODELS.groq[role] });
  }
  if (pools.vertex.length) {
    out.push({ provider: 'vertex', label: 'Vertex AI', keys: pools.vertex, model: MODELS.vertex[role] });
  }
  if (role !== 'reasoning' && pools.zai.length) {
    out.push({ provider: 'zai', label: 'Z.ai', keys: pools.zai, model: MODELS.zai[role] });
  }
  if (hasAI(env)) {
    out.push({ provider: 'workers-ai', label: 'Workers AI', keys: [null], model: MODELS['workers-ai'][role] });
  }
  return out;
}

/* ── normalisation ── */
function cleanMessages(input) {
  return (Array.isArray(input) ? input : [])
    .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) }));
}

function normaliseWorkers(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (result.result && typeof result.result.response === 'string') return result.result.response;
  if (Array.isArray(result.choices) && result.choices[0]) {
    const c = result.choices[0].message;
    if (c && typeof c.content === 'string') return c.content;
  }
  return '';
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.retryable = status === 429 || status === 401 || status === 403 || status >= 500;
  return err;
}

/* ── provider adapters ── */
async function callGroq(key, model, messages, opts) {
  const body = {
    model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw httpError(`GroqCloud ${res.status}`, res.status);
  const data = await res.json();
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function && tc.function.name,
    args: safeParse(tc.function && tc.function.arguments)
  })).filter((t) => t.name);
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls };
}

async function callZai(key, model, messages, opts) {
  const body = {
    model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw httpError(`Z.ai ${res.status}`, res.status);
  const data = await res.json();
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function && tc.function.name,
    args: safeParse(tc.function && tc.function.arguments)
  })).filter((t) => t.name);
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls };
}

async function callVenice(key, model, messages, opts) {
  const body = {
    model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    venice_parameters: { include_venice_system_prompt: false }
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw httpError(`Venice AI ${res.status}`, res.status);
  const data = await res.json();
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function && tc.function.name,
    args: safeParse(tc.function && tc.function.arguments)
  })).filter((t) => t.name);
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls };
}

function safeParse(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function toVertex(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n\n${m.content}`;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  return { system, contents };
}

function vertexToolSchema(params) {
  // Vertex rejects empty-property objects and some keywords; keep the useful subset.
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (['$schema', 'additionalProperties', 'default'].includes(k)) continue;
      out[k] = walk(v);
    }
    if (out.type === 'object' && (!out.properties || !Object.keys(out.properties).length)) {
      out.properties = { _: { type: 'string', description: 'unused' } };
    }
    return out;
  };
  return walk(params);
}

async function callVertex(key, model, messages, opts) {
  const { system, contents } = toVertex(messages);
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature,
      maxOutputTokens: opts.maxTokens
    }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (opts.tools && opts.tools.length) {
    body.tools = [{
      functionDeclarations: opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: vertexToolSchema(t.function.parameters)
      }))
    }];
  }
  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw httpError(`Vertex ${res.status}`, res.status);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  let text = '';
  const toolCalls = [];
  for (const p of parts) {
    if (typeof p.text === 'string') text += p.text;
    if (p.functionCall && p.functionCall.name) {
      toolCalls.push({
        id: p.functionCall.id || `call_${Math.random().toString(36).slice(2, 8)}`,
        name: p.functionCall.name,
        args: p.functionCall.args || {}
      });
    }
  }
  return { text, toolCalls };
}

async function callWorkersAI(env, model, messages, opts) {
  const result = await env.AI.run(model, {
    messages,
    max_tokens: Math.min(opts.maxTokens || 4096, 4096)
  });
  return { text: normaliseWorkers(result), toolCalls: [] };
}

/* ── rotation ── */
async function withRotation(candidate, messages, opts, env) {
  let lastErr = null;
  for (const key of candidate.keys) {
    const started = Date.now();
    try {
      let out;
      if (candidate.provider === 'groq') out = await callGroq(key, candidate.model, messages, opts);
      else if (candidate.provider === 'zai') out = await callZai(key, candidate.model, messages, opts);
      else if (candidate.provider === 'vertex') out = await callVertex(key, candidate.model, messages, opts);
      else if (candidate.provider === 'venice') out = await callVenice(key, candidate.model, messages, opts);
      else out = await callWorkersAI(env, candidate.model, messages, opts);

      if (!out.text && !(out.toolCalls && out.toolCalls.length)) {
        throw httpError(`${candidate.label} returned an empty response`, 502);
      }
      return {
        ok: true,
        provider: candidate.provider,
        label: candidate.label,
        model: candidate.model,
        text: out.text,
        toolCalls: out.toolCalls || [],
        ms: Date.now() - started
      };
    } catch (err) {
      lastErr = err;
      if (!err.retryable) break;
    }
  }
  return {
    ok: false,
    provider: candidate.provider,
    label: candidate.label,
    model: candidate.model,
    error: lastErr ? lastErr.message : 'No usable key',
    ms: 0
  };
}

function overrideModel(candidate, requested) {
  if (!requested || typeof requested !== 'string') return candidate;
  const req = requested.trim();
  if (!req) return candidate;
  if (req.startsWith('@cf/')) {
    return candidate.provider === 'workers-ai' ? { ...candidate, model: req } : candidate;
  }
  if (/gemini/i.test(req)) {
    return candidate.provider === 'vertex' ? { ...candidate, model: req } : candidate;
  }
  if (/glm/i.test(req)) {
    return candidate.provider === 'zai' ? { ...candidate, model: req } : candidate;
  }
  if (/venice|dolphin/i.test(req)) {
    return candidate.provider === 'venice' ? { ...candidate, model: req } : candidate;
  }
  return candidate.provider === 'groq' ? { ...candidate, model: req } : candidate;
}

/* ── effort strategies ── */
const SYNTH_SYSTEM = `You are the Lead Synthesizer of the NOVA council. Several models answered the same request independently. Merge them into one answer that is strictly better than any single draft: keep every correct specific, discard contradictions, and never invent facts that no draft supports. Reply in the same register as the user's request, in Markdown, with no preamble about being a synthesis.`;

async function synthesise(env, drafts, messages, opts, requested) {
  const ok = drafts.filter((d) => d.ok && d.text.trim());
  if (ok.length <= 1) return ok[0] || null;

  const transcript = ok.map((d, i) => `### DRAFT ${i + 1} — ${d.label} (${d.model})\n${d.text.slice(0, 6000)}`).join('\n\n');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const synthMessages = [
    { role: 'system', content: SYNTH_SYSTEM },
    { role: 'user', content: `User request:\n${(lastUser && lastUser.content) || 'Continue the conversation.'}\n\n${transcript}` }
  ];

  const pools = poolsFor(env, 'reasoning');
  const order = [];
  if (pools.vertex.length) order.push({ provider: 'vertex', label: 'Vertex AI', keys: pools.vertex, model: MODELS.vertex.synth });
  if (pools.groq.length) order.push({ provider: 'groq', label: 'GroqCloud', keys: pools.groq, model: MODELS.groq.coding });
  if (hasAI(env)) order.push({ provider: 'workers-ai', label: 'Workers AI', keys: [null], model: MODELS['workers-ai'].reasoning });

  for (const cand of order) {
    const out = await withRotation(overrideModel(cand, requested), synthMessages, { ...opts, tools: null, maxTokens: Math.min(opts.maxTokens, 4096) }, env);
    if (out.ok && out.text.trim()) {
      return { ...out, text: out.text.trim(), synthesised: true };
    }
  }
  return ok[0];
}

async function balancedVerify(env, primary, messages, opts) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const checkMessages = [
    { role: 'system', content: 'You verify answers for correctness. Reply with "OK" if the answer is accurate, complete and internally consistent. Otherwise reply with a terse list of concrete corrections, no preamble.' },
    { role: 'user', content: `REQUEST:\n${(lastUser && lastUser.content) || ''}\n\nANSWER:\n${primary.text.slice(0, 8000)}` }
  ];
  const cand = candidatesFor(env, 'reasoning')[0];
  if (!cand) return primary;
  const check = await withRotation(cand, checkMessages, { ...opts, tools: null, maxTokens: 500 }, env);
  if (!check.ok) return primary;
  const verdict = (check.text || '').trim();
  if (!verdict || /^ok\b/i.test(verdict)) return { ...primary, verified: true };

  const fixMessages = [
    ...messages,
    { role: 'assistant', content: primary.text },
    { role: 'user', content: `A verifier flagged these issues:\n${verdict.slice(0, 1200)}\n\nRewrite your answer so every issue is fixed. Return only the corrected answer.` }
  ];
  const fixed = await withRotation(cand, fixMessages, { ...opts, tools: null }, env);
  if (fixed.ok && fixed.text.trim()) {
    return { ...fixed, provider: fixed.provider, verified: true, verification: verdict, repaired: true };
  }
  return { ...primary, verified: true, verification: verdict };
}

/* ── handler ── */
export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const messages = cleanMessages(payload.messages);
  if (!messages.length) return json({ error: '`messages` must be a non-empty array' }, 400);

  const role = ROLES.includes(payload.role) ? payload.role : 'chat';
  const effort = ['efficient', 'balanced', 'powerful', 'uncensored'].includes(payload.effort) ? payload.effort : 'balanced';
  const opts = {
    temperature: typeof payload.temperature === 'number' ? Math.max(0, Math.min(1.4, payload.temperature)) : 0.65,
    maxTokens: Math.min(Math.max(Number(payload.max_tokens) || 4096, 256), 4096),
    tools: Array.isArray(payload.tools) && payload.tools.length ? payload.tools : null
  };

  const candidates = candidatesFor(env, role, effort).map((c) => overrideModel(c, payload.model));
  if (!candidates.length) {
    return json({
      error: 'No AI providers configured. Add GROQ_/VERTEX_/ZAI_ key pools in Cloudflare Pages environment variables, or deploy with the [ai] binding.',
      configured: false,
      role
    }, 503);
  }

  const started = Date.now();

  /* Efficient — first healthy provider only */
  if (effort === 'efficient') {
    for (const cand of candidates) {
      const out = await withRotation(cand, messages, opts, env);
      if (out.ok) {
        return json({ text: out.text, ...out, role, effort, totalMs: Date.now() - started, council: [out] });
      }
    }
    return json({ error: 'Every configured provider failed for this request.', role, effort }, 502);
  }

  /* Uncensored — Venice AI direct routing, no filters */
  if (effort === 'uncensored') {
    for (const cand of candidates) {
      const out = await withRotation(cand, messages, opts, env);
      if (out.ok) {
        return json({ text: out.text, ...out, role, effort, totalMs: Date.now() - started, council: [out], verified: false, synthesised: false });
      }
    }
    return json({ error: 'Venice AI is not configured. Add VENICE_API_KEYS in Cloudflare Pages environment variables.', configured: false, role, effort }, 503);
  }

  /* Balanced — primary answer + verifier pass */
  if (effort === 'balanced') {
    let primary = null;
    const drafts = [];
    for (const cand of candidates) {
      const out = await withRotation(cand, messages, opts, env);
      drafts.push(out);
      if (out.ok) { primary = out; break; }
    }
    if (!primary) return json({ error: 'Every configured provider failed for this request.', council: drafts, role, effort }, 502);
    if (opts.tools && primary.toolCalls.length) {
      return json({ text: primary.text || '', ...primary, role, effort, council: drafts, totalMs: Date.now() - started });
    }
    const verified = await balancedVerify(env, primary, messages, opts).catch(() => primary);
    return json({
      text: verified.text,
      provider: verified.provider,
      label: verified.label,
      model: verified.model,
      ms: verified.ms,
      role,
      effort,
      verified: Boolean(verified.verified),
      repaired: Boolean(verified.repaired),
      verification: verified.verification || null,
      council: drafts,
      totalMs: Date.now() - started
    });
  }

  /* Powerful — parallel council + synthesis */
  const settled = await Promise.allSettled(
    candidates.slice(0, 4).map((cand) => withRotation(cand, messages, opts, env))
  );
  const drafts = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { ok: false, provider: candidates[i].provider, label: candidates[i].label, model: candidates[i].model, error: String(s.reason && s.reason.message), ms: 0 }
  );
  const usable = drafts.filter((d) => d.ok);
  if (!usable.length) return json({ error: 'The council could not reach consensus — every provider failed.', council: drafts, role, effort }, 502);

  if (opts.tools && usable.some((d) => d.toolCalls && d.toolCalls.length)) {
    const lead = usable.find((d) => d.toolCalls.length) || usable[0];
    return json({ text: lead.text || '', ...lead, role, effort, council: drafts, totalMs: Date.now() - started });
  }

  const lead = await synthesise(env, drafts, messages, opts, payload.synthModel || payload.model);
  const final = lead || usable[0];
  return json({
    text: final.text,
    provider: final.provider,
    label: final.label,
    model: final.model,
    ms: final.ms,
    synthesised: Boolean(final.synthesised),
    role,
    effort,
    council: drafts.map(({ provider, label, model, text, ms, ok, error }) => ({
      provider, label, model, ms, ok, error: error || null,
      excerpt: typeof text === 'string' ? text.slice(0, 900) : ''
    })),
    totalMs: Date.now() - started
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const providers = {
    'workers-ai': { configured: hasAI(env), label: 'Cloudflare Workers AI', binding: 'AI' },
    vertex: { configured: poolsFor(env, 'chat').vertex.length + poolsFor(env, 'coding').vertex.length + poolsFor(env, 'reasoning').vertex.length > 0, label: 'Google Vertex Express' },
    groq: { configured: poolsFor(env, 'chat').groq.length + poolsFor(env, 'coding').groq.length + poolsFor(env, 'reasoning').groq.length > 0, label: 'GroqCloud' },
    zai: { configured: poolsFor(env, 'chat').zai.length + poolsFor(env, 'coding').zai.length > 0, label: 'Z.ai' },
    venice: { configured: splitKeys(env.VENICE_API_KEYS || env.VENICE_API_KEY).length > 0, label: 'Venice AI (Uncensored)' }
  };

  const roles = {};
  for (const role of ROLES) {
    const pools = poolsFor(env, role);
    const count = pools.vertex.length + pools.groq.length + pools.zai.length + (hasAI(env) ? 1 : 0) + (pools.venice.length ? 1 : 0);
    roles[role] = {
      configured: count > 0,
      keys: {
        vertex: pools.vertex.length,
        groq: pools.groq.length,
        zai: pools.zai.length,
        'workers-ai': hasAI(env) ? 1 : 0,
        venice: pools.venice.length
      },
      total: count,
      provider: (candidatesFor(env, role)[0] || {}).provider || null,
      model: (candidatesFor(env, role)[0] || {}).model || null
    };
  }

  const anyConfigured = Object.values(providers).some((p) => p.configured);

  return json({
    ok: true,
    configured: anyConfigured,
    providers,
    roles,
    models: MODELS,
    integrations: {
      github: Boolean(env && env.GITHUB_PAT),
      deployHook: Boolean(env && env.CF_DEPLOY_HOOK),
      githubUser: Boolean(env && env.GITHUB_USERNAME)
    },
    ts: Date.now()
  });
}
