/**
 * Spectrum rendering module contract (seed of the M4 module system).
 * A style is a pure draw function over analyser data — no playback coupling.
 */
export interface SpectrumStyle {
  id: string;
  label: string;
  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    freq: Uint8Array,
    time: Uint8Array,
  ): void;
}
