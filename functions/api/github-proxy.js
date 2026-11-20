/* ============================================================
   NOVA // OS — GitHub + Cloudflare deploy proxy
   POST /api/github-proxy  { action, ... }
   GITHUB_PAT / GITHUB_USERNAME / CF_DEPLOY_HOOK live only in
   Cloudflare Pages environment variables.
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

export const onRequestGet = async (context) => {
  const env = (context && context.env) || {};
  return json({
    ok: true,
    configured: Boolean(env.GITHUB_PAT),
    username: env.GITHUB_USERNAME || 'iniakinpelu2020-oss',
    deployHook: Boolean(env.CF_DEPLOY_HOOK)
  });
};

const GH = 'https://api.github.com';

function ghHeaders(pat) {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'nova-os',
    'content-type': 'application/json'
  };
}

async function gh(pat, path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: ghHeaders(pat),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.message) || `GitHub ${res.status}`;
    const err = new Error(msg);
    err.status = res.status === 401 || res.status === 403 ? 401 : res.status;
    throw err;
  }
  return data;
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const b64decode = (b64) => {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

function validRepo(repo) {
  return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
}

function sanitisePath(p) {
  const path = String(p || '').replace(/^\/+/, '').trim();
  if (!path || path.includes('..') || path.length > 400) throw Object.assign(new Error('Invalid file path'), { status: 400 });
  return path;
}

async function resolveRepo(pat, repo) {
  const full = validRepo(repo) ? repo.trim() : null;
  if (!full) throw Object.assign(new Error('Expected repo as "owner/name"'), { status: 400 });
  return full;
}

async function defaultBranch(pat, repo) {
  const info = await gh(pat, `/repos/${repo}`);
  return info.default_branch || 'main';
}

async function pushMulti(pat, { repo, files, message, branch }) {
  if (!Array.isArray(files) || !files.length) throw Object.assign(new Error('No files supplied'), { status: 400 });
  if (files.length > 40) throw Object.assign(new Error('At most 40 files per commit'), { status: 400 });
  const target = validRepo(branch) ? branch : (branch || (await defaultBranch(pat, repo)));

  let baseCommitSha = null;
  let baseTreeSha = null;
  try {
    const ref = await gh(pat, `/repos/${repo}/git/ref/heads/${encodeURIComponent(target)}`);
    baseCommitSha = ref.object.sha;
    const commit = await gh(pat, `/repos/${repo}/git/commits/${baseCommitSha}`);
    baseTreeSha = commit.tree.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    // branch does not exist yet — create it from the default branch
    const fallback = await defaultBranch(pat, repo);
    const ref = await gh(pat, `/repos/${repo}/git/ref/heads/${encodeURIComponent(fallback)}`);
    baseCommitSha = ref.object.sha;
    const commit = await gh(pat, `/repos/${repo}/git/commits/${baseCommitSha}`);
    baseTreeSha = commit.tree.sha;
  }

  const tree = [];
  for (const f of files) {
    if (!f || typeof f.content !== 'string') continue;
    const path = sanitisePath(f.path);
    const blob = await gh(pat, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: b64encode(f.content), encoding: 'base64' }
    });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  if (!tree.length) throw Object.assign(new Error('No valid files supplied'), { status: 400 });

  const newTree = await gh(pat, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree }
  });
  const commit = await gh(pat, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: {
      message: String(message || 'nova: update workspace').slice(0, 240),
      tree: newTree.sha,
      parents: [baseCommitSha]
    }
  });
  await gh(pat, `/repos/${repo}/git/refs/heads/${encodeURIComponent(target)}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false }
  });
  return {
    commit: commit.sha,
    branch: target,
    files: tree.length,
    url: `https://github.com/${repo}/commit/${commit.sha}`
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const pat = env && env.GITHUB_PAT;
  if (!pat) {
    return json({
      error: 'GITHUB_PAT is not set. Add it under Cloudflare Pages → Settings → Environment variables.',
      setup: true
    }, 501);
  }

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const action = payload.action;

  try {
    switch (action) {
      case 'list_repos': {
        const repos = await gh(pat, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
        return json({
          repos: (repos || []).map((r) => ({
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            default_branch: r.default_branch,
            updated_at: r.updated_at,
            language: r.language
          }))
        });
      }
      case 'get_tree': {
        const repo = await resolveRepo(pat, payload.repo || (env.GITHUB_USERNAME ? `${env.GITHUB_USERNAME}/${payload.name}` : ''));
        const branch = payload.branch || (await defaultBranch(pat, repo));
        const data = await gh(pat, `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        return json({
          repo,
          branch,
          truncated: Boolean(data.truncated),
          tree: (data.tree || [])
            .filter((n) => n.type === 'blob')
            .slice(0, 400)
            .map((n) => ({ path: n.path, size: n.size, sha: n.sha }))
        });
      }
      case 'read_file': {
        const repo = await resolveRepo(pat, payload.repo);
        const path = sanitisePath(payload.path);
        const data = await gh(pat, `/repos/${repo}/contents/${encodeURI(path)}${payload.branch ? `?ref=${encodeURIComponent(payload.branch)}` : ''}`);
        if (Array.isArray(data)) return json({ error: 'Path is a directory', entries: data.map((d) => d.name) }, 400);
        return json({
          repo,
          path,
          sha: data.sha,
          size: data.size,
          content: data.content ? b64decode(data.content) : ''
        });
      }
      case 'push_file': {
        const repo = await resolveRepo(pat, payload.repo);
        if (typeof payload.content !== 'string') return json({ error: '`content` required' }, 400);
        const out = await pushMulti(pat, { repo, files: [{ path: payload.path, content: payload.content }], message: payload.message, branch: payload.branch });
        return json(out);
      }
      case 'push_multi_files': {
        const repo = await resolveRepo(pat, payload.repo);
        const out = await pushMulti(pat, { repo, files: payload.files, message: payload.message, branch: payload.branch });
        return json(out);
      }
      case 'pages_status': {
        const repo = await resolveRepo(pat, payload.repo || `${env.GITHUB_USERNAME}/${(payload.name || 'nova-os')}`);
        let pages = null;
        let build = null;
        try { pages = await gh(pat, `/repos/${repo}/pages`); } catch (err) { if (err.status !== 404) throw err; }
        try { build = await gh(pat, `/repos/${repo}/pages/builds/latest`); } catch (err) { if (err.status !== 404) throw err; }
        return json({
          repo,
          pages: pages ? { url: pages.html_url, status: pages.status, cname: pages.cname, branch: pages.source && pages.source.branch } : null,
          build: build ? { status: build.status, created_at: build.created_at, updated_at: build.updated_at, url: build.url } : null
        });
      }
      case 'trigger_deploy': {
        if (!env.CF_DEPLOY_HOOK) return json({ error: 'CF_DEPLOY_HOOK is not set in environment variables.', setup: true }, 501);
        const res = await fetch(env.CF_DEPLOY_HOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const text = await res.text();
        if (!res.ok) return json({ error: `Deploy hook rejected (${res.status})`, detail: text.slice(0, 300) }, 502);
        let id = `build_${Date.now().toString(36)}`;
        let url = '';
        try {
          const parsed = JSON.parse(text);
          id = parsed.id || parsed.build_id || id;
          url = parsed.url || parsed.deploy_url || '';
        } catch { /* hook returned plain text */ }
        return json({ ok: true, id, url, status: res.status });
      }
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const status = err.status || 502;
    const message = err.status === 401
      ? 'GitHub rejected the token (401). Rotate GITHUB_PAT in environment variables.'
      : err.message || 'GitHub request failed';
    return json({ error: message }, status);
  }
}
