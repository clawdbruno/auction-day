// Suburban Australian ambience, synthesised — no samples, no network.
// Kookaburra cackles, magpie warbles, and someone's always mowing somewhere.

export class Ambience {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume?.();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.running = true;
      this.mower();
      this.scheduleBirds();
    } catch { /* no audio device — silence is also very suburban */ }
  }

  note(freq, t0, dur, { type = 'sawtooth', gain = 0.03, glideTo = null, pan = 0 } = {}) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (p) { p.pan.value = pan; o.connect(g).connect(p).connect(this.master); }
    else o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  // rising "oo-oo-oo" into the full cackle and back down
  kookaburra() {
    const t = this.ctx.currentTime + 0.05;
    const pan = Math.random() * 1.6 - 0.8;
    let when = t;
    const steps = [500, 520, 560, 620, 700, 820, 900, 940, 900, 820, 700, 600];
    steps.forEach((f, i) => {
      const loud = i > 3 && i < 9;
      this.note(f, when, loud ? 0.13 : 0.1, {
        type: 'sawtooth',
        gain: loud ? 0.035 : 0.015,
        glideTo: f * 0.92,
        pan,
      });
      when += loud ? 0.14 : 0.17;
    });
  }

  // liquid glissando warble
  magpie() {
    const t = this.ctx.currentTime + 0.05;
    const pan = Math.random() * 1.6 - 0.8;
    let when = t;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
      const f0 = 500 + Math.random() * 500;
      const f1 = 700 + Math.random() * 900;
      this.note(f0, when, 0.35 + Math.random() * 0.25, {
        type: 'sine', gain: 0.028, glideTo: f1, pan,
      });
      when += 0.28 + Math.random() * 0.2;
    }
  }

  // two-stroke drone three backyards over
  mower() {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 57;
    const buzz = this.ctx.createOscillator();
    buzz.type = 'square';
    buzz.frequency.value = 114;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const g = this.ctx.createGain();
    g.gain.value = 0.008;
    // the engine surges as it hits thick grass
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.35;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.003;
    lfo.connect(lfoGain).connect(g.gain);
    o.connect(lp); buzz.connect(lp);
    lp.connect(g).connect(this.master);
    o.start(); buzz.start(); lfo.start();
  }

  scheduleBirds() {
    if (!this.running) return;
    const next = 6000 + Math.random() * 16000;
    setTimeout(() => {
      if (!this.running) return;
      try {
        if (Math.random() < 0.45) this.kookaburra();
        else this.magpie();
      } catch { /* context died; stay quiet */ }
      this.scheduleBirds();
    }, next);
  }
}
