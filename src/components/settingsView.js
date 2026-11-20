/* ============================================================
   NOVA // OS — settings
   Vertical list: usage & quota, server status, model routing,
   preferences, memory, persona, voice, theme, biometrics.
   No core provider key inputs exist here by design.
   ============================================================ */
import { store, escapeHtml } from '../services/store.js';
import { getStatus } from '../services/aiCouncil.js';
import { voicesAvailable } from '../services/voiceEngine.js';
import { openPanel, toast, pct, openModal } from '../services/ui.js';

const MODEL_OPTIONS = {
  chat: ['@cf/zhipuai/glm-4.7-flash', 'gemini-3.5-flash', 'llama-3.3-70b-versatile', 'GLM-4.7-Flash'],
  coding: ['@cf/openai/gpt-oss-120b', '@cf/qwen/qwen3.8-27b', 'gemini-2.5-pro', 'openai/gpt-oss-120b'],
  reasoning: ['@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'gemini-2.5-pro', 'openai/gpt-oss-120b'],
  synth: ['gemini-2.5-pro', 'openai/gpt-oss-120b', 'GLM-4.7-Flash'],
  uncensored: ['venice-uncensored', 'dolphin-2.9.2-qwen2-72b']
};

const ROLE_LABEL = { chat: 'Chat', coding: 'Coding', reasoning: 'Reasoning', synth: 'Lead synthesizer', uncensored: 'Uncensored Venice' };

export function openSettingsPanel(app) {
  let status = store.get('councilStatus', null);
  let loading = true;

  const switchHtml = (path, checked, label) =>
    `<button class="switch" role="switch" aria-checked="${Boolean(checked)}" aria-label="${escapeHtml(label)}" data-switch="${path}" type="button"></button>`;

  const usageBlock = () => {
    const u = store.get('usage', {});
    const pool = status && status.roles ? status.roles : {};
    const providers = [
      { id: 'workers-ai', label: 'Workers AI binding' },
      { id: 'vertex', label: 'Vertex (AQ.)' },
      { id: 'groq', label: 'GroqCloud' },
      { id: 'zai', label: 'Z.ai' },
      { id: 'venice', label: 'Venice AI (Uncensored)' }
    ];
    return `
      <div class="settings-group">
        <div class="settings-group__title">Usage &amp; quota</div>
        <div class="set-row">
          <div class="set-row__label"><b>Current session</b><small>Tokens routed through this tab</small></div>
          <div class="meter">
            <div class="meter__row"><span>${u.session || 0}</span><span>${u.sessionCap || 25000}</span></div>
            <div class="meter__bar"><i style="width:${pct(u.session || 0, u.sessionCap || 25000)}"></i></div>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Daily neurons</b><small>Resets at local midnight</small></div>
          <div class="meter">
            <div class="meter__row"><span>${u.daily || 0}</span><span>${u.dailyCap || 100000}</span></div>
            <div class="meter__bar"><i class="${(u.daily || 0) > (u.dailyCap || 100000) * 0.8 ? 'is-warn' : ''}" style="width:${pct(u.daily || 0, u.dailyCap || 100000)}"></i></div>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Council key pool health</b>
            <small>${loading ? 'Checking environment…' : status && status.configured ? 'Role pools resolve to live providers' : 'No provider keys in this environment — demo routing'}</small>
          </div>
          <span class="badge ${status && status.configured ? 'badge--ok' : 'badge--demo'}">${loading ? '…' : status && status.configured ? 'ENV CONNECTED' : 'DEMO'}</span>
        </div>
        ${providers.map((p) => {
          const on = Boolean(status && status.providers && status.providers[p.id] && status.providers[p.id].configured);
          return `<div class="set-row" style="padding-top:8px;padding-bottom:8px">
            <div class="set-row__label"><b style="font-weight:400">${p.label}</b>
              <small>${Object.entries(pool).map(([role, v]) => `${role} ${v.keys[p.id] || 0}`).join(' · ') || 'chat 0 · coding 0 · reasoning 0'}</small>
            </div>
            <span class="badge ${on ? 'badge--ok' : ''}">${on ? 'connected' : 'not set'}</span>
          </div>`;
        }).join('')}
      </div>`;
  };

  const modelsBlock = () => `
    <div class="settings-group">
      <div class="settings-group__title">Model routing</div>
      ${Object.keys(MODEL_OPTIONS).map((role) => `
        <div class="set-row">
          <div class="set-row__label"><b>${ROLE_LABEL[role]}</b><small>${role === 'synth' ? 'Writes the final synthesis in Powerful mode' : 'Used by the council for this role'}</small></div>
          <div class="set-row__control">
            <select data-model="${role}">
              ${MODEL_OPTIONS[role].map((m) => `<option value="${m}" ${store.get(`prefs.models.${role}`) === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
        </div>`).join('')}
    </div>`;

  const prefsBlock = () => {
    const v = store.get('prefs.voice', {});
    const voices = voicesAvailable();
    return `
      <div class="settings-group">
        <div class="settings-group__title">Preferences</div>
        <div class="set-row">
          <div class="set-row__label"><b>Notifications &amp; proactive alerts</b><small>Deadline watchdogs and approval pings from scheduled tasks</small></div>
          ${switchHtml('prefs.notifications', store.get('prefs.notifications'), 'Notifications')}
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Call approvals</b><small>Require an explicit yes before any outbound call is placed</small></div>
          ${switchHtml('prefs.alerts', store.get('prefs.alerts'), 'Call approvals')}
        </div>
        <button class="set-row" type="button" data-open="memory">
          <div class="set-row__label"><b>Personal context &amp; memory</b><small>${(store.get('memory.facts') || []).length} facts remembered</small></div>
          <div class="set-row__control"><span class="dim">›</span></div>
        </button>
        <button class="set-row" type="button" data-open="hub">
          <div class="set-row__label"><b>Connected apps</b><small>Telegram, social, calls, inbox, voice and more</small></div>
          <div class="set-row__control"><span class="dim">›</span></div>
        </button>
        <div class="set-row">
          <div class="set-row__label"><b>Persona &amp; tone</b><small>Witty J.A.R.V.I.S. banter with Master Drippy Dee, or straight Serious Mode</small></div>
          <div class="set-row__control">
            ${switchHtml('prefs.personality', store.get('prefs.personality'), 'Persona')}
            ${switchHtml('prefs.serious', store.get('prefs.serious'), 'Serious mode')}
          </div>
        </div>
        <button class="set-row" type="button" data-open="hub-skills">
          <div class="set-row__label"><b>Skills</b><small>${store.get('skills', []).length} installed</small></div>
          <div class="set-row__control"><span class="dim">›</span></div>
        </button>
        <div class="set-row">
          <div class="set-row__label"><b>Wake word</b><small>Say “wake up, Nova” inside voice mode</small></div>
          ${switchHtml('prefs.wakeWord', store.get('prefs.wakeWord'), 'Wake word')}
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Voice</b><small>Browser speech synthesis, or a studio voice through the connector</small></div>
          <div class="set-row__control">
            <select data-voice>
              <option value="">System default</option>
              ${voices.map((vo) => `<option value="${vo.voiceURI}" ${v.voiceURI === vo.voiceURI ? 'selected' : ''}>${escapeHtml(vo.name)}</option>`).join('')}
            </select>
            ${switchHtml('prefs.voice.muted', v.muted, 'Mute speech')}
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Theme</b><small>Pure OLED black, or a slightly lifted slate</small></div>
          <div class="set-row__control">
            <button class="theme-swatch ${store.get('prefs.theme') === 'oled' ? 'is-active' : ''}" data-theme="oled" style="background:#050508" aria-label="OLED black" type="button"></button>
            <button class="theme-swatch ${store.get('prefs.theme') === 'slate' ? 'is-active' : ''}" data-theme="slate" style="background:#10131a" aria-label="Dark slate" type="button"></button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Biometric lock</b><small>Face activation gate at startup, PIN 2026 as fallback</small></div>
          ${switchHtml('lock.biometric', store.get('lock.biometric'), 'Biometric lock')}
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Startup PIN</b><small>Custom 4–8 digit fallback PIN (default 2026)</small></div>
          <div class="set-row__control">
            <input type="password" inputmode="numeric" maxlength="8" data-pin-input value="${escapeHtml(store.get('lock.pin', '2026'))}" style="width:96px" />
            <button class="btn" data-pin-save type="button">Save PIN</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Search endpoint</b><small>SearXNG instance used for citations</small></div>
          <div class="set-row__control"><input type="url" data-field="prefs.searxng" value="${escapeHtml(store.get('prefs.searxng'))}" style="width:190px" /></div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Default repository</b><small>Target for Push to GitHub</small></div>
          <div class="set-row__control"><input type="text" data-field="prefs.repo" value="${escapeHtml(store.get('prefs.repo'))}" style="width:190px" /></div>
        </div>
      </div>`;
  };

  const build = () => `
    <div style="padding:0 2px">${usageBlock()}${modelsBlock()}${prefsBlock()}
      <p class="vision-note" style="text-align:center;margin:6px 0 10px">Core provider keys and the GitHub token are environment variables on the server. This screen cannot read or write them.</p>
    </div>`;

  const panel = openPanel({
    id: 'settings',
    title: 'Settings',
    sub: 'WORKSPACE · PERSONA · ROUTING',
    icon: '⚙',
    wide: true,
    body: () => build(),
    onMount: ({ body, refresh, close }) => {
      const rerender = () => { body.innerHTML = build(); };
      body.addEventListener('click', (e) => {
        const sw = e.target.closest('[data-switch]');
        if (sw) {
          const path = sw.dataset.switch;
          const next = sw.getAttribute('aria-checked') !== 'true';
          store.set(path, next);
          sw.setAttribute('aria-checked', String(next));
          if (path === 'prefs.serious') {
            document.body.classList.toggle('serious', next);
            toast(next ? 'Serious Mode on' : 'Persona restored');
          }
          if (path === 'lock.biometric') toast(next ? 'Face lock enabled at startup' : 'Face lock disabled — PIN only');
          if (path.startsWith('prefs.voice')) rerender();
          return;
        }
        const theme = e.target.closest('[data-theme]');
        if (theme) {
          store.set('prefs.theme', theme.dataset.theme);
          document.body.classList.toggle('theme-slate', theme.dataset.theme === 'slate');
          rerender();
          return;
        }
        const pinSave = e.target.closest('[data-pin-save]');
        if (pinSave) {
          const input = body.querySelector('[data-pin-input]');
          const value = (input && input.value || '').trim();
          if (!/^\d{4,8}$/.test(value)) { toast('PIN must be 4–8 digits', 'err'); return; }
          store.set('lock.pin', value);
          toast('Startup PIN updated', 'ok');
          return;
        }
        const open = e.target.closest('[data-open]');
        if (open) {
          const target = open.dataset.open;
          if (target === 'memory') openMemory();
          if (target === 'hub') { close(); app.openPanel('hub', { tab: 'connectors' }); }
          if (target === 'hub-skills') { close(); app.openPanel('hub', { tab: 'skills' }); }
        }
      });

      body.addEventListener('change', (e) => {
        const model = e.target.closest('[data-model]');
        if (model) {
          store.set(`prefs.models.${model.dataset.model}`, model.value);
          toast(`${ROLE_LABEL[model.dataset.model]} routed to ${model.value}`, 'ok');
          app.chat && app.chat.setMode();
          return;
        }
        if (e.target.matches('[data-voice]')) {
          store.set('prefs.voice.voiceURI', e.target.value);
          toast('Voice preference saved');
          return;
        }
        const field = e.target.closest('[data-field]');
        if (field) {
          store.set(field.dataset.field, field.value.trim());
          toast('Saved', 'ok');
        }
      });

      /* memory manager */
      function openMemory() {
        const facts = () => store.get('memory.facts') || [];
        const list = () => facts().map((f, i) => `
          <div class="memory-item"><span>${escapeHtml(f)}</span><button data-del-memory="${i}" type="button" aria-label="Remove">✕</button></div>`).join('') ||
          '<p class="dim" style="font-size:12.5px">No facts yet. Nova will still remember the conversation.</p>';

        const m = openModal({
          title: 'Personal context & memory',
          sub: 'Facts Nova should carry across every conversation',
          body: `<div class="memory-list" id="memList">${list()}</div>
            <div class="field" style="margin-top:14px"><label for="memNew">Add a fact</label>
              <div style="display:flex;gap:8px"><input id="memNew" type="text" placeholder="Prefers short answers before noon" style="flex:1" /><button class="btn" id="memAdd" type="button">Add</button></div>
            </div>
            <div class="field"><label for="memImport">Import memory (one per line, or a JSON array)</label>
              <textarea id="memImport" placeholder='["Ships on Cloudflare Pages", "Dislikes filler"]'></textarea>
            </div>`,
          actions: [
            { label: 'Close' },
            {
              label: 'Import',
              kind: 'primary',
              onClick: (el) => {
                const raw = el.querySelector('#memImport').value.trim();
                if (!raw) return false;
                let items = [];
                try {
                  const parsed = JSON.parse(raw);
                  items = Array.isArray(parsed) ? parsed : [String(parsed)];
                } catch {
                  items = raw.split('\n').map((s) => s.trim()).filter(Boolean);
                }
                items.slice(0, 40).forEach((t) => store.remember(String(t)));
                toast(`${items.length} memory items imported`, 'ok');
                return false;
              }
            }
          ],
          onMount: (el) => {
            el.addEventListener('click', (ev) => {
              const del = ev.target.closest('[data-del-memory]');
              if (del) {
                store.update((d) => { d.memory.facts.splice(Number(del.dataset.delMemory), 1); });
                el.querySelector('#memList').innerHTML = list();
              }
            });
            el.querySelector('#memAdd').addEventListener('click', () => {
              const inp = el.querySelector('#memNew');
              store.remember(inp.value);
              inp.value = '';
              el.querySelector('#memList').innerHTML = list();
              toast('Memory updated', 'ok');
            });
          }
        });
        return m;
      }

      /* hydrate live status */
      getStatus(true).then((st) => {
        status = st;
        loading = false;
        store.set('councilStatus', st);
        refresh();
        app.syncStatus && app.syncStatus();
      }).catch(() => { loading = false; refresh(); });
    }
  });

  return panel;
}
