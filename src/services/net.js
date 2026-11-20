/* ============================================================
   NOVA // OS — network layer
   Same-origin bridge first, then direct, then the optional
   user-supplied CORS relay. Never throws raw CORS noise.
   ============================================================ */
import { store } from './store.js';

export class HttpError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const TIMEOUT = 20000;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function isSameOrigin(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('/')) return true;
  try { return new URL(url).origin === location.origin; } catch { return false; }
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function timedFetch(url, opts = {}) {
  const { signal, done } = withTimeout(opts.timeout || TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal });
  } finally {
    done();
  }
}

async function viaProxy(proxyUrl, target, opts = {}) {
  const payload = {
    url: target,
    method: (opts.method || 'GET').toUpperCase(),
    headers: opts.headers || {},
    body: opts.body ?? null
  };
  const res = await timedFetch(proxyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: opts.timeout || TIMEOUT
  });
  // a missing Pages Function returns 404/405/501 with an HTML page
  if (!res.ok) {
    const body = await readBody(res);
    const msg = body && typeof body === 'object' && body.error ? body.error : `Proxy ${res.status}`;
    throw new HttpError(msg, res.status, body);
  }
  return res;
}

/**
 * Fetch any URL with graceful transport fallback.
 * Returns a native Response whose body is the origin server's body.
 */
export async function smartFetch(url, opts = {}) {
  if (isSameOrigin(url)) return timedFetch(url, opts);

  const attempts = [() => viaProxy('/api/proxy', url, opts), () => timedFetch(url, opts)];
  const cors = store.get('prefs.corsProxy', '').trim();
  if (cors) attempts.push(() => viaProxy(cors, url, opts));

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new HttpError('Network unreachable');
}

export async function fetchJSON(url, opts = {}) {
  const res = await smartFetch(url, opts);
  const body = await readBody(res);
  if (!res.ok) {
    throw new HttpError(
      (body && typeof body === 'object' && (body.error || body.message)) || `Request failed (${res.status})`,
      res.status,
      body
    );
  }
  return body;
}

/** Same-origin API helper (Pages Functions). */
export async function api(path, { method = 'POST', body = null, timeout = 45000 } = {}) {
  const { signal, done } = withTimeout(timeout);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal
    });
    const data = await readBody(res);
    if (!res.ok) {
      const msg =
        (data && typeof data === 'object' && (data.error || data.message)) ||
        `Request failed (${res.status})`;
      throw new HttpError(msg, res.status, data);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError('Request timed out', 0, null);
    throw err;
  } finally {
    done();
  }
}

/** Public status probe: returns null instead of throwing. */
export async function apiSafe(path, opts) {
  try {
    return await api(path, opts);
  } catch {
    return null;
  }
}

export function describeError(err) {
  if (!err) return 'Unknown fault';
  if (err.name === 'AbortError') return 'Timed out';
  if (err instanceof HttpError) return err.message;
  if (err.message && /Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
    return 'Network blocked — add a CORS relay in Settings';
  }
  return err.message || 'Unknown fault';
}
