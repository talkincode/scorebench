import type { SpectrumStyle } from "./types";

/** Oscilloscope waveform from the time-domain buffer. */
export const wave: SpectrumStyle = {
  id: "wave",
  label: "Wave",
  draw(ctx, width, height, _freq, time) {
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "hsl(160 80% 55%)";
    ctx.beginPath();
    const mid = height / 2;
    for (let i = 0; i < time.length; i++) {
      const x = (i / (time.length - 1)) * width;
      const y = mid + ((time[i] - 128) / 128) * mid * 0.9;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};
