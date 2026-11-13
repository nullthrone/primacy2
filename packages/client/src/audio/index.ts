/**
 * Procedural audio: every sound is synthesised with the Web Audio API, so the game ships no
 * sound files. Engine and drive tones follow the frame view; one-shot sounds follow its events.
 */
import { quat, v3, type GameEvent, type Vec3 } from '@primacy2/shared';
import type { FrameView } from '../contracts.ts';

export type UiSound = 'click' | 'hover' | 'open' | 'close' | 'confirm' | 'deny' | 'notice' | 'warning';

export interface GameAudio {
  /** Called once per frame; drives engine, weapon and ambience sounds from the view and its events. */
  update(view: FrameView | null): void;
  /** Plays a short interface sound. */
  ui(sound: UiSound): void;
  /** Browsers only allow audio after a user gesture; call from the first click or key press. */
  unlock(): void;
  /** 0..1 */
  setVolume(volume: number): void;
}

const UI: Record<UiSound, [freq: number, to: number, dur: number, type: OscillatorType, gain: number]> = {
  click: [880, 660, 0.05, 'triangle', 0.12],
  hover: [1200, 1200, 0.02, 'sine', 0.04],
  open: [440, 880, 0.12, 'sine', 0.1],
  close: [880, 440, 0.1, 'sine', 0.1],
  confirm: [660, 1320, 0.14, 'triangle', 0.12],
  deny: [220, 160, 0.18, 'sawtooth', 0.1],
  notice: [990, 1320, 0.1, 'sine', 0.1],
  warning: [520, 390, 0.25, 'square', 0.09],
};

class Synth implements GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.7;
  private engine: { osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private drive: { osc: OscillatorNode; gain: GainNode } | null = null;
  private lastAlarm = 0;
  /** One-shot sounds started this frame, to keep a busy fight from clipping. */
  private voices = 0;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      const limiter = ctx.createDynamicsCompressor();
      master.connect(limiter).connect(ctx.destination);
      this.master = master;

      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      // A fixed generator keeps the noise identical on every start; it only has to sound random.
      let s = 22222;
      for (let i = 0; i < len; i++) {
        s = (s * 16807) % 2147483647;
        data[i] = (s / 2147483647) * 2 - 1;
      }

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(gain).connect(master);
      osc.start();
      sub.start();
      this.engine = { osc, sub, filter, gain };

      const d = ctx.createOscillator();
      d.type = 'triangle';
      const dg = ctx.createGain();
      dg.gain.value = 0;
      d.connect(dg).connect(master);
      d.start();
      this.drive = { osc: d, gain: dg };
    } catch {
      // No audio device or an unsupported browser: the game stays silent.
      this.ctx = null;
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  ui(sound: UiSound): void {
    const [f, to, dur, type, gain] = UI[sound];
    this.tone(f, to, dur, type, gain);
  }

  /** A short pitched sound gliding from `from` to `to` hertz. */
  private tone(from: number, to: number, dur: number, type: OscillatorType, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running' || this.voices > 10) return;
    this.voices++;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A burst of filtered noise: impacts, explosions, cannon fire. */
  private burst(freq: number, dur: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || ctx.state !== 'running' || this.voices > 10) return;
    this.voices++;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, (t * 0.37) % 0.5);
    src.stop(t + dur + 0.02);
  }

  private event(e: GameEvent, view: FrameView): void {
    // Loudness falls off with distance from the pilot's ship; own events are always close.
    // Event coordinates are in the zone's frame, whose axes turn with the body near the ground.
    const at = 'at' in e && view.zone && view.zoneRot ? v3.add(view.zone, quat.rotate(view.zoneRot, e.at as Vec3)) : null;
    const dist = at ? v3.len(at) : 0;
    const near = 1 / (1 + dist / 700);
    const own = view.self?.id;
    switch (e.e) {
      case 'shot': {
        const g = (e.from === own ? 0.16 : 0.1 * near);
        if (e.w.startsWith('pulse')) this.tone(1500, 380, 0.11, 'sawtooth', g);
        else if (e.w.startsWith('beam')) this.tone(700, 640, 0.18, 'square', g * 0.6);
        else if (e.w.startsWith('mining')) this.tone(320, 300, 0.2, 'sawtooth', g * 0.5);
        else if (e.w.startsWith('missile')) this.burst(900, 0.5, g);
        else this.burst(1800, 0.09, g * 1.2);
        break;
      }
      case 'hit':
        if (e.shield) this.tone(2400, 900, 0.14, 'sine', (e.id === own ? 0.2 : 0.08 * near));
        else this.burst(2600, 0.12, e.id === own ? 0.3 : 0.1 * near);
        break;
      case 'destroyed':
        this.burst(700, 1.4, e.id === own ? 0.6 : 0.5 * near);
        this.tone(90, 30, 1.2, 'sine', e.id === own ? 0.5 : 0.35 * near);
        break;
      case 'mine':
        this.tone(260, 240, 0.22, 'sawtooth', e.from === own ? 0.06 : 0.03 * near);
        break;
      case 'cruise':
        if (e.id === own || near > 0.2) this.tone(e.on ? 120 : 900, e.on ? 900 : 120, 0.7, 'triangle', 0.14);
        break;
      case 'fold':
        this.tone(e.out ? 80 : 1600, e.out ? 1600 : 80, 1.1, 'sawtooth', 0.14 * (e.id === own ? 1 : near));
        break;
      case 'scoop':
        if (e.id === own) this.tone(880, 1760, 0.12, 'sine', 0.12);
        break;
      case 'dock':
        if (e.id === own) this.tone(e.docked ? 440 : 660, e.docked ? 220 : 880, 0.3, 'triangle', 0.12);
        break;
      default:
        break;
    }
  }

  update(view: FrameView | null): void {
    const ctx = this.ctx;
    this.voices = 0;
    if (!ctx || ctx.state !== 'running' || !this.engine || !this.drive) return;
    const t = ctx.currentTime;
    const self = view?.self;
    let thrust = 0;
    let speedTone = 0;
    if (self && view) {
      const i = self.input;
      thrust = Math.min(1, Math.abs(i.thrust[0]) + Math.abs(i.thrust[1]) + Math.abs(i.thrust[2]) + Math.abs(self.state.throttle) * 0.8);
      if (view.fx.boosting) thrust = 1.4;
      speedTone = Math.min(1, v3.len(self.state.vel) / Math.max(1, self.stats.maxSpeed));
    }
    // Engine: a low rumble that opens up and rises with thrust.
    this.engine.osc.frequency.setTargetAtTime(48 + thrust * 46 + speedTone * 18, t, 0.12);
    this.engine.sub.frequency.setTargetAtTime(32 + thrust * 20, t, 0.12);
    this.engine.filter.frequency.setTargetAtTime(160 + thrust * 900, t, 0.1);
    this.engine.gain.gain.setTargetAtTime(self ? 0.05 + thrust * 0.11 : 0, t, 0.15);
    // Drive: a rising tone for cruise speed, drive charge and the fold tunnel.
    const fx = view?.fx;
    const drive = fx ? Math.max(fx.cruise, fx.charge * 0.8, fx.fold > 0 ? 1 : 0) : 0;
    this.drive.osc.frequency.setTargetAtTime(140 + drive * 520 + (fx?.fold ?? 0) * 200, t, 0.2);
    this.drive.gain.gain.setTargetAtTime(drive > 0 ? 0.02 + drive * 0.06 : 0, t, 0.2);

    if (view) {
      for (const e of view.events) this.event(e, view);
      if (view.fx.hitFlash > 0.95) this.burst(1500, 0.15, 0.2);
      if (view.fx.heat > 0.9 && view.clock - this.lastAlarm > 0.6) {
        this.lastAlarm = view.clock;
        this.tone(1040, 1040, 0.12, 'square', 0.07);
      }
    }
  }
}

export function createAudio(): GameAudio {
  return new Synth();
}
