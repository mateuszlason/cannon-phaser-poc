// ─── AudioManager ─────────────────────────────────────────────────────────────
// All sounds are synthesised with Web Audio API — no asset files required.

export class AudioManager {
  private ctx: AudioContext | null = null;
  private musicNodes: AudioNode[] = [];
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicPlaying = false;

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  /** Must be called from a user-gesture handler to unlock AudioContext. */
  resume() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.28;
      this.musicGain.connect(this.ctx.destination);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.55;
      this.sfxGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  // ── Music ──────────────────────────────────────────────────────────────────

  startMusic() {
    if (this.musicPlaying || !this.ctx || !this.musicGain) return;
    this.musicPlaying = true;
    this.scheduleMusic();
  }

  stopMusic() {
    this.musicPlaying = false;
    this.musicNodes.forEach((n) => {
      try {
        (n as OscillatorNode).stop?.();
      } catch (_) { /* already stopped */ }
    });
    this.musicNodes = [];
  }

  private scheduleMusic() {
    if (!this.ctx || !this.musicGain || !this.musicPlaying) return;

    const ctx = this.ctx;
    const out = this.musicGain;

    // ── Ambient drone (low pad) ──────────────────────────────────────────────
    const droneFreqs = [55, 82.4, 110]; // A1, E2, A2
    droneFreqs.forEach((freq) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      g.gain.value = 0.06;
      osc.connect(g);
      g.connect(out);
      osc.start();
      this.musicNodes.push(osc);

      // Slow LFO wobble on the drone
      const lfo = ctx.createOscillator();
      const lfoG = ctx.createGain();
      lfo.frequency.value = 0.3 + Math.random() * 0.2;
      lfoG.gain.value = freq * 0.008;
      lfo.connect(lfoG);
      lfoG.connect(osc.frequency);
      lfo.start();
      this.musicNodes.push(lfo);
    });

    // ── Arpeggio melody ───────────────────────────────────────────────────────
    // Pentatonic scale in A minor: A3 C4 D4 E4 G4
    const pentatonic = [220, 261.63, 293.66, 329.63, 392];
    const arpPattern = [0, 2, 4, 1, 3, 4, 2, 0, 1, 3];
    const stepDuration = 0.18; // seconds per note

    const playArp = (startTime: number) => {
      if (!this.musicPlaying || !this.ctx) return;

      arpPattern.forEach((idx, step) => {
        const t = startTime + step * stepDuration;
        const freq = pentatonic[idx % pentatonic.length];

        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq * (Math.random() < 0.15 ? 2 : 1); // occasional octave jump
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.07, t + 0.01);
        env.gain.exponentialRampToValueAtTime(0.001, t + stepDuration * 0.85);

        osc.connect(env);
        env.connect(out);
        osc.start(t);
        osc.stop(t + stepDuration);
      });

      // Schedule next loop
      const loopEnd = startTime + arpPattern.length * stepDuration;
      const delay = (loopEnd - ctx.currentTime) * 1000 - 50;
      setTimeout(() => playArp(ctx.currentTime + 0.05), Math.max(0, delay));
    };

    playArp(ctx.currentTime + 0.1);

    // ── Kick / pulse bass beat ─────────────────────────────────────────────
    const bpm = 128;
    const beatDur = 60 / bpm;

    const playBeat = (startTime: number) => {
      if (!this.musicPlaying || !this.ctx) return;

      // 4/4 pattern: kick on 1 & 3, hi-hat on every beat
      for (let b = 0; b < 4; b++) {
        const t = startTime + b * beatDur;

        if (b % 2 === 0) {
          // Kick: pitched noise burst
          const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 4);
          }
          const src = ctx.createBufferSource();
          const g = ctx.createGain();
          src.buffer = buf;
          g.gain.setValueAtTime(0.35, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
          src.connect(g);
          g.connect(out);
          src.start(t);
        }

        // Hi-hat: short white noise
        {
          const buf = ctx.createBuffer(1, ctx.sampleRate * 0.04, ctx.sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
          }
          const src = ctx.createBufferSource();
          const hpf = ctx.createBiquadFilter();
          const g = ctx.createGain();
          hpf.type = 'highpass';
          hpf.frequency.value = 8000;
          src.buffer = buf;
          g.gain.setValueAtTime(0.04, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
          src.connect(hpf);
          hpf.connect(g);
          g.connect(out);
          src.start(t);
        }
      }

      const loopEnd = startTime + 4 * beatDur;
      const delay = (loopEnd - ctx.currentTime) * 1000 - 50;
      setTimeout(() => playBeat(ctx.currentTime + 0.05), Math.max(0, delay));
    };

    playBeat(ctx.currentTime + 0.1);
  }

  // ── SFX ───────────────────────────────────────────────────────────────────

  playLaser() {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const out = this.sfxGain;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.08);
    env.gain.setValueAtTime(0.18, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
    osc.connect(env);
    env.connect(out);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  }

  playExplosion(sizeFactor = 1) {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const out = this.sfxGain;

    const duration = 0.18 + sizeFactor * 0.22;
    const buf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.5 + sizeFactor);
    }

    const src = ctx.createBufferSource();
    const lpf = ctx.createBiquadFilter();
    const env = ctx.createGain();
    lpf.type = 'lowpass';
    lpf.frequency.value = 800 + sizeFactor * 600;
    env.gain.setValueAtTime(0.5 + sizeFactor * 0.3, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.buffer = buf;
    src.connect(lpf);
    lpf.connect(env);
    env.connect(out);
    src.start(ctx.currentTime);
  }

  destroy() {
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = null;
  }
}
