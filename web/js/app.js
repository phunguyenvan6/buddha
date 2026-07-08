const video         = document.getElementById('video');
const canvas        = document.getElementById('canvas');
const permScreen    = document.getElementById('perm-screen');
const startBtn      = document.getElementById('start-btn');
const confFill      = document.getElementById('conf-fill');
const mantraEl      = document.getElementById('mantra');
const instructionEl = document.getElementById('instruction');
const loaderEl      = document.getElementById('loader');
const errorEl       = document.getElementById('perm-error');

const detector = new GestureDetector();
let   renderer = null;

// Gesture mới nhất do MediaPipe cung cấp (cập nhật ~15–30fps).
// Render loop chạy riêng bằng requestAnimationFrame để hình luôn mượt ~60fps.
let latestGesture = {
  confidence: 0, isPrayer: false,
  handCenter: null, headPos: null, torsoPos: null, faceWidth: 0,
};
let started     = false;
let lastTime    = 0;
let bell        = null;   // BellSound, tạo sau khi người dùng bấm Bắt Đầu
let firstResult = false;  // đã nhận kết quả đầu tiên từ model chưa
let modelTimer  = null;   // timeout phát hiện model không tải được

// ── Canh kích thước canvas / vùng video ─────────────────────────────────────
let videoRect = { x: 0, y: 0, w: 0, h: 0 };

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
  if (renderer) renderer.videoRect = videoRect;
}

// Dùng devicePixelRatio để nét trên màn Retina, nhưng chặn trần ở 2 để nhẹ máy.
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width  = window.innerWidth  + 'px';
  canvas.style.height = window.innerHeight + 'px';
  computeVideoRect();
}

window.addEventListener('resize', resize);
resize();

// ── MediaPipe Holistic ───────────────────────────────────────────────────────
// Tải asset (wasm/tflite/data/binarypb) từ CDN jsdelivr, khớp phiên bản đã pin.
const HOLISTIC_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629';
const holistic = new Holistic({
  locateFile: f => `${HOLISTIC_CDN}/${f}`,
});

holistic.setOptions({
  modelComplexity:        1,
  smoothLandmarks:        true,
  enableSegmentation:     true,   // bật mặt nạ tách người → làm glow theo cơ thể
  smoothSegmentation:     true,
  minDetectionConfidence: 0.55,
  minTrackingConfidence:  0.50,
});

// Chỉ tính toán gesture + cập nhật silhouette ở đây — KHÔNG vẽ. Việc vẽ do renderLoop lo.
holistic.onResults(results => {
  if (!firstResult) {
    firstResult = true;
    loaderEl.style.display = 'none';
    if (modelTimer) { clearTimeout(modelTimer); modelTimer = null; }
  }
  latestGesture = detector.detect(results, videoRect);
  // Dựng silhouette ngay trong callback (mask chỉ hợp lệ tại đây), tần suất thấp
  // hơn render loop nên rẻ. renderLoop chỉ việc blur + vẽ lại.
  if (renderer) renderer.setSegmentation(results.segmentationMask || null);
});

// ── Vòng lặp render độc lập (mượt, tách khỏi FPS của model) ───────────────────
function renderLoop(now) {
  if (!started) return;
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0.016;
  lastTime = now;

  if (renderer) {
    renderer.update(latestGesture, dt);
    renderer.render(latestGesture);
  }
  updateHud(latestGesture);
  requestAnimationFrame(renderLoop);
}

function updateHud(gesture) {
  const p = gesture.isPrayer;
  confFill.style.width = `${(gesture.confidence * 100).toFixed(1)}%`;
  confFill.style.background = p
    ? 'linear-gradient(90deg,#b8860b,#ffd700,#fffacd)'
    : 'linear-gradient(90deg,#3a5fa0,#6ab)';
  mantraEl.style.opacity      = p ? '1' : '0';
  instructionEl.style.opacity = p ? '0' : '1';

  // Rung chuông đúng một lần ở khoảnh khắc bắt đầu chắp tay.
  if (p && !updateHud._wasPrayer && bell) bell.ring();
  updateHud._wasPrayer = p;
}

// ── Nút Bắt Đầu ───────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  startBtn.disabled    = true;
  startBtn.textContent = 'Đang kết nối…';
  errorEl.textContent  = '';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();

    // Chuông chỉ khởi tạo được sau một cú click (chính sách autoplay của trình duyệt).
    bell = new BellSound();

    computeVideoRect();
    renderer = new EffectsRenderer(canvas, video);
    renderer.videoRect = videoRect;

    permScreen.style.opacity       = '0';
    permScreen.style.pointerEvents = 'none';
    setTimeout(() => permScreen.remove(), 600);

    loaderEl.style.display = 'flex';

    const cam = new Camera(video, {
      onFrame: async () => holistic.send({ image: video }),
      width: 1280, height: 720,
    });
    cam.start();

    // Nếu sau 30s vẫn chưa có kết quả đầu tiên → coi như lỗi tải mô hình.
    modelTimer = setTimeout(() => { if (!firstResult) showModelError(); }, 30000);

    started = true;
    requestAnimationFrame(renderLoop);

  } catch (err) {
    showError(err);
    startBtn.disabled    = false;
    startBtn.textContent = 'Bắt Đầu';
  }
});

// Model không tải xong sau timeout: đổi loader thành thông báo lỗi (bỏ spinner).
function showModelError() {
  const spinner = loaderEl.querySelector('.spinner');
  if (spinner) spinner.style.display = 'none';
  const txt = loaderEl.querySelector('span');
  if (txt) txt.innerHTML =
    'Không tải được mô hình.<br>Kiểm tra kết nối mạng rồi tải lại trang.';
  loaderEl.style.display = 'flex';
}

function showError(err) {
  let msg;
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      msg = 'Bạn chưa cấp quyền camera. Hãy cho phép truy cập rồi thử lại.';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      msg = 'Không tìm thấy camera nào trên thiết bị.';
      break;
    case 'NotReadableError':
      msg = 'Camera đang được ứng dụng khác sử dụng. Hãy đóng bớt và thử lại.';
      break;
    default:
      msg = 'Không thể mở camera: ' + (err && err.message ? err.message : 'lỗi không rõ');
  }
  errorEl.textContent = msg;
}
