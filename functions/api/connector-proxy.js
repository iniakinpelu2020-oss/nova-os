/* ============================================================
   NOVA // OS — Connector proxy
   POST /api/connector-proxy { url, method, headers, body }

   Forwards authenticated REST / webhook calls from the Connectors
   Hub, inbox triage and outbound call triggers to third parties
   (Twilio, Vapi, Bland, ElevenLabs, Fish Audio, Notion, Telegram,
   Discord, Slack, n8n, Google Calendar, custom APIs) without
   browser CORS errors. Credentials are supplied per-request by the
   user's own connector config and are never logged.
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

const ALLOWED_HEADERS = new Set([
  'content-type', 'accept', 'authorization', 'xi-api-key', 'notion-version',
  'anthropic-version', 'x-api-key', 'x-goog-api-key', 'user-agent',
  'x-requested-with', 'cache-control'
]);

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1|.*\.local|.*\.internal|metadata\.google\.internal)/i;

function validateUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
  if (!['https:', 'http:'].includes(url.protocol)) throw Object.assign(new Error('Only http(s) endpoints are allowed'), { status: 400 });
  if (PRIVATE_HOST.test(url.hostname)) throw Object.assign(new Error('Private hosts are blocked'), { status: 400 });
  if (url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
    throw Object.assign(new Error('Private hosts are blocked'), { status: 400 });
  }
  return url;
}

function cleanHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).toLowerCase().trim();
    if (!ALLOWED_HEADERS.has(key)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    out[key] = String(v).slice(0, 2048);
  }
  return out;
}

function encodeBody(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return String(body); }
}

async function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function onRequestPost(context) {
  const { request } = context;

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  let url;
  try { url = validateUrl(payload.url); } catch (err) { return json({ error: err.message }, err.status || 400); }

  const method = String(payload.method || 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return json({ error: 'Unsupported method' }, 400);
  }

  const headers = cleanHeaders(payload.headers);
  if (payload.body != null && !headers['content-type']) headers['content-type'] = 'application/json';
  const rawBody = encodeBody(payload.body);
  if (rawBody && rawBody.length > 262144) return json({ error: 'Request body too large (256KB max)' }, 413);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'DELETE' ? undefined : rawBody,
      signal: controller.signal,
      redirect: 'follow'
    });

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return json({ error: 'Response too large (8MB max)' }, 413);

    if (/^(audio|image|video|application\/octet-stream|application\/pdf)/i.test(contentType)) {
      return json({
        ok: res.ok,
        status: res.status,
        contentType,
        base64: await toBase64(buf)
      });
    }

    const text = new TextDecoder().decode(buf);
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return json({ ok: res.ok, status: res.status, contentType, data });
  } catch (err) {
    if (err.name === 'AbortError') return json({ error: 'Connector timed out after 22s' }, 504);
    return json({ error: `Connector request failed: ${err.message}` }, 502);
  } finally {
    clearTimeout(timer);
  }
}
