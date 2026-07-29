# scorebench v0.3.4

## Highlights

- Adds **蜃景 · Mirage**, a music-reactive cinematic particle imagery with a
  72,000-sample gold orbital band, slowly rotating procedural planet,
  travelling blue-violet streams, asynchronously twinkling stars, a
  steel-blue spectrum landscape, restrained ship motion, volumetric engine
  trails, foreground parallax dust, and beat-driven energy pulses.
- Keeps the focal layers clean: the opaque planet occludes the far ring,
  planet/ring glow no longer compounds into a glassy atmosphere, shockwaves
  fade independently instead of becoming a permanent halo, and the planet
  surface separates oceans, continents, lakes, and sparse warm lights without
  line primitives.
- Adds a deterministic Mirage showcase harness, dynamics tests, registry
  coverage, and a dedicated client-bundle budget.
- Moves the application contract to ScoreKit 0.7, including exact clips,
  deterministic automation, independent percussion tracks, live renderer
  profile certification, stricter orchestration schema validation, and richer
  scene observation.

## Verification

- Frontend type checking and 164 Vitest tests pass.
- The production build and bundle gate pass; Mirage is 33.1 KiB raw / 10.5 KiB
  gzip inside its reviewed ceiling.
- Rust formatting, strict Clippy, 179 unit tests, and the Tauri-boundary
  integration test pass.

ScoreKit remains an external runtime dependency and is not bundled. On first
launch, scorebench reports its discovered path, doctor status, machine-readable
version compatibility, and ScoreKit-provided installation hints.
