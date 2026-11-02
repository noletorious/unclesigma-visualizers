export const SCENE_SECONDS = 1200; // 20 min

export const TAU = Math.PI * 2;
/** Phase for a motion with the given period in seconds (must divide 1200). */
export const ph = (t: number, period: number) => (TAU * t) / period;
export const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

// Deterministic PRNG so every page load / worker builds the identical scene.
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stateless hash -> [0,1), for events scheduled as a pure function of time.
export function hash01(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  a = Math.imul(a ^ (a >>> 15), 2246822507);
  a = Math.imul(a ^ (a >>> 13), 3266489909);
  return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}
