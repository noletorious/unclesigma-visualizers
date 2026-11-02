import * as THREE from "three";
import { archivedScenes, recordScenes } from "./scenes";
import type { RecordScene, VisualHandle } from "./types";

// A small player for the scenes: one canvas inside a container, one scene showing at a time, and a
// crossfade when the scene changes. Nothing here owns a timer. The caller calls update(t) with the
// time in seconds (any value: every scene's motion is a pure function of t, so the same t draws the
// same frame, which is what lets the stream follow its schedule clock and the recorder step frames).
//
// This package never imports Strudel. Audio-reactive scenes are a later step: update() already takes
// an optional AudioData (plain numbers) so callers will not change when scenes start using it.

/** Plain audio numbers for reactive scenes (reserved: no scene reads this yet). */
export type AudioData = { level: number; bands: number[] };

export interface VisualOptions {
  /** Device pixel ratio for the canvas. Below 1 draws fewer pixels (cheaper) and lets CSS scale it up. Default 1. */
  pixelRatio?: number;
  antialias?: boolean;
  /** Crossfade length in seconds when the scene changes. Default 4. */
  fade?: number;
  /** MSAA samples for the crossfade targets (0 is cheapest). Default 0. */
  samples?: number;
}

export interface Visual {
  /** Size in CSS pixels. The canvas fills its container; call this when the container resizes. */
  setSize(width: number, height: number): void;
  /** Crossfade to another scene (starting at the next update). Unknown ids are ignored. */
  setScene(id: string): void;
  /** Draw the frame for time `t` (seconds). */
  update(t: number, audio?: AudioData): void;
  readonly sceneId: string;
  dispose(): void;
}

/** Every scene id the package knows (the three in the 1-hour video, then the archived ones). */
export const VISUAL_IDS: string[] = [...recordScenes, ...archivedScenes].map((s) => s.id);

const entry = (id: string): RecordScene | undefined => [...recordScenes, ...archivedScenes].find((s) => s.id === id);
const smooth = (k: number) => {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
};

type Instance = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; handle: VisualHandle };

export function createVisual(container: HTMLElement, initialId: string, opts: VisualOptions = {}): Visual {
  const fade = opts.fade ?? 4;
  let width = Math.max(1, container.clientWidth);
  let height = Math.max(1, container.clientHeight);

  const renderer = new THREE.WebGLRenderer({ antialias: opts.antialias ?? false, powerPreference: "high-performance" });
  renderer.setPixelRatio(opts.pixelRatio ?? 1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  container.appendChild(renderer.domElement);

  const instances = new Map<string, Instance>();
  const instance = (id: string): Instance | null => {
    const found = instances.get(id);
    if (found) return found;
    const def = entry(id);
    if (!def) return null;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 200);
    const made = { scene, camera, handle: def.build(scene, camera) };
    instances.set(id, made);
    return made;
  };

  // Crossfade: both scenes draw into targets and a full-screen quad mixes them.
  let targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  const makeTarget = () =>
    new THREE.WebGLRenderTarget(width * renderer.getPixelRatio(), height * renderer.getPixelRatio(), {
      type: THREE.HalfFloatType,
      samples: opts.samples ?? 0,
    });
  const mixMaterial = new THREE.ShaderMaterial({
    uniforms: { tA: { value: null }, tB: { value: null }, mixAmount: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D tA; uniform sampler2D tB; uniform float mixAmount; varying vec2 vUv;
      void main(){
        gl_FragColor = mix(texture2D(tA, vUv), texture2D(tB, vUv), mixAmount);
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  quadScene.add(new THREE.Mesh(quadGeometry, mixMaterial));
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let current = entry(initialId) ? initialId : recordScenes[0].id;
  let from: string | null = null;
  let startedAt: number | null = null; // set by the first update() after setScene()

  return {
    get sceneId() {
      return current;
    },
    setSize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setSize(width, height, false);
      for (const { camera } of instances.values()) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      if (targets) {
        const pr = renderer.getPixelRatio();
        for (const t of targets) t.setSize(width * pr, height * pr);
      }
    },
    setScene(id) {
      if (id === current || !entry(id)) return;
      from = current;
      current = id;
      startedAt = null;
    },
    update(t) {
      const now = instance(current);
      if (!now) return;
      let mix = 1;
      if (from) {
        startedAt ??= t;
        mix = fade > 0 ? smooth((t - startedAt) / fade) : 1;
        if (mix >= 1) from = null;
      }
      const before = from ? instance(from) : null;
      now.handle.update(t, now.camera);
      if (!before) {
        renderer.setRenderTarget(null);
        renderer.render(now.scene, now.camera);
        return;
      }
      before.handle.update(t, before.camera);
      targets ??= [makeTarget(), makeTarget()];
      renderer.setRenderTarget(targets[0]);
      renderer.render(before.scene, before.camera);
      renderer.setRenderTarget(targets[1]);
      renderer.render(now.scene, now.camera);
      renderer.setRenderTarget(null);
      mixMaterial.uniforms.tA.value = targets[0].texture;
      mixMaterial.uniforms.tB.value = targets[1].texture;
      mixMaterial.uniforms.mixAmount.value = mix;
      renderer.render(quadScene, quadCamera);
    },
    dispose() {
      for (const { handle } of instances.values()) handle.dispose();
      instances.clear();
      targets?.forEach((t) => t.dispose());
      targets = null;
      mixMaterial.dispose();
      quadGeometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
