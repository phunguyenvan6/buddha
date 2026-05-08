const video         = document.getElementById('video');
const canvas        = document.getElementById('canvas');
const permScreen    = document.getElementById('perm-screen');
const startBtn      = document.getElementById('start-btn');
const confFill      = document.getElementById('conf-fill');
const mantraEl      = document.getElementById('mantra');
const instructionEl = document.getElementById('instruction');
const loaderEl      = document.getElementById('loader');

const detector  = new GestureDetector();
let   renderer  = null;
let   lastTime  = performance.now();
let   videoRect = { x: 0, y: 0, w: 0, h: 0 };

// ── Canvas / video sizing ─────────────────────────────────────────────────────
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  computeVideoRect();
  if (renderer) renderer.videoRect = videoRect;
}

function computeVideoRect() {
  const vw = video.videoWidth  || 1280;
  const vh = video.videoHeight || 720;
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / vw, ch / vh);
  videoRect = {
    x: (cw - vw * scale) / 2,
    y: (ch - vh * scale) / 2,
    w: vw * scale,
    h: vh * scale,
  };
}

window.addEventListener('resize', resize);
resize();

// ── MediaPipe Holistic setup ──────────────────────────────────────────────────
const holistic = new Holistic({
  locateFile: f => `./node_modules/@mediapipe/holistic/${f}`,
});

holistic.setOptions({
  modelComplexity:        1,
  smoothLandmarks:        true,
  minDetectionConfidence: 0.55,
  minTrackingConfidence:  0.50,
});

// ── Per-frame processing ──────────────────────────────────────────────────────
function onFrame(results) {
  if (!renderer) return;

  const now = performance.now();
  const dt  = Math.min((now - lastTime) / 1000, 0.1);
  lastTime  = now;

  computeVideoRect();
  renderer.videoRect = videoRect;

  const gesture = detector.detect(results, videoRect);
  renderer.update(gesture, dt);
  renderer.render(gesture);

  confFill.style.width = `${(gesture.confidence * 100).toFixed(1)}%`;
  const p = gesture.isPrayer;
  confFill.style.background = p
    ? 'linear-gradient(90deg,#b8860b,#ffd700,#fffacd)'
    : 'linear-gradient(90deg,#3a5fa0,#6ab)';
  mantraEl.style.opacity      = p ? '1' : '0';
  instructionEl.style.opacity = p ? '0' : '1';
}

// ── Start button ──────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  startBtn.disabled    = true;
  startBtn.textContent = 'Đang kết nối…';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();

    computeVideoRect();
    renderer = new EffectsRenderer(canvas, video);
    renderer.videoRect = videoRect;

    permScreen.style.opacity     = '0';
    permScreen.style.pointerEvents = 'none';
    setTimeout(() => permScreen.remove(), 600);

    loaderEl.style.display = 'flex';

    // First frame: hide loader, then hand off to onFrame for all subsequent frames
    holistic.onResults(results => {
      loaderEl.style.display = 'none';
      holistic.onResults(onFrame);
      onFrame(results);
    });

    const cam = new Camera(video, {
      onFrame: async () => holistic.send({ image: video }),
      width: 1280, height: 720,
    });
    cam.start();

  } catch (err) {
    alert('Không thể mở camera: ' + err.message);
    startBtn.disabled    = false;
    startBtn.textContent = 'Bắt Đầu';
  }
});
