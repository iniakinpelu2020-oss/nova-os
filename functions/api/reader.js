/* ============================================================
   NOVA // OS — Reader bridge
   POST /api/reader { url }
   Fetches a URL and returns extracted readable text.
   ============================================================ */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost(context) {
  const { request } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const url = String(payload && payload.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return json({ error: 'url required' }, 400);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'nova-os-reader/1.0' } });
    if (!res.ok) return json({ error: `fetch ${res.status}` }, 502);
    const html = await res.text();
    // strip tags
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    text = text.slice(0, 12000);
    return json({ ok: true, url, text, length: text.length });
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
}