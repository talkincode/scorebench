# Working with the Agent

The central interaction in scorebench is not filling out parameter forms. It is helping the Agent translate creative intent into a valid, testable ScoreKit scene. Clearer briefs usually require fewer iterations.

## A practical brief template

```text
Purpose: Where will the music play? Is it a loop or a one-shot cue?
Mood: What should the listener feel, and what should be avoided?
Length and form: How many bars, and are intro/explore/combat sections needed?
Material: Tempo, key, meter, motif, or a reference color.
Orchestration: Who carries melody, harmony, bass, rhythm, and texture?
Constraints: Do you need stems, a seamless loop, or a particular SFZ profile?
Acceptance: What would make the result complete?
```

You do not need to know every theory term. A phrase such as “a distant memory, sparse, no drums” is useful as long as the Agent eventually translates it into tempo, register, instrumentation, rests, and dynamics that the live schema can express.

## A productive iteration loop

1. **Set roles and form first.** Decide who carries melody, harmony, bass, rhythm, and whether the piece needs multiple sections.
2. **Generate and validate the scene.** Passing `scorekit validate` proves protocol validity, not musical quality.
3. **Listen with the default sound source.** Use FluidSynth to judge melody, harmony, density, and form quickly.
4. **Change one class of problem at a time.** Fix phrasing, then orchestration, then sound sources. The semantic diff remains meaningful.
5. **Move to the target sound source last.** An SFZ profile can change envelopes, balance, articulation, and perceived space, so listen again after switching.
6. **Use Review for alternatives.** Review is text analysis over an evidence pack. It does not hear the audio or edit the scene directly.

## Make revision requests executable

| Vague request | More executable request |
| --- | --- |
| Make it more epic | Raise combat intensity, add brass and timpani, and preserve the original motif |
| It is not sad enough | Slow it down, reduce simultaneous melodic voices, add rests, and avoid a bright upper register |
| Give it more depth | Separate instrumental roles, pan complementary textures, and adjust near/far placement instead of raising every track |
| Make the ending natural | For a loop, make the final harmony return to the opening; for a one-shot, leave a clear decay |
| Make it sound human | Add small seeded timing and velocity variation, then verify legato and the target articulation |

## StylePack, grammar, and renderer profile are different

- A **StylePack** is a scorebench creative preference package. It guides the Agent toward particular harmony, orchestration, form, and review criteria.
- A **grammar profile** is a set of measurable ScoreKit aesthetic checks, such as tempo limits, voice count, and melody rest ratio.
- A **renderer profile** maps ScoreKit instruments and articulations to local SFZ files for sfizz.
- A **texture profile** maps portable ambience and sound-effect source names to local audio files, independently of the renderer.

StylePack influences choices, grammar checks the compiled music, a renderer profile controls instrumental timbre, and a texture profile binds scheduled recordings. None of them replaces the others.

## Project files and recovery

Scenes, the project manifest, sessions, and Agent memory are plain files. When the Agent writes a scene, scorebench records semantic history and validates immediately. Invalid YAML may remain on disk with a visible error so the Agent can repair it. Put the project under Git if you want review and rollback.

The selected renderer, SFZ profile, and texture profile are stored in `bench.json`. Sample rate, gain, quality, format, and stems are immediate Render-panel choices. Never put secrets in `bench.json`.
