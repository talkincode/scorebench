import * as THREE from "three";
import { AudioPulse, BandSmoother } from "../dynamics";
import { bandLevels, bassLevel, createShell, energyLevel, glowTexture, hueColor } from "./common";
import type { ThreeFrame, ThreeInstance } from "./types";

const RING_COUNT = 26;
const SPACING = 5;
const TOTAL = RING_COUNT * SPACING;
const BANDS = 13;

/** Infinite ring tunnel: each hoop pulses with its own frequency band. */
export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const shell = createShell(canvas, 72);
  shell.camera.position.set(0, 0, 9);

  const group = new THREE.Group();
  shell.scene.add(group);
  const geometry = new THREE.TorusGeometry(5.4, 0.06, 8, 72);
  const rings: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];
  for (let i = 0; i < RING_COUNT; i++) {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    rings.push({ mesh, material });
  }

  const texture = glowTexture();
  const beacon = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  beacon.position.set(0, 0, -TOTAL + 12);
  beacon.scale.setScalar(10);
  shell.scene.add(beacon);

  let offset = 0;
  let lastHue = Number.NaN;
  const pulse = new AudioPulse();
  const smoother = new BandSmoother(BANDS);
  return {
    render(frame: ThreeFrame) {
      const hue = frame.options.themeHue ?? 171;
      if (hue !== lastHue) {
        lastHue = hue;
        for (let i = 0; i < RING_COUNT; i++) rings[i].material.color = hueColor(hue + (i % BANDS) * 9, 0.85, 0.55);
        beacon.material.color = hueColor(hue + 30, 0.9, 0.6);
      }
      const { energy, bass, impact } = pulse.update(
        energyLevel(frame.freq),
        bassLevel(frame.freq),
        frame.dt,
      );
      const bands = smoother.step(bandLevels(frame.freq, BANDS), frame.dt);
      const motion = frame.prefersReducedMotion ? 0.15 : 1;
      offset += frame.dt * (5 + energy * 22 + impact * 26) * motion;

      for (let i = 0; i < RING_COUNT; i++) {
        const { mesh, material } = rings[i];
        const z = (((-i * SPACING + offset) % TOTAL) + TOTAL) % TOTAL; // 0..TOTAL
        mesh.position.z = z - TOTAL + 10; // far..near(+10)
        const depth = z / TOTAL; // 0 far → 1 near
        const band = bands[i % BANDS];
        const scale = 1 + band * 0.5 + bass * 0.1 + impact * 0.08;
        mesh.scale.setScalar(scale);
        material.opacity = Math.min(1, (0.12 + band * 0.85 + impact * 0.25) * (0.25 + depth));
        mesh.rotation.z = frame.elapsed * 0.12 * motion * (i % 2 === 0 ? 1 : -1);
      }

      group.rotation.z += frame.dt * (0.04 + energy * 0.18) * motion;
      beacon.material.opacity = 0.28 + bass * 0.45 + impact * 0.3;
      beacon.scale.setScalar(9 + bass * 5.5 + impact * 5);
      shell.camera.position.x = Math.sin(frame.elapsed * 0.24 * motion) * 0.7;
      shell.camera.position.y = Math.cos(frame.elapsed * 0.19 * motion) * 0.55;
      shell.camera.lookAt(0, 0, -TOTAL / 2);
      shell.renderer.render(shell.scene, shell.camera);
    },
    resize: shell.resize,
    dispose() {
      texture.dispose();
      shell.dispose();
    },
  };
}
