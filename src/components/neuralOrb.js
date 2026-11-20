/* ============================================================
   NOVA // OS — 3D neural orb
   A dotted Fibonacci sphere rendered on a 2D canvas with depth
   shading, slow rotation and audio-reactive expansion. No
   three.js, no shaders, no build step.
   ============================================================ */

const TAU = Math.PI * 2;

export function mountOrb(canvas) {
  if (!canvas) return { setState() {}, setLevel() {}, destroy() {} };
  const ctx = canvas.getContext('2d');
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0;
  let h = 0;
  let raf = 0;
  let running = true;
  let state = 'idle';
  let level = 0;
  let target = 0;
  let time = 0;

  const COUNT = 780;
  const points = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (i / (COUNT - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points.push({
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
      seed: Math.random() * TAU
    });
  }

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width || window.innerWidth;
    h = rect.height || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const palette = () => {
    const serious = document.body.classList.contains('serious');
    return serious
      ? { dot: '225, 29, 72', glow: '245, 184, 75', core: '255, 210, 220' }
      : { dot: '139, 156, 255', glow: '192, 132, 252', core: '225, 232, 255' };
  };

  const draw = () => {
    if (!running) return;
    raf = requestAnimationFrame(draw);
    time += 0.006;
    level += (target - level) * 0.08;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * (state === 'speaking' ? 0.21 : 0.19);
    const R = base * (1 + level * 0.22 + Math.sin(time * 1.6) * 0.008);
    const c = palette();
    const speed = state === 'thinking' ? 1.9 : state === 'speaking' ? 1.25 : 0.55;
    const rotY = time * speed;
    const rotX = Math.sin(time * 0.42) * 0.26;

    // ambient core glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.4);
    grad.addColorStop(0, `rgba(${c.dot}, ${0.1 + level * 0.08})`);
    grad.addColorStop(0.55, `rgba(${c.glow}, 0.035)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const projected = points.map((p) => {
      // rotate Y
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      let x = p.x * cosY + p.z * sinY;
      let z = -p.x * sinY + p.z * cosY;
      // rotate X
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);
      const y = p.y * cosX - z * sinX;
      z = p.y * sinX + z * cosX;

      const wobble = state === 'speaking' || state === 'listening'
        ? 1 + Math.sin(time * 5 + p.seed) * 0.035 * (0.6 + level)
        : 1;

      return { x: x * R * wobble, y: y * R * wobble, z, seed: p.seed };
    }).sort((a, b) => a.z - b.z);

    for (const p of projected) {
      const depth = (p.z + 1) / 2;              // 0 back … 1 front
      const px = cx + p.x;
      const py = cy + p.y;
      const size = 0.55 + depth * 1.75;
      const alpha = 0.14 + depth * 0.78;
      const pulse = state === 'speaking' ? 0.6 + 0.4 * Math.sin(time * 7 + p.seed) : 1;
      ctx.beginPath();
      ctx.fillStyle = depth > 0.82
        ? `rgba(${c.core}, ${alpha * 0.85})`
        : `rgba(${c.dot}, ${alpha * pulse})`;
      ctx.arc(px, py, size, 0, TAU);
      ctx.fill();
    }

    // orbital rings
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotX * 0.6);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${c.dot}, ${0.1 - i * 0.02})`;
      ctx.lineWidth = 1;
      ctx.ellipse(0, 0, R * (1.32 + i * 0.12), R * (0.36 + i * 0.06), rotY * 0.35 + i * 0.7, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    // level halo
    if (level > 0.02) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${c.glow}, ${0.22 + level * 0.3})`;
      ctx.lineWidth = 1.2;
      ctx.arc(cx, cy, R * 1.42 + level * 26, 0, TAU);
      ctx.stroke();
    }
  };

  resize();
  window.addEventListener('resize', resize);
  raf = requestAnimationFrame(draw);

  return {
    setState(next) { state = next; },
    setLevel(v) { target = Math.max(0, Math.min(1, v)); },
    resize,
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    }
  };
}

/** Simple microphone level meter for the voice overlay. */
export async function createMicMeter() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    return {
      read() {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        return Math.min(1, (sum / buf.length) / 90);
      },
      stop() {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      }
    };
  } catch {
    return null;
  }
}
