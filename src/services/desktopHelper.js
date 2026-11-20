/* NOVA // OS — local desktop helper client (Phase 1-8) */
import { store } from './store.js';

const DEFAULT_URL = 'http://127.0.0.1:8787';

export function helperBase() {
  return (store.get('prefs.helperUrl', DEFAULT_URL) || DEFAULT_URL).replace(/\/+$/, '');
}

export function helperToken() {
  return store.get('prefs.helperToken', '') || '';
}

export function helperConfigured() {
  return Boolean(helperToken());
}

export async function helperHealth() {
  try {
    const res = await fetch(`${helperBase()}/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function helperAction(action, args = {}) {
  const token = helperToken();
  if (!token) return { ok: false, error: 'Helper token not configured' };
  // Security toggles
  const toggles = store.get('prefs.helperToggles', {}) || {};
  const needsInput = ['type_text', 'press_keys', 'mouse_click'].includes(action);
  const needsVision = action === 'capture_screen';
  if (needsInput && !toggles.inputControl) return { ok: false, error: 'Input control is OFF' };
  if (needsVision && !toggles.screenVision) return { ok: false, error: 'Screen vision is OFF' };
  try {
    const res = await fetch(`${helperBase()}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nova-token': token },
      body: JSON.stringify({ action, args })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.detail || data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

export const HELPER_ACTIONS = [
  'open_app', 'open_folder', 'read_file', 'list_folder', 'write_file', 'delete_file',
  'list_windows', 'focus_window', 'move_window', 'resize_window', 'minimize_window', 'maximize_window', 'close_window',
  'type_text', 'press_keys', 'mouse_click',
  'capture_screen', 'tts'
];