/**
 * Effects near the camera: weapon fire, impacts, explosions, mining and salvage beams, jump
 * flashes, missile trails, the dust that gives a sense of speed, and the regolith a ship kicks up
 * from the ground. Most are self-lit; debris and dust shine by the light that falls on them.
 *
 * Game events arrive once, with coordinates relative to the zone anchor. Each starts one or more
 * pooled effects that live in anchor coordinates; every frame the live effects are stepped and
 * written, camera-relative, into two instanced batches (streaks and discs of light). Shield flares,
 * debris and dust have their own small meshes.
 */
import { Group, HalfFloatType, PerspectiveCamera, WebGLRenderTarget, type WebGLRenderer } from 'three';
import type { FrameView, Lighting } from '../../../contracts.ts';
import type { Part } from '../part.ts';
import { sunVisibility } from '../util.ts';
import { Blasts } from './blasts.ts';
import { Frame } from './core.ts';
import { Debris } from './debris.ts';
import { Dust } from './dust.ts';
import { Impacts } from './impacts.ts';
import { Missiles } from './missiles.ts';
import { Flashes, Sparks } from './particles.ts';
import { Regolith } from './regolith.ts';
import { Ribbons } from './ribbons.ts';
import { Sprites } from './sprites.ts';
import { Weapons } from './weapons.ts';

export function createFx(): Part {
  const root = new Group();
  const frame = new Frame();
  const ribbons = new Ribbons(4096);
  const sprites = new Sprites(1024);
  const sparks = new Sparks(2048);
  const flashes = new Flashes(512);
  const weapons = new Weapons(frame, ribbons, sprites, sparks, flashes);
  const impacts = new Impacts(frame, sparks, flashes);
  const debris = new Debris();
  const blasts = new Blasts(frame, sparks, flashes, debris, weapons);
  const missiles = new Missiles(frame, ribbons, sprites);
  const dust = new Dust();
  const regolith = new Regolith(frame);
  root.add(debris.group, dust.mesh, regolith.mesh, impacts.mesh, ribbons.mesh, sprites.mesh);
  /** The light that reaches the camera: the sun is gone on the night side of the body it is near. Refilled every frame. */
  const lit: Lighting = { sunDir: [0, 1, 0], sunColor: [1, 1, 1], sunIntensity: 0, ambient: 0, envMap: null };

  /** Drops everything live; stored positions mean nothing once the anchor is gone or has changed. */
  const clear = (): void => {
    sparks.clear();
    flashes.clear();
    weapons.clear();
    impacts.clear();
    debris.clear();
    missiles.clear();
    regolith.clear();
  };

  return {
    root,

    init(renderer: WebGLRenderer): Promise<void> {
      // The debris models are optional and may arrive late; generated shards stand in until then.
      void debris.load();
      // Compile the shaders now, so the first shot of a fight does not stall a frame. A program is
      // compiled per output colour space, so this is done against a linear target like the one the
      // space renderer draws into. It only saves time; nothing depends on it having worked.
      const target = new WebGLRenderTarget(4, 4, { type: HalfFloatType, depthBuffer: false });
      const before = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(target);
        renderer.compile(root, new PerspectiveCamera());
      } catch {
        // The shaders compile on first use instead.
      } finally {
        renderer.setRenderTarget(before);
        target.dispose();
      }
      return Promise.resolve();
    },

    update(view: FrameView, light: Lighting): void {
      const zone = view.zone;
      if (!zone) {
        clear();
        root.visible = false;
        return;
      }
      root.visible = true;
      if (!frame.begin(view, zone)) clear();
      // Every effect writes its positions in the axes of the zone's frame (see `core.ts`); in a
      // surface frame those turn with the body, and this turns the whole part into system axes.
      root.quaternion.set(frame.qx, frame.qy, frame.qz, frame.qw);

      const events = view.events;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        switch (ev.e) {
          case 'shot': weapons.shot(ev); regolith.shot(ev); break;
          case 'mine': weapons.mine(ev); break;
          case 'salvage': weapons.salvage(ev); break;
          case 'hit': impacts.hit(ev); regolith.hit(ev); break;
          case 'destroyed': blasts.destroyed(ev); regolith.destroyed(ev); break;
          case 'fold': blasts.fold(ev); break;
          case 'cruise': blasts.cruise(ev); break;
          default: break;
        }
      }

      ribbons.begin();
      sprites.begin();
      weapons.update();
      missiles.update();
      impacts.update();
      // Wreckage and dust are lit by the sun, and the sun sets near the ground of a landable body.
      const sunlight = sunVisibility(view, light.sunDir);
      lit.sunDir = light.sunDir;
      lit.sunColor = light.sunColor;
      lit.sunIntensity = light.sunIntensity * sunlight;
      lit.ambient = light.ambient;
      lit.envMap = light.envMap;
      debris.update(frame, lit);
      dust.update(frame, lit);
      regolith.update(frame, lit, sunlight);
      sparks.update(frame, ribbons);
      flashes.update(frame, sprites);
      ribbons.end();
      sprites.end();
    },

    dispose(): void {
      ribbons.dispose();
      sprites.dispose();
      impacts.dispose();
      debris.dispose();
      dust.dispose();
      regolith.dispose();
    },
  };
}
