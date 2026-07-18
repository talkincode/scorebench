import type { SpectrumStyle } from "./types";

/** Oscilloscope waveform from the time-domain buffer. */
export const wave: SpectrumStyle = {
  id: "wave",
  label: "Wave",
  draw({ ctx, width, height, time, prefersReducedMotion, options }) {
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsl(${options.themeHue ?? 171} 80% 58%)`;
    ctx.beginPath();
    const mid = height / 2;
    const stride = prefersReducedMotion ? 8 : 2;
    for (let i = 0; i < time.length; i += stride) {
      const x = (i / Math.max(1, time.length - 1)) * width;
      const y = mid + ((time[i] - 128) / 128) * mid * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};
