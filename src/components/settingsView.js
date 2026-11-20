/* ============================================================
   NOVA // OS — settings
   Vertical list: usage & quota, server status, model routing,
   preferences, memory, persona, voice, theme, biometrics.
   No core provider key inputs exist here by design.
   ============================================================ */
import { store, escapeHtml } from '../services/store.js';
import { getStatus } from '../services/aiCouncil.js';
import { isWebAuthnSupported, isPlatformAuthenticatorAvailable, registerPasskey, removePasskey, loadFaceApi, enrollFace, removeFace } from '../services/biometric.js';
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
          <div class="set-row__label"><b>Search endpoint</b><small>SearXNG instance used for citations</small></div>
          <div class="set-row__control"><input type="url" data-field="prefs.searxng" value="${escapeHtml(store.get('prefs.searxng'))}" style="width:190px" /></div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Default repository</b><small>Target for Push to GitHub</small></div>
          <div class="set-row__control"><input type="text" data-field="prefs.repo" value="${escapeHtml(store.get('prefs.repo'))}" style="width:190px" /></div>
        </div>
      </div>`;
  };

  const securityBlock = () => {
    const pin = store.get('lock.pin', '2026');
    const enrolled = !!store.get('lock.faceDescriptor', null);
    const passkey = !!store.get('lock.webauthnCredentialId', null);
    const enrolledAt = store.get('lock.faceEnrolledAt', null);
    return `
      <div class="settings-group">
        <div class="settings-group__title">Security &amp; Lock</div>
        <div class="set-row">
          <div class="set-row__label"><b>Lock screen at startup</b><small>Show the security gate when NOVA boots</small></div>
          ${switchHtml('lock.enabled', store.get('lock.enabled', true), 'Lock screen')}
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Face scan on lock screen</b><small>Allow “Scan Face” to unlock</small></div>
          ${switchHtml('lock.biometric', store.get('lock.biometric', true), 'Face scan')}
        </div>
        <div class="set-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="set-row__label"><b>Change PIN</b><small>4–6 digits. Requires current PIN.</small></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <input type="password" inputmode="numeric" maxlength="6" data-cur-pin placeholder="Current" style="width:96px" />
            <input type="password" inputmode="numeric" maxlength="6" data-new-pin placeholder="New" style="width:96px" />
            <input type="password" inputmode="numeric" maxlength="6" data-confirm-pin placeholder="Confirm" style="width:96px" />
            <button class="btn" data-change-pin type="button">Change PIN</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Webcam face enrollment</b><small>${enrolled ? `Enrolled ${enrolledAt ? new Date(enrolledAt).toLocaleDateString() : ''}` : 'Not enrolled'} · face-api.js</small></div>
          <div class="set-row__control">
            <button class="btn" data-enroll-face type="button">Register My Face</button>
            ${enrolled ? '<button class="btn" data-remove-face type="button">Remove</button>' : ''}
          </div>
        </div>
        <div class="set-row">
          <div class="set-row__label"><b>Hardware biometrics (WebAuthn)</b><small>${passkey ? 'Passkey registered' : 'Face Unlock / Fingerprint / Windows Hello'}</small></div>
          <div class="set-row__control">
            <button class="btn" data-register-passkey type="button">Register Passkey</button>
            ${passkey ? '<button class="btn" data-remove-passkey type="button">Remove</button>' : ''}
          </div>
        </div>
        <div class="set-row" data-enroll-preview hidden style="flex-direction:column;align-items:stretch;gap:8px">
          <video data-enroll-video autoplay playsinline muted style="width:100%;max-width:240px;border-radius:12px;background:#000"></video>
          <div style="display:flex;gap:6px">
            <button class="btn btn--primary" data-capture-face type="button">Capture Face</button>
            <button class="btn" data-cancel-enroll type="button">Cancel</button>
          </div>
          <small class="dim" data-enroll-status>Position your face in frame, then capture.</small>
        </div>
      </div>`;
  };

  const build = () => `
    <div style="padding:0 2px">${usageBlock()}${securityBlock()}${modelsBlock()}${prefsBlock()}
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
          if (path === 'lock.biometric') toast(next ? 'Face scan enabled' : 'Face scan disabled');
          if (path === 'lock.enabled') toast(next ? 'Lock screen enabled' : 'Lock screen disabled');
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
        const changePin = e.target.closest('[data-change-pin]');
        if (changePin) {
          const cur = (body.querySelector('[data-cur-pin]')?.value || '').trim();
          const nw = (body.querySelector('[data-new-pin]')?.value || '').trim();
          const cf = (body.querySelector('[data-confirm-pin]')?.value || '').trim();
          const expected = String(store.get('lock.pin', '2026'));
          if (cur !== expected) { toast('Current PIN incorrect', 'bad'); return; }
          if (!/^\d{4,6}$/.test(nw)) { toast('New PIN must be 4–6 digits', 'bad'); return; }
          if (nw !== cf) { toast('PINs do not match', 'bad'); return; }
          store.set('lock.pin', nw);
          body.querySelectorAll('[data-cur-pin],[data-new-pin],[data-confirm-pin]').forEach((i) => (i.value = ''));
          toast('Startup PIN updated', 'ok');
          return;
        }

        const enrollFaceBtn = e.target.closest('[data-enroll-face]');
        if (enrollFaceBtn) {
          const preview = body.querySelector('[data-enroll-preview]');
          if (preview) preview.hidden = false;
          const video = body.querySelector('[data-enroll-video]');
          if (video && navigator.mediaDevices) {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 320 }, audio: false })
              .then((s) => { video.srcObject = s; video.play().catch(() => {}); video.dataset.streamId = s.id; })
              .catch(() => toast('Camera access denied', 'bad'));
          }
          return;
        }

        const cancelEnroll = e.target.closest('[data-cancel-enroll]');
        if (cancelEnroll) {
          const video = body.querySelector('[data-enroll-video]');
          if (video && video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
          const preview = body.querySelector('[data-enroll-preview]');
          if (preview) preview.hidden = true;
          return;
        }

        const captureFace = e.target.closest('[data-capture-face]');
        if (captureFace) {
          const video = body.querySelector('[data-enroll-video]');
          const status = body.querySelector('[data-enroll-status]');
          if (status) status.textContent = 'Loading face models…';
          captureFace.disabled = true;
          (async () => {
            try {
              await loadFaceApi();
              const desc = await enrollFace(video);
              if (!desc) { if (status) status.textContent = 'No face detected. Try again.'; toast('No face detected', 'bad'); return; }
              if (status) status.textContent = 'Face enrolled successfully.';
              toast('Face enrolled', 'ok');
              if (video && video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
              const preview = body.querySelector('[data-enroll-preview]');
              if (preview) preview.hidden = true;
              rerender();
            } catch (e) {
              if (status) status.textContent = 'Enrollment failed.';
              toast('Face enrollment failed: ' + (e && e.message ? e.message : e), 'bad');
            } finally {
              captureFace.disabled = false;
            }
          })();
          return;
        }

        const removeFaceBtn = e.target.closest('[data-remove-face]');
        if (removeFaceBtn) {
          removeFace();
          toast('Face enrollment removed', 'ok');
          rerender();
          return;
        }

        const registerPasskeyBtn = e.target.closest('[data-register-passkey]');
        if (registerPasskeyBtn) {
          registerPasskeyBtn.disabled = true;
          (async () => {
            try {
              const avail = await isPlatformAuthenticatorAvailable();
              if (!avail) { toast('No platform authenticator available', 'bad'); return; }
              await registerPasskey();
              toast('Passkey registered', 'ok');
              rerender();
            } catch (e) {
              toast('Passkey registration failed: ' + (e && e.message ? e.message : e), 'bad');
            } finally {
              registerPasskeyBtn.disabled = false;
            }
          })();
          return;
        }

        const removePasskeyBtn = e.target.closest('[data-remove-passkey]');
        if (removePasskeyBtn) {
          removePasskey();
          toast('Passkey removed', 'ok');
          rerender();
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
