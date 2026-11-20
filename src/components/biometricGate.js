/* ============================================================
   NOVA // OS — startup security gate
   Optional face activation with a reticle scan, real webcam
   preview when granted, and a PIN fallback that is checked
   locally. Nothing is uploaded: the frame never leaves the tab.
   ============================================================ */
import { store, escapeHtml } from '../services/store.js';

export function mountBiometricGate({ onUnlock } = {}) {
  const root = document.getElementById('lockScreen');
  if (!root) return { unlock() {} };

  const msg = document.getElementById('lockMessage');
  const sub = document.getElementById('lockSub');
  const meter = document.getElementById('lockMeter');
  const pinForm = document.getElementById('lockPinForm');
  const pinInput = document.getElementById('lockPinInput');
  const reticle = document.getElementById('lockReticle');
  const video = document.getElementById('lockVideo');
  const scanBtn = document.getElementById('lockScanBtn');
  const pinBtn = document.getElementById('lockPinBtn');
  const skipBtn = document.getElementById('lockSkip');

  const user = escapeHtml(store.get('lock.user', 'Master Drippy Dee'));
  let stream = null;
  let busy = false;

  const setMsg = (text, state = '') => {
    msg.textContent = text;
    sub.innerHTML = state === 'denied'
      ? 'Check the PIN, or try the scan again.'
      : state === 'granted'
        ? 'Session keys stay server-side. Welcome back.'
        : 'Look at the sensor, or use your PIN.';
  };

  const setState = (state) => {
    root.classList.remove('is-scanning', 'is-denied', 'is-granted');
    if (state) root.classList.add(`is-${state}`);
  };

  const stopCam = () => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
    reticle.classList.remove('has-video');
  };

  const finish = (via) => {
    setState('granted');
    setMsg(`Welcome, ${user}`);
    meter.style.width = '100%';
    stopCam();
    setTimeout(() => {
      root.classList.add('is-unlocked');
      root.setAttribute('aria-hidden', 'true');
      onUnlock && onUnlock(via);
    }, 720);
  };

  const deny = (text = 'Access denied') => {
    setState('denied');
    setMsg(text, 'denied');
    meter.style.width = '0%';
    if (navigator.vibrate) navigator.vibrate(60);
  };

  const animateMeter = (ms) => {
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / ms);
      meter.style.width = `${Math.round(p * 100)}%`;
      if (p < 1 && root.classList.contains('is-scanning')) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  async function scan() {
    if (busy) return;
    busy = true;
    setState('scanning');
    setMsg('Scanning…');
    pinForm.hidden = true;
    animateMeter(2400);

    let live = false;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 320 }, audio: false });
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
          reticle.classList.add('has-video');
          live = true;
        }
      }
    } catch {
      live = false;
    }

    await new Promise((r) => setTimeout(r, 2300));
    busy = false;

    if (!live) {
      setState('');
      setMsg('No camera available');
      sub.textContent = store.get('lock.pin', '2026') === '2026' ? 'Nothing to scan. Use your PIN. Default PIN: 2026' : 'Nothing to scan. Use your PIN.';
      pinForm.hidden = false;
      setTimeout(() => pinInput && pinInput.focus(), 60);
      return;
    }
    finish('face');
  }

  function submitPin(e) {
    e.preventDefault();
    const expected = String(store.get('lock.pin', '2026'));
    const entered = (pinInput.value || '').trim();
    if (!entered) { pinInput.focus(); return; }
    if (entered === expected) {
      finish('pin');
    } else {
      pinInput.value = '';
      deny('Access denied');
      setTimeout(() => { if (!root.classList.contains('is-granted')) { setState(''); setMsg('Face activation required…'); } }, 2400);
    }
  }

  scanBtn.addEventListener('click', scan);
  pinBtn.addEventListener('click', () => {
    pinForm.hidden = !pinForm.hidden;
    if (!pinForm.hidden) pinInput.focus();
  });
  pinForm.addEventListener('submit', submitPin);
  skipBtn.addEventListener('click', () => finish('demo'));

  // spring straight to the gate unless it was disabled in Settings
  const enabled = store.get('lock.biometric', true);
  if (!enabled) {
    root.classList.add('is-unlocked');
    root.setAttribute('aria-hidden', 'true');
    setTimeout(() => onUnlock && onUnlock('disabled'), 60);
  }

  window.addEventListener('beforeunload', stopCam);

  return { unlock: () => finish('manual'), relock: () => root.classList.remove('is-unlocked') };
}
