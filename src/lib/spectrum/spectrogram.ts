import type { SpectrumStyle } from "./types";

interface RingState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cursor: number;
  frame: number;
  width: number;
  height: number;
}

const rings = new WeakMap<CanvasRenderingContext2D, RingState>();

function ringFor(ctx: CanvasRenderingContext2D, width: number, height: number): RingState {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  let state = rings.get(ctx);
  if (!state || state.width !== w || state.height !== h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ringCtx = canvas.getContext("2d");
    if (!ringCtx) throw new Error("offscreen spectrogram canvas unavailable");
    ringCtx.fillStyle = "#11131a";
    ringCtx.fillRect(0, 0, w, h);
    state = { canvas, ctx: ringCtx, cursor: 0, frame: 0, width: w, height: h };
    rings.set(ctx, state);
  }
  return state;
}

export const spectrogram: SpectrumStyle = {
  id: "spectrogram",
  label: "Spectrogram",
  draw({ ctx, width, height, freq, prefersReducedMotion, options }) {
    const state = ringFor(ctx, width, height);
    state.frame++;
    const shouldAdvance = !prefersReducedMotion || state.frame % 5 === 0;
    if (shouldAdvance) {
      const x = state.cursor;
      const rows = Math.min(freq.length, state.height);
      for (let row = 0; row < rows; row++) {
        const bin = Math.floor((row / rows) * freq.length);
        const value = (freq[bin] ?? 0) / 255;
        const hue = (options.themeHue ?? 171) + value * 82;
        state.ctx.fillStyle = `hsl(${hue} 90% ${8 + value * 60}%)`;
        state.ctx.fillRect(x, state.height - row - 1, 1, 1);
      }
      state.cursor = (state.cursor + 1) % state.width;
    }

    ctx.clearRect(0, 0, width, height);
    const tail = state.width - state.cursor;
    ctx.drawImage(state.canvas, state.cursor, 0, tail, state.height, 0, 0, tail, height);
    if (state.cursor > 0) {
      ctx.drawImage(
        state.canvas,
        0,
        0,
        state.cursor,
        state.height,
        tail,
        0,
        state.cursor,
        height,
      );
    }
  },
};
