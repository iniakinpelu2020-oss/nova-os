/* ============================================================
   NOVA // OS — Cloudflare Workers AI bridge
   POST /api/workers-ai   { messages, model, max_tokens }
   Uses the native env.AI binding declared in wrangler.toml.
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

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env || !env.AI) {
    return json({ error: 'Workers AI binding is not available. Deploy with wrangler.toml [ai] binding = "AI".' }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || !messages.length) return json({ error: '`messages` must be a non-empty array' }, 400);

  const model = String(payload.model || DEFAULT_MODEL);
  if (!model.startsWith(ALLOWED_PREFIX)) {
    return json({ error: 'Only Cloudflare Workers AI models (@cf/…) are accepted on this endpoint' }, 400);
  }

  const clean = messages
    .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
    .map((m) => ({ role: m.role, content: m.content.slice(0, 24000) }));
  if (!clean.length) return json({ error: 'No usable messages' }, 400);

  const started = Date.now();
  try {
    const result = await env.AI.run(model, {
      messages: clean,
      max_tokens: Math.min(Number(payload.max_tokens) || 4096, 4096)
    });
    const text = normalise(result);
    if (!text) return json({ error: 'Model returned an empty response', model }, 502);
    return json({ text, model, provider: 'workers-ai', ms: Date.now() - started });
  } catch (err) {
    return json({ error: `Workers AI failed: ${err && err.message ? err.message : 'unknown error'}`, model }, 502);
  }
}
