/* ============================================================
   NOVA // OS — local Cloudflare-Pages-compatible dev server
   Serves the static app AND executes functions/api/*.js with a
   Web Request/Response context, so /api/council?status=1,
   /api/proxy and friends behave like production.

   Usage:  node tools/dev-server.mjs   (PORT env optional)
   ============================================================ */
import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.toml': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const moduleCache = new Map();

async function loadFunction(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  const file = path.join(ROOT, 'functions', 'api', `${name}.js`);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    moduleCache.set(name, null);
    return null;
  }
  const mod = await import(pathToFileURL(file).href);
  moduleCache.set(name, mod);
  return mod;
}

function buildEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GROQ_|VERTEX_|ZAI_|GITHUB_|CF_|NOVA_)/.test(k)) env[k] = v;
  }
  return env;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ts: Date.now() });

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
    if (!/^[a-z0-9-]+$/i.test(name)) return sendJson(res, 400, { error: 'Invalid function name' });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type, authorization'
      });
      return res.end();
    }

    const mod = await loadFunction(name);
    if (!mod) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`No function at /api/${name}`);
    }

    const handler = req.method === 'GET' || req.method === 'HEAD' ? mod.onRequestGet : mod.onRequestPost;
    if (typeof handler !== 'function') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`Method ${req.method} not supported by /api/${name}`);
    }

    try {
      const raw = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: raw && raw.length ? raw : undefined
      });
      const response = await handler({ request, env: buildEnv(), params: {} });
      if (!(response instanceof Response)) throw new Error('handler did not return a Response');

      const buf = Buffer.from(await response.arrayBuffer());
      const outHeaders = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      outHeaders['content-length'] = String(buf.length);
      res.writeHead(response.status, outHeaders);
      res.end(buf);
      console.log(`${req.method} ${url.pathname}${url.search} → ${response.status} (${Date.now() - started}ms)`);
      return;
    } catch (err) {
      console.error(`[api/${name}]`, err);
      return sendJson(res, 500, { error: err.message || 'Function crashed' });
    }
  }

  // static
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }

  try {
    let target = filePath;
    const info = await stat(target).catch(() => null);
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><body style="background:#050508;color:#9BA6BC;font-family:monospace;padding:40px"><h1 style="color:#00F0FF">404</h1><p>${pathname} not found.</p><a style="color:#00F0FF" href="/">← console</a></body>`);
    }
    if (info.isDirectory()) target = path.join(target, 'index.html');
    const data = await readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NOVA // OS dev server → http://${HOST}:${PORT}`);
  console.log(`Static root: ${ROOT}`);
  console.log(`Functions:   /api/{council,workers-ai,github-proxy,connector-proxy,proxy}`);
});
