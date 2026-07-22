import * as THREE from "three";

/** Averages `freq` bins into `count` normalized bands (0..1). */
export function bandLevels(freq: Uint8Array, count: number): Float32Array {
  const bands = new Float32Array(count);
  const step = Math.max(1, Math.floor(freq.length / count));
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += freq[i * step + j] ?? 0;
    bands[i] = sum / step / 255;
  }
  return bands;
}

/** Mean of the lowest eighth of the spectrum — a bass/impact proxy. */
export function bassLevel(freq: Uint8Array): number {
  const n = Math.max(1, Math.floor(freq.length / 8));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += freq[i];
  return sum / n / 255;
}

/** Mean of the full spectrum. */
export function energyLevel(freq: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < freq.length; i++) sum += freq[i];
  return freq.length ? sum / freq.length / 255 : 0;
}

/** Round sprite texture for glow/particle materials, generated once per call. */
export function glowTexture(size = 64): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export interface SceneShell {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

/** Shared renderer/scene/camera boilerplate with safe disposal. */
export function createShell(canvas: HTMLCanvasElement, fov = 60): SceneShell {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 400);
  return {
    renderer,
    scene,
    camera,
    resize(width, height, dpr) {
      renderer.setPixelRatio(Math.min(dpr, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    },
    dispose() {
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      renderer.getContext()?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
