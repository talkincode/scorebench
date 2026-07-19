import * as THREE from "three";
import { bandLevels, bassLevel, createShell, energyLevel, glowTexture, hueColor } from "./common";
import type { ThreeFrame, ThreeInstance } from "./types";

interface Cloud {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  radii: Float32Array;
  baseSize: number;
}

function makeCloud(count: number, radius: number, thickness: number, baseSize: number, texture: THREE.Texture): Cloud {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = (Math.random() - 0.5) * thickness * (1 - (r / radius) * 0.55);
    positions[i * 3 + 2] = Math.sin(angle) * r;
    radii[i] = r / radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: baseSize,
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  return { points: new THREE.Points(geometry, material), material, radii, baseSize };
}

function recolor(cloud: Cloud, hue: number, spread: number) {
  const attr = cloud.points.geometry.getAttribute("color") as THREE.BufferAttribute;
  const color = new THREE.Color();
  for (let i = 0; i < cloud.radii.length; i++) {
    const t = cloud.radii[i];
    color.setHSL((((hue + t * spread) % 360) + 360) % 360 / 360, 0.85, 0.42 + (1 - t) * 0.3);
    attr.setXYZ(i, color.r, color.g, color.b);
  }
  attr.needsUpdate = true;
}

/** Drifting particle nebula: bass breathes the core, treble shimmers the halo. */
export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const shell = createShell(canvas, 58);
  shell.camera.position.set(0, 3.4, 12.5);
  shell.camera.lookAt(0, 0, 0);

  const texture = glowTexture();
  const inner = makeCloud(1500, 5.2, 2.6, 0.34, texture);
  const outer = makeCloud(1300, 10.5, 4.4, 0.24, texture);
  shell.scene.add(inner.points, outer.points);

  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  core.scale.setScalar(4);
  shell.scene.add(core);

  let lastHue = Number.NaN;
  return {
    render(frame: ThreeFrame) {
      const hue = frame.options.themeHue ?? 171;
      if (hue !== lastHue) {
        lastHue = hue;
        recolor(inner, hue, 40);
        recolor(outer, hue + 26, 70);
        core.material.color = hueColor(hue, 0.9, 0.62);
      }
      const bass = bassLevel(frame.freq);
      const energy = energyLevel(frame.freq);
      const bands = bandLevels(frame.freq, 4);
      const motion = frame.prefersReducedMotion ? 0.12 : 1;

      inner.points.rotation.y += frame.dt * (0.06 + energy * 0.42) * motion;
      outer.points.rotation.y -= frame.dt * (0.03 + bands[3] * 0.3) * motion;
      inner.points.scale.setScalar(1 + bass * 0.24);
      outer.points.scale.setScalar(1 + bands[2] * 0.14);
      inner.material.size = inner.baseSize * (1 + bass * 0.9);
      outer.material.size = outer.baseSize * (1 + bands[3] * 0.8);
      core.scale.setScalar(3.4 + bass * 3.2);
      core.material.opacity = 0.28 + bass * 0.5;

      shell.camera.position.x = Math.sin(frame.elapsed * 0.1 * motion) * 1.1;
      shell.camera.position.y = 3.1 + Math.sin(frame.elapsed * 0.07 * motion) * 0.5;
      shell.camera.lookAt(0, 0, 0);
      shell.renderer.render(shell.scene, shell.camera);
    },
    resize: shell.resize,
    dispose() {
      texture.dispose();
      shell.dispose();
    },
  };
}
