import type { SpectrumStyle } from "./types";

/** Classic frequency bars with a warm-to-hot gradient and soft peak glow. */
export const bars: SpectrumStyle = {
  id: "bars",
  label: "Bars",
  draw(ctx, width, height, freq) {
    ctx.clearRect(0, 0, width, height);
    const barCount = 64;
    const step = Math.floor(freq.length / barCount) || 1;
    const gap = 2;
    const barWidth = (width - gap * (barCount - 1)) / barCount;

    for (let i = 0; i < barCount; i++) {
      // Average a slice of bins per bar for stability.
      let sum = 0;
      for (let j = 0; j < step; j++) sum += freq[i * step + j] ?? 0;
      const v = sum / step / 255;
      const barHeight = Math.max(2, v * height);
      const x = i * (barWidth + gap);
      const y = height - barHeight;

      const hue = 210 - v * 180; // cool blue floor -> hot amber peaks
      ctx.fillStyle = `hsl(${hue} 85% ${35 + v * 25}%)`;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  },
};
