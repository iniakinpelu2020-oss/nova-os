/* ============================================================
   NOVA // OS — Text-to-Speech bridge
   POST /api/tts  { text, voiceId? }
   Supports ELEVENLABS_API_KEY (+ ELEVENLABS_VOICE_ID default
   "21m00Tcm4TlvDq8ikWAM") or FISH_AUDIO_API_KEY.
   Outputs audio/mpeg (MP3). No key reaches the browser.
   ============================================================ */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });

export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const text = String(payload && payload.text || '').trim();
  if (!text) return json({ error: '`text` required' }, 400);

  const elevenKey = env && env.ELEVENLABS_API_KEY;
  const fishKey = env && env.FISH_AUDIO_API_KEY;
  const voiceId = (env && env.ELEVENLABS_VOICE_ID) || '21m00Tcm4TlvDq8ikWAM';

  // ElevenLabs
  if (elevenKey) {
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.75 } })
      });
      if (!res.ok) return json({ error: `ElevenLabs ${res.status}` }, 502);
      const buf = await res.arrayBuffer();
      return new Response(buf, { status: 200, headers: { 'content-type': 'audio/mpeg', ...CORS } });
    } catch (err) {
      return json({ error: `ElevenLabs failed: ${err && err.message}` }, 502);
    }
  }

  // Fish Audio
  if (fishKey) {
    try {
      const res = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { authorization: `Bearer ${fishKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, reference_id: voiceId, format: 'mp3' })
      });
      if (!res.ok) return json({ error: `Fish Audio ${res.status}` }, 502);
      const buf = await res.arrayBuffer();
      return new Response(buf, { status: 200, headers: { 'content-type': 'audio/mpeg', ...CORS } });
    } catch (err) {
      return json({ error: `Fish Audio failed: ${err && err.message}` }, 502);
    }
  }

  return json({ error: 'No TTS provider configured. Set ELEVENLABS_API_KEY or FISH_AUDIO_API_KEY.' }, 503);
}