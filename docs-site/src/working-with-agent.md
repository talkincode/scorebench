# Working with the Agent

The central interaction in scorebench is not filling out parameter forms. It is helping the Agent translate creative intent into a valid, testable ScoreKit scene. Clearer briefs usually require fewer iterations.

## A practical brief template

```text
Purpose: Where will the music play? Is it a loop or a one-shot cue?
Mood: What should the listener feel, and what should be avoided?
Length and form: How many bars, and are intro/explore/combat sections needed?
Material: Tempo, key, meter, motif, or a reference color.
Orchestration: Who carries melody, harmony, bass, rhythm, and texture?
Constraints: Do you need stems, a seamless loop, or a particular orchestration profile?
Acceptance: What would make the result complete?
```

You do not need to know every theory term. A phrase such as “a distant memory, sparse, no drums” is useful as long as the Agent eventually translates it into tempo, register, instrumentation, rests, and dynamics that the live schema can express.

## A productive iteration loop

1. **Set roles and form first.** The Agent records a concise arrangement intent before writing: task mode, expected fields, invariants, form, and creative instrumentation.
2. **Generate and validate the scene.** Existing scenes are read before the intent is declared. Passing `scorekit validate` proves protocol validity, while the independent intent-alignment gate proves the semantic edit stayed in scope; neither alone proves musical quality.
3. **Listen with the default sound source.** Use FluidSynth to judge melody, harmony, density, and form quickly.
4. **Change one class of problem at a time.** Fix phrasing, then orchestration, then sound sources. The semantic diff remains meaningful.
5. **Move to the target sound source last.** An orchestration profile can change envelopes, balance, articulation, and perceived space, so listen again after switching.
6. **Use Review for alternatives.** Review is text analysis over an evidence pack. It does not hear the audio or edit the scene directly.

## Make revision requests executable

| Vague request | More executable request |
| --- | --- |
| Make it more epic | Raise combat intensity, add brass and timpani, and preserve the original motif |
| It is not sad enough | Slow it down, reduce simultaneous melodic voices, add rests, and avoid a bright upper register |
| Give it more depth | Separate instrumental roles, pan complementary textures, and adjust near/far placement instead of raising every track |
| Make the ending natural | For a loop, make the final harmony return to the opening; for a one-shot, leave a clear decay |
| Make it sound human | Add small seeded timing and velocity variation, then verify legato and the target articulation |

## StylePack, grammar, and orchestration profile are different

- A **StylePack** is a scorebench creative preference package. Built-ins distinguish schema-legal `preferred_instruments` from descriptive `creative_concepts`; neither is the same thing as a Scene routing palette.
- A **grammar profile** is a set of measurable ScoreKit aesthetic checks, such as tempo limits, voice count, and melody rest ratio.
- An **orchestration profile** routes each scene track's logical `palette` (or the orchestration's `default_palette`) to a leaf renderer profile mapping ScoreKit instruments and articulations to local SFZ files for sfizz.
- A **texture profile** maps portable ambience and sound-effect source names to local audio files, independently of the renderer.

StylePack influences choices, grammar checks the compiled music, an orchestration profile controls instrumental timbre per track, and a texture profile binds scheduled recordings. A creative concept must be translated into live-schema instruments; a Scene `palette` may only name a key from the active orchestration. None of these layers replaces the others.

## Project files and recovery

Scenes, the project manifest, sessions, and Agent memory are plain files. Before writing, the Agent declares a run-local arrangement intent; scorebench freezes the original scene baseline, records semantic history, validates immediately, and compares every retry with that baseline. Invalid YAML may remain on disk with a visible error so the Agent can repair it, but independent intent-alignment, validation, build, instrument-resolution, and grammar gates prevent that run from finishing normally until every failed check is retried successfully. Streamed model text remains visibly marked as a provisional draft until the response and any tools finish. Accepted text stays transactional across the run and is finalized only after the completed history is durable on disk; blocked, incomplete, cancelled, exhausted, failed, or non-durable claims are removed instead of being presented as completed chat history. Project switching is disabled during a live run, and late events are tied to the project and session that started it. Put the project under Git if you want review and rollback.

The selected renderer, orchestration profile, and texture profile are stored in `bench.json`. Sample rate, gain, quality, format, and stems are immediate Render-panel choices. Never put secrets in `bench.json`.
