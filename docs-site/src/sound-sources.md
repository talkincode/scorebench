# Sound Sources, Sample Libraries, and Licensing

A sound source determines what performs the notes. It is related to a rendering backend but is not the same thing: FluidSynth is software and a SoundFont is its instrument data; sfizz is software and SFZ files plus samples are its instrument data.

## The default SoundFont

The standard ScoreKit installation uses the official **MuseScore General 0.2.0** SoundFont, named `MuseScore_General.sf2`. ScoreKit's installer also stores the accompanying MIT license file.

A normal user-managed sound directory looks like:

```text
~/.local/share/scorekit/sounds/
├── sf2/MuseScore_General.sf2
├── sfz/
└── profiles/
```

The Homebrew package uses a package-managed sound directory and exposes it to ScoreKit through `SCOREKIT_SOUND_LIBRARY_DIR`. A source installation can use the same environment variable to place sounds on another disk.

```bash
export SCOREKIT_SOUND_LIBRARY_DIR=/Volumes/Samples/scorekit
scorekit doctor
```

scorebench neither copies nor redistributes this file. It asks the locally installed ScoreKit to use the default source.

## Custom SF2 files

FluidSynth and TiMidity++ accept GM-compatible `.sf2` files. Each scene `instrument` maps to a General MIDI program, so a complete and correctly mapped GM SoundFont is the easiest replacement.

Before adopting a custom SF2, remember:

- A correct extension does not prove the file is valid; test it with ScoreKit and the renderer.
- Missing or unusual GM mappings can produce silence, substitutions, or the wrong instrument.
- The balance of the same MIDI can change substantially between SoundFonts.
- `articulation` does not switch an SF2 to pizzicato, spiccato, or another sample set. Only SFZ profiles use that field.
- A license may permit music made with a library while forbidding redistribution of the original samples or instrument file.

The current scorebench Render panel does not expose a custom-SoundFont picker, although the Agent/backend build interface supports a `soundfont` parameter. For a fixed project source, configure the ScoreKit sound directory or make the build workflow pass an explicit path rather than copying a large library into the repository.

## SFZ files and samples

SFZ is a text format that describes how samples are mapped into an instrument. A `.sfz` commonly references WAV or FLAC files beside it or elsewhere in the library. Copying the `.sfz` without its referenced samples cannot produce sound.

ScoreKit uses a renderer profile to map protocol instruments onto local SFZ files:

```yaml
name: open-orchestra
root: /Volumes/Samples
instruments:
  violin:
    sustain: VSCO/Violin/Violin-Sustain.sfz
    pizzicato: VSCO/Violin/Violin-Pizzicato.sfz
  cello:
    sustain: VSCO/Cello/Cello-Sustain.sfz
  drums:
    sustain: Drums/Programs/basic-kit.sfz
```

Every instrument needs a `sustain` mapping. When a dedicated articulation is absent, ScoreKit falls back to that instrument's `sustain`. This keeps machine-specific paths out of portable scene YAML, but teams still need an installation convention for the profile and its sample root.

Certify a profile before use:

```bash
scorekit profile check profile.yaml
scorekit --json profile check profile.yaml
```

The check covers paths, render probes, silence, warnings, and repeat-render behavior. One successful patch does not prove that every patch in the same library is compatible with sfizz.

## Open sources worth evaluating

ScoreKit's example profiles and research have used or evaluated sources such as:

| Source | Typical use | Licensing note |
| --- | --- | --- |
| MuseScore General 0.2.0 | Default GM sketching source | ScoreKit's installer records it as MIT; retain the supplied license |
| VSCO 2 Community Edition | Orchestral SFZ and samples | Common releases are CC0; verify the actual archive you download |
| VCSL | Instrumental and experimental samples | Much of the library is CC0; verify the source and version |
| FreePats | GM sounds, guitars, drums, and synthesizers | Packages use different licenses; do not treat the entire site as one license |

These names are not promises that the libraries are bundled or that every patch is compatible. Large SFZ instruments may rely on SFZv2 or ARIA opcodes, keyswitches, round-robin logic, microphone mixers, or pedal controls that sfizz does not implement completely. Test the exact patch you intend to map.

## “Free” does not mean “redistributable”

Ask three separate questions:

1. May you download and use the library without paying?
2. May you use rendered music commercially?
3. May you redistribute the original samples, SF2, or SFZ files with your application or repository?

The answers can differ. CC0, CC BY, MIT, GPL, CC BY-NC, and vendor EULAs impose different obligations. A software license and a recorded-sample license are not interchangeable.

## Sound-source adoption checklist

- Download from the official project or release, not an unknown repack.
- Record the version, source URL, file size, and SHA-256.
- Preserve LICENSE and NOTICE files; retain attribution for CC BY material.
- Test common range, low and high velocity, repeated notes, note-off, sustain pedal, and release behavior.
- Render twice at the target sample rate and inspect silence, warnings, and unacceptable random drift.
- Map only the exact patches that passed testing.
- Do not commit large sample sets without redistribution permission.
- Repeat full listening and loudness checks after changing sources.

This guide is not legal advice. For a commercial release, review the license text that accompanied the exact version you downloaded.
