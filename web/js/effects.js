// EffectsRenderer — vẽ toàn bộ hiệu ứng "giác ngộ" lên canvas 2D.
//
// Nâng cấp so với bản cũ:
//  • Viền outline sắc nét ôm cơ thể + các gợn viền toả ra như sóng năng lượng
//    (dựng từ segmentationMask). Không còn hiệu ứng phát sáng giữa hai bàn tay.
//  • Hệ hạt bụi vàng (motes) bay lên quanh thân khi chắp tay.
//  • Ánh sáng dùng chế độ hoà trộn cộng ('lighter') → glow rực, mượt, không bệt.
//  • Vignette ấm ôm quanh khung hình khi đạt trạng thái prayer.
//  • Halo có quầng ngoài, hai vòng và các nan sáng xoay nhẹ.
class EffectsRenderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.video  = video;

    this.fogBlur  = 14;   // px blur lên khung video
    this.fogAlpha = 0.58; // độ mờ lớp phủ tối
    this.haloOp   = 0;     // độ hiện của halo
    this.rayAngle = 0;     // góc xoay cho các nan sáng của halo
    this.time     = 0;     // đồng hồ nội bộ (giây) cho nhịp đập

    this.particles     = [];
    this.MAX_PARTICLES = 90;
    this._spawnAcc     = 0;   // bộ tích luỹ để rải hạt đều theo thời gian

    // Mask đã làm mượt (khử răng cưa/khối vuông của mask thấp phân giải)
    this._maskSmooth    = document.createElement('canvas');
    this._maskSmoothCtx = this._maskSmooth.getContext('2d');
    // Silhouette cơ thể dựng từ segmentationMask
    this._sil    = document.createElement('canvas');
    this._silCtx = this._sil.getContext('2d');
    // Viền outline sắc nét của cơ thể (ring mảnh quanh mép người)
    this._outline    = document.createElement('canvas');
    this._outlineCtx = this._outline.getContext('2d');
    this._hasSil = false;

    // Scale ảnh chất lượng cao ở mọi context → không lộ pixel khi phóng to.
    for (const c of [this.ctx, this._maskSmoothCtx, this._silCtx, this._outlineCtx]) {
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
    }
    this.bodyOp  = 0;   // độ hiện của hiệu ứng thân (nội suy theo trạng thái prayer)

    // Các "gợn" viền toả ra từ cơ thể như sóng năng lượng
    this._ripples        = [];
    this._rippleAcc      = 0;
    this.RIPPLE_INTERVAL = 0.7;   // giây giữa hai gợn liên tiếp
    this.RIPPLE_TTL      = 1.9;   // giây một gợn sống (toả hết rồi tắt)
    this.RIPPLE_SPREAD   = 0.55;  // scale tối đa cộng thêm khi toả ra

    this.videoRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  }

  // Nhận segmentationMask từ MediaPipe và dựng sẵn 2 thứ: silhouette vàng đặc
  // và viền outline sắc nét. Gọi mỗi khi có kết quả model (tần suất thấp) nên
  // render loop chỉ việc vẽ lại — rẻ.
  setSegmentation(mask) {
    if (!mask || !mask.width || !mask.height) { this._hasSil = false; return; }
    const w = mask.width, h = mask.height;

    // ── Làm mượt mask một lần: blur nhẹ để khử răng cưa / khối vuông của mask
    //    thấp phân giải trước khi tô màu và phóng to lên toàn màn hình. ────────
    const ms = this._maskSmooth, msc = this._maskSmoothCtx;
    if (ms.width !== w || ms.height !== h) { ms.width = w; ms.height = h; }
    msc.clearRect(0, 0, w, h);
    msc.filter = `blur(${Math.max(1, Math.min(w, h) * 0.01).toFixed(2)}px)`;
    msc.drawImage(mask, 0, 0, w, h);
    msc.filter = 'none';

    // ── Silhouette vàng đặc (nền cho glow dịu) ────────────────────────────────
    const off = this._sil, octx = this._silCtx;
    if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, w, h);
    octx.drawImage(ms, 0, 0, w, h);          // vùng người = có alpha
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = 'rgb(255,214,64)';       // tô vàng theo đúng silhouette
    octx.fillRect(0, 0, w, h);
    octx.globalCompositeOperation = 'source-over';

    // ── Viền outline sắc nét = (silhouette nở ra) trừ (silhouette gốc) ────────
    // Nở (dilate) bằng cách vẽ mask mượt lệch theo 24 hướng, rồi khoét lõi để
    // còn lại một vòng viền mảnh, đều, mượt quanh mép cơ thể.
    const ol = this._outline, olc = this._outlineCtx;
    if (ol.width !== w || ol.height !== h) { ol.width = w; ol.height = h; }
    const R = Math.max(1.5, Math.min(w, h) * 0.012);   // độ dày viền (px không gian mask)
    olc.globalCompositeOperation = 'source-over';
    olc.clearRect(0, 0, w, h);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      olc.drawImage(ms, Math.cos(a) * R, Math.sin(a) * R, w, h);
    }
    olc.globalCompositeOperation = 'source-in';
    olc.fillStyle = 'rgb(255,236,140)';        // viền vàng sáng hơn thân
    olc.fillRect(0, 0, w, h);
    olc.globalCompositeOperation = 'destination-out';
    olc.drawImage(ms, 0, 0, w, h);             // khoét lõi → còn ring viền
    olc.globalCompositeOperation = 'source-over';

    this._hasSil = true;
  }

  update(gesture, dt) {
    const { isPrayer, confidence, torsoPos, handCenter } = gesture;
    const spd = 2.2;

    this.time     += dt;
    this.fogBlur  += ((isPrayer ? 0 : 14)   - this.fogBlur)  * Math.min(1, dt * spd);
    this.fogAlpha += ((isPrayer ? 0 : 0.58) - this.fogAlpha) * Math.min(1, dt * spd);
    this.haloOp   += ((isPrayer ? 1 : 0)    - this.haloOp)   * Math.min(1, dt * 0.5);
    this.bodyOp   += ((isPrayer ? 1 : 0)    - this.bodyOp)   * Math.min(1, dt * 3.0);

    this.rayAngle += dt * 0.35;

    this._updateRipples(dt, isPrayer);
    this._updateParticles(dt, isPrayer, confidence, torsoPos, handCenter);
  }

  // Định kỳ sinh một gợn viền mới khi đang chắp tay; nuôi lớn & thải gợn hết đời.
  _updateRipples(dt, isPrayer) {
    if (isPrayer && this._hasSil) {
      this._rippleAcc += dt;
      while (this._rippleAcc >= this.RIPPLE_INTERVAL) {
        this._rippleAcc -= this.RIPPLE_INTERVAL;
        this._ripples.push({ age: 0 });
      }
    } else {
      this._rippleAcc = 0;
    }
    for (let i = this._ripples.length - 1; i >= 0; i--) {
      this._ripples[i].age += dt;
      if (this._ripples[i].age >= this.RIPPLE_TTL) this._ripples.splice(i, 1);
    }
  }

  render(gesture) {
    const { ctx, canvas, video } = this;
    const cw = canvas.width, ch = canvas.height;
    const vr = this.videoRect;
    const { confidence, headPos, torsoPos, faceWidth } = gesture;

    ctx.clearRect(0, 0, cw, ch);

    // ── 1. Khung video (mờ khi còn "sương") ──────────────────────────────────
    ctx.save();
    if (this.fogBlur > 0.4) ctx.filter = `blur(${this.fogBlur.toFixed(1)}px)`;
    ctx.drawImage(video, vr.x, vr.y, vr.w, vr.h);
    ctx.restore();

    // ── 2. Lớp phủ tối ────────────────────────────────────────────────────────
    if (this.fogAlpha > 0.005) {
      ctx.fillStyle = `rgba(8,4,18,${this.fogAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, cw, ch);
    }

    // ── 3. Vignette ấm khi đã "giác ngộ" ─────────────────────────────────────
    const warm = 1 - this.fogAlpha / 0.58;   // 0 khi mờ tối → 1 khi sáng rõ
    if (warm > 0.02) this._warmVignette(cw, ch, warm);

    // ── 4. Mọi hiệu ứng sáng dùng hoà trộn cộng ──────────────────────────────
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Viền outline cơ thể + các gợn toả ra (thay cho mọi hiệu ứng giữa hai tay).
    if (this.bodyOp > 0.01 && this._hasSil) {
      const center = torsoPos || { x: vr.x + vr.w / 2, y: vr.y + vr.h / 2 };
      this._bodyAura(center, this.bodyOp);
    }

    if (confidence > 0.08 && headPos && this.haloOp > 0.01) this._halo(headPos, faceWidth);

    this._renderParticles();
    ctx.restore();
  }

  // ── Hệ hạt bụi vàng ─────────────────────────────────────────────────────────

  _updateParticles(dt, isPrayer, conf, torsoPos, handCenter) {
    // Rải hạt mới khi đang chắp tay (khoảng 18 hạt/giây, theo confidence)
    if (isPrayer && (torsoPos || handCenter)) {
      this._spawnAcc += dt * 18 * conf;
      const anchor = handCenter || torsoPos;
      const spread = this.videoRect.w * 0.10;
      while (this._spawnAcc >= 1 && this.particles.length < this.MAX_PARTICLES) {
        this._spawnAcc -= 1;
        // Toạ độ ngẫu nhiên quanh mỏ neo, không dùng Math.random ở lõi tất định
        // của app — nhưng ở renderer trình duyệt thì Math.random hoàn toàn ổn.
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.random() * spread;
        this.particles.push({
          x:    anchor.x + Math.cos(ang) * rad,
          y:    anchor.y + Math.sin(ang) * rad * 0.6,
          vx:   (Math.random() - 0.5) * 22,
          vy:   -22 - Math.random() * 40,          // bay lên
          life: 0,
          ttl:  1.6 + Math.random() * 1.8,
          size: 1.4 + Math.random() * 2.6,
        });
      }
    }

    // Cập nhật + loại bỏ hạt hết đời
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.ttl) { this.particles.splice(i, 1); continue; }
      p.vy   += 8 * dt;                 // hơi chậm lại khi lên cao
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.vx   *= 1 - 0.6 * dt;
    }
  }

  _renderParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const k     = p.life / p.ttl;           // 0 → 1 vòng đời
      const alpha = Math.sin(Math.PI * k) * 0.9;   // mờ dần hai đầu
      if (alpha <= 0.01) continue;
      const r = p.size;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      g.addColorStop(0,   `rgba(255,244,190,${alpha.toFixed(3)})`);
      g.addColorStop(0.4, `rgba(255,210,90,${(alpha * 0.6).toFixed(3)})`);
      g.addColorStop(1,   'rgba(255,180,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Các hiệu ứng đơn lẻ ──────────────────────────────────────────────────────

  _warmVignette(cw, ch, k) {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(
      cw / 2, ch * 0.45, Math.min(cw, ch) * 0.25,
      cw / 2, ch * 0.45, Math.max(cw, ch) * 0.75);
    g.addColorStop(0, 'rgba(255,200,80,0)');
    g.addColorStop(1, `rgba(120,70,0,${(k * 0.35).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }

  // Hiệu ứng thân: glow nền rất dịu + viền outline sắc nét ôm sát cơ thể,
  // cùng các "gợn" viền phóng to dần rồi mờ đi — toả ra như sóng năng lượng.
  _bodyAura(center, strength) {
    const ctx = this.ctx, vr = this.videoRect;
    const cx = center.x, cy = center.y;

    // 1. Glow nền dịu từ silhouette (blur nhẹ) cho thân có chiều sâu, không bệt.
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.26 * strength);
    ctx.filter      = 'blur(14px)';
    ctx.drawImage(this._sil, vr.x, vr.y, vr.w, vr.h);
    ctx.restore();

    // 2. Viền outline sắc nét ôm sát cơ thể.
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.95 * strength);
    ctx.drawImage(this._outline, vr.x, vr.y, vr.w, vr.h);
    ctx.restore();

    // 3. Các gợn viền toả ra: phóng to quanh tâm thân, mờ dần (ease-out) khi lan xa.
    for (const rp of this._ripples) {
      const k = rp.age / this.RIPPLE_TTL;               // 0 → 1
      const s = 1 + k * this.RIPPLE_SPREAD;             // scale nở ra
      const a = (1 - k) * (1 - k) * 0.9 * strength;     // mờ dần
      if (a <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      ctx.drawImage(this._outline, vr.x, vr.y, vr.w, vr.h);
      ctx.restore();
    }
  }

  // Hào quang vàng phía trên đầu: quầng ngoài + hai vòng + nan sáng xoay
  _halo(headPos, faceWidth) {
    const op    = this.haloOp;
    const pulse = 1 + 0.07 * Math.sin(this.time * 2.8);
    const cx    = headPos.x;
    const cy    = headPos.y - faceWidth * 1.55;
    const rx    = faceWidth * 0.68 * pulse;
    const ry    = faceWidth * 0.18 * pulse;
    const ctx   = this.ctx;

    // Quầng sáng ngoài
    const og = ctx.createRadialGradient(cx, cy, rx * 0.25, cx, cy, rx * 2.1);
    og.addColorStop(0, `rgba(255,215,0,${(op * 0.30).toFixed(3)})`);
    og.addColorStop(1, 'rgba(255,165,0,0)');
    ctx.fillStyle = og;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 2, ry * 2.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Nan sáng ngắn xoay quanh vành halo
    ctx.save();
    ctx.strokeStyle = `rgba(255,235,140,${(op * 0.5).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, rx * 0.05);
    ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const a  = (i / 12) * Math.PI * 2 + this.rayAngle * 1.4;
      const c  = Math.cos(a), s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + c * rx * 1.05, cy + s * ry * 1.05);
      ctx.lineTo(cx + c * rx * 1.35, cy + s * ry * 1.35);
      ctx.stroke();
    }
    ctx.restore();

    // Hai vòng vàng đồng tâm
    ctx.save();
    ctx.shadowColor = `rgba(255,200,0,${op.toFixed(3)})`;
    ctx.shadowBlur  = 30;
    ctx.strokeStyle = `rgba(255,215,0,${op.toFixed(3)})`;
    ctx.lineWidth   = Math.max(2, rx * 0.10);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = `rgba(255,248,210,${(op * 0.8).toFixed(3)})`;
    ctx.lineWidth   = Math.max(1, rx * 0.04);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.78, ry * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
