/* ============================================================
   NOVA // OS — small shared utilities
   ============================================================ */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

export const titleCase = (s = '') => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export const langOf = (path = '') => {
  const ext = path.split('.').pop().toLowerCase();
  return ({
    html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', md: 'markdown',
    py: 'python', php: 'php', rb: 'ruby', go: 'go', rs: 'rust', sql: 'sql',
    toml: 'toml', yml: 'yaml', yaml: 'yaml', sh: 'bash', txt: 'text'
  })[ext] || 'text';
};

export const stripCodeFence = (s = '') => s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '');

/** Minimal LCS line diff, capped for UI sanity. */
export function diffLines(oldText = '', newText = '', maxRows = 220) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const n = a.length;
  const m = b.length;
  const rows = [];
  let added = 0;
  let removed = 0;

  if (n * m > 400000) {
    const max = Math.max(n, m);
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i]) {
        if (a[i] !== undefined) { rows.push({ t: 'del', s: '-' }); removed++; }
        if (b[i] !== undefined) { rows.push({ t: 'add', s: '+' }); added++; }
      } else if (a[i] !== undefined) {
        rows.push({ t: 'ctx', s: ' ' });
      }
      if (rows.length > maxRows) break;
    }
    return { rows: rows.slice(0, maxRows), added, removed, truncated: rows.length > maxRows };
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m && rows.length < maxRows) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', s: ' ', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ t: 'del', s: '-', text: a[i] });
      removed++; i++;
    } else {
      rows.push({ t: 'add', s: '+', text: b[j] });
      added++; j++;
    }
  }
  while (i < n && rows.length < maxRows) { rows.push({ t: 'del', s: '-', text: a[i++] }); removed++; }
  while (j < m && rows.length < maxRows) { rows.push({ t: 'add', s: '+', text: b[j++] }); added++; }

  return { rows, added, removed, truncated: i < n || j < m };
}

/** Collapse an unchanged block into context rows for readable diffs. */
export function compactDiff(diff, context = 2) {
  const out = [];
  let gap = 0;
  diff.rows.forEach((row, idx) => {
    if (row.t === 'ctx') {
      gap++;
      if (gap > context * 2 + 1) {
        if (out[out.length - 1] && !out[out.length - 1].skip) out.push({ t: 'meta', text: '⋯', skip: true });
        return;
      }
    } else {
      gap = 0;
    }
    out.push(row);
  });
  return { ...diff, rows: out };
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 400);
}

export const domainOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

export const fileExt = (p) => (p.split('.').pop() || '').slice(0, 4).toUpperCase();
