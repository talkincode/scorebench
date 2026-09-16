//! Scene validation plus read-only scene and artifact display models.
//!
//! Unknown scorekit fields are tolerated. scorebench extracts values for
//! display and delegates validity to `scorekit validate --json`.

use std::{collections::BTreeMap, path::Path};

use serde::Serialize;
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value};

use crate::error::BenchError;
use crate::{manifest, project, scorekit};

#[derive(Debug, Clone, Serialize)]
pub struct SceneInspection {
    pub scene: Option<SceneDisplay>,
    pub parse_error: Option<String>,
    pub validation: ValidationDisplay,
    /// Compatibility with the project's persisted orchestration
    /// configuration; `None` when no sfizz orchestration is active.
    pub orchestration: Option<manifest::OrchestrationCompat>,
    /// Texture source compatibility; `None` when the scene has no textures.
    pub texture_profile: Option<manifest::TextureProfileCompat>,
    pub last_diff: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationDisplay {
    pub status: String,
    pub error: Option<BenchError>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SceneDisplay {
    pub title: Option<String>,
    /// Narrative intent (scorekit ≥0.2 `story`): informational only.
    pub story: Option<String>,
    pub tempo: Option<f64>,
    pub key: Option<String>,
    pub time_signature: Option<String>,
    pub bars: Option<u64>,
    pub loop_enabled: Option<bool>,
    pub harmony: Vec<String>,
    pub clips: Vec<ClipDisplay>,
    pub sections: Vec<SectionDisplay>,
    pub tracks: Vec<TrackDisplay>,
    pub textures: Vec<TextureDisplay>,
    pub has_performance: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SectionDisplay {
    pub name: Option<String>,
    pub bars: Option<u64>,
    pub tempo: Option<f64>,
    pub loop_enabled: Option<bool>,
    pub intensity: Option<f64>,
    /// Stable track IDs silenced in this section.
    pub mute: Vec<String>,
    /// Stable track ID to section-local clip replacement.
    pub clips: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct TrackDisplay {
    /// Stable scene-local track ID (routing, sections, stems).
    pub id: Option<String>,
    /// Logical orchestration palette; absent uses the orchestration default.
    pub palette: Option<String>,
    pub instrument: Option<String>,
    pub pattern: Option<String>,
    pub motif: Option<String>,
    pub clip: Option<String>,
    pub intensity: Option<f64>,
    pub articulation: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ClipDisplay {
    pub id: String,
    pub kind: Option<String>,
    pub length_beats: Option<f64>,
    pub mode: Option<String>,
    pub event_count: usize,
    pub automation: Vec<AutomationDisplay>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct AutomationDisplay {
    pub id: String,
    pub target: Option<String>,
    pub interpolation: String,
    pub point_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct TextureDisplay {
    pub source: Option<String>,
    pub mode: Option<String>,
    pub gain: Option<f64>,
    pub start_beat: Option<f64>,
    pub at: Vec<f64>,
}

pub fn inspect_scene(root: &Path, rel_path: &str) -> Result<SceneInspection, BenchError> {
    if !(rel_path.ends_with(".yaml") || rel_path.ends_with(".yml")) {
        return Err(BenchError::invalid("scene path must end in .yaml or .yml"));
    }
    let path = project::resolve_inside(root, rel_path)?;
    let raw = std::fs::read_to_string(&path).map_err(BenchError::io)?;
    let (scene, parse_error) = match serde_yaml::from_str::<Value>(&raw) {
        Ok(value) => match value.as_mapping() {
            Some(mapping) => (Some(display(mapping)), None),
            None => (None, Some("scene YAML root must be a mapping".into())),
        },
        Err(error) => (None, Some(error.to_string())),
    };
    let validation = match scorekit::validate(&path) {
        Ok(()) => ValidationDisplay {
            status: "valid".into(),
            error: None,
        },
        Err(error @ BenchError::ScorekitMissing { .. }) => ValidationDisplay {
            status: "unavailable".into(),
            error: Some(error),
        },
        Err(error) => ValidationDisplay {
            status: "invalid".into(),
            error: Some(error),
        },
    };
    let render = manifest::load(root).0.render.unwrap_or_default();
    let orchestration = manifest::check_scene_profile(root, &path, &render);
    let texture_profile = manifest::check_scene_texture_profile(root, &path, &render);
    Ok(SceneInspection {
        scene,
        parse_error,
        validation,
        orchestration,
        texture_profile,
        last_diff: read_last_diff(root, rel_path)?,
    })
}

/// Validate unsaved editor content: stage it in a hidden temp file inside the
/// project (so relative references resolve like the real scene would), run
/// `scorekit validate --json`, then remove the staging file.
pub fn validate_scene_content(root: &Path, content: &str) -> Result<ValidationDisplay, BenchError> {
    let rel = format!(
        ".scorebench/.validate-{}-{}.yaml",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let path = project::write_text_atomic(root, &rel, content)?;
    let result = scorekit::validate(&path);
    let _ = std::fs::remove_file(&path);
    Ok(match result {
        Ok(()) => ValidationDisplay {
            status: "valid".into(),
            error: None,
        },
        Err(error @ BenchError::ScorekitMissing { .. }) => ValidationDisplay {
            status: "unavailable".into(),
            error: Some(error),
        },
        Err(error) => ValidationDisplay {
            status: "invalid".into(),
            error: Some(error),
        },
    })
}

pub fn read_meta(root: &Path, rel_path: &str) -> Result<JsonValue, BenchError> {
    if !rel_path.ends_with(".meta.json") {
        return Err(BenchError::invalid("artifact path must end in .meta.json"));
    }
    let path = project::resolve_inside(root, rel_path)?;
    let raw = std::fs::read_to_string(&path).map_err(BenchError::io)?;
    serde_json::from_str(&raw).map_err(|error| {
        BenchError::invalid(format!("meta file `{rel_path}` is not valid JSON: {error}"))
    })
}

fn display(mapping: &Mapping) -> SceneDisplay {
    SceneDisplay {
        title: string(mapping, "title"),
        story: string(mapping, "story"),
        tempo: number(mapping, "tempo"),
        key: string(mapping, "key"),
        time_signature: scalar_string(mapping, "time_signature"),
        bars: integer(mapping, "bars"),
        loop_enabled: boolean(mapping, "loop"),
        harmony: sequence(mapping, "harmony")
            .into_iter()
            .filter_map(value_string)
            .collect(),
        clips: clip_displays(mapping),
        sections: sequence(mapping, "sections")
            .into_iter()
            .filter_map(|value| value.as_mapping())
            .map(|section| SectionDisplay {
                name: string(section, "name"),
                bars: integer(section, "bars"),
                tempo: number(section, "tempo"),
                loop_enabled: boolean(section, "loop"),
                intensity: number(section, "intensity"),
                mute: sequence(section, "mute")
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                    .collect(),
                clips: string_map(section, "clips"),
            })
            .collect(),
        tracks: sequence(mapping, "tracks")
            .into_iter()
            .filter_map(|value| value.as_mapping())
            .map(|track| TrackDisplay {
                id: string(track, "id"),
                palette: string(track, "palette"),
                instrument: string(track, "instrument"),
                pattern: string(track, "pattern"),
                motif: string(track, "motif"),
                clip: string(track, "clip"),
                intensity: number(track, "intensity"),
                articulation: string(track, "articulation"),
            })
            .collect(),
        textures: sequence(mapping, "textures")
            .into_iter()
            .filter_map(|value| value.as_mapping())
            .map(|texture| TextureDisplay {
                source: string(texture, "source"),
                mode: string(texture, "mode"),
                gain: number(texture, "gain"),
                start_beat: number(texture, "start_beat"),
                at: sequence(texture, "at")
                    .into_iter()
                    .filter_map(Value::as_f64)
                    .collect(),
            })
            .collect(),
        has_performance: get(mapping, "performance").is_some(),
    }
}

fn clip_displays(scene: &Mapping) -> Vec<ClipDisplay> {
    let Some(clips) = get(scene, "clips").and_then(Value::as_mapping) else {
        return Vec::new();
    };
    let mut displays = clips
        .iter()
        .filter_map(|(id, value)| {
            let id = id.as_str()?;
            let clip = value.as_mapping()?;
            Some(ClipDisplay {
                id: id.to_owned(),
                kind: string(clip, "kind"),
                length_beats: number(clip, "length_beats"),
                mode: string(clip, "mode"),
                event_count: mapping_len(clip, "events"),
                automation: automation_displays(clip),
            })
        })
        .collect::<Vec<_>>();
    displays.sort_by(|left, right| left.id.cmp(&right.id));
    displays
}

fn automation_displays(clip: &Mapping) -> Vec<AutomationDisplay> {
    let Some(automation) = get(clip, "automation").and_then(Value::as_mapping) else {
        return Vec::new();
    };
    let mut displays = automation
        .iter()
        .filter_map(|(id, value)| {
            let id = id.as_str()?;
            let lane = value.as_mapping()?;
            Some(AutomationDisplay {
                id: id.to_owned(),
                target: string(lane, "target"),
                interpolation: string(lane, "interpolation").unwrap_or_else(|| "step".to_owned()),
                point_count: mapping_len(lane, "points"),
            })
        })
        .collect::<Vec<_>>();
    displays.sort_by(|left, right| left.id.cmp(&right.id));
    displays
}

fn mapping_len(mapping: &Mapping, key: &str) -> usize {
    get(mapping, key)
        .and_then(Value::as_mapping)
        .map_or(0, Mapping::len)
}

fn string_map(mapping: &Mapping, key: &str) -> BTreeMap<String, String> {
    get(mapping, key)
        .and_then(Value::as_mapping)
        .into_iter()
        .flat_map(Mapping::iter)
        .filter_map(|(key, value)| Some((key.as_str()?.to_owned(), value.as_str()?.to_owned())))
        .collect()
}

fn get<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Value> {
    mapping.get(Value::String(key.into()))
}

fn string(mapping: &Mapping, key: &str) -> Option<String> {
    get(mapping, key)
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn scalar_string(mapping: &Mapping, key: &str) -> Option<String> {
    get(mapping, key).and_then(value_string)
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn number(mapping: &Mapping, key: &str) -> Option<f64> {
    get(mapping, key).and_then(|value| value.as_f64())
}

fn integer(mapping: &Mapping, key: &str) -> Option<u64> {
    get(mapping, key).and_then(|value| value.as_u64())
}

fn boolean(mapping: &Mapping, key: &str) -> Option<bool> {
    get(mapping, key).and_then(|value| value.as_bool())
}

fn sequence<'a>(mapping: &'a Mapping, key: &str) -> Vec<&'a Value> {
    get(mapping, key)
        .and_then(|value| value.as_sequence())
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}

pub fn diff_rel_path(scene_rel: &str) -> String {
    let safe = scene_rel
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!(".scorebench/last-diff/{safe}.json")
}

fn read_last_diff(root: &Path, scene_rel: &str) -> Result<Option<JsonValue>, BenchError> {
    let root = root.canonicalize().map_err(BenchError::io)?;
    let path = root.join(diff_rel_path(scene_rel));
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| BenchError::invalid(format!("invalid saved diff: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BenchError::io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/scenes")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn parses_scorekit_forest_fixture() {
        let value: Value = serde_yaml::from_str(&fixture("forest.yaml")).unwrap();
        let scene = display(value.as_mapping().unwrap());
        assert_eq!(scene.title.as_deref(), Some("Forest Theme"));
        assert_eq!(scene.tempo, Some(92.0));
        assert_eq!(scene.time_signature.as_deref(), Some("4/4"));
        assert_eq!(scene.tracks.len(), 4);
    }

    #[test]
    fn story_is_extracted_when_present_and_none_otherwise() {
        let with: Value =
            serde_yaml::from_str("title: T\nstory: |\n  A quiet dawn over the valley.\n").unwrap();
        let scene = display(with.as_mapping().unwrap());
        assert_eq!(
            scene.story.as_deref(),
            Some("A quiet dawn over the valley.\n")
        );

        let without: Value = serde_yaml::from_str(&fixture("forest.yaml")).unwrap();
        assert_eq!(display(without.as_mapping().unwrap()).story, None);
    }

    #[test]
    fn parses_sections_and_tolerates_unknown_fields() {
        let value: Value = serde_yaml::from_str(&fixture("forest_suite.yaml")).unwrap();
        let scene = display(value.as_mapping().unwrap());
        assert_eq!(scene.sections.len(), 4);
        assert_eq!(scene.sections[2].tempo, Some(132.0));
        assert_eq!(
            scene.sections[0].mute,
            vec!["foundation".to_owned(), "pulse".to_owned()]
        );
    }

    #[test]
    fn parses_track_id_and_palette() {
        let value: Value = serde_yaml::from_str(&fixture("forest_suite.yaml")).unwrap();
        let scene = display(value.as_mapping().unwrap());
        assert_eq!(scene.tracks[0].id.as_deref(), Some("lead"));
        assert_eq!(scene.tracks[0].palette, None);

        let with_palette: Value = serde_yaml::from_str(
            "tracks:\n  - { id: solo_violin, palette: solo, instrument: strings, pattern: sustain }\n",
        )
        .unwrap();
        let scene = display(with_palette.as_mapping().unwrap());
        assert_eq!(scene.tracks[0].id.as_deref(), Some("solo_violin"));
        assert_eq!(scene.tracks[0].palette.as_deref(), Some("solo"));
    }

    #[test]
    fn parses_scorekit_v07_clips_for_observation() {
        let value: Value = serde_yaml::from_str(&fixture("clips.yaml")).unwrap();
        let scene = display(value.as_mapping().unwrap());

        assert_eq!(scene.clips.len(), 3);
        let keys = scene
            .clips
            .iter()
            .find(|clip| clip.id == "keys_line")
            .unwrap();
        assert_eq!(keys.kind.as_deref(), Some("pitched"));
        assert_eq!(keys.length_beats, Some(4.0));
        assert_eq!(keys.event_count, 2);
        assert_eq!(keys.automation.len(), 1);
        assert_eq!(keys.automation[0].target.as_deref(), Some("cc74"));
        assert_eq!(keys.automation[0].interpolation, "linear");
        assert_eq!(keys.automation[0].point_count, 3);
        assert_eq!(scene.tracks[0].clip.as_deref(), Some("keys_line"));
        assert_eq!(
            scene
                .tracks
                .iter()
                .filter(|track| track.instrument.as_deref() == Some("drums"))
                .count(),
            2
        );
    }

    #[test]
    fn parses_section_clip_replacements_and_effective_step_default() {
        let value: Value = serde_yaml::from_str(
            "clips:\n  base:\n    kind: pitched\n    length_beats: 4\n    mode: loop\n    events: {}\n    automation:\n      motion:\n        target: cc1\n        points: { start: { at: 0, value: 0 } }\nsections:\n  - name: alternate\n    bars: 1\n    clips: { lead: base }\n",
        )
        .unwrap();
        let scene = display(value.as_mapping().unwrap());

        assert_eq!(scene.clips[0].automation[0].interpolation, "step");
        assert_eq!(
            scene.sections[0].clips.get("lead").map(String::as_str),
            Some("base")
        );
    }

    #[test]
    fn parses_texture_layers_for_observation() {
        let value: Value = serde_yaml::from_str(
            "textures:\n  - { source: river, mode: loop, gain: 0.25, start_beat: 2 }\n  - { source: birds, mode: one_shot, at: [4, 12], gain: 0.5 }\n",
        )
        .unwrap();
        let scene = display(value.as_mapping().unwrap());
        assert_eq!(scene.textures.len(), 2);
        assert_eq!(scene.textures[0].source.as_deref(), Some("river"));
        assert_eq!(scene.textures[0].start_beat, Some(2.0));
        assert_eq!(scene.textures[1].at, vec![4.0, 12.0]);
    }

    #[test]
    fn malformed_yaml_returns_observation_error_not_panic() {
        let root = std::env::temp_dir().join(format!(
            "scorebench-observation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("broken.yaml"), "title: [unterminated").unwrap();
        let inspected = inspect_scene(&root, "broken.yaml").unwrap();
        assert!(inspected.scene.is_none());
        assert!(inspected.parse_error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
