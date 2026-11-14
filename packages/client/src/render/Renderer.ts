/**
 * The space renderer. It owns the WebGL renderer and the frame: sky and celestial bodies are drawn
 * first, then the local scene and the cockpit (each with a fresh depth buffer) into one HDR target,
 * which is bloomed, tone mapped and finished with the flight effects in a final pass. In cruise the
 * sky takes a detour through a target of its own, where it is smeared into streaks.
 */
import { HalfFloatType, LinearFilter, NoToneMapping, PerspectiveCamera, Scene, WebGLRenderTarget, WebGLRenderer } from 'three';
import type { FrameView, GameRenderer, GraphicsSettings, LocalLayer } from '../contracts.ts';
import { Bloom } from './post/Bloom.ts';
import { Composite } from './post/Composite.ts';
import { CRUISE_MIN, Cruise } from './post/Cruise.ts';
import { FullscreenPass } from './post/fullscreen.ts';
import { Bodies } from './space/Bodies.ts';
import { Sky } from './space/Sky.ts';
import { idleFrame } from './space/idle.ts';
import { computeLighting } from './space/lighting.ts';
import type { SpaceFrame, ViewParams } from './space/types.ts';

export function createRenderer(canvas: HTMLCanvasElement): GameRenderer {
  return new SpaceRenderer(canvas);
}

class SpaceRenderer implements GameRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly pass = new FullscreenPass();
  private readonly bloom = new Bloom();
  private readonly cruise = new Cruise();
  private readonly composite = new Composite();
  private readonly sky = new Sky();
  private readonly bodies = new Bodies(() => this.sky.cube);
  private readonly spaceScene = new Scene();
  // Celestial bodies are drawn without depth testing, so the depth range is free.
  private readonly spaceCam = new PerspectiveCamera(70, 1, 0.001, 1e7);
  private readonly localCam = new PerspectiveCamera(70, 1, 0.5, 400000);
  private readonly cockpitCam = new PerspectiveCamera(70, 1, 0.05, 100);
  private target: WebGLRenderTarget | null = null;
  private targetSamples = -1;
  private skyTarget: WebGLRenderTarget | null = null;
  /** Render-target size in device pixels. */
  private width = 2;
  private height = 2;
  private sizeKey = '';
  private local: LocalLayer | null = null;
  private localReady = false;
  private idleGraphics: GraphicsSettings = { quality: 2, bloom: true, resolution: 1 };
  private readonly startMs = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance',
    });
    this.renderer.autoClear = false;
    // Tone mapping and sRGB encoding happen once, in the final pass.
    this.renderer.toneMapping = NoToneMapping;
    this.sky.group.renderOrder = -1000;
    this.spaceScene.add(this.sky.group, this.bodies.group);
    this.resize(canvas.clientWidth || canvas.width || 2, canvas.clientHeight || canvas.height || 2, 1);
  }

  async init(local: LocalLayer): Promise<void> {
    this.local = local;
    await local.init(this.renderer);
    this.localReady = true;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    // Callers may resize every frame; the targets are only rebuilt when something changed.
    const key = `${width}x${height}@${pixelRatio}`;
    if (key === this.sizeKey) return;
    this.sizeKey = key;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.width = Math.max(2, Math.floor(width * pixelRatio));
    this.height = Math.max(2, Math.floor(height * pixelRatio));
    this.target?.dispose();
    this.target = null;
    this.skyTarget?.dispose();
    this.skyTarget = null;
    this.bloom.setSize(this.width, this.height);
  }

  /** The HDR scene target; multisampled on higher quality levels. */
  private ensureTarget(quality: number): WebGLRenderTarget {
    const samples = Math.min(this.renderer.capabilities.maxSamples, quality === 2 ? 4 : quality === 1 ? 2 : 0);
    if (!this.target || this.targetSamples !== samples) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(this.width, this.height, {
        type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true, samples,
      });
      this.targetSamples = samples;
    }
    return this.target;
  }

  /** Holds the sky alone while the ship is in cruise; made on first use. Nothing in the sky has an edge to smooth. */
  private ensureSkyTarget(): WebGLRenderTarget {
    this.skyTarget ??= new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false,
    });
    return this.skyTarget;
  }

  private aimCamera(cam: PerspectiveCamera, frame: SpaceFrame): void {
    const q = frame.camera.rot;
    cam.quaternion.set(q[0], q[1], q[2], q[3]);
    const aspect = this.width / this.height;
    if (cam.fov !== frame.camera.fov || cam.aspect !== aspect) {
      cam.fov = frame.camera.fov;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
  }

  render(view: FrameView | null): void {
    const r = this.renderer;
    if (view) this.idleGraphics = view.graphics;
    const frame: SpaceFrame = view ?? idleFrame((performance.now() - this.startMs) / 1000, this.idleGraphics);
    const quality = frame.graphics.quality;
    const target = this.ensureTarget(quality);

    this.sky.update(r, frame.system, frame.galaxy, quality);
    const lighting = computeLighting(frame.bodies, this.sky.envMap);
    const local = view && this.local && this.localReady ? this.local : null;
    if (local && view) local.update(view, lighting);

    this.aimCamera(this.spaceCam, frame);
    const params: ViewParams = {
      pixAngle: (2 * Math.tan((frame.camera.fov * Math.PI) / 360)) / this.height,
      width: this.width,
      height: this.height,
      quality,
      // Wrapped (at a multiple of the shaders' animation periods) so float32 time stays precise.
      clock: frame.clock % 14400,
    };
    this.sky.frame(params);
    this.bodies.update(frame, params);

    r.setClearColor(0x000000, 1);
    if (frame.fx.cruise > CRUISE_MIN) {
      // In cruise the sky is drawn on its own, smeared into streaks on its way into the frame,
      // and everything else is drawn over it as always.
      const sky = this.ensureSkyTarget();
      this.bodies.group.visible = false;
      r.setRenderTarget(sky);
      r.clear(true, false, false);
      r.render(this.spaceScene, this.spaceCam);
      this.bodies.group.visible = true;
      r.setRenderTarget(target);
      r.clear(true, true, false);
      this.cruise.render(r, this.pass, sky.texture, target, frame.fx.cruise, frame.clock, this.width, this.height, quality);
      this.sky.group.visible = false;
      r.render(this.spaceScene, this.spaceCam);
      this.sky.group.visible = true;
    } else {
      r.setRenderTarget(target);
      r.clear(true, true, false);
      r.render(this.spaceScene, this.spaceCam);
    }
    if (local) {
      this.aimCamera(this.localCam, frame);
      this.aimCamera(this.cockpitCam, frame);
      r.clearDepth();
      r.render(local.scene, this.localCam);
      r.clearDepth();
      r.render(local.cockpit, this.cockpitCam);
    }

    const bloom = frame.graphics.bloom ? this.bloom.render(r, this.pass, target.texture, this.width, this.height) : null;
    this.composite.render(r, this.pass, target.texture, bloom, frame.fx, frame.clock, this.width, this.height);
  }

  dispose(): void {
    this.local?.dispose();
    this.bodies.dispose();
    this.sky.dispose();
    this.bloom.dispose();
    this.cruise.dispose();
    this.composite.dispose();
    this.pass.dispose();
    this.target?.dispose();
    this.skyTarget?.dispose();
    this.renderer.dispose();
  }
}
