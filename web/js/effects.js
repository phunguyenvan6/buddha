// EffectsRenderer — vẽ toàn bộ hiệu ứng "giác ngộ" lên canvas 2D.
//
// Nâng cấp so với bản cũ:
//  • Sương mù động cuộn trôi trước khi chắp tay; khi chắp tay lớp sương vỡ như
//    kính rồi tan thành bụi bay đi ("Thanos búng tay"), lộ ra cảnh sáng.
//  • Viền outline sắc nét ôm cơ thể + các gợn viền toả ra như sóng năng lượng
//    (dựng từ segmentationMask). Không còn hiệu ứng phát sáng giữa hai bàn tay.
//  • Vệt sáng comet bám theo tay + bụi phép bắn ra khi tay vẩy nhanh.
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

    // Sương mù động: các đám sương cuộn trôi trước khi chắp tay
    this._fogBlobs = [];
    for (let i = 0; i < 5; i++) {
      this._fogBlobs.push({
        r:     0.35 + Math.random() * 0.30,
        speed: 0.05 + Math.random() * 0.08,
        phase: Math.random() * Math.PI * 2,
        op:    0.10 + Math.random() * 0.10,
      });
    }

    // Vỡ kính + phân rã ("Thanos búng tay") khi vừa chắp tay
    this._shards     = [];
    this._shatterT   = -1;      // -1 = không hoạt động
    this._wasPrayer  = false;
    this.SHATTER_FLY = 1.5;     // giây bay/tan của mỗi mảnh

    // Vệt sáng theo từng đầu ngón + bụi phép khi vẩy nhanh
    this._trails     = {};      // id đầu ngón → mảng điểm vệt gần đây
    this._handPrev   = {};      // id đầu ngón → vị trí frame trước
    this._handSparks = [];
    this.TRAIL_TTL   = 0.32;    // giây một điểm vệt tồn tại
    this.MAX_TRAIL   = 24;

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

    // Vỡ kính + phân rã khi vừa chắp tay; hoàn nguyên khi buông tay.
    if (isPrayer && !this._wasPrayer) this._startShatter(handCenter);
    if (!isPrayer && this._wasPrayer) { this._shards = []; this._shatterT = -1; }
    this._wasPrayer = isPrayer;
    if (this._shatterT >= 0) this._updateShards(dt);

    this._updateRipples(dt, isPrayer);
    this._updateParticles(dt, isPrayer, confidence, torsoPos, handCenter);
    this._updateHands(dt, gesture.hands || []);
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

    // ── 2. Sương mù động, hoặc lớp sương đang vỡ tan ─────────────────────────
    if (this._shatterT >= 0) {
      this._drawShards(ctx);
    } else if (this.fogAlpha > 0.005) {
      this._drawFog(ctx, cw, ch, this.fogAlpha);
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
    this._drawHands();
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

  // ── Vệt sáng theo tay + bụi phép ──────────────────────────────────────────

  _updateHands(dt, tips) {
    const seen = {};
    for (const h of tips) {
      seen[h.id] = true;
      if (!this._trails[h.id]) this._trails[h.id] = [];
      const trail = this._trails[h.id];
      const last  = trail[trail.length - 1];
      // Chỉ thêm điểm khi đầu ngón dịch đủ xa → vệt gọn, đứng yên không nhiễu.
      if (!last || Math.hypot(h.x - last.x, h.y - last.y) > 1.5) {
        trail.push({ x: h.x, y: h.y, life: 0 });
        if (trail.length > this.MAX_TRAIL) trail.shift();
      }
      // Vận tốc đầu ngón → bắn bụi phép khi vẩy nhanh.
      const prev = this._handPrev[h.id];
      if (prev) {
        const vx = (h.x - prev.x) / Math.max(dt, 1e-3);
        const vy = (h.y - prev.y) / Math.max(dt, 1e-3);
        const speed = Math.hypot(vx, vy);
        if (speed > 350 && this._handSparks.length < 240) {
          const n = Math.min(3, Math.floor(speed / 400));
          for (let i = 0; i < n; i++) {
            this._handSparks.push({
              x: h.x, y: h.y,
              vx: vx * 0.15 + (Math.random() - 0.5) * 70,
              vy: vy * 0.15 + (Math.random() - 0.5) * 70,
              life: 0, ttl: 0.5 + Math.random() * 0.5,
              size: 1.0 + Math.random() * 2.0,
            });
          }
        }
      }
      this._handPrev[h.id] = { x: h.x, y: h.y };
    }

    // Già hoá & loại điểm vệt hết đời (mọi đầu ngón, kể cả vừa khuất khỏi khung)
    for (const id in this._trails) {
      if (!seen[id]) this._handPrev[id] = null;
      const trail = this._trails[id];
      for (let i = trail.length - 1; i >= 0; i--) {
        trail[i].life += dt;
        if (trail[i].life > this.TRAIL_TTL) trail.splice(i, 1);
      }
    }
    // Cập nhật bụi phép
    for (let i = this._handSparks.length - 1; i >= 0; i--) {
      const p = this._handSparks[i];
      p.life += dt;
      if (p.life >= p.ttl) { this._handSparks.splice(i, 1); continue; }
      p.vy += 120 * dt;              // trọng lực nhẹ
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.vx *= 1 - 0.8 * dt;
    }
  }

  _drawHands() {
    const ctx = this.ctx;

    // Đốm sáng luôn bám mỗi đầu ngón (hiện cả khi tay đứng yên) → ánh sáng
    // "theo tay" thấy rõ suốt, kể cả trước khi chắp tay, trên nền sương.
    const dotR = Math.min(this.canvas.width, this.canvas.height) * 0.02;
    for (const id in this._handPrev) {
      const p = this._handPrev[id];
      if (!p) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, dotR);
      g.addColorStop(0,   'rgba(255,250,225,0.55)');
      g.addColorStop(0.4, 'rgba(255,216,110,0.28)');
      g.addColorStop(1,   'rgba(255,180,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Vệt comet cho từng đầu ngón: lớp glow rộng mờ + lõi sáng, nhạt dần về đuôi.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const id in this._trails) {
      const trail = this._trails[id];
      if (trail.length < 2) continue;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < trail.length; i++) {
          const b = trail[i];
          const k = 1 - b.life / this.TRAIL_TTL;   // 0 (đuôi cũ) → 1 (đầu mới)
          if (k <= 0) continue;
          ctx.strokeStyle = pass === 0
            ? `rgba(255,205,80,${(0.09 * k).toFixed(3)})`
            : `rgba(255,248,215,${(0.5 * k).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.5, (pass === 0 ? 11 : 3) * k);
          ctx.beginPath();
          ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // Bụi phép bắn theo chuyển động
    for (const p of this._handSparks) {
      const alpha = (1 - p.life / p.ttl) * 0.9;
      if (alpha <= 0.01) continue;
      const r = p.size;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      g.addColorStop(0,   `rgba(255,245,200,${alpha.toFixed(3)})`);
      g.addColorStop(0.5, `rgba(255,210,90,${(alpha * 0.6).toFixed(3)})`);
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

  // Sương mù: nền tối + các đám sương xám cuộn trôi (trước khi chắp tay).
  _drawFog(ctx, cw, ch, alpha) {
    ctx.fillStyle = `rgba(8,4,18,${alpha.toFixed(3)})`;
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this._fogBlobs) {
      const t = this.time * b.speed + b.phase;
      const x = cw * (0.5 + 0.42 * Math.sin(t));
      const y = ch * (0.5 + 0.30 * Math.cos(t * 0.8 + b.phase));
      const r = Math.min(cw, ch) * b.r;
      const a = alpha * b.op;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(120,130,158,${a.toFixed(3)})`);
      g.addColorStop(1, 'rgba(90,100,130,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.restore();
  }

  // Bắt đầu vỡ: tạo mảnh kính KHÔNG ĐỀU theo kiểu nứt do va đập điểm — các nan
  // toả ra từ tâm (chỗ hai tay) + các vòng đồng tâm, đều bị jitter ngẫu nhiên.
  // Giao của chúng cho các mảnh nhỏ ở tâm, lớn dần ra rìa; sau đó mỗi mảnh bay
  // ra, xoay, co nhỏ và tan thành bụi ("Thanos búng tay").
  _startShatter(center) {
    const cw = this.canvas.width, ch = this.canvas.height;
    const cx = center ? center.x : cw * 0.5;
    const cy = center ? center.y : ch * 0.5;

    // Bán kính đủ phủ tới góc màn xa nhất
    let maxR = 0;
    for (const [gx, gy] of [[0, 0], [cw, 0], [0, ch], [cw, ch]])
      maxR = Math.max(maxR, Math.hypot(gx - cx, gy - cy));
    maxR *= 1.08;

    // Góc các nan: đều + jitter → khoảng cách không đều
    const nSpokes = 18;
    const step = (Math.PI * 2) / nSpokes;
    const angles = [];
    for (let i = 0; i < nSpokes; i++)
      angles.push(i * step + (Math.random() - 0.5) * step * 0.7);
    angles.push(angles[0] + Math.PI * 2);   // khép vòng

    // Bán kính các vòng theo phân bố luỹ thừa (dồn dày ở tâm) + jitter → mảnh
    // nhỏ gần tay, to dần ra rìa màn hình. Chuẩn hoá để vòng ngoài phủ hết maxR.
    const nRings = 9;
    const radii = [0];
    for (let j = 1; j <= nRings; j++) {
      const frac   = j / nRings;
      const base   = Math.pow(frac, 1.9);              // dồn vòng về gần tâm
      const jitter = (Math.random() - 0.5) * (0.6 / nRings);
      radii.push(Math.max(radii[j - 1] + 0.01, base + jitter));
    }
    const norm = maxR / radii[radii.length - 1];
    for (let j = 1; j < radii.length; j++) radii[j] *= norm;

    // Dựng lưới node (giao nan × vòng) rồi NHIỄU từng node → cạnh mảnh gãy khúc
    // bất quy tắc, không còn các "đường chéo" thẳng toả đều ra tâm. Các mảnh liền
    // kề dùng chung node nên vẫn phủ kín, không kẽ hở.
    const nodes = [];
    for (let i = 0; i <= nSpokes; i++) {
      const a = angles[i];
      const ca = Math.cos(a), sa = Math.sin(a);
      const col = [];
      for (let j = 0; j <= nRings; j++) {
        if (j === 0)       { col.push([cx, cy]); continue; }       // tâm cố định
        if (i === nSpokes) { col.push(nodes[0][j]); continue; }    // khép vòng
        const r = radii[j];
        const ringGap = r - radii[j - 1];
        const jt = (Math.random() - 0.5) * (r * step) * 0.6;       // lệch tiếp tuyến
        const jr = (Math.random() - 0.5) * ringGap * 0.6;          // lệch xuyên tâm
        col.push([
          cx + ca * (r + jr) - sa * jt,
          cy + sa * (r + jr) + ca * jt,
        ]);
      }
      nodes.push(col);
    }

    this._shards = [];
    for (let i = 0; i < nSpokes; i++) {
      for (let j = 0; j < nRings; j++) {
        const verts = [
          nodes[i][j], nodes[i + 1][j], nodes[i + 1][j + 1], nodes[i][j + 1],
        ];
        let mx = 0, my = 0;                    // trọng tâm mảnh
        for (const v of verts) { mx += v[0]; my += v[1]; }
        mx /= 4; my /= 4;
        const dx = mx - cx, dy = my - cy;
        const dist = Math.hypot(dx, dy) || 1;
        this._shards.push({
          cx: mx, cy: my,
          pts: verts.map(v => [v[0] - mx, v[1] - my]),   // đỉnh tương đối trọng tâm
          ux: dx / dist, uy: dy / dist,
          delay: (dist / maxR) * 0.5,          // sóng vỡ lan dần từ tâm
          speed: 220 + Math.random() * 260,
          rot: 0, vrot: (Math.random() - 0.5) * 6,
          bright: 0.85 + Math.random() * 0.5,
        });
      }
    }
    this._shatterT = 0;
  }

  _updateShards(dt) {
    this._shatterT += dt;
    const t = this._shatterT;
    for (const s of this._shards) {
      const t2 = t - s.delay;
      if (t2 < 0 || t2 >= this.SHATTER_FLY) continue;   // chưa vỡ hoặc đã tan
      s.cx  += (s.ux * s.speed * 0.6 + 45) * dt;         // toả ra + gió sang phải
      s.cy  += (s.uy * s.speed * 0.6 - 95) * dt;         // + bốc lên
      s.rot += s.vrot * dt;
    }
    if (t > 0.5 + this.SHATTER_FLY + 0.05) { this._shatterT = -1; this._shards = []; }
  }

  // Vẽ mảnh kính: đứng yên (còn phủ kín) → bay, xoay, co nhỏ, mờ dần thành bụi.
  _drawShards(ctx) {
    const t = this._shatterT;
    for (const s of this._shards) {
      const t2 = t - s.delay;
      let scale = 1, alpha = 1, flying = false;
      if (t2 >= 0) {
        const k = t2 / this.SHATTER_FLY;
        if (k >= 1) continue;
        scale  = 1 - 0.65 * k;
        alpha  = 1 - k * k;
        flying = true;
      }
      const cb = s.bright;
      const fill = `rgb(${(10 * cb) | 0},${(7 * cb) | 0},${(24 * cb) | 0})`;

      ctx.save();
      ctx.translate(s.cx, s.cy);
      if (flying) { ctx.rotate(s.rot); ctx.scale(scale, scale); }

      ctx.beginPath();
      ctx.moveTo(s.pts[0][0], s.pts[0][1]);
      for (let p = 1; p < s.pts.length; p++) ctx.lineTo(s.pts[p][0], s.pts[p][1]);
      ctx.closePath();

      ctx.globalAlpha = alpha * 0.62;
      ctx.fillStyle = fill;
      ctx.fill();

      if (flying) {
        // Mép kính sáng khi đã bung ra
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = 'rgba(175,205,255,1)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // Bịt kẽ hở giữa các mảnh khi còn đứng yên
        ctx.globalAlpha = alpha * 0.62;
        ctx.strokeStyle = fill;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
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
