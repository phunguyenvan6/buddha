// BellSound — tổng hợp tiếng chuông chùa bằng Web Audio API, không cần file mp3.
//
// Tiếng chuông = vài sóng sine hài âm (partials) cộng lại rồi tắt dần theo hàm mũ,
// cho cảm giác ngân vang như chuông kim loại. Phải khởi tạo sau một thao tác của
// người dùng (click) để không vướng chính sách autoplay của trình duyệt.
class BellSound {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    // Bus âm lượng chung + reverb nhẹ tạo độ vang.
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);

    this._minGap = 1.2;   // giây — chặn rung chuông dồn dập
    this._lastAt = -999;
  }

  ring() {
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    if (now - this._lastAt < this._minGap) return;
    this._lastAt = now;

    // Các hài âm của một quả chuông (tần số × biên độ × thời gian ngân).
    const base = 440;
    const partials = [
      { m: 1.00, g: 0.55, d: 3.2 },
      { m: 2.00, g: 0.28, d: 2.4 },
      { m: 2.76, g: 0.18, d: 1.8 },
      { m: 5.40, g: 0.10, d: 1.2 },
    ];

    for (const p of partials) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type            = 'sine';
      osc.frequency.value = base * p.m;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(p.g, now + 0.008);   // gõ nhanh
      gain.gain.exponentialRampToValueAtTime(0.0001, now + p.d);  // ngân tắt

      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + p.d + 0.1);
    }
  }
}
