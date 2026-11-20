/* ============================================================
   NOVA // OS — Connected Apps & Skills hub
   Discover / Connectors / Skills. Every credential field is
   optional and stored locally; nothing is sent anywhere until
   the connector is actually used.
   ============================================================ */
import { store, escapeHtml, uid } from '../services/store.js';
import { connectorFetch, enabledConnectors } from '../services/toolsEngine.js';
import { api, describeError } from '../services/net.js';
import { openPanel, openModal, toast, copyText } from '../services/ui.js';

const FEATURED = [
  { icon: '✈️', name: 'Telegram Bot', desc: 'Ship alerts and approval pings straight to your phone.', connector: 'telegram' },
  { icon: '📣', name: 'Social Autopilot', desc: 'Stage a post, approve it, publish through your webhook.', connector: 'social' },
  { icon: '📞', name: 'Outbound Call', desc: 'Escalate with a spoken brief via Twilio, Vapi or Bland.', connector: 'phone' },
  { icon: '🎬', name: 'AI Video Studio', desc: 'Render scenes and stills from a prompt through your pipeline.', connector: 'video' },
  { icon: '📬', name: 'Priority Inbox', desc: 'Rank unread mail by revenue risk, then draft replies.', connector: 'inbox' },
  { icon: '🗂️', name: 'Notion', desc: 'Write briefs and research dossiers into a database.', connector: 'notion' }
];

export function openCustomizeHub(app, initialTab = 'discover') {
  let tab = initialTab;
  let query = '';

  const connectorById = (id) => store.get('connectors', []).find((c) => c.id === id);

  const envBadges = () => {
    const st = store.get('councilStatus', {}) || {};
    const integ = st.integrations || {};
    return {
      github: Boolean(integ.github),
      cloudflare: Boolean(integ.deployHook),
      searxng: Boolean(store.get('prefs.searxng', ''))
    };
  };

  const installed = () => store.get('connectors', []).filter((c) => c.enabled || c.group === 'builtin');

  /* ── consent sheet ───────────────────────────────────────── */
  function configure(id) {
    const c = connectorById(id);
    if (!c) return;

    if (c.group === 'builtin') {
      openModal({
        title: c.name,
        sub: 'Environment-backed integration',
        body: `<p style="font-size:13px;color:var(--dim);line-height:1.65">
          ${escapeHtml(c.desc)}<br /><br />
          This one is wired on the server. Add <span class="mono">${id === 'github' ? 'GITHUB_PAT + GITHUB_USERNAME' : id === 'cloudflare' ? 'CF_DEPLOY_HOOK' : 'a SearXNG endpoint'}</span>
          to the Pages environment variables — the browser never sees the value and there is no key field here on purpose.
        </p>`,
        actions: [{ label: 'Got it', kind: 'primary' }]
      });
      return;
    }

    if (c.id === 'bookmarklet') {
      const code = `javascript:(()=>{const s=encodeURIComponent(document.title+'\\n'+location.href);window.open('https://r.jina.ai/'+location.href,'_blank');navigator.clipboard&&navigator.clipboard.writeText(decodeURIComponent(s));})()`;
      openModal({
        title: 'Page clipper bookmarklet',
        sub: 'Drag this to your bookmarks bar',
        body: `<p style="font-size:12.5px;color:var(--dim);line-height:1.6">It copies the title and URL, then opens the reader view so the page text is ready to hand to Nova.</p>
          <div class="field" style="margin-top:12px"><textarea readonly style="min-height:96px;font-size:11px">${escapeHtml(code)}</textarea></div>`,
        actions: [
          { label: 'Copy snippet', onClick: () => { copyText(code, 'Bookmarklet copied'); return true; } },
          { label: 'Enable', kind: 'primary', onClick: () => { setEnabled(c.id, true); } }
        ]
      });
      return;
    }

    const fields = c.fields.map((f) => {
      if (f.type === 'select') {
        return `<div class="field"><label for="cf_${f.key}">${escapeHtml(f.label)}</label>
          <select id="cf_${f.key}" data-k="${f.key}">${(f.options || []).map((o) => `<option ${c.values[f.key] === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></div>`;
      }
      if (f.type === 'textarea') {
        return `<div class="field"><label for="cf_${f.key}">${escapeHtml(f.label)}</label><textarea id="cf_${f.key}" data-k="${f.key}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(c.values[f.key] || '')}</textarea></div>`;
      }
      return `<div class="field"><label for="cf_${f.key}">${escapeHtml(f.label)}</label>
        <input id="cf_${f.key}" data-k="${f.key}" type="${f.secret ? 'password' : 'text'}" autocomplete="off"
          placeholder="${escapeHtml(f.placeholder || '')}" value="${f.secret ? '' : escapeHtml(c.values[f.key] || '')}" />
        ${f.secret ? `<small>${c.values[f.key] ? 'Saved locally — leave blank to keep it.' : 'Stored in this browser only.'}</small>` : ''}</div>`;
    }).join('');

    openModal({
      title: c.name,
      sub: 'Permission & setup',
      body: `<p style="font-size:12px;color:var(--dim);line-height:1.6;margin-bottom:14px">${escapeHtml(c.desc)} Nova sends requests through the same-origin connector proxy, so the vendor never sees your browser origin. Credentials stay in <span class="mono">localStorage</span> and are masked here.</p>${fields}`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save & enable',
          kind: 'primary',
          onClick: (el) => {
            const values = { ...c.values };
            el.querySelectorAll('[data-k]').forEach((inp) => {
              const v = inp.value.trim();
              if (v) values[inp.dataset.k] = v;
            });
            store.update((d) => {
              const target = d.connectors.find((x) => x.id === c.id);
              if (target) { target.values = values; target.enabled = true; }
            });
            toast(`${c.name} connected`, 'ok');
            render();
            app.syncStatus && app.syncStatus();
          }
        }
      ]
    });
  }

  function setEnabled(id, on) {
    store.update((d) => {
      const c = d.connectors.find((x) => x.id === id);
      if (c) c.enabled = on;
    });
    render();
    app.syncStatus && app.syncStatus();
  }

  async function testPing(id) {
    const c = connectorById(id);
    if (!c) return;
    if (c.group === 'builtin') {
      if (id === 'github') {
        try { await api('/api/github-proxy', { method: 'POST', body: { action: 'list_repos' } }); toast('GitHub PAT present', 'ok'); }
        catch (err) { toast(`GitHub bridge up · ${err.status === 501 || err.status === 503 ? 'no PAT' : describeError(err)}`, 'bad'); }
      } else if (id === 'cloudflare') {
        toast(envBadges().cloudflare ? 'Deploy hook present' : 'Bridge up · no CF_DEPLOY_HOOK', envBadges().cloudflare ? 'ok' : 'bad');
      } else {
        toast(store.get('prefs.searxng') ? 'SearXNG endpoint configured' : 'No endpoint configured', store.get('prefs.searxng') ? 'ok' : 'bad');
      }
      return;
    }
    if (c.id === 'deeplinks' || c.id === 'bookmarklet') { toast('No network call needed for this bridge', 'ok'); return; }
    const url = c.values.endpoint;
    if (!url) { toast('Add an endpoint first', 'bad'); return; }
    toast(`Pinging ${c.name}…`);
    const res = await connectorFetch({ url, method: 'GET' });
    toast(res.ok ? `${c.name} responded` : `${c.name}: ${res.error}`, res.ok ? 'ok' : 'bad');
  }

  /* ── renderers ───────────────────────────────────────────── */
  function connCard(c) {
    const env = envBadges()[c.id];
    const on = c.enabled || Boolean(env);
    const state = c.group === 'builtin'
      ? `<span class="conn-card__state ${env ? 'is-env' : ''}">${env ? 'ENV connected' : 'server key'}</span>`
      : `<span class="conn-card__state ${on ? 'is-on' : ''}">${on ? 'connected' : 'available'}</span>`;
    return `<div class="conn-card${on && c.group !== 'builtin' ? ' is-on' : ''}" data-card="${c.id}">
      <span class="conn-card__icon">${c.icon}</span>
      <span class="conn-card__meta"><b>${escapeHtml(c.name)} ${state}</b><p>${escapeHtml(c.desc)}</p></span>
      <button class="conn-test" data-test="${c.id}" type="button">Test ping</button>
      <button class="conn-plus" data-toggle="${c.id}" type="button" aria-label="${on ? 'Disable' : 'Connect'}">${on && c.group !== 'builtin' ? '✓' : '+'}</button>
    </div>`;
  }

  function skillCard(s) {
    return `<div class="skill-card">
      <span class="skill-card__icon">✦</span>
      <span style="flex:1;min-width:0"><b>${escapeHtml(s.name)}</b><p>${escapeHtml(s.desc || 'Custom skill')}</p></span>
      <span class="conn-card__state ${s.builtin ? 'is-env' : ''}">${s.builtin ? 'built-in' : 'custom'}</span>
      <button class="conn-test" data-run-skill="${s.id}" type="button">Use</button>
      ${s.builtin ? '' : `<button class="conn-test" data-del-skill="${s.id}" type="button" aria-label="Delete">✕</button>`}
    </div>`;
  }

  function bodyFor() {
    const conns = store.get('connectors', []);
    const needle = query.trim().toLowerCase();
    const match = (c) => !needle || `${c.name} ${c.desc}`.toLowerCase().includes(needle);
    const skills = store.get('skills', []).filter((s) => !needle || `${s.name} ${s.desc}`.toLowerCase().includes(needle));

    if (tab === 'discover') {
      return `
        <div class="hub-sect" style="padding-top:18px">Featured</div>
        <div class="conn-grid">
          ${FEATURED.map((f) => `
            <button class="conn-card" data-open-conn="${f.connector}" type="button">
              <span class="conn-card__icon">${f.icon}</span>
              <span class="conn-card__meta"><b>${f.name}</b><p>${f.desc}</p></span>
              <span class="conn-plus">+</span>
            </button>`).join('')}
        </div>
        <div class="hub-sect">At a glance</div>
        <div class="conn-grid">
          <div class="conn-card">
            <span class="conn-card__icon">🔐</span>
            <span class="conn-card__meta"><b>Server-side core keys</b><p>Workers AI, Vertex, Groq, Z.ai and GitHub live in the Pages environment — there is no key field anywhere in this app.</p></span>
          </div>
          <div class="conn-card">
            <span class="conn-card__icon">🧠</span>
            <span class="conn-card__meta"><b>${(store.get('memory.facts') || []).length} memory facts</b><p>Editable in Settings → Personal context. Import or clear them anytime.</p></span>
            <button class="conn-test" data-goto="settings" type="button">Open</button>
          </div>
          <div class="conn-card">
            <span class="conn-card__icon">✦</span>
            <span class="conn-card__meta"><b>${store.get('skills', []).length} skills installed</b><p>Skills are reusable instructions you can fire from the composer or this hub.</p></span>
            <button class="conn-test" data-goto="skills" type="button">View</button>
          </div>
        </div>`;
    }

    if (tab === 'connectors') {
      const inst = conns.filter((c) => c.enabled || c.group === 'builtin').filter(match);
      const rest = conns.filter((c) => !(c.enabled || c.group === 'builtin')).filter(match);
      return `
        <div class="hub-sect" style="padding-top:16px">Installed ${inst.length ? `· ${inst.length}` : ''}</div>
        <div class="conn-grid">${inst.length ? inst.map(connCard).join('') : '<p class="dim" style="font-size:12.5px">Nothing connected yet.</p>'}</div>
        <div class="hub-sect">All apps</div>
        <div class="conn-grid">${rest.length ? rest.map(connCard).join('') : '<p class="dim" style="font-size:12.5px">Everything already connected.</p>'}</div>
        <div class="hub-sect">Bridges without an API</div>
        <div class="conn-grid">
          <div class="conn-card">
            <span class="conn-card__icon">🔗</span>
            <span class="conn-card__meta"><b>Deep links</b><p>Open WhatsApp, X or mail with the draft already filled in.</p></span>
            <button class="conn-test" data-deeplink="1" type="button">Try</button>
          </div>
        </div>`;
    }

    return `
      <div class="hub-sect" style="padding-top:16px;display:flex;align-items:center">
        <span>Skills</span>
        <span style="flex:1"></span>
        <button class="btn btn--sm" data-new-skill="manual" type="button">Create manually</button>
        <button class="btn btn--sm btn--primary" data-new-skill="nova" type="button" style="margin-left:6px">+ Create with Nova</button>
      </div>
      <div class="conn-grid">${skills.length ? skills.map(skillCard).join('') : '<p class="dim" style="font-size:12.5px">No skills match.</p>'}</div>`;
  }

  const panel = openPanel({
    id: 'hub',
    title: 'Connected apps & skills',
    sub: 'CUSTOMIZE',
    icon: '✧',
    wide: true,
    body: `
      <div class="hub-tabs" id="hubTabs">
        <button class="hub-tab${tab === 'discover' ? ' is-active' : ''}" data-tab="discover" type="button">Discover</button>
        <button class="hub-tab${tab === 'connectors' ? ' is-active' : ''}" data-tab="connectors" type="button">Connectors</button>
        <button class="hub-tab${tab === 'skills' ? ' is-active' : ''}" data-tab="skills" type="button">Skills</button>
      </div>
      <label class="hub-search">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <input id="hubSearch" type="search" placeholder="Search apps and skills" aria-label="Search" />
      </label>
      <div id="hubBody"></div>`,
    onMount: ({ body, close }) => {
      const bodyEl = body.querySelector('#hubBody');
      const searchEl = body.querySelector('#hubSearch');

      const render = () => {
        bodyEl.innerHTML = bodyFor();
        body.querySelectorAll('.hub-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
      };
      render();

      searchEl.addEventListener('input', () => { query = searchEl.value; render(); });

      body.querySelector('#hubTabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        tab = b.dataset.tab;
        render();
      });

      bodyEl.addEventListener('click', (e) => {
        const openConn = e.target.closest('[data-open-conn]');
        if (openConn) { configure(openConn.dataset.openConn); return; }
        const test = e.target.closest('[data-test]');
        if (test) { testPing(test.dataset.test); return; }
        const toggle = e.target.closest('[data-toggle]');
        if (toggle) {
          const id = toggle.dataset.toggle;
          const c = connectorById(id);
          if (!c) return;
          if (c.group === 'builtin') { configure(id); return; }
          if (c.enabled) { setEnabled(id, false); toast(`${c.name} disconnected`); }
          else configure(id);
          return;
        }
        const runSkill = e.target.closest('[data-run-skill]');
        if (runSkill) {
          const s = store.get('skills', []).find((x) => x.id === runSkill.dataset.runSkill);
          if (!s) return;
          document.dispatchEvent(new CustomEvent('nova:send', { detail: { text: s.prompt } }));
          close();
          return;
        }
        const delSkill = e.target.closest('[data-del-skill]');
        if (delSkill) {
          store.update((d) => { d.skills = d.skills.filter((s) => s.id !== delSkill.dataset.delSkill); });
          toast('Skill removed');
          render();
          return;
        }
        const goto = e.target.closest('[data-goto]');
        if (goto) {
          if (goto.dataset.goto === 'settings') { close(); app.openPanel('settings'); }
          else { tab = 'skills'; render(); }
          return;
        }
        const newSkill = e.target.closest('[data-new-skill]');
        if (newSkill) { createSkill(newSkill.dataset.newSkill); return; }
        if (e.target.closest('[data-deeplink]')) {
          window.open('https://wa.me/?text=' + encodeURIComponent('Draft from NOVA // OS: '), '_blank', 'noopener');
        }
      });

      function createSkill(mode) {
        openModal({
          title: mode === 'nova' ? 'Create a skill with Nova' : 'Create a skill',
          sub: 'A skill is a reusable instruction',
          body: `<div class="field"><label for="skName">Name</label><input id="skName" type="text" placeholder="Launch copywriter" /></div>
            <div class="field"><label for="skDesc">What it does</label><input id="skDesc" type="text" placeholder="Writes launch posts in my voice" /></div>
            <div class="field"><label for="skPrompt">Instruction sent to Nova</label><textarea id="skPrompt" style="min-height:96px" placeholder="Write three launch hooks…"></textarea></div>`,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Save skill',
              kind: 'primary',
              onClick: (el) => {
                const name = el.querySelector('#skName').value.trim();
                const desc = el.querySelector('#skDesc').value.trim();
                const prompt = el.querySelector('#skPrompt').value.trim() || desc;
                if (!name) { toast('Give the skill a name', 'bad'); return true; }
                store.update((d) => d.skills.push({ id: uid('skill'), name, desc, prompt, builtin: false }));
                toast('Skill saved', 'ok');
                if (tab !== 'skills') { tab = 'skills'; }
                render();
                return false;
              }
            }
          ],
          onMount: (el) => {
            if (mode !== 'nova') return;
            const desc = el.querySelector('#skDesc');
            const prompt = el.querySelector('#skPrompt');
            desc.addEventListener('change', async () => {
              if (!desc.value.trim() || prompt.value.trim()) return;
              prompt.placeholder = 'Drafting with Nova…';
              const { runAgent } = await import('../services/aiCouncil.js');
              let text = '';
              await runAgent({
                prompt: `Write a single reusable instruction (max 60 words, imperative voice, no preamble) for a skill that ${desc.value.trim()}.`,
                mode: 'chat',
                onEvent: (e) => { if (e.type === 'final') text = e.message.text; }
              });
              if (text) { prompt.value = text.replace(/^["'`]+|["'`]+$/g, '').trim(); prompt.placeholder = ''; }
            });
          }
        });
      }
    }
  });

  return panel;
}
