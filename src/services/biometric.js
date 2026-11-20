/* ============================================================
   NOVA // OS — biometric helpers
   WebAuthn platform passkeys + face-api.js webcam face match.
   All credentials/descriptors stay in localStorage (store).
   ============================================================ */
import { store } from './store.js';

const FACE_API_CDN = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

let faceApiPromise = null;

export function isWebAuthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && typeof navigator.credentials.create === 'function');
}

export async function isPlatformAuthenticatorAvailable() {
  if (!isWebAuthnSupported()) return false;
  if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch { return false; }
  }
  return true;
}

export function loadFaceApi() {
  if (window.faceapi && window.__novaFaceModelsLoaded) {
    return Promise.resolve(window.faceapi);
  }
  if (faceApiPromise) return faceApiPromise;
  faceApiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = FACE_API_CDN;
    s.async = true;
    s.onload = async () => {
      try {
        const faceapi = window.faceapi;
        if (!faceapi) throw new Error('faceapi missing');
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        window.__novaFaceModelsLoaded = true;
        resolve(faceapi);
      } catch (e) {
        faceApiPromise = null;
        reject(e);
      }
    };
    s.onerror = () => { faceApiPromise = null; reject(new Error('face-api load failed')); };
    document.head.appendChild(s);
  });
  return faceApiPromise;
}

export async function registerPasskey() {
  if (!isWebAuthnSupported()) throw new Error('WebAuthn not supported');
  if (!location.hostname) throw new Error('WebAuthn requires a secure origin');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'NOVA // OS', id: location.hostname },
      user: { id: userId, name: 'nova-user', displayName: store.get('lock.user', 'Master') },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
      attestation: 'none'
    }
  });
  if (!cred) throw new Error('no credential returned');
  const id = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
  store.set('lock.webauthnCredentialId', id);
  return cred;
}

export async function authenticatePasskey() {
  const id = store.get('lock.webauthnCredentialId', null);
  if (!id || !isWebAuthnSupported()) return false;
  if (!location.hostname) return false;
  let rawId;
  try { rawId = Uint8Array.from(atob(id), (c) => c.charCodeAt(0)); }
  catch { return false; }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: rawId, transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000
      }
    });
    return !!assertion;
  } catch {
    return false;
  }
}

export function removePasskey() {
  store.set('lock.webauthnCredentialId', null);
}

export async function enrollFace(videoEl) {
  const faceapi = await loadFaceApi();
  const detection = await faceapi
    .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  const arr = Array.from(detection.descriptor);
  store.set('lock.faceDescriptor', arr);
  store.set('lock.faceEnrolledAt', Date.now());
  return arr;
}

export function enrolledDescriptor() {
  const d = store.get('lock.faceDescriptor', null);
  return d ? new Float32Array(d) : null;
}

export async function detectFaceDescriptor(videoEl) {
  const faceapi = await loadFaceApi();
  const detection = await faceapi
    .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  return detection.descriptor;
}

export function faceDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export function removeFace() {
  store.set('lock.faceDescriptor', null);
  store.set('lock.faceEnrolledAt', null);
}

export const FACE_THRESHOLD = 0.45;
