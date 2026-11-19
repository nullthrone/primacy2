import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadOrder, soundsOf, type ShippedManifest } from './library.ts';
import { azimuthOf, balance, behindCutoff, crossfadeWeights, stagePan, wrapDegrees } from './stage.ts';

const manifest = JSON.parse(readFileSync(new URL('../../public/audio/manifest.json', import.meta.url), 'utf8')) as ShippedManifest;

describe('the place of a one-channel sound', () => {
  it('folds degrees into -180 .. 180', () => {
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-190)).toBe(170);
    expect(wrapDegrees(360)).toBe(0);
  });

  it('straight ahead both sides play at the level of the file', () => {
    expect(balance(0)).toEqual({ left: 1, right: 1 });
  });

  it('no side ever gets more than the file holds', () => {
    for (let a = -180; a <= 180; a += 5) {
      const b = balance(a);
      expect(Math.max(b.left, b.right)).toBeLessThanOrEqual(1);
      expect(Math.min(b.left, b.right)).toBeGreaterThanOrEqual(0);
    }
  });

  it('a sound from the right is quieter on the left, and the other way round', () => {
    expect(balance(90).right).toBe(1);
    expect(balance(90).left).toBeCloseTo(0);
    expect(balance(-90).left).toBe(1);
    expect(balance(-90).right).toBeCloseTo(0);
    expect(balance(20).left).toBeCloseTo(1 - Math.sin((20 * Math.PI) / 180));
  });

  it('a source behind is panned like its mirror image ahead and is duller', () => {
    expect(stagePan(150)).toBeCloseTo(stagePan(30));
    expect(stagePan(-120)).toBeCloseTo(stagePan(-60));
    expect(behindCutoff(0)).toBe(20000);
    expect(behindCutoff(90)).toBe(20000);
    expect(behindCutoff(180)).toBeCloseTo(3500);
    expect(behindCutoff(135)).toBeLessThan(20000);
    expect(behindCutoff(135)).toBeGreaterThan(3500);
  });

  it('is the direction of the event, else the place of the sound, else straight ahead', () => {
    expect(azimuthOf({ place: 20 }, -70)).toBe(-70);
    expect(azimuthOf({ place: 20 })).toBe(20);
    expect(azimuthOf({ place: 'event' })).toBe(0);
    expect(azimuthOf({})).toBe(0);
    expect(azimuthOf({ place: 20 }, Number.NaN)).toBe(20);
  });
});

describe('the crossfade of the engine levels', () => {
  const points = [0, 0.25, 0.5, 0.75, 1, 1.4];

  it('on a level only that level sounds', () => {
    points.forEach((p, i) => {
      const w = crossfadeWeights(points, p);
      w.forEach((x, j) => expect(x).toBeCloseTo(i === j ? 1 : 0));
    });
  });

  it('between two levels the neighbours share with equal power and the rest is silent', () => {
    for (let t = 0; t <= 1.4; t += 0.01) {
      const w = crossfadeWeights(points, t);
      expect(w.reduce((a, x) => a + x * x, 0)).toBeCloseTo(1);
      expect(w.filter((x) => x > 1e-9).length).toBeLessThanOrEqual(2);
    }
  });

  it('holds the ends beyond the range', () => {
    expect(crossfadeWeights(points, -1)[0]).toBe(1);
    expect(crossfadeWeights(points, 9)[5]).toBe(1);
  });
});

describe('the shipped manifest', () => {
  it('has the six engine levels the crossfade needs, with the boost beyond full thrust', () => {
    const levels = manifest.sounds.filter((s) => s.family === 'engine_main').map((s) => s.params?.thrust).sort();
    expect(levels).toEqual([0, 0.25, 0.5, 0.75, 1, 1.4]);
  });

  it('an event finds its own sounds, a stand-in those of its target, a role its downloads', () => {
    expect(soundsOf(manifest, 'thruster_pulse_c').length).toBeGreaterThan(1);
    expect(soundsOf(manifest, 'thruster_pulse_a')).toEqual(soundsOf(manifest, 'thruster_pulse_c'));
    expect(soundsOf(manifest, 'ui_click')).toEqual(manifest.roles.ui_click);
    expect(soundsOf(manifest, 'weapon_cannon_fire')).toEqual([]);
    expect(soundsOf(manifest, 'no_such_event')).toEqual([]);
  });

  it('every event is answered once: by its own sounds, a stand-in, or silence with a reason', () => {
    const events = new Set([...Object.keys(manifest.events), ...Object.keys(manifest.standIn), ...Object.keys(manifest.silent)]);
    expect(events.size).toBe(Object.keys(manifest.events).length + Object.keys(manifest.standIn).length + Object.keys(manifest.silent).length);
    for (const target of Object.values(manifest.standIn)) expect(manifest.events[target]).toBeDefined();
    for (const ids of [...Object.values(manifest.events), ...Object.values(manifest.roles)]) {
      for (const id of ids) expect(manifest.sounds.some((s) => s.id === id), id).toBe(true);
    }
  });

  it('loads the room, the cabin, the engine and the thrusters first, and everything once', () => {
    const order = loadOrder(manifest);
    expect(order.length).toBe(manifest.sounds.length);
    expect(new Set(order).size).toBe(order.length);
    expect(order.slice(0, 2)).toEqual(['cabin_ir', 'cabin_ambience_loop']);
    const first = order.slice(0, 17);
    for (const id of ['engine_main_t000', 'engine_main_boost', 'g_thruster_pulse_c', 'thruster_burn_loop']) expect(first).toContain(id);
  });
});
