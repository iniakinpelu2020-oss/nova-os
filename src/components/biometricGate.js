/* ============================================================
   NOVA // OS — startup security gate
   Optional face activation with a reticle scan, real webcam
   preview when granted, and a PIN fallback that is checked
   locally. Nothing is uploaded: the frame never leaves the tab.
   ============================================================ */
import { store, escapeHtml } from '../services/store.js';
import { isWebAuthnSupported, authenticatePasskey, loadFaceApi, enrolledDescriptor, detectFaceDescriptor, faceDistance, FACE_THRESHOLD } from '../services/biometric.js';

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
    pinForm.hidden = true;

    const hasPasskey = !!store.get('lock.webauthnCredentialId', null);
    const hasFace = !!store.get('lock.faceDescriptor', null);

    // 1) Hardware biometrics / WebAuthn passkey (one tap)
    if (hasPasskey && isWebAuthnSupported()) {
      setState('scanning');
      setMsg('Verifying biometrics…');
      animateMeter(1500);
      const ok = await authenticatePasskey();
      busy = false;
      if (ok) { finish('passkey'); return; }
      deny('Biometric check failed');
      setTimeout(() => { if (!root.classList.contains('is-granted')) { setState(''); setMsg('Face activation required…'); } }, 2400);
      return;
    }

    // 2) Webcam face match via face-api.js
    if (hasFace) {
      setState('scanning');
      setMsg('Scanning face…');
      animateMeter(6000);
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
      } catch { live = false; }

      if (!live) {
        busy = false;
        setState('');
        setMsg('No camera available');
        sub.textContent = 'Camera blocked. Use your PIN.';
        pinForm.hidden = false;
        setTimeout(() => pinInput && pinInput.focus(), 60);
        return;
      }

      const enrolled = enrolledDescriptor();
      let matched = false;
      const deadline = Date.now() + 9000;
      try {
        await loadFaceApi();
      } catch {
        // fall through; no match possible
      }
      while (Date.now() < deadline && !matched) {
        try {
          const desc = await detectFaceDescriptor(video);
          if (desc && enrolled) {
            const d = faceDistance(desc, enrolled);
            if (d < FACE_THRESHOLD) { matched = true; break; }
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 700));
      }

      stopCam();
      busy = false;
      if (matched) {
        finish('face');
      } else {
        deny('Face not recognized');
        setTimeout(() => { if (!root.classList.contains('is-granted')) { setState(''); setMsg('Face activation required…'); } }, 2400);
      }
      return;
    }

    // 3) No enrollment: legacy camera scan fallback (demo)
    setState('scanning');
    setMsg('Scanning…');
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
    } catch { live = false; }

    await new Promise((r) => setTimeout(r, 2300));
    busy = false;

    if (!live) {
      setState('');
      setMsg('No face enrolled');
      sub.textContent = 'Register a face in Settings → Security & Lock, or use your PIN.';
      pinForm.hidden = false;
      setTimeout(() => pinInput && pinInput.focus(), 60);
      return;
    }
    stopCam();
    deny('No face enrolled — use PIN');
    setTimeout(() => { if (!root.classList.contains('is-granted')) { setState(''); setMsg('Face activation required…'); pinForm.hidden = false; } }, 2400);
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
  scanBtn.hidden = !store.get('lock.biometric', true);
  pinBtn.addEventListener('click', () => {
    pinForm.hidden = !pinForm.hidden;
    if (!pinForm.hidden) pinInput.focus();
  });
  pinForm.addEventListener('submit', submitPin);
  skipBtn.addEventListener('click', () => finish('demo'));

  // spring straight to the gate unless lock screen disabled in Settings
  const lockEnabled = store.get('lock.enabled', true);
  if (!lockEnabled) {
    root.classList.add('is-unlocked');
    root.setAttribute('aria-hidden', 'true');
    setTimeout(() => onUnlock && onUnlock('disabled'), 60);
  }

  window.addEventListener('beforeunload', stopCam);

  return { unlock: () => finish('manual'), relock: () => root.classList.remove('is-unlocked') };
}
