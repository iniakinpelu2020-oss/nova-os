/* ============================================================
   NOVA // OS — Vision, Screen Co-Pilot & Ad Studio
   Real capture (getDisplayMedia / getUserMedia), local frame
   analysis, multimodal hand-off when env keys exist, video link
   summarising through the reader bridge, and social staging
   that always asks before publishing.
   ============================================================ */
import { store, escapeHtml, uid } from '../services/store.js';
import { readWebpage, connectorById, connectorFetch, postToConnector } from '../services/toolsEngine.js';
import { api, describeError } from '../services/net.js';
import { openPanel, toast, copyText } from '../services/ui.js';

function frameStats(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const w = Math.min(64, img.width);
      const h = Math.max(1, Math.round((img.height / img.width) * w));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      let r = 0, g = 0, b = 0, lum = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
        lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      const n = data.length / 4;
      resolve({
        width: img.width,
        height: img.height,
        orientation: img.width >= img.height ? 'landscape' : 'portrait',
        rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
        brightness: Math.round((lum / n / 255) * 100)
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export function openVisionPanel(app, opts = {}) {
  let stream = null;
  const hasScreenShare = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  let mode = hasScreenShare ? 'screen' : 'camera';
  let frame = null;
  let busy = false;
  let lastRead = '';
  let adDraft = null;

  const stopStream = () => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    document.querySelectorAll('#visionVideo, #visionShot').forEach((v) => { if (v.tagName === 'VIDEO') v.srcObject = null; });
  };

  const shell = () => `
    <div class="vision">
      <div class="mode-toggle" id="visionMode">
        <button data-mode="screen" class="${mode === 'screen' ? 'is-active' : ''}" type="button" ${hasScreenShare ? '' : 'disabled'}>Screen</button>
        <button data-mode="camera" class="${mode === 'camera' ? 'is-active' : ''}" type="button">Camera</button>
      </div>
      ${hasScreenShare ? '' : '<p class="vision-note">Screen share requires desktop — using camera/upload instead.</p>'}

      <div class="vision-stage" id="visionStage">
        <div class="vision-empty" id="visionEmpty">
          <b>Nothing captured yet</b>
          <span>${mode === 'screen' ? 'Share a window or tab to walk through it together.' : 'Open the camera for a snapshot and a read of what is in frame.'}</span>
        </div>
      </div>

      <div class="vision-actions">
        <button class="btn btn--primary" id="visionShare" type="button">${mode === 'screen' ? 'Share screen' : 'Open camera'}</button>
        <button class="btn" id="visionSnap" type="button" disabled>Capture frame</button>
        <button class="btn" id="visionAsk" type="button" disabled>Ask Nova about this</button>
        <button class="btn btn--ghost" id="visionStop" type="button" hidden>Stop</button>
      </div>
      <p class="vision-note">Frames stay in this tab unless you press <b>Ask Nova</b> with a live vision model configured. Nothing is written to storage.</p>
      <div id="visionRead"></div>

      <div style="height:1px;background:var(--line);margin:20px 0"></div>

      <h4 style="font-size:13px;font-weight:500;letter-spacing:-.01em">Summarize a video or link</h4>
      <div class="field" style="margin-top:8px">
        <div style="display:flex;gap:8px">
          <input id="visionUrl" type="url" placeholder="https://youtube.com/watch?v=…" style="flex:1" />
          <button class="btn" id="visionSum" type="button">Summarize</button>
        </div>
        <small>Reads the page through the Jina reader bridge, then hands the text to Nova.</small>
      </div>
      <div id="visionSummary"></div>

      <div style="height:1px;background:var(--line);margin:20px 0"></div>

      <h4 style="font-size:13px;font-weight:500;letter-spacing:-.01em">Stage a post</h4>
      <p class="vision-note" style="margin-top:4px">Nova drafts hooks and a shot list. Publishing goes through your Social connector only after you approve it.</p>
      <div class="field" style="margin-top:10px">
        <textarea id="adBrief" placeholder="What is the post about? e.g. launch of the spatial studio site, 15s vertical reel"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="adDraftBtn" type="button">Draft hooks &amp; shot list</button>
        <button class="btn btn--ghost" id="adUpload" type="button">Attach media</button>
      </div>
      <div id="adOut"></div>
    </div>`;

  const panel = openPanel({
    id: 'vision',
    title: 'Vision & Ad Studio',
    sub: 'SCREEN CO-PILOT · CAMERA · SOCIAL',
    icon: '🎨',
    wide: true,
    body: shell(),
    onMount: ({ body, wrap, close }) => {
      const stage = body.querySelector('#visionStage');
      const shareBtn = body.querySelector('#visionShare');
      const snapBtn = body.querySelector('#visionSnap');
      const askBtn = body.querySelector('#visionAsk');
      const stopBtn = body.querySelector('#visionStop');
      const readOut = body.querySelector('#visionRead');

      const paintEmpty = () => {
        stage.innerHTML = `<div class="vision-empty"><b>Nothing captured yet</b><span>${mode === 'screen' ? 'Share a window or tab to walk through it together.' : 'Open the camera for a snapshot and a read of what is in frame.'}</span></div>`;
      };

      const start = async () => {
        stopStream();
        try {
          stream = mode === 'screen'
            ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false })
            : await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280 }, audio: false });
          stage.innerHTML = `<video id="visionVideo" autoplay playsinline muted></video>`;
          const v = body.querySelector('#visionVideo');
          v.srcObject = stream;
          await v.play().catch(() => {});
          snapBtn.disabled = false;
          stopBtn.hidden = false;
          if (mode === 'screen') {
            stream.getVideoTracks()[0].addEventListener('ended', () => { stopStream(); paintEmpty(); snapBtn.disabled = true; stopBtn.hidden = true; });
          }
        } catch (err) {
          toast(err && err.name === 'NotAllowedError' ? 'Capture permission was denied' : describeError(err), 'bad');
          paintEmpty();
        }
      };

      const snapshot = async () => {
        const v = body.querySelector('#visionVideo');
        if (!v || !v.videoWidth) { toast('No live frame to capture'); return; }
        const c = document.createElement('canvas');
        c.width = Math.min(1280, v.videoWidth);
        c.height = Math.round((v.videoHeight / v.videoWidth) * c.width);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        frame = c.toDataURL('image/jpeg', 0.82);
        stage.innerHTML = `<img id="visionShot" src="${frame}" alt="Captured frame" />`;
        askBtn.disabled = false;
        stopBtn.hidden = true;
        stopStream();
        const stats = await frameStats(frame);
        readOut.innerHTML = `<div class="vision-result">
          <div style="font-size:10px;letter-spacing:.16em;color:var(--mute);text-transform:uppercase">Frame captured</div>
          <p style="margin-top:6px;font-size:12.5px;color:var(--dim)">
            ${stats ? `${stats.width}×${stats.height} · ${stats.orientation} · average brightness ${stats.brightness}% · avg rgb(${stats.rgb.join(', ')})` : 'Frame held in memory.'}
          </p>
          <p style="margin-top:8px;font-size:12px;color:var(--mute)">Press <b>Ask Nova about this</b> to send the frame to a multimodal model.</p>
        </div>`;
        toast('Frame captured', 'ok');
      };

      const ask = async () => {
        if (!frame || busy) return;
        busy = true;
        askBtn.textContent = 'Reading…';
        try {
          if (app.isDemo()) {
            const stats = await frameStats(frame);
            lastRead = [
              '**Demo read** — no multimodal key is loaded, so this is measured locally rather than described by a model.',
              '',
              stats ? `- Capture: ${stats.width}×${stats.height}, ${stats.orientation}` : '- Capture held in memory',
              stats ? `- Average brightness: ${stats.brightness}%` : '',
              stats ? `- Dominant tone: rgb(${stats.rgb.join(', ')})` : '',
              '',
              'Connect Vertex, Groq or Workers AI in the Pages environment and the same frame goes to a vision model for a genuine walkthrough — controls, error text and next actions included.'
            ].filter(Boolean).join('\n');
          } else {
            const res = await api('/api/council', {
              method: 'POST',
              timeout: 60000,
              body: {
                messages: [{ role: 'user', content: 'You are a screen co-pilot. Read this frame: name the app or page, quote any error text, and give the two most useful next actions. Be specific and brief.' }],
                images: [frame],
                role: 'chat',
                effort: 'efficient'
              }
            });
            lastRead = res.text || 'The model returned an empty answer.';
          }
          readOut.innerHTML = `<div class="vision-result">
            <div class="md" style="font-size:13px">${lastRead.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</div>
            <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn--sm" id="readToChat" type="button">Send to chat</button></div>
          </div>`;
          body.querySelector('#readToChat').addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('nova:send', { detail: { text: `Screen co-pilot read:\n\n${lastRead}` } }));
            close();
          });
        } catch (err) {
          toast(describeError(err), 'bad');
        } finally {
          busy = false;
          askBtn.textContent = 'Ask Nova about this';
        }
      };

      shareBtn.addEventListener('click', start);
      snapBtn.addEventListener('click', snapshot);
      askBtn.addEventListener('click', ask);
      stopBtn.addEventListener('click', () => { stopStream(); paintEmpty(); snapBtn.disabled = true; stopBtn.hidden = true; });

      body.querySelector('#visionMode').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (!b) return;
        mode = b.dataset.mode;
        body.querySelectorAll('#visionMode button').forEach((x) => x.classList.toggle('is-active', x === b));
        shareBtn.textContent = mode === 'screen' ? 'Share screen' : 'Open camera';
        stopStream();
        paintEmpty();
      });

      /* summariser */
      body.querySelector('#visionSum').addEventListener('click', async () => {
        const url = body.querySelector('#visionUrl').value.trim();
        const out = body.querySelector('#visionSummary');
        if (!url) { toast('Paste a link first'); return; }
        out.innerHTML = '<div class="vision-result dim">Reading the page…</div>';
        const page = await readWebpage(url);
        if (!page.ok) {
          out.innerHTML = `<div class="vision-result"><b>Reader unavailable</b><p class="dim" style="font-size:12px;margin-top:4px">${escapeHtml(page.error || '')}</p></div>`;
          return;
        }
        document.dispatchEvent(new CustomEvent('nova:send', {
          detail: { text: `Summarize this source in five bullets and flag anything that contradicts itself.\n\nURL: ${url}\n\n${page.text.slice(0, 4000)}` }
        }));
        close();
      });

      /* ad studio */
      body.querySelector('#adDraftBtn').addEventListener('click', async () => {
        const brief = body.querySelector('#adBrief').value.trim() || 'A launch post for NOVA // OS';
        const out = body.querySelector('#adOut');
        out.innerHTML = '<div class="vision-result dim">Drafting…</div>';
        try {
          const { runAgent } = await import('../services/aiCouncil.js');
          let text = '';
          await runAgent({
            prompt: `Write a short social ad package for: ${brief}. Return exactly: three hooks (one line each), a 90-word caption, and a five-shot vertical video shot list with on-screen text.`,
            mode: 'chat',
            onEvent: (e) => { if (e.type === 'text') text = e.text; if (e.type === 'final') text = e.message.text; }
          });
          adDraft = { brief, text: text || '', ts: Date.now() };
          out.innerHTML = `<div class="ad-card">
            <div class="ad-card__label">Staged draft · not published</div>
            <h4>${escapeHtml(brief)}</h4>
            <p style="white-space:pre-wrap;font-size:12.5px;color:#cbd2e0;margin-top:8px;line-height:1.6">${escapeHtml(adDraft.text.slice(0, 1400))}</p>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn btn--sm btn--primary" id="adApprove" type="button">✅ Approve &amp; publish via webhook</button>
              <button class="btn btn--sm" id="adEdit" type="button">✏️ Edit caption</button>
            </div>
          </div>`;
          body.querySelector('#adEdit').addEventListener('click', () => {
            const ta = document.createElement('textarea');
            ta.className = 'field';
            ta.style.cssText = 'width:100%;min-height:120px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:12.5px';
            ta.value = adDraft.text;
            const node = body.querySelector('.ad-card p');
            node.replaceWith(ta);
            ta.focus();
            ta.addEventListener('blur', () => { adDraft.text = ta.value; });
          });
          body.querySelector('#adApprove').addEventListener('click', async () => {
            const c = connectorById('social');
            if (!c || !c.enabled) {
              toast('Social connector is not configured — draft kept locally', 'bad');
              return;
            }
            const res = await connectorFetch({
              url: c.values.endpoint,
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(c.values.authHeader ? { authorization: c.values.authHeader } : {}) },
              body: { caption: adDraft.text, platforms: (c.values.platforms || 'instagram').split(',').map((s) => s.trim()), brief: adDraft.brief }
            });
            toast(res.ok ? 'Publish request accepted by your webhook' : `Publish failed: ${res.error}`, res.ok ? 'ok' : 'bad');
          });
        } catch (err) {
          out.innerHTML = `<div class="vision-result">Draft failed: ${escapeHtml(describeError(err))}</div>`;
        }
      });

      body.querySelector('#adUpload').addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*,video/*';
        inp.addEventListener('change', () => {
          const f = inp.files && inp.files[0];
          if (!f) return;
          store.update((d) => d.library.unshift({ id: uid('lib'), kind: 'media', title: f.name, meta: `${f.type || 'media'} · ${Math.round(f.size / 1024)} KB`, ts: Date.now() }));
          toast(`${f.name} added to the media index`, 'ok');
        });
        inp.click();
      });

      if (opts.share) setTimeout(start, 260);
      if (opts.camera) { mode = 'camera'; setTimeout(start, 260); }

      wrap.addEventListener('transitionend', () => {
        if (!wrap.classList.contains('is-open')) stopStream();
      });
    }
  });

  return panel;
}
