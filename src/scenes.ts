import * as THREE from "three";
import { SCENE_SECONDS, TAU, hash01, mulberry32, ph, smoothstep } from "./helpers";
import type { RecordScene, VisualHandle } from "./types";

// The scenes. Every motion is a pure function of `t` whose period divides
// SCENE_SECONDS, so a scene (and a video made of them) loops seamlessly.
// Rainbow palette, slow motion, black background. Moved here from the site's
// recorder (src/record/scenes.ts) unchanged.

export { SCENE_SECONDS };

// Rainbow wave grid: a wide line-mesh height field of layered travelling
// waves, hue drifting slowly across it, fading to black at the edges. The
// whole field streams toward/past the camera (flying forward) while the camera
// drifts slowly left and right.
function buildRainbowGrid(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): VisualHandle {
  const nx = 150;
  const nz = 110;
  const width = 64;
  const cols = nx + 1;
  // Rows run well past the camera (z=9) so the near edge bleeds out of the
  // bottom of the frame instead of showing where the grid begins; one more
  // row lets the lattice scroll.
  const frontRows = 16;
  const rows = nz + 2 + frontRows;
  const count = cols * rows;

  // Flow speed (units/s): the field streams past the camera, which reads as
  // flying forward through the grid. Chosen so the z-travelling waves (0.28*z
  // and 0.2*(x+z) terms) complete a whole number of cycles over SCENE_SECONDS,
  // and the cell size so the lattice crosses a whole number of cells in that
  // time, so the scene loops seamlessly.
  const flow = (2 * Math.PI * 20) / (0.28 * SCENE_SECONDS);
  const cellsPerLoop = Math.round((flow * SCENE_SECONDS) / 0.436);
  const dz = (flow * SCENE_SECONDS) / cellsPerLoop;
  const depth = dz * nz; // ~48

  const baseX = new Float32Array(cols);
  const edgeFade = new Float32Array(cols);
  for (let i = 0; i <= nx; i++) {
    baseX[i] = (i / nx - 0.5) * width;
    edgeFade[i] = 1 - smoothstep(0.55, 1, Math.abs(baseX[i]) / (width / 2));
  }
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const indices: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i <= nx; i++) {
      const id = r * cols + i;
      if (i < nx) indices.push(id, id + 1);
      if (r < rows - 1) indices.push(id, id + cols);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  scene.add(lines);

  const color = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);

  // "Measurement" events: now and then the wave function collapses at a random
  // spot. The waves around it flatten, a narrow spike rises and flashes
  // white, and a ring spreads outward before the waves return. Events are
  // anchored to the flowing field and scheduled as a pure function of time
  // (slots divide SCENE_SECONDS), so they loop with the scene.
  const EVENT_SECONDS = 4.5;
  const channels = [
    { slot: 12, seed: 3 },
    { slot: 15, seed: 8 },
  ];
  type Measure = { x0: number; zw: number; tStart: number; u: number };
  const activeEvents = (t: number): Measure[] => {
    const out: Measure[] = [];
    for (const ch of channels) {
      const n = SCENE_SECONDS / ch.slot;
      const s = Math.floor(t / ch.slot);
      const idx = ((s % n) + n) % n;
      if (hash01(idx * 13 + ch.seed) >= 0.6) continue;
      const h = (k: number) => hash01(idx * 31 + ch.seed * 7 + k);
      const tStart = s * ch.slot + h(1) * (ch.slot - EVENT_SECONDS - 0.1);
      const u = (t - tStart) / EVENT_SECONDS;
      if (u < 0 || u > 1) continue;
      out.push({ x0: -13 + h(2) * 26, zw: -3 - h(3) * 18, tStart, u });
    }
    return out;
  };

  return {
    update(t) {
      const w1 = ph(t, 60);
      const w2 = ph(t, 40);
      const w3 = ph(t, 120);
      const w4 = ph(t, 30);
      const hueShift = t / 120;
      const scroll = flow * t;
      const off = (((scroll / dz) % 1) + 1) % 1;
      const events = activeEvents(t);

      for (let r = 0; r < rows; r++) {
        // Row r sits one cell back per unit of `off`, so rows drift away from
        // the camera and row r+1 takes row r's place as `off` wraps.
        const z = 6 + frontRows * dz - (r - 1 + off) * dz;
        const u = (6 - z) / depth;
        const rowFade = 1 - smoothstep(0.35, 1, u);
        const zs = z + scroll;
        for (let i = 0; i <= nx; i++) {
          const id = r * cols + i;
          const x = baseX[i];
          const rr = Math.sqrt(x * x + (z + 6) * (z + 6));
          let h =
            0.55 * Math.sin(0.35 * x + w1) +
            0.45 * Math.sin(0.28 * zs + w2) +
            0.35 * Math.sin(0.2 * (x + zs) + w3) +
            0.3 * Math.sin(0.45 * rr - w4);
          let flash = 0; // white-hot amount
          let dim = 0; // collapsed region goes quiet
          for (const ev of events) {
            // Distance from the event centre, which drifts away with the field.
            const dx = x - ev.x0;
            const dzz = z - ev.zw + flow * (t - ev.tStart);
            const d = Math.sqrt(dx * dx + dzz * dzz);
            const u = ev.u;
            const collapse =
              smoothstep(0, 0.1, u) * (1 - smoothstep(0.35, 0.9, u));
            const near = Math.exp(-((d / 5) * (d / 5)));
            const spike =
              smoothstep(0.06, 0.14, u) * (1 - smoothstep(0.14, 0.5, u));
            const burst =
              (1 - smoothstep(0.05, 0.35, u)) * smoothstep(0, 0.04, u);
            const ringR = 1 + u * 16;
            const ringEnv = Math.pow(1 - u, 1.5) * smoothstep(0.05, 0.15, u);
            const ring = Math.exp(-(((d - ringR) / 0.9) * ((d - ringR) / 0.9)));
            h *= 1 - 0.92 * collapse * near;
            h += ((2.8 * spike) / 1.3) * Math.exp(-((d / 0.55) * (d / 0.55)));
            h += 0.4 * ringEnv * ring * Math.sin(3 * (d - ringR));
            flash +=
              burst * Math.exp(-((d / 1.8) * (d / 1.8))) + 0.5 * ringEnv * ring;
            dim += 0.3 * collapse * near;
          }

          positions[id * 3] = x;
          positions[id * 3 + 1] = h * 1.3;
          positions[id * 3 + 2] = z;

          const hue =
            (((0.012 * x + 0.009 * zs + 0.04 * h + hueShift) % 1) + 1) % 1;
          color.setHSL(hue, 0.9, 0.5);
          if (flash > 0) color.lerp(white, Math.min(1, flash * 0.9));
          const glow =
            edgeFade[i] *
            rowFade *
            (0.55 + (0.45 * (h + 1.2)) / 2.4) *
            (1 + 2 * flash - dim);
          colors[id * 3] = color.r * glow;
          colors[id * 3 + 1] = color.g * glow;
          colors[id * 3 + 2] = color.b * glow;
        }
      }
      (geometry.attributes.position as THREE.BufferAttribute).needsUpdate =
        true;
      (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      // Camera drifts slowly right and left, banking its gaze a little with it.
      const drift = Math.sin(ph(t, 100)) * 3.4;
      camera.position.set(drift, 3.4 + Math.sin(ph(t, 60)) * 0.25, 9);
      camera.lookAt(drift * 0.45, -0.2, -7);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// Aurora: three layered curtains of additive colour, rippling slowly, with a
// faint star field behind. Vertical rays come from a high-frequency x term.
function buildAurora(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): VisualHandle {
  const nx = 220;
  const ny = 28;
  const width = 70;
  const cols = nx + 1;
  const layers = [
    { z: -4, y: -3.5, height: 9, hueOff: 0 },
    { z: -10, y: -2, height: 11, hueOff: 0.33 },
    { z: -17, y: -0.5, height: 13, hueOff: 0.66 },
  ];

  const meshes = layers.map(() => {
    const count = cols * (ny + 1);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const indices: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * cols + i;
        indices.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { geometry, material, positions, colors };
  });

  // Star field
  const rand = mulberry32(7);
  const starCount = 700;
  const starPos = new Float32Array(starCount * 3);
  const starCol = new Float32Array(starCount * 3);
  const c = new THREE.Color();
  for (let i = 0; i < starCount; i++) {
    starPos[i * 3] = (rand() - 0.5) * 90;
    starPos[i * 3 + 1] = rand() * 30 - 4;
    starPos[i * 3 + 2] = -28 - rand() * 12;
    c.setHSL(rand(), 0.5, 0.6);
    const b = 0.25 + rand() * 0.5;
    starCol[i * 3] = c.r * b;
    starCol[i * 3 + 1] = c.g * b;
    starCol[i * 3 + 2] = c.b * b;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starCol, 3));
  const starMat = new THREE.PointsMaterial({
    size: 0.09,
    vertexColors: true,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  // --- sky events: shooting stars + satellites, scheduled as a pure function
  // of time (slots divide SCENE_SECONDS, so the schedule loops seamlessly) ---
  const skySprite = makeGlowTexture();
  const additive = {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  } as const;
  const TAIL = 24;
  const shooters = [
    { slot: 15, seed: 11 },
    { slot: 16, seed: 29 },
  ];
  const shootPos = new Float32Array(shooters.length * TAIL * 6);
  const shootCol = new Float32Array(shooters.length * TAIL * 6);
  const shootGeo = new THREE.BufferGeometry();
  shootGeo.setAttribute("position", new THREE.BufferAttribute(shootPos, 3));
  shootGeo.setAttribute("color", new THREE.BufferAttribute(shootCol, 3));
  const shootMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    ...additive,
  });
  const shootLines = new THREE.LineSegments(shootGeo, shootMat);
  shootLines.frustumCulled = false;
  scene.add(shootLines);
  const headPos = new Float32Array(shooters.length * 3);
  const headCol = new Float32Array(shooters.length * 3);
  const headGeo = new THREE.BufferGeometry();
  headGeo.setAttribute("position", new THREE.BufferAttribute(headPos, 3));
  headGeo.setAttribute("color", new THREE.BufferAttribute(headCol, 3));
  const headMat = new THREE.PointsMaterial({
    size: 0.7,
    map: skySprite,
    vertexColors: true,
    sizeAttenuation: true,
    ...additive,
  });
  const heads = new THREE.Points(headGeo, headMat);
  heads.frustumCulled = false;
  scene.add(heads);

  const sats = [
    { slot: 60, seed: 5 },
    { slot: 80, seed: 17 },
  ];
  const satPos = new Float32Array(sats.length * 3);
  const satCol = new Float32Array(sats.length * 3);
  const satGeo = new THREE.BufferGeometry();
  satGeo.setAttribute("position", new THREE.BufferAttribute(satPos, 3));
  satGeo.setAttribute("color", new THREE.BufferAttribute(satCol, 3));
  const satMat = new THREE.PointsMaterial({
    size: 0.42,
    map: skySprite,
    vertexColors: true,
    sizeAttenuation: true,
    ...additive,
  });
  const satPts = new THREE.Points(satGeo, satMat);
  satPts.frustumCulled = false;
  scene.add(satPts);

  // Which event slot is `t` in, and is that slot's event on?
  const slotAt = (t: number, slot: number, seed: number, prob: number) => {
    const n = SCENE_SECONDS / slot;
    const s = Math.floor(t / slot);
    const idx = ((s % n) + n) % n;
    return { idx, local: t - s * slot, on: hash01(idx * 13 + seed) < prob };
  };
  const tmp = new THREE.Color();

  const updateSky = (t: number) => {
    shooters.forEach((ch, ci) => {
      const { idx, local, on } = slotAt(t, ch.slot, ch.seed, 0.4);
      const h = (k: number) => hash01(idx * 31 + ch.seed * 7 + k);
      const dur = 0.8 + h(1) * 0.5;
      const start = h(2) * (ch.slot - dur - 0.1);
      const u = (local - start) / dur;
      const base = ci * TAIL * 6;
      if (!on || u < 0 || u > 1) {
        shootCol.fill(0, base, base + TAIL * 6);
        headCol[ci * 3] = headCol[ci * 3 + 1] = headCol[ci * 3 + 2] = 0;
        return;
      }
      const sgn = h(6) < 0.5 ? 1 : -1;
      const ang = 0.3 + h(5) * 0.35;
      const dx = Math.cos(ang) * sgn;
      const dy = -Math.sin(ang);
      const len = 16 + h(8) * 10;
      const tail = 6 + h(9) * 3;
      const x0 = sgn > 0 ? -34 + h(3) * 34 : h(3) * 34;
      const y0 = 9 + h(4) * 10;
      const hx = x0 + dx * len * u;
      const hy = y0 + dy * len * u;
      const env = Math.pow(Math.sin(Math.PI * u), 0.6);
      tmp.setHSL(h(7), 0.35, 0.8);
      for (let i = 0; i < TAIL; i++) {
        const v = base + i * 6;
        const f0 = i / TAIL;
        const f1 = (i + 1) / TAIL;
        shootPos[v] = hx - dx * tail * f0;
        shootPos[v + 1] = hy - dy * tail * f0;
        shootPos[v + 2] = -34;
        shootPos[v + 3] = hx - dx * tail * f1;
        shootPos[v + 4] = hy - dy * tail * f1;
        shootPos[v + 5] = -34;
        const b0 = Math.pow(1 - f0, 1.4) * env;
        const b1 = Math.pow(1 - f1, 1.4) * env;
        shootCol[v] = tmp.r * b0;
        shootCol[v + 1] = tmp.g * b0;
        shootCol[v + 2] = tmp.b * b0;
        shootCol[v + 3] = tmp.r * b1;
        shootCol[v + 4] = tmp.g * b1;
        shootCol[v + 5] = tmp.b * b1;
      }
      headPos[ci * 3] = hx;
      headPos[ci * 3 + 1] = hy;
      headPos[ci * 3 + 2] = -34;
      headCol[ci * 3] = tmp.r * env;
      headCol[ci * 3 + 1] = tmp.g * env;
      headCol[ci * 3 + 2] = tmp.b * env;
    });
    (shootGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (shootGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (headGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (headGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    sats.forEach((ch, si) => {
      const { idx, local, on } = slotAt(t, ch.slot, ch.seed, 0.6);
      const h = (k: number) => hash01(idx * 17 + ch.seed * 5 + k);
      const dur = 34 + h(1) * 8;
      const start = h(2) * (ch.slot - dur - 1);
      const u = (local - start) / dur;
      if (!on || u < 0 || u > 1) {
        satCol[si * 3] = satCol[si * 3 + 1] = satCol[si * 3 + 2] = 0;
        return;
      }
      const dir = h(3) < 0.5 ? 1 : -1;
      satPos[si * 3] = dir * (-36 + u * 72);
      satPos[si * 3 + 1] = 11 + h(4) * 7 + Math.sin(u * Math.PI) * 1.2;
      satPos[si * 3 + 2] = -36;
      const blink = 0.75 + 0.25 * Math.sin(ph(t, 3) + idx);
      const edge = Math.min(1, u * 12) * Math.min(1, (1 - u) * 12);
      const b = 0.6 * blink * edge;
      satCol[si * 3] = b;
      satCol[si * 3 + 1] = b * 0.97;
      satCol[si * 3 + 2] = b * 0.9;
    });
    (satGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (satGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  };

  // --- mountains: layered dark ranges below the aurora. One big peak in the
  // middle with smaller natural ones to either side (far range tallest, near
  // range lowest and blackest). They are drawn over the sky, and their crests
  // and upper faces are lit by the aurora's own colours and brightness at that
  // spot, so they brighten and dim as the curtains move. ---
  type Peak = { c: number; h: number; w: number };
  const ridgeDefs: {
    z: number;
    base: number;
    half: number;
    color: number[];
    rim: number;
    seed: number;
    peaks: Peak[];
  }[] = [
    {
      z: -26,
      base: -6.8,
      half: 55,
      color: [0.0012, 0.0016, 0.004],
      rim: 0.035,
      seed: 3,
      peaks: [
        { c: -1, h: 13.5, w: 19 },
        { c: -23, h: 7, w: 11 },
        { c: -13, h: 3.6, w: 7.5 },
        { c: 19, h: 8.5, w: 11.5 },
        { c: 31, h: 4.2, w: 8.5 },
        { c: -35, h: 5.5, w: 9 },
      ],
    },
    {
      z: -16,
      base: -5.9,
      half: 46,
      color: [0.0005, 0.0007, 0.002],
      rim: 0.022,
      seed: 9,
      peaks: [
        { c: -18, h: 5.2, w: 8.5 },
        { c: -8, h: 2.3, w: 6 },
        { c: 9, h: 2.7, w: 6.5 },
        { c: 20, h: 4.6, w: 8 },
        { c: 32, h: 2.6, w: 6 },
      ],
    },
    {
      z: -8.5,
      base: -5.3,
      half: 38,
      color: [0, 0, 0],
      rim: 0.012,
      seed: 21,
      peaks: [
        { c: -14, h: 2.8, w: 6.5 },
        { c: 3, h: 1.4, w: 5 },
        { c: 15, h: 3, w: 6.5 },
        { c: 26, h: 1.6, w: 5 },
      ],
    },
  ];
  const RIDGE_N = 480;
  const ridges = ridgeDefs.map((def) => {
    const phases = [0, 1, 2, 3].map((k) => hash01(def.seed * 10 + k) * TAU);
    // Union of the peaks (pointed, with slightly concave flanks), roughened
    // in proportion to height so crests are rocky and foothills stay smooth.
    const profile = (x: number) => {
      let p = 0;
      for (const pk of def.peaks) {
        const q = Math.max(0, 1 - Math.abs(x - pk.c) / pk.w);
        p = Math.max(p, pk.h * Math.pow(q, 1.35));
      }
      const rough =
        0.55 * Math.sin(0.55 * x + phases[0]) +
        0.28 * Math.sin(1.25 * x + phases[1]) +
        0.14 * Math.sin(2.7 * x + phases[2]);
      const undulate = 0.4 * (0.5 + 0.5 * Math.sin(0.17 * x + phases[3]));
      return p + rough * 0.13 * p + undulate;
    };
    const vcount = (RIDGE_N + 1) * 3; // crest, just below the crest, bottom
    const positions = new Float32Array(vcount * 3);
    const colors = new Float32Array(vcount * 3);
    const crestX = new Float32Array(RIDGE_N + 1);
    const indices: number[] = [];
    for (let i = 0; i <= RIDGE_N; i++) {
      const x = (i / RIDGE_N - 0.5) * def.half * 2;
      crestX[i] = x;
      const y = def.base + profile(x);
      const v = i * 3;
      positions.set([x, y, def.z, x, y - 2.6, def.z, x, -40, def.z], v * 3);
      for (let r = 0; r < 3; r++) colors.set(def.color, (v + r) * 3);
      if (i < RIDGE_N) {
        const n = v + 3;
        indices.push(
          v,
          v + 1,
          n,
          v + 1,
          n + 1,
          n,
          v + 1,
          v + 2,
          n + 1,
          v + 2,
          n + 2,
          n + 1,
        );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    // Drawn after (and over) the sky, far to near, so nothing in the sky can
    // appear in front of a ridge.
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10 + ridgeDefs.indexOf(def);
    scene.add(mesh);
    // x on a ridge -> x of the curtains seen in the same direction.
    const toCurtain = 19 / (9 - def.z);
    return { def, geometry, material, colors, crestX, toCurtain };
  });

  // How bright the aurora is above x (curtain space) at time t, 0..1.
  const auroraLevel = (x: number, t: number) => {
    let sum = 0;
    for (let li = 0; li < 3; li++) {
      const w1 = ph(t, [60, 40, 120][li]);
      const w2 = ph(t, [30, 48, 80][li]);
      const rays =
        0.65 + 0.35 * Math.sin(1.7 * x + 2.5 * Math.sin(0.2 * x + w1));
      const flow = 0.55 + 0.45 * Math.sin(0.35 * x + w2 + li);
      sum += rays * flow;
    }
    return sum / 3;
  };
  const rimColor = new THREE.Color();
  const updateRidges = (t: number) => {
    ridges.forEach(({ def, geometry, colors, crestX, toCurtain }) => {
      for (let i = 0; i <= RIDGE_N; i++) {
        const xc = crestX[i] * toCurtain;
        const hue = (((0.011 * xc + 0.33 + t / 120) % 1) + 1) % 1;
        rimColor.setHSL(hue, 0.8, 0.5);
        const glow = def.rim * (0.25 + 1.6 * auroraLevel(xc, t));
        const v = i * 3 * 3;
        for (let c = 0; c < 3; c++) {
          const tint = [rimColor.r, rimColor.g, rimColor.b][c] * glow;
          colors[v + c] = def.color[c] + tint; // crest
          colors[v + 3 + c] = def.color[c] + tint * 0.4; // upper face
        }
      }
      (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    });
  };

  return {
    update(t) {
      layers.forEach((layer, li) => {
        const m = meshes[li];
        const w1 = ph(t, [60, 40, 120][li]);
        const w2 = ph(t, [30, 48, 80][li]);
        const w3 = ph(t, [120, 75, 100][li]);
        for (let j = 0; j <= ny; j++) {
          const v = j / ny;
          for (let i = 0; i <= nx; i++) {
            const id = j * cols + i;
            const x = (i / nx - 0.5) * width;
            const sway =
              Math.sin(0.18 * x + w1) * 2.2 + Math.sin(0.07 * x - w2) * 3;
            const bottom = layer.y + Math.sin(0.22 * x + w3) * 1.1;
            m.positions[id * 3] = x + Math.sin(v * 2 + w2) * 0.6;
            m.positions[id * 3 + 1] = bottom + v * layer.height;
            m.positions[id * 3 + 2] = layer.z + sway * (0.4 + 0.6 * v);

            const rays =
              0.65 + 0.35 * Math.sin(1.7 * x + 2.5 * Math.sin(0.2 * x + w1));
            const flow = 0.55 + 0.45 * Math.sin(0.35 * x + w2 + li);
            const vert = Math.pow(Math.sin(Math.PI * v), 1.6) * (1 - 0.35 * v);
            const level = vert * rays * flow * 0.26;
            const hue =
              (((0.011 * x + layer.hueOff + 0.12 * v + t / 120) % 1) + 1) % 1;
            c.setHSL(hue, 0.85, 0.5);
            m.colors[id * 3] = c.r * level;
            m.colors[id * 3 + 1] = c.g * level;
            m.colors[id * 3 + 2] = c.b * level;
          }
        }
        (m.geometry.attributes.position as THREE.BufferAttribute).needsUpdate =
          true;
        (m.geometry.attributes.color as THREE.BufferAttribute).needsUpdate =
          true;
      });

      updateSky(t);
      updateRidges(t);

      camera.position.set(
        Math.sin(ph(t, 300)) * 2,
        0.4 + Math.sin(ph(t, 200)) * 0.3,
        9,
      );
      camera.lookAt(0, 1.4, -10);
    },
    dispose() {
      meshes.forEach((m) => {
        m.geometry.dispose();
        m.material.dispose();
      });
      starGeo.dispose();
      starMat.dispose();
      [shootGeo, headGeo, satGeo].forEach((g) => g.dispose());
      [shootMat, headMat, satMat].forEach((m) => m.dispose());
      skySprite.dispose();
      ridges.forEach((r) => {
        r.geometry.dispose();
        r.material.dispose();
      });
    },
  };
}

// Soft round sprite for stars.
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Constellation drift: stars on small closed orbits around fixed homes, joined
// to their nearest neighbours by hairlines that stretch and relax as they move.
function buildConstellationDrift(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): VisualHandle {
  const rand = mulberry32(42);
  const n = 460;
  const home = new Float32Array(n * 3);
  const orbit = new Float32Array(n * 4); // radius, phase, period, twinkle phase
  const periods = [120, 200, 240, 300, 400, 600];
  const twinkles = [20, 24, 30, 40, 60];
  for (let i = 0; i < n; i++) {
    home[i * 3] = (rand() - 0.5) * 50;
    home[i * 3 + 1] = (rand() - 0.5) * 28;
    home[i * 3 + 2] = -28 + rand() * 27;
    orbit[i * 4] = 0.3 + rand() * 1;
    orbit[i * 4 + 1] = rand() * TAU;
    orbit[i * 4 + 2] = periods[Math.floor(rand() * periods.length)];
    orbit[i * 4 + 3] = rand() * TAU;
  }

  // Connect each star to up to 3 close neighbours.
  const pairs: number[] = [];
  const degree = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = i + 1; k < n && degree[i] < 3; k++) {
      if (degree[k] >= 3) continue;
      const dx = home[i * 3] - home[k * 3];
      const dy = home[i * 3 + 1] - home[k * 3 + 1];
      const dz = home[i * 3 + 2] - home[k * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < 5.2 * 5.2) {
        pairs.push(i, k);
        degree[i]++;
        degree[k]++;
      }
    }
  }

  const starPos = new Float32Array(n * 3);
  const starCol = new Float32Array(n * 3);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starCol, 3));
  const sprite = makeGlowTexture();
  const starMat = new THREE.PointsMaterial({
    size: 0.7,
    map: sprite,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(starGeo, starMat));

  const linePos = new Float32Array(pairs.length * 3);
  const lineCol = new Float32Array(pairs.length * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  const c = new THREE.Color();

  return {
    update(t) {
      for (let i = 0; i < n; i++) {
        const r = orbit[i * 4];
        const a = orbit[i * 4 + 1] + ph(t, orbit[i * 4 + 2]);
        const x = home[i * 3] + Math.cos(a) * r;
        const y = home[i * 3 + 1] + Math.sin(a) * r * 0.8;
        const z = home[i * 3 + 2] + Math.sin(a * 1) * r * 0.5;
        starPos[i * 3] = x;
        starPos[i * 3 + 1] = y;
        starPos[i * 3 + 2] = z;

        const hue =
          (((0.012 * home[i * 3] + 0.017 * home[i * 3 + 1] + t / 120) % 1) +
            1) %
          1;
        c.setHSL(hue, 0.8, 0.62);
        const tw = twinkles[i % twinkles.length];
        const b = 0.55 + 0.45 * Math.sin(ph(t, tw) + orbit[i * 4 + 3]);
        starCol[i * 3] = c.r * b;
        starCol[i * 3 + 1] = c.g * b;
        starCol[i * 3 + 2] = c.b * b;
      }
      for (let p = 0; p < pairs.length; p += 2) {
        const a = pairs[p];
        const b = pairs[p + 1];
        for (let e = 0; e < 2; e++) {
          const s = e === 0 ? a : b;
          linePos[(p + e) * 3] = starPos[s * 3];
          linePos[(p + e) * 3 + 1] = starPos[s * 3 + 1];
          linePos[(p + e) * 3 + 2] = starPos[s * 3 + 2];
          lineCol[(p + e) * 3] = starCol[s * 3] * 0.35;
          lineCol[(p + e) * 3 + 1] = starCol[s * 3 + 1] * 0.35;
          lineCol[(p + e) * 3 + 2] = starCol[s * 3 + 2] * 0.35;
        }
      }
      (starGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (starGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (lineGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      camera.position.set(
        Math.sin(ph(t, 300)) * 2.4,
        Math.sin(ph(t, 200)) * 1.2,
        9,
      );
      camera.lookAt(0, 0, -8);
    },
    dispose() {
      starGeo.dispose();
      starMat.dispose();
      sprite.dispose();
      lineGeo.dispose();
      lineMat.dispose();
    },
  };
}

// Tree of Life: the ten sephirot joined by the 22 paths, glowing in a rainbow
// that climbs from red (Malkuth) to violet (Kether). Nodes breathe, light
// pulses travel the paths, motes rise through the field, and faint rings
// turn behind it all.
function buildTreeOfLife(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): VisualHandle {
  const sx = 3.4;
  const nodes: [number, number][] = [
    [0, 5.4], // 0 Kether
    [sx, 4.2], // 1 Chokmah
    [-sx, 4.2], // 2 Binah
    [sx, 1.9], // 3 Chesed
    [-sx, 1.9], // 4 Geburah
    [0, 1.3], // 5 Tiphareth
    [sx, -0.9], // 6 Netzach
    [-sx, -0.9], // 7 Hod
    [0, -2.0], // 8 Yesod
    [0, -4.4], // 9 Malkuth
  ];
  const paths: [number, number][] = [
    [0, 1],
    [0, 2],
    [0, 5],
    [1, 2],
    [1, 5],
    [1, 3],
    [2, 5],
    [2, 4],
    [3, 4],
    [3, 5],
    [4, 5],
    [3, 6],
    [4, 7],
    [5, 6],
    [5, 7],
    [5, 8],
    [6, 7],
    [6, 8],
    [7, 8],
    [6, 9],
    [7, 9],
    [8, 9],
  ];
  const yMin = -4.4;
  const yMax = 5.4;
  const nodeHue = nodes.map(([, y]) => (0.78 * (y - yMin)) / (yMax - yMin));
  const hueAt = (base: number, t: number) => (((base + t / 120) % 1) + 1) % 1;
  const c = new THREE.Color();
  const c2 = new THREE.Color();
  const sprite = makeGlowTexture();
  const additive = {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  } as const;
  const pathPeriods = [20, 24, 30, 40, 48, 60];

  // --- path ribbons: 3 verts across (edge, centre, edge) at each end ---
  const makeRibbons = (halfWidth: number) => {
    const positions = new Float32Array(paths.length * 6 * 3);
    const colors = new Float32Array(paths.length * 6 * 3);
    const indices: number[] = [];
    paths.forEach(([a, b], p) => {
      const [x0, y0] = nodes[a];
      const [x1, y1] = nodes[b];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const nx = (-(y1 - y0) / len) * halfWidth;
      const ny = ((x1 - x0) / len) * halfWidth;
      for (let e = 0; e < 2; e++) {
        const [x, y] = e === 0 ? [x0, y0] : [x1, y1];
        for (let k = -1; k <= 1; k++) {
          const v = (p * 6 + e * 3 + k + 1) * 3;
          positions[v] = x + nx * k;
          positions[v + 1] = y + ny * k;
        }
      }
      for (let k = 0; k < 2; k++) {
        const a0 = p * 6 + k;
        const b0 = p * 6 + 3 + k;
        indices.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      ...additive,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { geometry, material, colors };
  };
  const glow = makeRibbons(0.17);
  const core = makeRibbons(0.016);

  // --- node rings + soft cores ---
  const ringGeo = new THREE.RingGeometry(0.46, 0.53, 96);
  const outerGeo = new THREE.RingGeometry(0.78, 0.795, 96);
  const rings = nodes.map(([x, y]) => {
    const mat = new THREE.MeshBasicMaterial({ ...additive });
    const outerMat = new THREE.MeshBasicMaterial({ ...additive });
    const ring = new THREE.Mesh(ringGeo, mat);
    const outer = new THREE.Mesh(outerGeo, outerMat);
    ring.position.set(x, y, 0.01);
    outer.position.set(x, y, 0.01);
    scene.add(ring, outer);
    return { ring, outer, mat, outerMat };
  });
  const corePos = new Float32Array(nodes.length * 3);
  const coreCol = new Float32Array(nodes.length * 3);
  nodes.forEach(([x, y], i) => {
    corePos[i * 3] = x;
    corePos[i * 3 + 1] = y;
  });
  const coreGeo = new THREE.BufferGeometry();
  coreGeo.setAttribute("position", new THREE.BufferAttribute(corePos, 3));
  coreGeo.setAttribute("color", new THREE.BufferAttribute(coreCol, 3));
  const coreMat = new THREE.PointsMaterial({
    size: 2.8,
    map: sprite,
    vertexColors: true,
    sizeAttenuation: true,
    ...additive,
  });
  scene.add(new THREE.Points(coreGeo, coreMat));

  // --- light pulses travelling the paths ---
  const pulseCount = paths.length * 2;
  const pulsePos = new Float32Array(pulseCount * 3);
  const pulseCol = new Float32Array(pulseCount * 3);
  const pulseGeo = new THREE.BufferGeometry();
  pulseGeo.setAttribute("position", new THREE.BufferAttribute(pulsePos, 3));
  pulseGeo.setAttribute("color", new THREE.BufferAttribute(pulseCol, 3));
  const pulseMat = new THREE.PointsMaterial({
    size: 0.5,
    map: sprite,
    vertexColors: true,
    sizeAttenuation: true,
    ...additive,
  });
  scene.add(new THREE.Points(pulseGeo, pulseMat));

  // --- rising motes ---
  const rand = mulberry32(108);
  const moteCount = 320;
  const moteHome = new Float32Array(moteCount * 4); // x, y0, period, phase
  const motePeriods = [120, 200, 240, 300];
  for (let i = 0; i < moteCount; i++) {
    moteHome[i * 4] = (rand() - 0.5) * 34;
    moteHome[i * 4 + 1] = rand() * 18;
    moteHome[i * 4 + 2] = motePeriods[Math.floor(rand() * motePeriods.length)];
    moteHome[i * 4 + 3] = rand() * TAU;
  }
  const motePos = new Float32Array(moteCount * 3);
  const moteCol = new Float32Array(moteCount * 3);
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute("color", new THREE.BufferAttribute(moteCol, 3));
  const moteMat = new THREE.PointsMaterial({
    size: 0.16,
    map: sprite,
    vertexColors: true,
    sizeAttenuation: true,
    ...additive,
  });
  scene.add(new THREE.Points(moteGeo, moteMat));

  // --- slowly turning background rings ---
  const bgRings = [8.6, 11.4, 14.2].map((radius, i) => {
    const segs = 256;
    const pos = new Float32Array(segs * 3);
    const col = new Float32Array(segs * 3);
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * TAU;
      pos[k * 3] = Math.cos(a) * radius;
      pos[k * 3 + 1] = Math.sin(a) * radius;
      c.setHSL(k / segs, 0.85, 0.5);
      const lvl = 0.16 - i * 0.03;
      col[k * 3] = c.r * lvl;
      col[k * 3 + 1] = c.g * lvl;
      col[k * 3 + 2] = c.b * lvl;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      ...additive,
    });
    const loop = new THREE.LineLoop(geo, mat);
    loop.position.set(0, 0.5, -1);
    scene.add(loop);
    return { geo, mat, loop, speed: [600, -400, 300][i] };
  });

  return {
    update(t) {
      // ribbons
      paths.forEach(([a, b], p) => {
        const breath =
          0.7 + 0.3 * Math.sin(ph(t, pathPeriods[p % pathPeriods.length]) + p);
        c.setHSL(hueAt(nodeHue[a], t), 0.9, 0.5);
        c2.setHSL(hueAt(nodeHue[b], t), 0.9, 0.5);
        for (let e = 0; e < 2; e++) {
          const col = e === 0 ? c : c2;
          for (let k = 0; k < 3; k++) {
            const v = (p * 6 + e * 3 + k) * 3;
            const g = (k === 1 ? 0.22 : 0) * breath;
            const q = (k === 1 ? 0.9 : 0.55) * breath;
            glow.colors[v] = col.r * g;
            glow.colors[v + 1] = col.g * g;
            glow.colors[v + 2] = col.b * g;
            core.colors[v] = col.r * q;
            core.colors[v + 1] = col.g * q;
            core.colors[v + 2] = col.b * q;
          }
        }
      });
      (glow.geometry.attributes.color as THREE.BufferAttribute).needsUpdate =
        true;
      (core.geometry.attributes.color as THREE.BufferAttribute).needsUpdate =
        true;

      // nodes
      nodes.forEach((_, i) => {
        const w = ph(t, [20, 24, 30, 40, 60][i % 5]) + i * 0.9;
        const breath = 0.5 + 0.5 * Math.sin(w);
        c.setHSL(hueAt(nodeHue[i], t), 0.85, 0.55);
        rings[i].mat.color.copy(c).multiplyScalar(0.55 + 0.35 * breath);
        rings[i].outerMat.color.copy(c).multiplyScalar(0.18 + 0.12 * breath);
        rings[i].ring.scale.setScalar(1 + 0.04 * breath);
        rings[i].outer.scale.setScalar(1 + 0.08 * (1 - breath));
        const k = 0.28 + 0.2 * breath;
        coreCol[i * 3] = c.r * k;
        coreCol[i * 3 + 1] = c.g * k;
        coreCol[i * 3 + 2] = c.b * k;
      });
      (coreGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      // pulses: two per path, evenly spaced
      for (let p = 0; p < paths.length; p++) {
        const [a, b] = paths[p];
        const period = pathPeriods[(p + 2) % pathPeriods.length];
        for (let n = 0; n < 2; n++) {
          const i = p * 2 + n;
          const u = (((t / period + n * 0.5 + p * 0.137) % 1) + 1) % 1;
          pulsePos[i * 3] = nodes[a][0] + (nodes[b][0] - nodes[a][0]) * u;
          pulsePos[i * 3 + 1] = nodes[a][1] + (nodes[b][1] - nodes[a][1]) * u;
          pulsePos[i * 3 + 2] = 0.02;
          c.setHSL(
            hueAt(nodeHue[a] + (nodeHue[b] - nodeHue[a]) * u, t),
            0.8,
            0.6,
          );
          const f = Math.sin(Math.PI * u) * 0.8;
          pulseCol[i * 3] = c.r * f;
          pulseCol[i * 3 + 1] = c.g * f;
          pulseCol[i * 3 + 2] = c.b * f;
        }
      }
      (pulseGeo.attributes.position as THREE.BufferAttribute).needsUpdate =
        true;
      (pulseGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      // motes rise and loop
      for (let i = 0; i < moteCount; i++) {
        const x0 = moteHome[i * 4];
        const period = moteHome[i * 4 + 2];
        const u = (((moteHome[i * 4 + 1] / 18 + t / period) % 1) + 1) % 1;
        motePos[i * 3] = x0 + Math.sin(u * TAU * 2 + moteHome[i * 4 + 3]) * 0.4;
        motePos[i * 3 + 1] = u * 18 - 9;
        motePos[i * 3 + 2] = -1 + (i % 7) * 0.3;
        c.setHSL(hueAt(x0 / 34 + 0.5, t), 0.8, 0.6);
        const f =
          Math.sin(Math.PI * u) *
          (0.35 + 0.25 * Math.sin(ph(t, 30) + moteHome[i * 4 + 3]));
        moteCol[i * 3] = c.r * f;
        moteCol[i * 3 + 1] = c.g * f;
        moteCol[i * 3 + 2] = c.b * f;
      }
      (moteGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (moteGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      bgRings.forEach(
        (r) =>
          (r.loop.rotation.z = ph(t, Math.abs(r.speed)) * Math.sign(r.speed)),
      );

      camera.position.set(
        Math.sin(ph(t, 300)) * 0.6,
        0.5 + Math.sin(ph(t, 200)) * 0.25,
        10.4,
      );
      camera.lookAt(0, 0.5, 0);
    },
    dispose() {
      [glow, core].forEach((r) => {
        r.geometry.dispose();
        r.material.dispose();
      });
      ringGeo.dispose();
      outerGeo.dispose();
      rings.forEach((r) => {
        r.mat.dispose();
        r.outerMat.dispose();
      });
      [coreGeo, pulseGeo, moteGeo].forEach((g) => g.dispose());
      [coreMat, pulseMat, moteMat].forEach((m) => m.dispose());
      bgRings.forEach((r) => {
        r.geo.dispose();
        r.mat.dispose();
      });
      sprite.dispose();
    },
  };
}

// Flower of Life: the 19 overlapping circles of the classic pattern inside two
// containing rings, centred, with the outermost ring touching the top and
// bottom of the frame. Behind it, the same lattice continues outward, dimmer,
// turning the other way so the two layers drift in and out of register. Glowing
// ribbons carry a rainbow that sweeps around the whole figure, brightness
// ripples outward from the centre, and motes drift forward through it all.
function buildFlowerOfLife(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): VisualHandle {
  type Circle = { cx: number; cy: number; radius: number; weight: number };
  const r = 1.55;
  const ringGap = 0.32;
  const ribbonHalf = 0.16; // half width of the glow ribbon
  // Outer edge of the outermost ring; the camera sits exactly this far
  // (times 1/tan(fov/2)) back, so it is flush with the top and bottom.
  const outerEdge = r * 3 + ringGap + ribbonHalf;
  const camZ = outerEdge / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

  const fg: Circle[] = [{ cx: 0, cy: 0, radius: r, weight: 1 }];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    fg.push({ cx: Math.cos(a) * r, cy: Math.sin(a) * r, radius: r, weight: 1 });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    fg.push({
      cx: Math.cos(a) * r * 2,
      cy: Math.sin(a) * r * 2,
      radius: r,
      weight: 0.7,
    });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    fg.push({
      cx: Math.cos(a) * r * Math.sqrt(3),
      cy: Math.sin(a) * r * Math.sqrt(3),
      radius: r,
      weight: 0.7,
    });
  }
  fg.push({ cx: 0, cy: 0, radius: r * 3, weight: 0.9 });
  fg.push({ cx: 0, cy: 0, radius: r * 3 + ringGap, weight: 0.45 });

  // Background: the same hex lattice (spacing r), continuing well past the frame.
  const bg: Circle[] = [];
  const reach = 13;
  const span = Math.ceil(reach / r) + 1;
  for (let j = -span; j <= span; j++) {
    for (let i = -span; i <= span; i++) {
      const cx = (i + j / 2) * r;
      const cy = j * (Math.sqrt(3) / 2) * r;
      if (Math.hypot(cx, cy) <= reach)
        bg.push({ cx, cy, radius: r, weight: 1 });
    }
  }

  const fgGroup = new THREE.Group();
  const bgGroup = new THREE.Group();
  bgGroup.position.z = -2.5;
  bgGroup.scale.setScalar((camZ + 2.5) / camZ); // keep it the same apparent size
  scene.add(bgGroup, fgGroup);

  // Ribbon ring set: 3 verts across (edge, centre, edge) at each of `seg` points.
  const makeRibbons = (
    circles: Circle[],
    seg: number,
    halfWidth: number,
    parent: THREE.Group,
  ) => {
    const n = circles.length * seg * 3;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const indices: number[] = [];
    circles.forEach((c, ci) => {
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * TAU;
        for (let j = 0; j < 3; j++) {
          const rad = c.radius + (j - 1) * halfWidth;
          const v = ((ci * seg + k) * 3 + j) * 3;
          positions[v] = c.cx + Math.cos(a) * rad;
          positions[v + 1] = c.cy + Math.sin(a) * rad;
        }
        const k2 = (k + 1) % seg;
        for (let j = 0; j < 2; j++) {
          const a0 = (ci * seg + k) * 3 + j;
          const b0 = (ci * seg + k2) * 3 + j;
          indices.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return { geometry, material, colors, circles, seg };
  };
  type Ribbons = ReturnType<typeof makeRibbons>;

  // Rainbow position of each ribbon point: angle around the figure plus a
  // radial offset, so hue sweeps across the whole pattern.
  const hueInfo = (circles: Circle[], seg: number) => {
    const baseHue = new Float32Array(circles.length * seg);
    const dist = new Float32Array(circles.length * seg);
    circles.forEach((c, ci) => {
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * TAU;
        const x = c.cx + Math.cos(a) * c.radius;
        const y = c.cy + Math.sin(a) * c.radius;
        const d = Math.hypot(x, y);
        baseHue[ci * seg + k] = Math.atan2(y, x) / TAU + 0.35 * (d / (r * 3));
        dist[ci * seg + k] = d;
      }
    });
    return { baseHue, dist };
  };

  const FG_SEG = 128;
  const BG_SEG = 96;
  const glow = makeRibbons(fg, FG_SEG, ribbonHalf, fgGroup);
  const core = makeRibbons(fg, FG_SEG, 0.014, fgGroup);
  const bgCore = makeRibbons(bg, BG_SEG, 0.012, bgGroup);
  const fgInfo = hueInfo(fg, FG_SEG);
  const bgInfo = hueInfo(bg, BG_SEG);
  const c = new THREE.Color();

  const paint = (
    rib: Ribbons,
    info: { baseHue: Float32Array; dist: Float32Array },
    t: number,
    centerLevel: number,
    edgeLevel: number,
    fade: (d: number) => number,
  ) => {
    const wave = ph(t, 20);
    const hueShift = t / 120;
    rib.circles.forEach((circle, ci) => {
      const breath = 0.8 + 0.2 * Math.sin(ph(t, 40) + ci * 0.6);
      for (let k = 0; k < rib.seg; k++) {
        const i = ci * rib.seg + k;
        const d = info.dist[i];
        c.setHSL((((info.baseHue[i] + hueShift) % 1) + 1) % 1, 0.9, 0.52);
        const f =
          (0.62 + 0.38 * Math.sin(1.2 * d - wave)) *
          breath *
          circle.weight *
          fade(d);
        for (let j = 0; j < 3; j++) {
          const v = (i * 3 + j) * 3;
          const lvl = (j === 1 ? centerLevel : edgeLevel) * f;
          rib.colors[v] = c.r * lvl;
          rib.colors[v + 1] = c.g * lvl;
          rib.colors[v + 2] = c.b * lvl;
        }
      }
    });
    (rib.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  };

  // Motes drifting forward through the pattern.
  const rand = mulberry32(19);
  const sprite = makeGlowTexture();
  const moteCount = 380;
  const moteHome = new Float32Array(moteCount * 4); // x, y, z-phase, period
  const motePeriods = [60, 100, 120, 200];
  for (let i = 0; i < moteCount; i++) {
    moteHome[i * 4] = (rand() - 0.5) * 20;
    moteHome[i * 4 + 1] = (rand() - 0.5) * 11;
    moteHome[i * 4 + 2] = rand();
    moteHome[i * 4 + 3] = motePeriods[Math.floor(rand() * motePeriods.length)];
  }
  const motePos = new Float32Array(moteCount * 3);
  const moteCol = new Float32Array(moteCount * 3);
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute("color", new THREE.BufferAttribute(moteCol, 3));
  const moteMat = new THREE.PointsMaterial({
    size: 0.2,
    map: sprite,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  scene.add(motes);

  return {
    update(t) {
      fgGroup.rotation.z = ph(t, 600);
      bgGroup.rotation.z = -ph(t, 400);

      paint(glow, fgInfo, t, 0.3, 0, () => 1);
      paint(core, fgInfo, t, 0.95, 0.52, () => 1);
      // Background fades out toward the edges of the lattice.
      paint(bgCore, bgInfo, t, 0.3, 0.16, (d) => 1 - smoothstep(6, reach, d));

      const hueShift = t / 120;
      for (let i = 0; i < moteCount; i++) {
        const u =
          (((moteHome[i * 4 + 2] + t / moteHome[i * 4 + 3]) % 1) + 1) % 1;
        motePos[i * 3] = moteHome[i * 4] + Math.sin(u * TAU + i) * 0.3;
        motePos[i * 3 + 1] = moteHome[i * 4 + 1] + Math.cos(u * TAU + i) * 0.3;
        motePos[i * 3 + 2] = -6 + u * 11;
        c.setHSL(
          (((moteHome[i * 4] / 20 + 0.5 + hueShift) % 1) + 1) % 1,
          0.8,
          0.6,
        );
        const f = Math.sin(Math.PI * u) * 0.5;
        moteCol[i * 3] = c.r * f;
        moteCol[i * 3 + 1] = c.g * f;
        moteCol[i * 3 + 2] = c.b * f;
      }
      (moteGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (moteGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      // Dead centre, no sway: the outer ring stays flush with top and bottom.
      camera.position.set(0, 0, camZ);
      camera.lookAt(0, 0, 0);
    },
    dispose() {
      [glow, core, bgCore].forEach((m) => {
        m.geometry.dispose();
        m.material.dispose();
      });
      moteGeo.dispose();
      moteMat.dispose();
      sprite.dispose();
    },
  };
}

export const recordScenes: RecordScene[] = [
  { id: "rainbow-grid", build: buildRainbowGrid, hud: { y: 17 } },
  { id: "aurora", build: buildAurora, hud: { y: 83 } },
  {
    id: "flower-of-life",
    build: buildFlowerOfLife,
    hud: { y: 50, countdownOpacity: 1 },
  },
];

/** Scenes kept around but not in the video; reachable via ?scene=<id>. */
export const archivedScenes: RecordScene[] = [
  { id: "tree-of-life", build: buildTreeOfLife, hud: { y: 50, panel: true } },
  { id: "constellation-drift", build: buildConstellationDrift, hud: { y: 50 } },
];
