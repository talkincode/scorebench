# Spectrum style contract

Spectrum styles are observation-only draw functions over `AnalyserNode` buffers. A style:

- receives one `SpectrumFrame` object and never controls playback, audio nodes, or project state;
- clears its own canvas region on every draw;
- honors `prefersReducedMotion` by reducing temporal movement or update frequency;
- should stay near a 1 ms/frame budget at the default 64 bars;
- may declare numeric options through `options`; the player renders those controls generically;
- may keep canvas-local visual history, such as the spectrogram ring buffer, but no audio-derived state outside analyser data.

Add a style under this directory and append it to `spectrumStyles` in `index.ts`. A thrown draw error is logged once and falls back to `bars`; playback is never stopped.
