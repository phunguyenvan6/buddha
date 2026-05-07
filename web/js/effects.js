class EffectsRenderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.video  = video;

    this.fogBlur  = 14;   // px blur on the video draw
    this.fogAlpha = 0.58; // dark overlay opacity
    this.haloOp   = 0;    // golden halo opacity
    this.rayAngle = 0;    // light-ray rotation accumulator

    this.burstT        = -1;
    this.BURST_DUR     = 1.6;  // seconds
    this.lastWasPrayer = false;

    this.videoRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  }

  update(gesture, dt) {
    const { isPrayer } = gesture;
    const spd = 2.2;

    this.fogBlur  += ((isPrayer ? 0   : 14)   - this.fogBlur)  * Math.min(1, dt * spd);
    this.fogAlpha += ((isPrayer ? 0   : 0.58) - this.fogAlpha) * Math.min(1, dt * spd);
    this.haloOp   += ((isPrayer ? 1   : 0)    - this.haloOp)   * Math.min(1, dt * 0.5);

    if (isPrayer && !this.lastWasPrayer) this.burstT = 0;
    if (this.burstT >= 0) this.burstT = Math.min(1, this.burstT + dt / this.BURST_DUR);

    this.lastWasPrayer = isPrayer;
    this.rayAngle += dt * 0.35;
  }

  render(gesture) {
    const { ctx, canvas, video } = this;
    const cw = canvas.width, ch = canvas.height;
    const vr = this.videoRect;
    const { confidence, handCenter, headPos, torsoPos, faceWidth } = gesture;

    ctx.clearRect(0, 0, cw, ch);

    // ── 1. Video frame (blurred when foggy) ──────────────────────────────────
    ctx.save();
    if (this.fogBlur > 0.4) ctx.filter = `blur(${this.fogBlur.toFixed(1)}px)`;
    ctx.drawImage(video, vr.x, vr.y, vr.w, vr.h);
    ctx.restore();

    // ── 2. Dark fog overlay ───────────────────────────────────────────────────
    if (this.fogAlpha > 0.005) {
      ctx.fillStyle = `rgba(8,4,18,${this.fogAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, cw, ch);
    }

    // ── 3. White burst (one-shot, from hands) ─────────────────────────────────
    if (this.burstT >= 0 && this.burstT < 1 && handCenter) {
      this._burst(handCenter, cw, ch);
    }

    // ── 4. Active effects ─────────────────────────────────────────────────────
    if (confidence > 0.08) {
      if (handCenter)
        this._handGlow(handCenter, confidence, faceWidth);

      if (torsoPos)
        this._lightRays(torsoPos, confidence, vr.h);

      if (headPos && this.haloOp > 0.01)
        this._halo(headPos, faceWidth);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _burst(center, cw, ch) {
    const t      = this.burstT;
    const eased  = 1 - (1 - t) ** 2;
    const radius = eased * Math.max(cw, ch) * 1.35;
    const alpha  = (1 - t) * 0.95;
    const { x, y } = center;

    const g = this.ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0,    `rgba(255,255,255,${alpha.toFixed(3)})`);
    g.addColorStop(0.2,  `rgba(255,252,225,${(alpha * 0.75).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(255,218,100,${(alpha * 0.35).toFixed(3)})`);
    g.addColorStop(1,    'rgba(255,175,30,0)');

    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // Soft white glow around clasped hands
  _handGlow(center, conf, faceWidth) {
    const r = faceWidth * 1.1 * conf;
    const { x, y } = center;
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0,   `rgba(255,255,255,${(conf * 0.70).toFixed(3)})`);
    g.addColorStop(0.45,`rgba(255,235,160,${(conf * 0.38).toFixed(3)})`);
    g.addColorStop(1,   'rgba(255,200,40,0)');
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  // 16 rotating rays emanating from torso center
  _lightRays(torsoPos, conf, videoH) {
    const { x: cx, y: cy } = torsoPos;
    const radius = videoH * 0.52 * conf;   // reaches well beyond body
    const ctx = this.ctx;

    ctx.save();
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + this.rayAngle;
      const long  = i % 2 === 0;
      const len   = radius * (long ? 1.55 : 0.80);
      const alpha = conf  * (long ? 0.50 : 0.22);
      const x2    = cx + Math.cos(angle) * len;
      const y2    = cy + Math.sin(angle) * len;

      const g = ctx.createLinearGradient(cx, cy, x2, y2);
      g.addColorStop(0, `rgba(255,222,55,${alpha.toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,200,0,0)');

      ctx.strokeStyle = g;
      ctx.lineWidth   = long ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Golden elliptical halo above the head.
  // Position: above the nose by ~0.65× face-width (≈ top of skull).
  // Size: driven by faceWidth so it scales with distance from camera.
  _halo(headPos, faceWidth) {
    const op    = this.haloOp;
    const pulse = 1 + 0.07 * Math.sin(performance.now() * 0.0028);
    const cx    = headPos.x;
    const cy    = headPos.y - faceWidth * 1.55;  // well above head
    const rx    = faceWidth * 0.68 * pulse;       // ear-to-ear width
    const ry    = faceWidth * 0.18 * pulse;       // flat disc

    const ctx = this.ctx;

    // Outer soft aura
    const og = ctx.createRadialGradient(cx, cy, rx * 0.25, cx, cy, rx * 2.1);
    og.addColorStop(0, `rgba(255,215,0,${(op * 0.28).toFixed(3)})`);
    og.addColorStop(1, 'rgba(255,165,0,0)');
    ctx.fillStyle = og;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 2, ry * 2.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ring
    ctx.save();
    ctx.strokeStyle = `rgba(255,215,0,${op.toFixed(3)})`;
    ctx.lineWidth   = Math.max(2, rx * 0.10);
    ctx.shadowColor = `rgba(255,200,0,${op.toFixed(3)})`;
    ctx.shadowBlur  = 30;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
