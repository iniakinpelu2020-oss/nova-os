/* ============================================================
   NOVA // OS — voice engine
   Dual TTS: /api/tts (ElevenLabs / Fish Audio MP3) with Web
   Audio unlock on first tap, with a seamless browser
   speechSynthesis fallback.
   STT: Web Speech API with live captions.
   ============================================================ */
import { store } from './store.js';
import { connectorById, connectorReady, connectorFetch } from './toolsEngine.js';

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

let currentAudio = null;
let speaking = false;
let recognition = null;
let listening = false;
let captionTimer = null;
let audioUnlocked = false;

export const voiceEvents = new EventTarget();

function emitCaption(text, done = false) {
  const el = document.getElementById('stageCaption');
  const txt = document.getElementById('stageCaptionText');
  if (!el || !txt) return;
  clearTimeout(captionTimer);
  if (!text) {
    el.hidden = true;
    txt.textContent = '';
    return;
  }
  el.hidden = false;
  txt.textContent = text;
  if (done) {
    captionTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
}

export function stripMarkdown(text = '') {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' code omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sentences(text) {
  const clean = stripMarkdown(text).replace(/\\n+/g, ' ');
  const parts = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    const piece = p.trim();
    if (!piece) continue;
    if ((buf + ' ' + piece).length > 240) {
      if (buf) chunks.push(buf.trim());
      buf = piece;
    } else {
      buf = `${buf} ${piece}`.trim();
    }
  }
  if (buf) chunks.push(buf.trim());
  return chunks.slice(0, 14);
}

export function voicesAvailable() {
  if (!synth || typeof synth.getVoices !== 'function') return [];
  return synth.getVoices().filter((v) => /en/i.test(v.lang));
}

function setSpeaking(on) {
  speaking = on;
  document.body.classList.toggle('is-speaking', on);
  voiceEvents.dispatchEvent(new CustomEvent('speaking', { detail: { on } }));
}

// Unlock audio on first user tap (mobile Safari / Android Chrome).
export function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      ctx.close().catch(() => {});
    }
    const a = new Audio();
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    a.play().then(() => { audioUnlocked = true; }).catch(() => {});
  } catch { /* noop */ }
}

function playBase64(base64, contentType = 'audio/mpeg') {
  return new Promise((resolve, reject) => {
    try {
      const audio = new Audio(`data:${contentType};base64,${base64}`);
      currentAudio = audio;
      audio.onended = () => { currentAudio = null; resolve(); };
      audio.onerror = () => { currentAudio = null; reject(new Error('Audio decode failed')); };
      audio.play().catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function tryStudioVoice(text) {
  // 1) Server-side /api/tts (ElevenLabs / Fish Audio → MP3)
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      await new Promise((resolve, reject) => {
        audio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; reject(new Error('audio')); };
        audio.play().catch(reject);
      });
      return true;
    }
  } catch { /* fall through */ }

  // 2) Legacy connector proxy
  try {
    const { connectorById, connectorReady, connectorFetch } = await import('./toolsEngine.js');
    const c = connectorById('voice');
    if (connectorReady(c)) {
      const v = c.values;
      const provider = (v.provider || 'ElevenLabs').toLowerCase();
      const url = provider.includes('fish')
        ? 'https://api.fish.audio/v1/tts'
        : `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.voiceId)}`;
      const headers = provider.includes('fish')
        ? { 'content-type': 'application/json', authorization: v.apiKey }
        : { 'content-type': 'application/json', 'xi-api-key': v.apiKey, accept: 'audio/mpeg' };
      const body = provider.includes('fish')
        ? { text, reference_id: v.voiceId, format: 'mp3' }
        : { text, model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.75 } };
      const out = await connectorFetch({ url, method: 'POST', headers, body });
      if (out.ok && out.base64) {
        await playBase64(out.base64, out.contentType || 'audio/mpeg');
        return true;
      }
    }
  } catch { /* fall through */ }
  return false;
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    if (!synth) return resolve(false);
    const prefs = store.get('prefs.voice', {});
    const chunks = sentences(text);
    if (!chunks.length) return resolve(false);
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return resolve(true);
      const chunk = chunks[i++];
      const u = new SpeechSynthesisUtterance(chunk);
      const voices = voicesAvailable();
      const chosen = voices.find((v) => v.voiceURI === prefs.voiceURI) || voices[0];
      if (chosen) u.voice = chosen;
      u.rate = Number(prefs.rate) || 1;
      u.pitch = Number(prefs.pitch) || 1;
      u.volume = 1;
      u.onstart = () => { emitCaption(chunk); setSpeaking(true); };
      u.onend = () => { next(); };
      u.onerror = () => { resolve(false); };
      synth.speak(u);
    };
    next();
  });
}

export async function speak(text, { force = false } = {}) {
  if (!text) return false;
  if (!force && store.get('prefs.voice.muted', false)) return false;
  cancel();
  setSpeaking(true);
  emitCaption(sentences(text)[0] || '');
  try {
    const studio = await tryStudioVoice(text);
    if (studio) {
      emitCaption('');
      setSpeaking(false);
      return true;
    }
  } catch { /* fall through to browser voice */ }
  const ok = await speakBrowser(text);
  setSpeaking(false);
  emitCaption('', true);
  return ok;
}

export function cancel() {
  try { if (synth) synth.cancel(); } catch { /* noop */ }
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* noop */ }
    currentAudio = null;
  }
  setSpeaking(false);
  speakBrowser._stop = true;
}

export function isSpeaking() {
  return speaking;
}

/* ── speech recognition ── */
export function sttSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function listen({ onInterim, onFinal, onEnd, onError } = {}) {
  if (listening) { stopListening(); return false; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onError && onError('Speech recognition is not available in this browser');
    return false;
  }
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    document.body.classList.add('is-listening');
    emitCaption('Listening…');
  };
  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) final += res[0].transcript;
      else interim += res[0].transcript;
    }
    if (interim) {
      emitCaption(interim);
      onInterim && onInterim(interim);
    }
    if (final) {
      emitCaption(final, true);
      onFinal && onFinal(final.trim());
    }
  };
  recognition.onerror = (e) => {
    listening = false;
    document.body.classList.remove('is-listening');
    onError && onError(e.error || 'microphone error');
  };
  recognition.onend = () => {
    if (!listening) return;
    listening = false;
    document.body.classList.remove('is-listening');
    emitCaption('', true);
    onEnd && onEnd();
  };

  try {
    recognition.start();
    return true;
  } catch (err) {
    listening = false;
    onError && onError(err.message);
    return false;
  }
}

export function stopListening() {
  if (recognition) {
    try { recognition.stop(); } catch { /* noop */ }
  }
  listening = false;
  document.body.classList.remove('is-listening');
}

export function isListening() {
  return listening;
}

/* voices load asynchronously in Chromium */
if (synth) {
  try { synth.getVoices(); } catch { /* noop */ }
  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', () => voiceEvents.dispatchEvent(new CustomEvent('voices')));
  }
}
/* unlock audio on first tap anywhere */
if (typeof document !== 'undefined') {
  const once = () => { unlockAudio(); document.removeEventListener('click', once); document.removeEventListener('touchstart', once); };
  document.addEventListener('click', once, { once: true });
  document.addEventListener('touchstart', once, { once: true });
}