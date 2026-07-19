import * as THREE from "three";
import { bandLevels, createShell, energyLevel, glowTexture, hueColor } from "./common";
import type { ThreeFrame, ThreeInstance } from "./types";

const COLS = 72;
const ROWS = 56;
const WIDTH = 96;
const DEPTH = 150;
const ROW_DEPTH = DEPTH / (ROWS - 1);

/** Scrolling synthwave landscape: newest spectrum row rises at the horizon. */
export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const shell = createShell(canvas, 62);
  shell.scene.fog = new THREE.Fog(0x020706, 26, 128);
  shell.camera.position.set(0, 8.2, DEPTH / 2 - 4);
  shell.camera.lookAt(0, 3.2, -DEPTH / 2);

  const geometry = new THREE.PlaneGeometry(WIDTH, DEPTH, COLS - 1, ROWS - 1);
  geometry.rotateX(-Math.PI / 2);
  const solid = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x020706, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
  );
  const wireMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.85 });
  const wire = new THREE.Mesh(geometry, wireMaterial);
  const group = new THREE.Group();
  group.add(solid, wire);
  shell.scene.add(group);

  const texture = glowTexture();
  const horizon = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  horizon.position.set(0, 6, -DEPTH / 2 - 6);
  horizon.scale.set(90, 26, 1);
  shell.scene.add(horizon);

  // heights[row][col]; row 0 is the far edge where new data appears.
  const heights = new Float32Array(ROWS * COLS);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;

  function pushRow(freq: Uint8Array) {
    heights.copyWithin(COLS, 0, (ROWS - 1) * COLS);
    const bands = bandLevels(freq, COLS);
    const center = (COLS - 1) / 2;
    for (let c = 0; c < COLS; c++) {
      const edge = Math.abs(c - center) / center;
      const bin = Math.min(COLS - 1, Math.round(edge * (COLS - 1) * 0.72));
      const value = bands[bin];
      heights[c] = Math.pow(value, 1.5) * 15 * (0.16 + edge * 0.95);
    }
  }

  function writeHeights() {
    for (let i = 0; i < ROWS * COLS; i++) position.setY(i, heights[i]);
    position.needsUpdate = true;
  }

  let travel = 0;
  let lastHue = Number.NaN;
  return {
    render(frame: ThreeFrame) {
      const hue = frame.options.themeHue ?? 171;
      if (hue !== lastHue) {
        lastHue = hue;
        wireMaterial.color = hueColor(hue, 0.82, 0.52);
        horizon.material.color = hueColor(hue + 14, 0.9, 0.55);
      }
      const energy = energyLevel(frame.freq);
      const motion = frame.prefersReducedMotion ? 0.18 : 1;
      travel += frame.dt * ROW_DEPTH * (5 + energy * 16) * motion;
      while (travel >= ROW_DEPTH) {
        travel -= ROW_DEPTH;
        pushRow(frame.freq);
      }
      const scroll = travel / ROW_DEPTH;
      writeHeights();
      group.position.z = scroll * ROW_DEPTH;

      horizon.material.opacity = 0.35 + energy * 0.45;
      shell.camera.position.x = Math.sin(frame.elapsed * 0.05 * motion) * 2.2;
      shell.camera.lookAt(0, 3.2, -DEPTH / 2);
      shell.renderer.render(shell.scene, shell.camera);
    },
    resize: shell.resize,
    dispose() {
      texture.dispose();
      shell.dispose();
    },
  };
}
