import type { SpectrumStyle } from "./types";

/** Classic frequency bars with a warm-to-hot gradient. */
export const bars: SpectrumStyle = {
  id: "bars",
  label: "Bars",
  options: [{ key: "bars", label: "Bars", min: 16, max: 128, step: 8, defaultValue: 64 }],
  draw({ ctx, width, height, freq, options }) {
    ctx.clearRect(0, 0, width, height);
    const barCount = Math.max(16, Math.min(128, Math.round(options.bars ?? 64)));
    const step = Math.floor(freq.length / barCount) || 1;
    const gap = 2;
    const barWidth = Math.max(1, (width - gap * (barCount - 1)) / barCount);

    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += freq[i * step + j] ?? 0;
      const value = sum / step / 255;
      const barHeight = Math.max(2, value * height);
      const x = i * (barWidth + gap);
      const y = height - barHeight;
      const hue = (options.themeHue ?? 171) + value * 58;
      ctx.fillStyle = `hsl(${hue} 82% ${34 + value * 30}%)`;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  },
};
