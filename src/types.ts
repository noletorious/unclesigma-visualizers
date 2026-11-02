import type * as THREE from "three";

export interface VisualHandle {
  update: (t: number, camera: THREE.PerspectiveCamera) => void;
  dispose: () => void;
}

export interface RecordScene {
  id: string;
  build: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => VisualHandle;
  /** Where the timer sits for this scene: vertical centre in % of the frame,
   * whether it gets a backing panel, and the countdown line's opacity (default
   * 0.35). Interpolated during crossfades. */
  hud: { y: number; panel?: boolean; countdownOpacity?: number };
}
