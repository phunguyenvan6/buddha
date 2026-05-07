class GestureDetector {
  constructor() {
    this.smoothedConf = 0;
    this.SMOOTH = 0.12;
  }

  // Returns { confidence, isPrayer, handCenter, headPos, torsoPos, faceWidth }
  // All positions are in canvas-pixel space using videoRect transform.
  detect(results, videoRect) {
    const lh   = results.leftHandLandmarks;
    const rh   = results.rightHandLandmarks;
    const pose = results.poseLandmarks;

    let rawConf   = 0;
    let handCenter = null;

    if (lh && rh) {
      const lWrist = lh[0], rWrist = rh[0];
      const lMid   = lh[9], rMid   = rh[9];

      const dx = lWrist.x - rWrist.x;
      const dy = lWrist.y - rWrist.y;
      const wristDist = Math.sqrt(dx * dx + dy * dy);

      const up0 = { x: lMid.x - lWrist.x, y: lMid.y - lWrist.y };
      const up1 = { x: rMid.x - rWrist.x, y: rMid.y - rWrist.y };
      const handsUp = up0.y < 0 && up1.y < 0;

      const n0 = Math.hypot(up0.x, up0.y);
      const n1 = Math.hypot(up1.x, up1.y);
      const cosine = n0 > 1e-6 && n1 > 1e-6
        ? (up0.x * up1.x + up0.y * up1.y) / (n0 * n1) : 0;

      const distScore = Math.max(0, 1 - wristDist / 0.25);
      const dirScore  = Math.max(0, cosine);
      rawConf = distScore * dirScore * (handsUp ? 1.0 : 0.4);

      if (rawConf > 0.2) {
        handCenter = this._toScreen(
          { x: (lWrist.x + rWrist.x) / 2, y: (lWrist.y + rWrist.y) / 2 },
          videoRect
        );
      }
    }

    this.smoothedConf += this.SMOOTH * (rawConf - this.smoothedConf);

    let headPos   = null;
    let torsoPos  = null;
    let faceWidth = videoRect.w * 0.12; // sensible default

    if (pose) {
      const nose     = pose[0];
      const lEar     = pose[7],  rEar     = pose[8];
      const lShoulder = pose[11], rShoulder = pose[12];

      if (nose && nose.visibility > 0.3) {
        headPos = this._toScreen(nose, videoRect);
      }

      // Derive face width from ear-to-ear distance for halo sizing
      if (lEar && rEar && lEar.visibility > 0.25 && rEar.visibility > 0.25) {
        const fw = Math.abs(lEar.x - rEar.x) * videoRect.w;
        if (fw > 20) faceWidth = fw;
      }

      // Torso = midpoint of shoulders → light-ray anchor
      if (lShoulder && rShoulder &&
          lShoulder.visibility > 0.4 && rShoulder.visibility > 0.4) {
        torsoPos = this._toScreen(
          { x: (lShoulder.x + rShoulder.x) / 2,
            y: (lShoulder.y + rShoulder.y) / 2 },
          videoRect
        );
      }
    }

    // Fallbacks when pose is not visible
    if (!headPos && handCenter) {
      headPos  = { x: handCenter.x, y: handCenter.y - videoRect.h * 0.30 };
    }
    if (!torsoPos && headPos) {
      torsoPos = { x: headPos.x, y: headPos.y + faceWidth * 1.8 };
    }

    return {
      confidence: this.smoothedConf,
      isPrayer:   this.smoothedConf > 0.55,
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
