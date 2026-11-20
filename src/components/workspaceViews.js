/* ============================================================
   NOVA // OS — library, schedule, study and notebook panels
   Small, real views over the persisted workspace. No invented
   network calls: every action either writes locally, opens an
   existing surface, or reports the missing credential.
   ============================================================ */
import { store, escapeHtml, uid } from '../services/store.js';
import { callPhone, sendTelegram, readWebpage } from '../services/toolsEngine.js';
import { openPanel, toast } from '../services/ui.js';
import { downloadText } from '../services/util.js';

/* ── library ──────────────────────────────────────────────── */
export function openLibraryPanel(app) {
  let filter = 'all';
  const render = () => {
    const items = store.get('library', []).filter((i) => filter === 'all' || i.kind === filter);
    return `
      <div class="mode-toggle" id="libFilter" style="margin-bottom:14px">
        ${['all', 'code', 'report', 'media'].map((f) => `<button data-filter="${f}" class="${filter === f ? 'is-active' : ''}" type="button">${f}</button>`).join('')}
      </div>
      <div class="conn-grid" style="padding:0">
        ${items.length ? items.map((i) => `
          <div class="conn-card" data-item="${i.id}" style="cursor:default">
            <span class="conn-card__icon">${i.kind === 'code' ? '⌘' : i.kind === 'report' ? '📄' : '🖼'}</span>
            <span class="conn-card__meta"><b>${escapeHtml(i.title)}</b><p>${escapeHtml(i.meta || i.kind)}</p></span>
            ${i.kind === 'code' ? '<button class="conn-test" data-open-item="workspace" type="button">Open</button>' : ''}
            <button class="conn-test" data-del-item="${i.id}" type="button" aria-label="Remove">✕</button>
          </div>`).join('') : '<p class="dim" style="font-size:12.5px">Nothing saved in this filter yet.</p>'}
      </div>`;
  };

  return openPanel({
    id: 'library',
    title: 'Library',
    sub: 'SAVED CODE · REPORTS · MEDIA',
    icon: '🖼️',
    wide: true,
    body: render(),
    onMount: ({ body, refresh, close }) => {
      body.addEventListener('click', (e) => {
        const f = e.target.closest('[data-filter]');
        if (f) { filter = f.dataset.filter; body.innerHTML = render(); return; }
        const del = e.target.closest('[data-del-item]');
        if (del) { store.update((d) => { d.library = d.library.filter((i) => i.id !== del.dataset.delItem); }); body.innerHTML = render(); toast('Removed from library'); return; }
        if (e.target.closest('[data-open-item="workspace"]')) { close(); app.openPanel('workspace'); }
      });
      refresh();
    }
  });
}

/* ── scheduled ────────────────────────────────────────────── */
export function openScheduledPanel(app) {
  const render = () => `
    <div class="conn-grid" style="padding:0">
      ${store.get('scheduled', []).map((t) => `
        <div class="conn-card" style="cursor:default">
          <button class="conn-card__icon" data-toggle-task="${t.id}" type="button" aria-label="Toggle done" style="font-size:13px;color:${t.done ? 'var(--ok)' : 'var(--mute)'}">${t.done ? '✓' : '○'}</button>
          <span class="conn-card__meta"><b style="${t.done ? 'color:var(--mute);text-decoration:line-through' : ''}">${escapeHtml(t.title)}</b><p>${escapeHtml(t.when)} · ${t.kind}${t.call ? ' · call allowed' : ''}</p></span>
          ${t.call ? `<button class="conn-test" data-sim-call="${t.id}" type="button">📞 Simulate call</button>` : ''}
        </div>`).join('')}
    </div>
    <div class="field" style="margin-top:16px"><label for="taskNew">Add a task</label>
      <div style="display:flex;gap:8px">
        <input id="taskNew" type="text" placeholder="Review the launch build" style="flex:1" />
        <button class="btn" id="taskAdd" type="button">Add</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn" id="tgPing" type="button">✈️ Send Telegram alert</button>
      <button class="btn btn--ghost" id="schedWatch" type="button">Arm deadline watchdog</button>
    </div>
    <p class="vision-note">Calls and Telegram messages only leave the browser once the matching connector is configured; otherwise the action is staged and reported honestly.</p>`;

  return openPanel({
    id: 'scheduled',
    title: 'Scheduled',
    sub: 'DEADLINES · WATCHDOGS · CALLS',
    icon: '🕒',
    wide: true,
    body: render(),
    onMount: ({ body, refresh }) => {
      const repaint = () => { body.innerHTML = render(); };
      body.addEventListener('click', async (e) => {
        const tog = e.target.closest('[data-toggle-task]');
        if (tog) {
          store.update((d) => { const t = d.scheduled.find((x) => x.id === tog.dataset.toggleTask); if (t) t.done = !t.done; });
          repaint();
          return;
        }
        const add = e.target.closest('#taskAdd');
        if (add) {
          const inp = body.querySelector('#taskNew');
          const title = inp.value.trim();
          if (!title) return;
          store.update((d) => d.scheduled.push({ id: uid('task'), title, when: 'Unscheduled', kind: 'block', done: false, call: false }));
          repaint();
          toast('Task added', 'ok');
          return;
        }
        const call = e.target.closest('[data-sim-call]');
        if (call) {
          const t = store.get('scheduled', []).find((x) => x.id === call.dataset.simCall);
          call.textContent = 'dialling…';
          const script = `Master Drippy Dee, this is Nova. ${t ? `You asked to be reminded about ${t.title}` : 'Checking in'}. It is ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Press 1 for the full brief, or say "not now" and I will reschedule.`;
          const res = await callPhone({ reason: t ? t.title : 'Check-in', script });
          call.textContent = '📞 Simulate call';
          toast(res.summary, res.ok && !res.demo ? 'ok' : 'bad');
          return;
        }
        if (e.target.closest('#tgPing')) {
          const res = await sendTelegram('NOVA // OS · deadline watchdog armed. Nothing is on fire yet.');
          toast(res.summary || 'Telegram not configured', res.ok ? 'ok' : 'bad');
          return;
        }
        if (e.target.closest('#schedWatch')) {
          document.dispatchEvent(new CustomEvent('nova:send', {
            detail: { text: 'Watch the deadlines on the schedule, rank them by consequence, and tell me what needs action before 18:00.' }
          }));
          toast('Watchdog handed to Nova');
        }
      });
      refresh();
    }
  });
}

/* ── study & research ─────────────────────────────────────── */
export function openStudyPanel(app) {
  const dossier = () => {
    const chat = store.activeChat();
    const msgs = (chat ? chat.messages : []).filter((m) => m.role === 'nova');
    if (!msgs.length) { toast('Ask a research question first', 'bad'); return; }
    const last = msgs[msgs.length - 1];
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>NOVA dossier</title>
      <style>body{font-family:Georgia,serif;max-width:720px;margin:48px auto;padding:0 24px;line-height:1.65;color:#111}
      h1{font-size:26px;letter-spacing:-.02em} .meta{color:#666;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
      pre{white-space:pre-wrap;font-family:inherit} .src{font-size:12px;color:#444;margin-top:18px;border-top:1px solid #ddd;padding-top:10px}</style></head>
      <body><p class="meta">Nova // OS · research dossier</p><h1>${escapeHtml(chat.title)}</h1>
      <pre>${escapeHtml(last.text)}</pre>
      ${(last.sources || []).length ? `<div class="src"><b>Sources</b><br>${last.sources.map((s) => `${escapeHtml(s.title || '')} — ${escapeHtml(s.url)}`).join('<br>')}</div>` : ''}
      </body></html>`;
    downloadText(`nova-dossier-${Date.now().toString(36)}.html`, html, 'text/html');
    toast('Dossier downloaded — open it and print to PDF');
  };

  return openPanel({
    id: 'study',
    title: 'Study & research',
    sub: 'SERIOUS MODE · SOURCES · DOSSIERS',
    icon: '🎓',
    wide: true,
    body: `
      <div class="conn-grid" style="padding:0">
        <button class="conn-card" id="seriousBtn" type="button">
          <span class="conn-card__icon">🎯</span>
          <span class="conn-card__meta"><b>Serious Mode deep research</b><p>Slower, adversarial reasoning with every claim sourced before it is made.</p></span>
          <span class="conn-plus">→</span>
        </button>
        <button class="conn-card" id="dossierBtn" type="button">
          <span class="conn-card__icon">📄</span>
          <span class="conn-card__meta"><b>Download the latest dossier</b><p>Turns Nova's last research answer into a printable report with its sources.</p></span>
          <span class="conn-plus">↓</span>
        </button>
      </div>
      <div class="field" style="margin-top:16px"><label for="studyUrl">Summarize a video or article</label>
        <div style="display:flex;gap:8px">
          <input id="studyUrl" type="url" placeholder="https://youtube.com/watch?v=…" style="flex:1" />
          <button class="btn" id="studySum" type="button">Read it</button>
        </div>
      </div>
      <div id="studyOut"></div>
      <p class="vision-note">Pages are read through the Jina reader bridge. If the bridge is unreachable the panel says so rather than inventing a summary.</p>`,
    onMount: ({ body, close }) => {
      body.querySelector('#seriousBtn').addEventListener('click', () => {
        store.set('prefs.serious', true);
        document.body.classList.add('serious');
        document.dispatchEvent(new CustomEvent('nova:send', {
          detail: { text: 'Serious Mode: pick the hardest open question on my board, research it with cited sources, and give me the strongest case against my current plan.' }
        }));
        close();
      });
      body.querySelector('#dossierBtn').addEventListener('click', dossier);
      body.querySelector('#studySum').addEventListener('click', async () => {
        const url = body.querySelector('#studyUrl').value.trim();
        const out = body.querySelector('#studyOut');
        if (!url) { toast('Paste a link first'); return; }
        out.innerHTML = '<p class="vision-note">Reading…</p>';
        const page = await readWebpage(url);
        if (!page.ok) {
          out.innerHTML = `<p class="vision-note">Reader unavailable: ${escapeHtml(page.error || 'unknown error')}. Nothing was summarized.</p>`;
          return;
        }
        document.dispatchEvent(new CustomEvent('nova:send', { detail: { text: `Summarize this source in five bullets and flag any contradiction.\n\n${url}\n\n${page.text.slice(0, 4000)}` } }));
        close();
      });
    }
  });
}

/* ── notebooks ────────────────────────────────────────────── */
export function openNotebooksPanel(app, openId = null) {
  if (openId) {
    const nb = store.get('notebooks', []).find((n) => n.id === openId);
    if (!nb) return openNotebooksPanel(app);
    return openPanel({
      id: 'notebook',
      title: nb.title,
      sub: 'NOTEBOOK',
      icon: '📓',
      wide: true,
      body: `<div class="field"><label for="nbNote">Notes</label>
        <textarea id="nbNote" style="min-height:240px">${escapeHtml(nb.note || '')}</textarea></div>
        <div style="display:flex;gap:8px"><button class="btn btn--primary" id="nbSave" type="button">Save note</button>
        <button class="btn" id="nbAsk" type="button">Ask Nova about this</button></div>`,
      onMount: ({ body, close }) => {
        body.querySelector('#nbSave').addEventListener('click', () => {
          store.update((d) => { const n = d.notebooks.find((x) => x.id === nb.id); if (n) n.note = body.querySelector('#nbNote').value; });
          toast('Notebook saved', 'ok');
        });
        body.querySelector('#nbAsk').addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('nova:send', { detail: { text: `Notebook "${nb.title}":\n\n${body.querySelector('#nbNote').value}\n\nWhat is the next concrete step?` } }));
          close();
        });
      }
    });
  }

  return openPanel({
    id: 'notebooks',
    title: 'Notebooks',
    sub: 'PROJECT WORKSPACES',
    icon: '📓',
    wide: true,
    body: `<div class="conn-grid" style="padding:0">
        ${store.get('notebooks', []).map((n) => `
          <button class="conn-card" data-nb-open="${n.id}" type="button">
            <span class="conn-card__icon">📓</span>
            <span class="conn-card__meta"><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.note || '')}</p></span>
            <span class="conn-plus">→</span>
          </button>`).join('') || '<p class="dim" style="font-size:12.5px">No notebooks yet.</p>'}
      </div>
      <button class="btn btn--primary" id="nbNew" type="button" style="margin-top:14px">+ New notebook</button>`,
    onMount: ({ body, close }) => {
      body.addEventListener('click', (e) => {
        const open = e.target.closest('[data-nb-open]');
        if (open) { close(); openNotebooksPanel(app, open.dataset.nbOpen); return; }
        if (e.target.closest('#nbNew')) {
          const title = prompt('Notebook name');
          if (!title) return;
          const id = uid('nb');
          store.update((d) => d.notebooks.unshift({ id, title: title.slice(0, 60), note: '', ts: Date.now(), entries: 0 }));
          close();
          openNotebooksPanel(app, id);
        }
      });
    }
  });
}
