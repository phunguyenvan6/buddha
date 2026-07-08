// GestureDetector — nhận diện cử chỉ chắp tay trước ngực ("prayer").
//
// So với bản cũ, bản này chính xác hơn nhờ:
//  • Đo độ khép của hai bàn tay qua NHIỀU cặp landmark (cổ tay, khớp, đầu ngón)
//    thay vì chỉ cổ tay → giảm nhận nhầm khi hai tay chỉ tình cờ ở gần nhau.
//  • Kiểm tra vị trí tay nằm trong vùng ngực/cằm và thẳng trục thân người.
//  • Hysteresis (ngưỡng vào 0.55 / ra 0.42) → trạng thái prayer không nhấp nháy.
class GestureDetector {
  constructor() {
    this.smoothedConf  = 0;
    this.SMOOTH        = 0.18;   // hệ số làm mượt confidence mỗi lần detect
    this.ENTER         = 0.55;   // ngưỡng bật prayer
    this.EXIT          = 0.42;   // ngưỡng tắt prayer (thấp hơn → chống nhấp nháy)
    this._isPrayer     = false;  // trạng thái có nhớ (cho hysteresis)
  }

  // Trả về { confidence, isPrayer, handCenter, headPos, torsoPos, faceWidth }
  // Mọi toạ độ đều đã đổi sang pixel-canvas qua videoRect.
  detect(results, videoRect) {
    const lh   = results.leftHandLandmarks;
    const rh   = results.rightHandLandmarks;
    const pose = results.poseLandmarks;

    let rawConf    = 0;
    let handCenter = null;

    if (lh && rh) {
      // ── 1. Độ khép của hai bàn tay (nhiều cặp điểm, lấy trung bình) ──────────
      // 0 = cổ tay, 5/9/13/17 = gốc các ngón, 8/12 = đầu ngón trỏ/giữa.
      const pairs = [[0, 0], [9, 9], [5, 5], [17, 17], [12, 12], [8, 8]];
      let sumDist = 0;
      for (const [a, b] of pairs) {
        sumDist += Math.hypot(lh[a].x - rh[b].x, lh[a].y - rh[b].y);
      }
      const avgDist   = sumDist / pairs.length;
      const closeScore = clamp01(1 - avgDist / 0.22);   // càng khép càng gần 1

      // ── 2. Hai bàn tay cùng chỉ lên (ngón hướng lên trên) ───────────────────
      const up0 = { x: lh[9].x - lh[0].x, y: lh[9].y - lh[0].y };
      const up1 = { x: rh[9].x - rh[0].x, y: rh[9].y - rh[0].y };
      const handsUp = up0.y < 0 && up1.y < 0;

      const n0 = Math.hypot(up0.x, up0.y);
      const n1 = Math.hypot(up1.x, up1.y);
      const cosine = n0 > 1e-6 && n1 > 1e-6
        ? (up0.x * up1.x + up0.y * up1.y) / (n0 * n1) : 0;
      const dirScore = clamp01(cosine);   // hai tay song song → gần 1

      // ── 3. Vị trí tay: trong vùng ngực/cằm và thẳng trục thân ───────────────
      const handMid = {
        x: (lh[0].x + rh[0].x) / 2,
        y: (lh[0].y + rh[0].y) / 2,
      };
      let posScore = 0.65;   // mặc định khi không thấy pose
      if (pose) {
        const nose = pose[0];
        const lSh  = pose[11], rSh = pose[12];
        if (nose && lSh && rSh && lSh.visibility > 0.4 && rSh.visibility > 0.4) {
          const shoulderY = (lSh.y + rSh.y) / 2;
          const bodyMidX  = (lSh.x + rSh.x) / 2;
          const shoulderW = Math.abs(lSh.x - rSh.x) || 0.001;

          // Dọc: tay nên nằm giữa mũi và dưới vai một chút.
          const topOK = handMid.y > nose.y - 0.05;
          const botOK = handMid.y < shoulderY + shoulderW * 0.9;
          const vScore = topOK && botOK ? 1 : 0.25;

          // Ngang: tay gần trục giữa thân.
          const offCenter = Math.abs(handMid.x - bodyMidX) / shoulderW;
          const hScore = clamp01(1 - offCenter / 0.9);

          posScore = vScore * (0.4 + 0.6 * hScore);
        }
      }

      rawConf = closeScore * dirScore * (handsUp ? 1.0 : 0.35) * posScore;

      if (rawConf > 0.15) {
        handCenter = this._toScreen(handMid, videoRect);
      }
    }

    // Làm mượt confidence
    this.smoothedConf += this.SMOOTH * (rawConf - this.smoothedConf);

    // Hysteresis: chỉ đổi trạng thái khi vượt ngưỡng vào/ra
    if (this._isPrayer) {
      if (this.smoothedConf < this.EXIT) this._isPrayer = false;
    } else {
      if (this.smoothedConf > this.ENTER) this._isPrayer = true;
    }

    // ── Vị trí đầu / thân / bề rộng mặt (cho halo, tia sáng) ──────────────────
    let headPos   = null;
    let torsoPos  = null;
    let faceWidth = videoRect.w * 0.12;

    if (pose) {
      const nose = pose[0];
      const lEar = pose[7],  rEar = pose[8];
      const lSh  = pose[11], rSh  = pose[12];

      if (nose && nose.visibility > 0.3) headPos = this._toScreen(nose, videoRect);

      if (lEar && rEar && lEar.visibility > 0.25 && rEar.visibility > 0.25) {
        const fw = Math.abs(lEar.x - rEar.x) * videoRect.w;
        if (fw > 20) faceWidth = fw;
      }

      if (lSh && rSh && lSh.visibility > 0.4 && rSh.visibility > 0.4) {
        torsoPos = this._toScreen(
          { x: (lSh.x + rSh.x) / 2, y: (lSh.y + rSh.y) / 2 }, videoRect);
      }
    }

    // Dự phòng khi không thấy pose
    if (!headPos && handCenter)
      headPos = { x: handCenter.x, y: handCenter.y - videoRect.h * 0.30 };
    if (!torsoPos && headPos)
      torsoPos = { x: headPos.x, y: headPos.y + faceWidth * 1.8 };

    return {
      confidence: this.smoothedConf,
      isPrayer:   this._isPrayer,
      handCenter,
      headPos,
      torsoPos,
      faceWidth,
    };
  }

  _toScreen(lm, vr) {
    return { x: lm.x * vr.w + vr.x, y: lm.y * vr.h + vr.y };
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
