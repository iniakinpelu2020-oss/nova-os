/* ============================================================
   NOVA // OS — same-origin transport bridge
   POST /api/proxy { url, method, headers, body }
   GET  /api/proxy?url=…

   Lets the browser reach services that do not send CORS headers
   (SearXNG, the Jina reader, ICS feeds) through one origin.
   Public endpoints only — private address space is rejected.
   ============================================================ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', ...CORS };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

const ALLOWED_HEADERS = new Set([
  'content-type', 'accept', 'authorization', 'user-agent', 'x-api-key',
  'x-goog-api-key', 'xi-api-key', 'notion-version', 'cache-control'
]);

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1|.*\.local|.*\.internal|metadata\.google\.internal)/i;

function validate(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
  if (!['https:', 'http:'].includes(url.protocol)) throw Object.assign(new Error('Only http(s) URLs are allowed'), { status: 400 });
  if (PRIVATE_HOST.test(url.hostname)) throw Object.assign(new Error('Private hosts are blocked'), { status: 400 });
  return url;
}

function cleanHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).toLowerCase().trim();
    if (!ALLOWED_HEADERS.has(key)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    out[key] = String(v).slice(0, 1024);
  }
  return out;
}

async function forward({ url, method, headers, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: controller.signal,
      redirect: 'follow'
    });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 6 * 1024 * 1024) return json({ error: 'Response too large' }, 413);
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return new Response(buf, {
      status: res.status,
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
        ...CORS
      }
    });
  } catch (err) {
    if (err.name === 'AbortError') return json({ error: 'Upstream timed out' }, 504);
    return json({ error: `Upstream unreachable: ${err.message}` }, 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost(context) {
  let payload;
  try { payload = await context.request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  let url;
  try { url = validate(payload.url); } catch (err) { return json({ error: err.message }, err.status || 400); }

  const method = String(payload.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return json({ error: 'Unsupported method' }, 400);
  }

  const headers = cleanHeaders(payload.headers);
  let body;
  if (payload.body != null) {
    if (typeof payload.body === 'string') body = payload.body;
    else {
      body = JSON.stringify(payload.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    if (body.length > 262144) return json({ error: 'Request body too large' }, 413);
  }

  return forward({ url, method, headers, body });
}

export async function onRequestGet(context) {
  const target = new URL(context.request.url).searchParams.get('url');
  if (!target) return json({ error: 'Pass ?url=https://…' }, 400);
  let url;
  try { url = validate(target); } catch (err) { return json({ error: err.message }, err.status || 400); }
  return forward({ url, method: 'GET', headers: { accept: 'application/json,text/plain,*/*' }, body: null });
}
