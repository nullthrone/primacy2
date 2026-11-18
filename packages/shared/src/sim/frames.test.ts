import { describe, expect, it } from 'vitest';
import { computeShipStats, starterLoadout } from '../catalog.ts';
import { SITE_ID_BASE, SURFACE_FRAME_EXIT, SURFACE_ID_BASE } from '../constants.ts';
import { quat, v3, type Quat, type Vec3 } from '../math.ts';
import {
  anchorBody, anchorFrame, anchorName, anchorState, bodyAngularVelocity, bodyRotation, bodySpinAxis, bodySpinRate, bodyState, findSite,
  groundSiteRotation, isRotatingAnchor, isSurfaceAnchor, isValidAnchor, pickNormalAnchor, surfaceAnchor, surfaceBodyAt, surfaceFrameAltitude,
} from '../universe/orbits.ts';
import { bodySurface, groundSitePose } from '../universe/surface.ts';
import {
  fixtureSystem, FIXTURE_MOON, FIXTURE_PLANET, landingSystem, LANDING_BASE, LANDING_GIANT, LANDING_MOON, LANDING_PLANET,
  LANDING_PLANET_DAY, LANDING_PLANET_RADIUS, LANDING_STAR, LANDING_STATION,
} from './fixtures.ts';
import { absolutePosition, absoluteRotation, absoluteVelocity, reanchor } from './frames.ts';
import { newShipState } from './ship.ts';
import type { ShipState } from './types.ts';

const wisp = computeShipStats(starterLoadout('wisp'));
const sys = landingSystem();
const T = 98_765.4;
const PLANET_SURFACE = surfaceAnchor(LANDING_PLANET);
const MOON_SURFACE = surfaceAnchor(LANDING_MOON);

/** A ship in some frame, moving and tilted. */
function ship(anchor: number, pos: Vec3, vel: Vec3 = [30, -12, 7]): ShipState {
  const s = newShipState(wisp);
  s.anchor = anchor;
  s.pos = v3.clone(pos);
  s.vel = v3.clone(vel);
  s.rot = quat.fromAxisAngle([0.3, -0.8, 0.5], 1.1);
  return s;
}

/** Angle in radians between two orientations. */
const angleBetween = (a: Readonly<Quat>, b: Readonly<Quat>): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

describe('body rotation', () => {
  it('turns body-fixed axes into system axes: spin about +Y by t / rotPeriod turns, then tilt about +X', () => {
    for (const tilt of [0, 0.3, 1.2, 2.9]) {
      for (const rotPeriod of [86_400, -50_000, 7200.5]) {
        for (const t of [0, 1234.5, 0.25 * 86_400, 8.7e8]) {
          const q = bodyRotation({ tilt, rotPeriod }, t);
          // The same rotation written out as matrices, the way Bodies.ts in the client composes it.
          const a = (2 * Math.PI * t) / rotPeriod;
          const spun = (v: Vec3): Vec3 => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
          const tilted = (v: Vec3): Vec3 => [v[0], v[1] * Math.cos(tilt) - v[2] * Math.sin(tilt), v[1] * Math.sin(tilt) + v[2] * Math.cos(tilt)];
          for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.5, 0.8]] as Vec3[]) {
            // Years of universe time cost a few digits of the phase; nothing more.
            expect(v3.dist(quat.rotate(q, v), tilted(spun(v)))).toBeLessThan(t > 1e8 ? 1e-7 : 1e-12);
          }
          expect(v3.dist(quat.rotate(q, [0, 1, 0]), bodySpinAxis({ tilt }))).toBeLessThan(1e-12);
        }
      }
    }
    // With no tilt and a quarter of a day gone, the body's +X axis points along system -Z.
    expect(v3.dist(quat.rotate(bodyRotation({ tilt: 0, rotPeriod: 100 }, 25), [1, 0, 0]), [0, 0, -1])).toBeLessThan(1e-12);
    // A body that does not turn (rotPeriod 0) keeps its tilt and nothing else.
    expect(bodyRotation({ tilt: 0, rotPeriod: 0 }, 5e5)).toEqual([0, 0, 0, 1]);
    expect(bodySpinRate({ rotPeriod: 0 })).toBe(0);
  });

  it('has the angular velocity that its rotation shows over a short time', () => {
    for (const body of [{ tilt: 0.3, rotPeriod: 14_400 }, { tilt: 1.9, rotPeriod: -30_000 }]) {
      const omega = bodyAngularVelocity(body);
      expect(v3.len(omega)).toBeCloseTo((2 * Math.PI) / Math.abs(body.rotPeriod), 15);
      expect(v3.dist(v3.scale(bodySpinAxis(body), bodySpinRate(body)), omega)).toBe(0);
      const p: Vec3 = [1e6, 2e5, -4e5];
      const dt = 0.5;
      const before = quat.rotate(bodyRotation(body, 1000 - dt), p);
      const after = quat.rotate(bodyRotation(body, 1000 + dt), p);
      const now = quat.rotate(bodyRotation(body, 1000), p);
      // Speed of a point of the body: omega x r.
      expect(v3.dist(v3.scale(v3.sub(after, before), 1 / (2 * dt)), v3.cross(omega, now))).toBeLessThan(1e-5);
    }
  });
});

describe('anchor ids', () => {
  it('keeps bodies below SURFACE_ID_BASE, surface frames up to SITE_ID_BASE and sites above', () => {
    expect(SURFACE_ID_BASE).toBe(500);
    expect(surfaceAnchor(7)).toBe(507);
    expect(isSurfaceAnchor(7)).toBe(false);
    expect(isSurfaceAnchor(507)).toBe(true);
    expect(isSurfaceAnchor(SITE_ID_BASE)).toBe(false);
    expect(anchorBody(7)).toBe(7);
    expect(anchorBody(507)).toBe(7);
    expect(anchorBody(SITE_ID_BASE + 3)).toBe(-1);
    expect(anchorBody(-1)).toBe(-1);
  });

  it('accepts a surface anchor only for a body that can be landed on', () => {
    expect(isValidAnchor(sys, PLANET_SURFACE)).toBe(true);
    expect(isValidAnchor(sys, MOON_SURFACE)).toBe(true);
    expect(isValidAnchor(sys, surfaceAnchor(LANDING_STAR))).toBe(false);
    expect(isValidAnchor(sys, surfaceAnchor(LANDING_GIANT))).toBe(false);
    expect(isValidAnchor(sys, surfaceAnchor(sys.bodies.length))).toBe(false);
    expect(() => anchorState(sys, surfaceAnchor(LANDING_GIANT), T)).toThrow();
    expect(() => anchorFrame(sys, surfaceAnchor(LANDING_GIANT), T)).toThrow();
    // The fixture of the older tests: its terran planet is not landable, its moon is.
    expect(isValidAnchor(fixtureSystem(), surfaceAnchor(FIXTURE_PLANET))).toBe(false);
    expect(isValidAnchor(fixtureSystem(), surfaceAnchor(FIXTURE_MOON))).toBe(true);
    expect(findSite(sys, PLANET_SURFACE)).toBeUndefined();
    expect(anchorName(sys, PLANET_SURFACE)).toBe('Lander I');
    expect(anchorName(sys, LANDING_BASE)).toBe('Lander Ground');
    expect(isRotatingAnchor(sys, LANDING_PLANET)).toBe(false);
    expect(isRotatingAnchor(sys, LANDING_STATION)).toBe(false);
    expect(isRotatingAnchor(sys, PLANET_SURFACE)).toBe(true);
    expect(isRotatingAnchor(sys, LANDING_BASE)).toBe(true);
  });
});

describe('anchorState and anchorFrame', () => {
  it('puts a surface frame at the body centre, turning with the body', () => {
    const body = sys.bodies[LANDING_PLANET]!;
    expect(anchorState(sys, PLANET_SURFACE, T)).toEqual(bodyState(sys, LANDING_PLANET, T));
    const f = anchorFrame(sys, PLANET_SURFACE, T);
    expect(f.pos).toEqual(bodyState(sys, LANDING_PLANET, T).pos);
    expect(f.vel).toEqual(bodyState(sys, LANDING_PLANET, T).vel);
    expect(f.rot).toEqual(bodyRotation(body, T));
    expect(f.omega).toEqual(bodyAngularVelocity(body));
    expect(v3.len(f.omega)).toBeCloseTo((2 * Math.PI) / LANDING_PLANET_DAY, 15);
    // Frames that do not turn say so.
    for (const id of [LANDING_STAR, LANDING_PLANET, LANDING_STATION]) {
      const g = anchorFrame(sys, id, T);
      expect(g.rot).toEqual([0, 0, 0, 1]);
      expect(g.omega).toEqual([0, 0, 0]);
      expect(g.pos).toEqual(anchorState(sys, id, T).pos);
      expect(g.vel).toEqual(anchorState(sys, id, T).vel);
    }
  });

  it('gives a ground site its true moving position: on the ground, carried around by the body', () => {
    const site = findSite(sys, LANDING_BASE)!;
    const body = sys.bodies[LANDING_PLANET]!;
    const centre = bodyState(sys, LANDING_PLANET, T);
    const st = anchorState(sys, LANDING_BASE, T);
    const expected = v3.add(centre.pos, quat.rotate(bodyRotation(body, T), site.ground!.pos));
    expect(v3.dist(st.pos, expected)).toBeLessThan(1e-3);
    // Its velocity is what its position does over a short time, and that is mostly the spin.
    const dt = 0.5;
    const numeric = v3.scale(v3.sub(anchorState(sys, LANDING_BASE, T + dt).pos, anchorState(sys, LANDING_BASE, T - dt).pos), 1 / (2 * dt));
    expect(v3.dist(st.vel, numeric)).toBeLessThan(0.05);
    expect(v3.len(v3.sub(st.vel, centre.vel))).toBeGreaterThan(500);

    const pose = groundSitePose(sys, site, T);
    expect(pose.surface.pos).toEqual(site.ground!.pos);
    expect(pose.surface.rot).toEqual(groundSiteRotation(site));
    expect(pose.system.pos).toEqual(st.pos);
    expect(pose.system.vel).toEqual(st.vel);
    // Up is the pad normal, the nose looks north along the ground.
    const up = quat.rotate(pose.surface.rot, [0, 1, 0]);
    expect(v3.dist(up, v3.normalize(site.ground!.pos))).toBeLessThan(1e-12);
    const nose = quat.rotate(pose.surface.rot, [0, 0, -1]);
    expect(Math.abs(v3.dot(nose, up))).toBeLessThan(1e-12);
    expect(nose[1]).toBeGreaterThan(0);
    expect(Math.abs(v3.dot(v3.cross(nose, [0, 1, 0]), up))).toBeLessThan(1e-12);
    expect(v3.dist(quat.rotate(pose.system.rot, [0, 1, 0]), quat.rotate(bodyRotation(body, T), up))).toBeLessThan(1e-12);
    expect(() => groundSitePose(sys, findSite(sys, LANDING_STATION)!, T)).toThrow();
  });
});

describe('absolute state and reanchor', () => {
  const height = LANDING_PLANET_RADIUS + 50_000;
  const anchors = [LANDING_STAR, LANDING_PLANET, PLANET_SURFACE, LANDING_MOON, MOON_SURFACE, LANDING_GIANT, LANDING_STATION, LANDING_BASE];

  it('expresses a ship in a turning frame in system axes, with the speed the frame carries it at', () => {
    const body = sys.bodies[LANDING_PLANET]!;
    const s = ship(PLANET_SURFACE, [height, 2000, -3000], [0, 0, 0]);
    const centre = bodyState(sys, LANDING_PLANET, T);
    const rot = bodyRotation(body, T);
    expect(v3.dist(absolutePosition(s, sys, T), v3.add(centre.pos, quat.rotate(rot, s.pos)))).toBe(0);
    // At rest over the ground it still moves with the ground: omega x r, about a kilometre per second here.
    const carried = v3.cross(bodyAngularVelocity(body), quat.rotate(rot, s.pos));
    expect(v3.len(carried)).toBeGreaterThan(900);
    expect(v3.dist(absoluteVelocity(s, sys, T), v3.add(centre.vel, carried))).toBeLessThan(1e-9);
    expect(angleBetween(absoluteRotation(s, sys, T), quat.mul(rot, s.rot))).toBeLessThan(1e-7);
    // A fold tunnel has no anchor; the offset comes back unchanged.
    const folding = ship(-1, [1, 2, 3]);
    expect(absolutePosition(folding, sys, T)).toEqual([1, 2, 3]);
    expect(absoluteRotation(folding, sys, T)).toEqual(folding.rot);
  });

  it('keeps the barycentric position, velocity and orientation between any two frames', () => {
    for (const from of anchors) {
      for (const to of anchors) {
        const s = ship(from, [height, 2000, -3000]);
        const pos = absolutePosition(s, sys, T);
        const vel = absoluteVelocity(s, sys, T);
        const rot = absoluteRotation(s, sys, T);
        reanchor(s, sys, to, T);
        expect(s.anchor).toBe(to);
        // Barycentric coordinates are around 1e12 m, where a double resolves a tenth of a millimetre.
        expect(v3.dist(absolutePosition(s, sys, T), pos), `${from} -> ${to}`).toBeLessThan(2e-3);
        expect(v3.dist(absoluteVelocity(s, sys, T), vel), `${from} -> ${to}`).toBeLessThan(1e-6);
        expect(angleBetween(absoluteRotation(s, sys, T), rot), `${from} -> ${to}`).toBeLessThan(1e-7);
      }
    }
  });

  it('comes back to the same state after a round trip through any other frame', () => {
    for (const from of anchors) {
      for (const via of anchors) {
        const s = ship(from, [height, 2000, -3000]);
        const start = { pos: v3.clone(s.pos), vel: v3.clone(s.vel), rot: quat.clone(s.rot) };
        reanchor(s, sys, via, T);
        reanchor(s, sys, from, T);
        expect(v3.dist(s.pos, start.pos), `${from} via ${via}`).toBeLessThan(2e-3);
        expect(v3.dist(s.vel, start.vel), `${from} via ${via}`).toBeLessThan(1e-6);
        expect(angleBetween(s.rot, start.rot), `${from} via ${via}`).toBeLessThan(1e-7);
      }
    }
  });

  it('is exact between a body frame and its own surface frame, where the origin does not move', () => {
    const s = ship(LANDING_PLANET, [height, 2000, -3000]);
    const start = { pos: v3.clone(s.pos), vel: v3.clone(s.vel) };
    reanchor(s, sys, PLANET_SURFACE, T);
    // The offset keeps its length to the last bits; nothing of the size of an orbit was added or taken away.
    expect(Math.abs(v3.len(s.pos) - v3.len(start.pos))).toBeLessThan(1e-8);
    // Over the ground the ship is slower or faster by what the ground itself does.
    expect(Math.abs(v3.len(s.vel) - v3.len(start.vel))).toBeGreaterThan(100);
    reanchor(s, sys, LANDING_PLANET, T);
    expect(v3.dist(s.pos, start.pos)).toBeLessThan(1e-8);
    expect(v3.dist(s.vel, start.vel)).toBeLessThan(1e-11);
    // Re-anchoring to the frame a ship is in changes nothing at all.
    const same = ship(PLANET_SURFACE, [height, 0, 0]);
    const copy = JSON.stringify(same);
    reanchor(same, sys, PLANET_SURFACE, T);
    expect(JSON.stringify(same)).toBe(copy);
  });

  it('puts a ship docked at a ground base where the base is', () => {
    const docked = ship(LANDING_BASE, [0, 0, 0], [0, 0, 0]);
    expect(v3.dist(absolutePosition(docked, sys, T), anchorState(sys, LANDING_BASE, T).pos)).toBe(0);
    expect(v3.dist(absoluteVelocity(docked, sys, T), anchorState(sys, LANDING_BASE, T).vel)).toBe(0);
    // In the surface frame that is the pad centre, at rest.
    reanchor(docked, sys, PLANET_SURFACE, T);
    expect(v3.dist(docked.pos, findSite(sys, LANDING_BASE)!.ground!.pos)).toBeLessThan(2e-3);
    expect(v3.len(docked.vel)).toBeLessThan(1e-6);
  });
});

describe('the anchor for normal flight', () => {
  it('is the surface frame below surfaceFrameAltitude and the body frame above', () => {
    const body = sys.bodies[LANDING_PLANET]!;
    // A tenth of the radius, between 60 and 300 km.
    expect(surfaceFrameAltitude(body)).toBe(240_000);
    expect(surfaceFrameAltitude({ radius: 4e5 })).toBe(60_000);
    expect(surfaceFrameAltitude({ radius: 6.4e6 })).toBe(300_000);
    const surface = bodySurface(sys, LANDING_PLANET)!;
    expect(surface.enter).toBe(LANDING_PLANET_RADIUS + 240_000);
    expect(surface.exit).toBe(LANDING_PLANET_RADIUS + SURFACE_FRAME_EXIT * 240_000);
    expect(bodySurface(sys, LANDING_GIANT)).toBeNull();

    const centre = bodyState(sys, LANDING_PLANET, T).pos;
    const at = (r: number): Vec3 => v3.add(centre, v3.scale(v3.normalize([1, 2, -2]), r));
    expect(pickNormalAnchor(sys, at(LANDING_PLANET_RADIUS + 239_000), T)).toBe(PLANET_SURFACE);
    expect(pickNormalAnchor(sys, at(LANDING_PLANET_RADIUS + 1_000), T)).toBe(PLANET_SURFACE);
    expect(pickNormalAnchor(sys, at(LANDING_PLANET_RADIUS + 241_000), T)).toBe(LANDING_PLANET);
    expect(surfaceBodyAt(sys, at(LANDING_PLANET_RADIUS + 239_000), T)).toBe(LANDING_PLANET);
    expect(surfaceBodyAt(sys, at(LANDING_PLANET_RADIUS + 241_000), T)).toBe(-1);
    // Around the moon too, and never around a body that cannot be landed on.
    const moon = bodyState(sys, LANDING_MOON, T).pos;
    expect(pickNormalAnchor(sys, v3.add(moon, [0, 4.5e5, 0]), T)).toBe(MOON_SURFACE);
    expect(pickNormalAnchor(sys, v3.add(moon, [0, 4.7e5, 0]), T)).toBe(LANDING_MOON);
    const giant = bodyState(sys, LANDING_GIANT, T).pos;
    expect(pickNormalAnchor(sys, v3.add(giant, [0, sys.bodies[LANDING_GIANT]!.radius * 1.001, 0]), T)).toBe(LANDING_GIANT);
    // At a station nothing has changed.
    expect(pickNormalAnchor(sys, v3.add(anchorState(sys, LANDING_STATION, T).pos, [500, 0, 0]), T)).toBe(LANDING_STATION);
  });

  it('is the surface frame even inside the zone of a station that orbits low', () => {
    // A station 150 km above the ground: its 250 km zone reaches down to the surface.
    const low = landingSystem();
    const station = findSite(low, LANDING_STATION)!;
    station.orbit = { ...station.orbit, parent: LANDING_PLANET, a: LANDING_PLANET_RADIUS + 150_000, period: 5000 };
    const centre = bodyState(low, LANDING_PLANET, T).pos;
    const at = anchorState(low, LANDING_STATION, T).pos;
    const down = v3.normalize(v3.sub(centre, at));
    expect(pickNormalAnchor(low, v3.addScaled(at, down, 100_000), T)).toBe(PLANET_SURFACE);
    // Above the surface frame the station's zone is what it was.
    station.orbit = { ...station.orbit, a: LANDING_PLANET_RADIUS + 400_000 };
    const high = anchorState(low, LANDING_STATION, T).pos;
    expect(pickNormalAnchor(low, v3.addScaled(high, v3.normalize(v3.sub(centre, high)), 100_000), T)).toBe(LANDING_STATION);
  });
});
