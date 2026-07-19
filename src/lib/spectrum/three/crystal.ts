import * as THREE from "three";
import { bandLevels, bassLevel, createShell, energyLevel, glowTexture, hueColor } from "./common";
import type { ThreeFrame, ThreeInstance } from "./types";

const BANDS = 24;

/** Faceted crystal whose surface ripples along frequency bands by latitude. */
export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const shell = createShell(canvas, 55);
  shell.camera.position.set(0, 0.4, 6.2);
  shell.camera.lookAt(0, 0, 0);

  const geometry = new THREE.IcosahedronGeometry(1.95, 3);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const base = new Float32Array(position.array);
  const bandIndex = new Uint8Array(position.count);
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).normalize();
    bandIndex[i] = Math.min(BANDS - 1, Math.floor(((vertex.y + 1) / 2) * BANDS));
  }

  const innerMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 });
  const wireMaterial = new THREE.MeshBasicMaterial({
    wireframe: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const crystal = new THREE.Group();
  crystal.add(new THREE.Mesh(geometry, innerMaterial), new THREE.Mesh(geometry, wireMaterial));
  shell.scene.add(crystal);

  const texture = glowTexture();
  const aura = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  aura.position.z = -2;
  shell.scene.add(aura);

  let lastHue = Number.NaN;
  return {
    render(frame: ThreeFrame) {
      const hue = frame.options.themeHue ?? 171;
      if (hue !== lastHue) {
        lastHue = hue;
        innerMaterial.color = hueColor(hue, 0.55, 0.07);
        wireMaterial.color = hueColor(hue, 0.85, 0.58);
        aura.material.color = hueColor(hue + 18, 0.9, 0.5);
      }
      const bands = bandLevels(frame.freq, BANDS);
      const bass = bassLevel(frame.freq);
      const energy = energyLevel(frame.freq);
      const motion = frame.prefersReducedMotion ? 0.15 : 1;

      const amp = 0.34 + bass * 0.16;
      for (let i = 0; i < position.count; i++) {
        const swell = 1 + bands[bandIndex[i]] * amp;
        position.setXYZ(i, base[i * 3] * swell, base[i * 3 + 1] * swell, base[i * 3 + 2] * swell);
      }
      position.needsUpdate = true;

      crystal.rotation.y += frame.dt * (0.18 + energy * 0.85) * motion;
      crystal.rotation.x += frame.dt * 0.07 * motion;
      wireMaterial.opacity = 0.55 + energy * 0.45;
      aura.scale.setScalar(6 + bass * 4.5);
      aura.material.opacity = 0.16 + bass * 0.4;
      shell.renderer.render(shell.scene, shell.camera);
    },
    resize: shell.resize,
    dispose() {
      texture.dispose();
      shell.dispose();
    },
  };
}
