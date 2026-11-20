/* ============================================================
   NOVA // OS — Gmail bridge
   GET  /api/gmail?action=inbox&max=8
   GET  /api/gmail?action=message&id=...
   POST /api/gmail { action:'reply', id, body }
   Uses GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
   ============================================================ */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

async function token(env) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) throw new Error('Gmail not configured');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'token failed');
  return data.access_token;
}

function hdr(msg, name) {
  const h = (msg.payload && msg.payload.headers) || [];
  const found = h.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function bodyText(msg) {
  const parts = [];
  function walk(p) {
    if (!p) return;
    if (p.body && p.body.data) {
      try { parts.push(atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/'))); } catch {}
    }
    if (Array.isArray(p.parts)) p.parts.forEach(walk);
  }
  walk(msg.payload);
  return parts.join('\n').slice(0, 4000);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'inbox';
  try {
    const tok = await token(env);
    if (action === 'inbox') {
      const max = Math.min(Number(url.searchParams.get('max') || 8), 20);
      const q = url.searchParams.get('q') || 'is:unread in:inbox';
      const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json());
      const ids = (list.messages || []).map((m) => m.id);
      const msgs = await Promise.all(ids.map(async (id) => {
        const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json());
        return { id, threadId: m.threadId, from: hdr(m, 'From'), subject: hdr(m, 'Subject'), date: hdr(m, 'Date'), snippet: m.snippet || '', body: bodyText(m) };
      }));
      return json({ ok: true, configured: true, messages: msgs });
    }
    if (action === 'message') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);
      const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json());
      return json({ ok: true, message: { id, threadId: m.threadId, from: hdr(m, 'From'), subject: hdr(m, 'Subject'), date: hdr(m, 'Date'), snippet: m.snippet || '', body: bodyText(m) } });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return json({ ok: false, configured: Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN), error: err.message }, 503);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (payload.action !== 'reply') return json({ error: 'unknown action' }, 400);
  try {
    const tok = await token(env);
    const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${payload.id}?format=full`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json());
    const threadId = msg.threadId;
    const to = hdr(msg, 'From');
    const subject = hdr(msg, 'Subject');
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    const raw = btoa(unescape(encodeURIComponent(
      `To: ${to}\r\nSubject: ${replySubject}\r\nIn-Reply-To: ${hdr(msg, 'Message-ID')}\r\nReferences: ${hdr(msg, 'References')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${payload.body || ''}`
    ))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw, threadId })
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error.message || 'send failed');
    return json({ ok: true, id: res.id });
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
}