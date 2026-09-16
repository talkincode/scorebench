//! Versioned, built-in arrangement doctrine for the composing agent.

use std::sync::OnceLock;

use serde::Deserialize;

const CANON_SOURCE: &str = include_str!("../arrangement/canon.yaml");

#[derive(Debug)]
pub struct ArrangementCanon {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub source_scorekit_range: String,
    pub source_commit: String,
    source: &'static str,
}

#[derive(Deserialize)]
struct Envelope {
    schema_version: u32,
    id: String,
    version: String,
    source_scorekit_range: String,
    provenance: Provenance,
}

#[derive(Deserialize)]
struct Provenance {
    commit: String,
}

pub fn canon() -> &'static ArrangementCanon {
    static CANON: OnceLock<ArrangementCanon> = OnceLock::new();
    CANON.get_or_init(|| {
        let envelope: Envelope = serde_yaml::from_str(CANON_SOURCE)
            .expect("embedded arrangement canon must be valid YAML");
        ArrangementCanon {
            schema_version: envelope.schema_version,
            id: envelope.id,
            version: envelope.version,
            source_scorekit_range: envelope.source_scorekit_range,
            source_commit: envelope.provenance.commit,
            source: CANON_SOURCE,
        }
    })
}

pub fn prompt_section() -> String {
    let canon = canon();
    format!(
        "ARRANGEMENT CANON `{}` v{} (schema {}, source scorekit {} @ {}):\n\
         Apply hard authority, source-honesty, and delivery rules to every scene operation. \
         Before write_scene, use declare_arrangement_intent and follow the declared task_mode; \
         creative craft rules are advisory defaults with the applicability and overrides encoded \
         below. The live ScoreKit schemas remain authoritative if this canon and the installed \
         tool disagree.\n{}\n",
        canon.id,
        canon.version,
        canon.schema_version,
        canon.source_scorekit_range,
        canon.source_commit,
        canon.source.trim_end()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canon_has_a_typed_versioned_scorekit_v07_envelope() {
        let canon = canon();

        assert_eq!(canon.schema_version, 1);
        assert_eq!(canon.id, "scorekit-arrangement-canon");
        assert_eq!(canon.version, "1.2.0");
        assert_eq!(canon.source_scorekit_range, ">=0.7.0, <0.8.0");
        assert_eq!(
            canon.source_scorekit_range,
            crate::scorekit::TESTED_SCOREKIT_RANGE
        );
        assert_eq!(canon.source_commit, "9a2c7b0");
        assert!(canon.source.contains("skills/scorekit/SKILL.md"));
        assert!(
            (4 * 1024..=11 * 1024).contains(&canon.source.len()),
            "canon must stay prompt-sized, got {} bytes",
            canon.source.len()
        );
    }

    #[test]
    fn prompt_requires_a_falsifiable_intent_contract_and_live_schema_only() {
        let prompt = prompt_section();

        for required in [
            "ARRANGEMENT CANON `scorekit-arrangement-canon` v1.2.0",
            "scorekit schema --json",
            "before_write",
            "expected_changes",
            "after_write",
            "never invent a scene field, instrument, palette, articulation, or texture source",
        ] {
            assert!(prompt.contains(required), "missing canon rule: {required}");
        }
    }

    #[test]
    fn prompt_breaks_palette_inertia_before_tracks_are_written() {
        let prompt = prompt_section();

        for required in [
            "name_the_inertia_answer",
            "candidate_count: \"2..=3\"",
            "minimum_changed_axes: 3",
            "Orchestral strings may be selected only when they win this comparison",
        ] {
            assert!(
                prompt.contains(required),
                "missing palette rule: {required}"
            );
        }
    }

    #[test]
    fn prompt_scopes_creative_rules_by_declared_task_mode() {
        let prompt = prompt_section();

        for required in [
            "task_modes:",
            "new_scene:",
            "revision:",
            "repair:",
            "recent_scene_fingerprint",
            "advisory defaults",
            "declare_arrangement_intent",
        ] {
            assert!(
                prompt.contains(required),
                "missing task-mode rule: {required}"
            );
        }
        assert!(!prompt.contains(
            "Apply this versioned doctrine to every compose or arrangement-revision turn."
        ));
        assert!(!prompt.contains(
            "Orchestral strings must win this comparison; they never inherit by default."
        ));
    }

    #[test]
    fn prompt_carries_the_measured_craft_contract() {
        let prompt = prompt_section();

        for required in [
            "core_identity_count: 1",
            "total_motifs_max: 2",
            "simultaneous_non_rest_melody_voices_max: 2",
            "rest_ratio_per_melody_min: 0.30",
            "long_rest_note_beats_max: 16",
            "shape: \"rise -> peak -> cut_or_contrast -> return\"",
            "loop_samples and total_samples",
            "last harmony must pull toward the first",
        ] {
            assert!(prompt.contains(required), "missing craft rule: {required}");
        }
    }

    #[test]
    fn prompt_carries_the_scorekit_v07_clip_contract() {
        let prompt = prompt_section();

        for required in [
            "authored_clips:",
            "linear_grid_ticks: 60",
            "event_budget_per_active_track: 65536",
            "Multiple drums tracks may share channel 10",
            "percussion_events_per_bar_min",
            "automation_activity",
            "scorekit profile check <leaf-profile>",
        ] {
            assert!(prompt.contains(required), "missing clip rule: {required}");
        }
    }

    #[test]
    fn prompt_keeps_every_world_identity_exact_only() {
        let prompt = prompt_section();

        for identity in [
            "erhu",
            "pipa",
            "guzheng",
            "dizi",
            "shakuhachi",
            "shamisen",
            "sitar",
            "tabla",
            "oud",
            "ney",
            "duduk",
        ] {
            assert!(
                prompt.contains(identity),
                "missing world identity: {identity}"
            );
        }
        assert!(prompt.contains("fallback_policy: exact_only"));
        assert!(prompt.contains("Never substitute into, out of, or within this family."));
        assert!(prompt.contains("gm_exact_melodic: [shakuhachi, shamisen, sitar]"));
        assert!(prompt.contains("tabla requires pattern tabla"));
    }

    #[test]
    fn prompt_discovers_and_certifies_textures_instead_of_guessing() {
        let prompt = prompt_section();

        for required in [
            "Never guess textures[].source",
            "scorekit --json texture inspect <texture-profile>",
            "scorekit --json texture inspect <texture-profile> --source <name>",
            "scorekit --json texture check <texture-profile>",
            "playback.modes",
            "no_match means re-orchestrate or add a real source",
        ] {
            assert!(
                prompt.contains(required),
                "missing texture rule: {required}"
            );
        }
    }

    #[test]
    fn prompt_orders_validate_lint_inspect_texture_and_build_gates() {
        let prompt = prompt_section();
        let ordered = [
            "G1_validate",
            "G2_lint",
            "G3_inspect_instruments",
            "G4_textures",
            "G5_build_evidence",
        ]
        .map(|gate| {
            prompt
                .find(gate)
                .unwrap_or_else(|| panic!("missing gate: {gate}"))
        });
        assert!(ordered.windows(2).all(|pair| pair[0] < pair[1]));

        for required in [
            "scorekit --json validate <scene>",
            "scorekit --json lint <scene> --grammar <grammar>",
            "scorekit --json inspect-instruments <scene> [--orchestration <orchestration>]",
            "scorekit build <scene> -o <output>",
            "failed_blocking_gate: do_not_report_completion",
        ] {
            assert!(prompt.contains(required), "missing gate rule: {required}");
        }
    }
}
