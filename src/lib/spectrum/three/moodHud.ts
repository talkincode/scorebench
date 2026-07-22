import * as THREE from "three";
import type { MoodState, WeatherMode } from "../mood";

const WEATHER_GLYPH: Record<WeatherMode, string> = {
  clear: "晴",
  mist: "雾",
  rain: "雨",
  snow: "雪",
  storm: "雷",
};

export interface MoodHud {
  render(
    renderer: THREE.WebGLRenderer,
    mood: MoodState,
    progress: number,
    hue: number,
    dt: number,
    enabled: boolean,
  ): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Shared in-canvas acceptance HUD used by every mood-aware Three.js imagery. */
export function createMoodHud(): MoodHud {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    fog: false,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(30, 15, 1);
  const scene = new THREE.Scene();
  scene.add(sprite);
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 100);
  camera.position.z = 40;
  let drawClock = Number.POSITIVE_INFINITY;

  const place = (aspect: number) => {
    camera.left = -50 * aspect;
    camera.right = 50 * aspect;
    camera.updateProjectionMatrix();
    sprite.position.set(-50 * aspect + 17.5, -50 + 16, 0);
  };
  place(1);

  const trackX = 30;
  const trackW = 214;
  const draw = (mood: MoodState, progress: number, hue: number) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 128);
    ctx.fillStyle = "rgba(8, 12, 20, 0.6)";
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, 255, 127, 10);
    ctx.fill();
    const bars: ReadonlyArray<readonly [string, number, string]> = [
      ["V", mood.valence, `hsl(${Math.round(220 - mood.valence * 180)} 72% 62%)`],
      ["A", mood.arousal, "hsl(48 82% 62%)"],
      ["T", mood.tension, "hsl(6 78% 58%)"],
    ];
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i < bars.length; i++) {
      const [label, value, color] = bars[i];
      const y = 15 + i * 24;
      ctx.fillStyle = "rgba(235, 240, 250, 0.75)";
      ctx.fillText(label, 11, y);
      ctx.fillStyle = "rgba(255, 255, 255, 0.13)";
      ctx.fillRect(trackX, y - 4, trackW, 8);
      ctx.fillStyle = color;
      ctx.fillRect(trackX, y - 4, trackW * value, 8);
    }

    ctx.fillStyle = "rgba(255, 255, 255, 0.38)";
    ctx.fillRect(trackX + trackW / 2, 8, 1, 14);
    const intentMode = mood.intent?.modeMajor;
    if (intentMode !== undefined) {
      const x = trackX + trackW * (0.5 + (intentMode - 0.5) * 0.8);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x + 5, 15);
      ctx.lineTo(x, 22);
      ctx.lineTo(x - 5, 15);
      ctx.closePath();
      ctx.stroke();
    }

    const buildY = 87;
    ctx.fillStyle = "rgba(235, 240, 250, 0.55)";
    ctx.fillText("↗", 11, buildY);
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.fillRect(trackX, buildY - 2, trackW, 4);
    ctx.fillStyle = `rgba(255, 214, 130, ${(0.45 + mood.buildUp * 0.55).toFixed(3)})`;
    ctx.fillRect(trackX, buildY - 2, trackW * mood.buildUp, 4);

    ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(235, 240, 250, 0.92)";
    const dominant = Math.round(mood.weights[mood.dominant] * 100);
    const weather = Math.round(mood.weather[mood.weatherMode] * 100);
    const intentTag = intentMode !== undefined ? "  ◆ intent" : "";
    ctx.fillText(
      `${mood.dominant} ${dominant}% · ${WEATHER_GLYPH[mood.weatherMode]} ${weather}%${intentTag}`,
      11,
      110,
    );

    const scrub = Math.max(0, Math.min(1, progress));
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.fillRect(11, 120, trackX + trackW - 11, 3);
    ctx.fillStyle = `hsl(${Math.round(hue)} 75% 62%)`;
    ctx.fillRect(11, 120, (trackX + trackW - 11) * scrub, 3);
    texture.needsUpdate = true;
  };

  return {
    render(renderer, mood, progress, hue, dt, enabled) {
      if (!enabled) return;
      drawClock += dt;
      if (drawClock >= 0.15) {
        drawClock = 0;
        draw(mood, progress, hue);
      }
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
    resize(width, height) {
      place(width / Math.max(1, height));
    },
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}
