/**
 * Self-lit effects near the camera: weapon fire, impacts, explosions, mining and salvage beams,
 * jump flashes, missile trails and the dust that gives a sense of speed.
 *
 * Game events arrive once, with coordinates relative to the zone anchor. Each starts one or more
 * pooled effects that live in anchor coordinates; every frame the live effects are stepped and
 * written, camera-relative, into two instanced batches (streaks and discs of light). Shield flares,
 * debris and dust have their own small meshes.
 */
import { Group } from 'three';
import type { FrameView, Lighting } from '../../../contracts.ts';
import type { Part } from '../part.ts';
import { Frame } from './core.ts';
import { Flashes, Sparks } from './particles.ts';
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
  root.add(ribbons.mesh, sprites.mesh);

  /** Drops everything live; stored positions mean nothing once the anchor is gone or has changed. */
  const clear = (): void => {
    sparks.clear();
    flashes.clear();
    weapons.clear();
  };

  return {
    root,

    init: () => Promise.resolve(),

    update(view: FrameView, _light: Lighting): void {
      const zone = view.zone;
      if (!zone) {
        clear();
        root.visible = false;
        return;
      }
      root.visible = true;
      if (!frame.begin(view, zone)) clear();

      const events = view.events;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        switch (ev.e) {
          case 'shot': weapons.shot(ev); break;
          case 'mine': weapons.mine(ev); break;
          case 'salvage': weapons.salvage(ev); break;
          default: break;
        }
      }

      ribbons.begin();
      sprites.begin();
      weapons.update();
      sparks.update(frame, ribbons);
      flashes.update(frame, sprites);
      ribbons.end();
      sprites.end();
    },

    dispose(): void {
      ribbons.dispose();
      sprites.dispose();
    },
  };
}
