/* ============================================================
   NOVA // OS — Cloudflare Workers AI bridge
   POST /api/workers-ai   { messages, model, max_tokens }
   Uses the native env.AI binding declared in wrangler.toml.
   Falls back to a Groq key pool (GROQ_CHAT_KEYS) when the
   binding is unavailable or returns 429/402.
   No key ever reaches the browser.
   ============================================================ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });

export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

const DEFAULT_MODEL = '@cf/zhipuai/glm-4.7-flash';
const ALLOWED_PREFIX = '@cf/';
const FALLBACK_MODEL = '@cf/openai/gpt-oss-120b';

function normalise(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (result.result && typeof result.result.response === 'string') return result.result.response;
  if (Array.isArray(result.choices) && result.choices[0]) {
    const msg = result.choices[0].message || {};
    if (typeof msg.content === 'string') return msg.content;
  }
  if (Array.isArray(result) && typeof result[0] === 'string') return result.join('');
  return '';
}

function splitKeys(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[,\\s;]+/).map((k) => k.trim()).filter((k) => k.length > 3))];
}

async function groqFallback(keys, messages, maxTokens) {
  let lastErr = null;
  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: Math.min(maxTokens || 4096, 4096), temperature: 0.65 })
      });
      if (!res.ok) {
        const err = new Error(`Groq ${res.status}`);
        err.status = res.status;
        err.retryable = res.status === 429 || res.status === 402 || res.status >= 500;
        throw err;
      }
      const data = await res.json();
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) return { ok: true, text, model: 'llama-3.3-70b-versatile', provider: 'groq' };
      throw new Error('empty');
    } catch (err) {
      lastErr = err;
      if (!err.retryable) break;
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'No usable Groq key' };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || !messages.length) return json({ error: '`messages` must be a non-empty array' }, 400);

  const model = String(payload.model || DEFAULT_MODEL);
  const clean = messages
    .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
    .map((m) => ({ role: m.role, content: m.content.slice(0, 24000) }));
  if (!clean.length) return json({ error: 'No usable messages' }, 400);

  const maxTokens = Math.min(Number(payload.max_tokens) || 4096, 4096);
  const started = Date.now();

  // If a Workers AI model was requested and the binding exists, use it.
  if (model.startsWith(ALLOWED_PREFIX) && env && env.AI) {
    // Fallback model handling: try requested, then gpt-oss-120b
    const modelsToTry = model === FALLBACK_MODEL ? [FALLBACK_MODEL] : [model, FALLBACK_MODEL];
    for (const m of modelsToTry) {
      try {
        const result = await env.AI.run(m, { messages: clean, max_tokens: maxTokens });
        const text = normalise(result);
        if (text) return json({ text, model: m, provider: 'workers-ai', ms: Date.now() - started });
      } catch (err) {
        // rotate to fallback model / groq
        if (m === FALLBACK_MODEL) break;
      }
    }
  }

  // Key-pool fallback (Groq)
  const groqKeys = splitKeys(env && (env.GROQ_CHAT_KEYS || env.GROQ_API_KEYS || env.GROQ_API_KEY));
  if (groqKeys.length) {
    const out = await groqFallback(groqKeys, clean, maxTokens);
    if (out.ok) return json({ text: out.text, model: out.model, provider: out.provider, ms: Date.now() - started });
  }

  if (!env || !env.AI) {
    return json({ error: 'Workers AI binding is not available and no GROQ_CHAT_KEYS configured.' }, 503);
  }
  return json({ error: 'Workers AI failed to produce a response' }, 502);
}