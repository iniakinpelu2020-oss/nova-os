/* ============================================================
   NOVA // OS — live code workspace
   Multi-file tree, editor, unified diff against the last
   commit point, sandboxed preview with a console bridge and a
   pre-deploy security gate.
   ============================================================ */
import { store, escapeHtml, STARTER_FILES } from '../services/store.js';
import { runSecurityAudit, github } from '../services/toolsEngine.js';
import { diffLines, langOf, downloadText } from '../services/util.js';
import { highlight } from './chatCanvas.js';
import { openPanel, toast, copyText } from '../services/ui.js';

const BUILTIN = '__builtin__';

function assemblePreview(files, snippet) {
  if (snippet) return snippet;
  const html = files['index.html'] || '<!doctype html><body style="font-family:system-ui;color:#111;padding:24px">No index.html in this workspace yet.</body>';
  const css = files['styles.css'] || files['style.css'] || '';
  const js = files['app.js'] || files['main.js'] || files['script.js'] || '';
  let doc = html;
  if (css) doc = doc.replace(/<link[^>]+href=["'][^"']*\.css["'][^>]*>/i, `<style>\n${css}\n</style>`);
  if (js) doc = doc.replace(/<script[^>]+src=["'][^"']*\.js["'][^>]*><\/script>/i, `<script>\n${js}\n</script>`);

  const chrome = `<style>html{scrollbar-width:thin;scrollbar-color:#31384a #0a0c12}body{scrollbar-width:thin}</style>`;
  if (doc.includes('</head>')) doc = doc.replace('</head>', `${chrome}</head>`);
  else doc = chrome + doc;

  const bridge = `<script>
  (function(){
    var send=function(kind,text){try{parent.postMessage({__nova:1,kind:kind,text:String(text).slice(0,400)},"*")}catch(e){}};
    window.addEventListener('error',function(e){send('error',(e.message||'Script error')+' @ '+(e.filename||'inline')+':'+(e.lineno||0))});
    window.addEventListener('unhandledrejection',function(e){send('error','Unhandled rejection: '+(e.reason&&e.reason.message||e.reason))});
    var ce=console.error;console.error=function(){send('error',Array.prototype.join.call(arguments,' '));ce.apply(console,arguments)};
  })();
  <\/script>`;
  return doc.includes('</head>') ? doc.replace('</head>', `${bridge}</head>`) : `${bridge}${doc}`;
}

export function openWorkspacePanel(app, opts = {}) {
  let tab = opts.tab || 'files';
  let active = store.get('activeFile', 'index.html');
  let mobileFrame = false;
  let dirty = false;
  let snippet = opts.snippet || null;
  let consoleErrors = [];

  const files = () => store.get('files', {});
  const baseline = () => store.get('filesBaseline', null) || STARTER_FILES;

  const diffSummary = () => {
    const cur = files();
    const base = baseline();
    const paths = [...new Set([...Object.keys(cur), ...Object.keys(base)])].sort();
    const changed = paths.filter((p) => (cur[p] || '') !== (base[p] || ''));
    return { paths, changed };
  };

  const shell = () => {
    const cur = files();
    const names = Object.keys(cur).sort();
    const { changed } = diffSummary();
    return `
      <div class="ws">
        <div class="ws-bar" id="wsTabs">
          <button class="ws-tab ${tab === 'files' ? 'is-active' : ''}" data-ws-tab="files" type="button">Files</button>
          <button class="ws-tab ${tab === 'diff' ? 'is-active' : ''}" data-ws-tab="diff" type="button">Diff ${changed.length ? `<span class="badge badge--accent">${changed.length}</span>` : ''}</button>
          <button class="ws-tab ${tab === 'audit' ? 'is-active' : ''}" data-ws-tab="audit" type="button">Audit</button>
          <button class="ws-tab ${tab === 'preview' ? 'is-active' : ''}" data-ws-tab="preview" type="button">Preview</button>
          <span style="flex:1"></span>
          <button class="btn btn--sm" id="wsAudit" type="button">🛡️ Security Audit</button>
          <button class="btn btn--sm" id="wsPush" type="button">🐙 Push to GitHub</button>
          <button class="btn btn--sm" id="wsDeploy" type="button">🚀 Trigger Deploy</button>
          <button class="btn btn--sm btn--primary" id="wsApply" type="button">Apply &amp; commit</button>
        </div>
        <div class="ws-body">
          <div class="ws-tree" id="wsTree">
            ${names.map((n) => `<button class="ws-file ${n === active ? 'is-active' : ''}" data-file="${escapeHtml(n)}" type="button"><span class="ws-file__dot"></span>${escapeHtml(n)}</button>`).join('')}
            <button class="ws-file" id="wsNew" type="button" style="color:var(--mute)"><span class="ws-file__dot"></span>+ new file</button>
          </div>
          <div class="ws-main" id="wsMain"></div>
        </div>
      </div>`;
  };

  const editorPane = () => {
    if (snippet) return previewPane();
    const cur = files();
    const content = cur[active] ?? '';
    return `
      <div class="ws-toolbar">
        <span class="mono">${escapeHtml(active)}</span>
        <span>· ${langOf(active)}</span>
        <span class="right">
          <span class="dim" id="wsDirty">${dirty ? 'unsaved' : 'saved'}</span>
          <button class="btn btn--sm" id="wsDownload" type="button">Download</button>
          <button class="btn btn--sm" id="wsSave" type="button">Save</button>
        </span>
      </div>
      <div class="ws-editor">
        <textarea id="wsCode" spellcheck="false" aria-label="Code editor">${escapeHtml(content)}</textarea>
      </div>`;
  };

  const diffPane = () => {
    const cur = files();
    const base = baseline();
    const { changed } = diffSummary();
    if (!changed.length) {
      return `<div style="padding:26px;text-align:center;color:var(--mute);font-size:12.5px">No changes since the last commit point.<br /><span style="font-size:11.5px">Edit a file, or ask Nova to build something, then come back.</span></div>`;
    }
    const html = changed.slice(0, 6).map((p) => {
      const d = diffLines(base[p] || '', cur[p] || '', 140);
      const rows = d.rows.map((r) => `<div class="diff__row diff__row--${r.t}"><span>${r.s === ' ' ? '' : r.s}</span><span>${escapeHtml(r.text ?? '')}</span></div>`).join('');
      return `<div style="border-bottom:1px solid var(--line)">
        <div class="ws-toolbar"><span class="mono">${escapeHtml(p)}</span><span class="right"><span class="badge badge--ok">+${d.added}</span><span class="badge">−${d.removed}</span></span></div>
        <div class="diff">${rows}</div>
      </div>`;
    }).join('');
    return `<div class="ws-diff">${html}${changed.length > 6 ? `<div style="padding:12px;color:var(--mute);font-size:11.5px">+${changed.length - 6} more changed files</div>` : ''}</div>`;
  };

  const auditPane = () => {
    const audit = runSecurityAudit(files());
    return `<div style="padding:16px;overflow:auto">
      <div class="block__head" style="padding:0 0 12px;border:0">🛡 <b>Pre-deploy security gate</b>
        <span class="right"><span class="audit-score" data-low="${audit.score < 100 ? 1 : 0}">${audit.score}/100</span></span>
      </div>
      <div class="audit-list">
        ${audit.rows.map((r) => `<div class="audit-row" data-fail="${r.ok ? 0 : 1}">
          <span class="audit-row__icon">${r.ok ? '✓' : '!'}</span>
          <span>${escapeHtml(r.label)}</span>
          <span class="audit-row__note">${escapeHtml(r.note || '')}</span>
        </div>`).join('')}
      </div>
      ${audit.score === 100
        ? `<div class="ship-bar" style="border-radius:12px;margin-top:14px"><p>Gate clear · ${audit.files} files · ${audit.lines} lines</p><button class="btn btn--sm btn--primary" id="wsShip" type="button">🚀 Ship it</button></div>`
        : `<p class="vision-note">${audit.total - audit.passed} check(s) need attention before this can ship. Ask Nova to fix them, or edit the files directly.</p>`}
      <p class="vision-note">Every check runs locally over the virtual workspace. Nothing is uploaded.</p>
    </div>`;
  };

  const previewPane = () => `
    <div class="ws-preview">
      <div class="ws-toolbar">
        <span class="mono">${snippet ? 'snippet.html' : 'sandbox'}</span>
        <span class="right">
          <div class="mode-toggle" id="wsSize">
            <button data-size="desktop" class="${mobileFrame ? '' : 'is-active'}" type="button">Desktop</button>
            <button data-size="mobile" class="${mobileFrame ? 'is-active' : ''}" type="button">Mobile</button>
          </div>
          <button class="btn btn--sm" id="wsReload" type="button">Reload</button>
        </span>
      </div>
      <div id="wsErrorBar" hidden style="padding:8px 12px;background:rgba(251,113,133,.08);border-bottom:1px solid rgba(251,113,133,.25);font-size:11.5px;color:#ffc2cb;display:flex;gap:10px;align-items:center">
        <span id="wsErrorText" style="flex:1"></span>
        <button class="btn btn--sm" id="wsAutoFix" type="button">Ask Nova to fix</button>
      </div>
      <div style="flex:1;display:flex;justify-content:center;background:#07080c;padding:${mobileFrame ? '14px' : '0'};overflow:auto">
        <iframe id="wsFrame" title="Sandboxed preview" sandbox="allow-scripts allow-forms allow-modals"
          style="width:${mobileFrame ? '390px' : '100%'};height:${mobileFrame ? '720px' : '100%'};border:${mobileFrame ? '1px solid var(--line)' : '0'};border-radius:${mobileFrame ? '16px' : '0'};background:#fff"></iframe>
      </div>
    </div>`;

  const mainFor = () => {
    if (tab === 'diff') return diffPane();
    if (tab === 'audit') return auditPane();
    if (tab === 'preview') return previewPane();
    return editorPane();
  };

  const panel = openPanel({
    id: 'workspace',
    title: 'Workspace',
    sub: snippet ? 'SNIPPET PREVIEW' : 'LIVE CODE · SANDBOXED',
    icon: '⌘',
    full: true,
    body: shell(),
    onMount: ({ body, close }) => {
      const tree = body.querySelector('#wsTree');
      const main = body.querySelector('#wsMain');

      const paintMain = () => {
        main.innerHTML = mainFor();
        bindMain();
      };

      const paintTree = () => {
        tree.innerHTML = Object.keys(files()).sort().map((n) =>
          `<button class="ws-file ${n === active ? 'is-active' : ''}" data-file="${escapeHtml(n)}" type="button"><span class="ws-file__dot"></span>${escapeHtml(n)}</button>`
        ).join('') + `<button class="ws-file" id="wsNew" type="button" style="color:var(--mute)"><span class="ws-file__dot"></span>+ new file</button>`;
      };

      function bindMain() {
        const code = main.querySelector('#wsCode');
        if (code) {
          code.addEventListener('input', () => {
            dirty = true;
            const d = body.querySelector('#wsDirty');
            if (d) d.textContent = 'unsaved';
          });
          code.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
            if (e.key === 'Tab') {
              e.preventDefault();
              const start = code.selectionStart;
              code.setRangeText('  ', start, code.selectionEnd, 'end');
            }
          });
        }

        main.querySelector('#wsSave')?.addEventListener('click', save);
        main.querySelector('#wsDownload')?.addEventListener('click', () => {
          downloadText(active, files()[active] || '', 'text/plain');
        });

        main.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
          mobileFrame = b.dataset.size === 'mobile';
          paintMain();
        }));

        main.querySelector('#wsReload')?.addEventListener('click', () => mountFrame());
        main.querySelector('#wsAutoFix')?.addEventListener('click', () => {
          const err = consoleErrors[0] || 'Unknown runtime error';
          document.dispatchEvent(new CustomEvent('nova:send', {
            detail: { text: `The sandbox preview threw a runtime error:\n\n${err}\n\nFix it in the workspace files and show me the diff.` }
          }));
          close();
        });
        main.querySelector('#wsShip')?.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('nova:send', {
            detail: { text: 'Run the pre-deploy security audit, then deploy the current workspace and report the live URL.' }
          }));
          close();
        });

        if (tab === 'preview' || snippet) mountFrame();
      }

      function save() {
        const code = main.querySelector('#wsCode');
        if (!code) return;
        store.set(`files.${active}`, code.value);
        dirty = false;
        const d = body.querySelector('#wsDirty');
        if (d) d.textContent = 'saved';
        toast(`${active} saved`, 'ok');
      }

      function mountFrame() {
        const frame = main.querySelector('#wsFrame');
        if (!frame) return;
        consoleErrors = [];
        const bar = main.querySelector('#wsErrorBar');
        if (bar) bar.hidden = true;
        frame.srcdoc = assemblePreview(files(), snippet);
      }

      window.addEventListener('message', (e) => {
        if (!e.data || !e.data.__nova) return;
        if (e.data.kind !== 'error') return;
        const frame = main.querySelector('#wsFrame');
        if (!frame || e.source !== frame.contentWindow) return;
        consoleErrors.push(e.data.text);
        const bar = main.querySelector('#wsErrorBar');
        const txt = main.querySelector('#wsErrorText');
        if (bar && txt) {
          bar.hidden = false;
          txt.textContent = `${consoleErrors.length} runtime error${consoleErrors.length > 1 ? 's' : ''} · ${e.data.text}`;
        }
      });

      body.addEventListener('click', (e) => {
        const t = e.target.closest('[data-ws-tab]');
        if (t) {
          if (dirty && tab === 'files') save();
          tab = t.dataset.wsTab;
          body.querySelectorAll('[data-ws-tab]').forEach((x) => x.classList.toggle('is-active', x === t));
          paintMain();
          return;
        }
        const f = e.target.closest('[data-file]');
        if (f) {
          if (dirty) save();
          active = f.dataset.file;
          store.set('activeFile', active);
          tab = 'files';
          paintTree();
          paintMain();
          return;
        }
        if (e.target.closest('#wsNew')) {
          const name = prompt('New file name (e.g. notes.md)');
          if (!name) return;
          store.set(`files.${name}`, '');
          active = name;
          store.set('activeFile', name);
          paintTree();
          paintMain();
          return;
        }
        if (e.target.closest('#wsApply')) {
          commit();
          return;
        }
        if (e.target.closest('#wsPush')) {
          push();
          return;
        }
        if (e.target.closest('#wsAudit')) {
          tab = 'audit';
          body.querySelectorAll('[data-ws-tab]').forEach((x) => x.classList.toggle('is-active', x.dataset.wsTab === 'audit'));
          paintMain();
          return;
        }
        if (e.target.closest('#wsDeploy')) {
          deploy();
          return;
        }
      });

      async function commit() {
        store.set('filesBaseline', JSON.parse(JSON.stringify(files())));
        store.set('audit', runSecurityAudit(files()));
        const tabBtn = body.querySelector('[data-ws-tab="diff"]');
        if (tabBtn) tabBtn.textContent = 'Diff';
        toast('Applied locally — commit point updated', 'ok');
        paintMain();
      }

      async function push() {
        const repo = store.get('prefs.repo', 'iniakinpelu2020-oss/nova-os');
        const payload = Object.entries(files()).map(([path, content]) => ({ path, content }));
        toast('Pushing complete files…');
        const res = await github.pushFiles(repo, payload, 'nova: workspace snapshot');
        if (res.ok) {
          store.set('filesBaseline', JSON.parse(JSON.stringify(files())));
          toast(`Committed to ${repo}`, 'ok');
        } else {
          toast(`GitHub not set: ${res.error || 'no GITHUB_PAT'}`, 'bad');
          copyText(payload.map((f) => f.content).join('\n\n'), 'Files copied as fallback');
        }
      }

      async function deploy() {
        const repo = store.get('prefs.repo', 'iniakinpelu2020-oss/nova-os');
        toast('Triggering deploy…');
        const res = await github.triggerDeploy(repo);
        if (res && res.ok) toast(`Deploy triggered: ${res.id || 'accepted'}`, 'ok');
        else toast(`Deploy not set: ${res && res.error ? res.error : 'no CF_DEPLOY_HOOK'}`, 'bad');
      }

      paintMain();
      if (tab === 'preview' || snippet) mountFrame();
    }
  });

  return panel;
}
