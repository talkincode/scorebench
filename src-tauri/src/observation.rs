//! Read-only scene and artifact display models.
//!
//! Unknown scorekit fields are tolerated. scorebench extracts values for
//! display and delegates validity to `scorekit validate --json`.

use std::path::Path;

use serde::Serialize;
use serde_json::Value as JsonValue;
use serde_yaml::{Mapping, Value};

use crate::error::BenchError;
use crate::{project, scorekit};

#[derive(Debug, Clone, Serialize)]
pub struct SceneInspection {
    pub scene: Option<SceneDisplay>,
    pub parse_error: Option<String>,
    pub validation: ValidationDisplay,
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
    pub tempo: Option<f64>,
    pub key: Option<String>,
    pub time_signature: Option<String>,
    pub bars: Option<u64>,
    pub loop_enabled: Option<bool>,
    pub harmony: Vec<String>,
    pub sections: Vec<SectionDisplay>,
    pub tracks: Vec<TrackDisplay>,
    pub has_performance: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SectionDisplay {
    pub name: Option<String>,
    pub bars: Option<u64>,
    pub tempo: Option<f64>,
    pub loop_enabled: Option<bool>,
    pub intensity: Option<f64>,
    pub mute: Vec<u64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct TrackDisplay {
    pub instrument: Option<String>,
    pub pattern: Option<String>,
    pub motif: Option<String>,
    pub intensity: Option<f64>,
    pub articulation: Option<String>,
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
    Ok(SceneInspection {
        scene,
        parse_error,
        validation,
        last_diff: read_last_diff(root, rel_path)?,
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
        tempo: number(mapping, "tempo"),
        key: string(mapping, "key"),
        time_signature: scalar_string(mapping, "time_signature"),
        bars: integer(mapping, "bars"),
        loop_enabled: boolean(mapping, "loop"),
        harmony: sequence(mapping, "harmony")
            .into_iter()
            .filter_map(value_string)
            .collect(),
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
                    .filter_map(|value| value.as_u64())
                    .collect(),
            })
            .collect(),
        tracks: sequence(mapping, "tracks")
            .into_iter()
            .filter_map(|value| value.as_mapping())
            .map(|track| TrackDisplay {
                instrument: string(track, "instrument"),
                pattern: string(track, "pattern"),
                motif: string(track, "motif"),
                intensity: number(track, "intensity"),
                articulation: string(track, "articulation"),
            })
            .collect(),
        has_performance: get(mapping, "performance").is_some(),
    }
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
    fn parses_sections_and_tolerates_unknown_fields() {
        let value: Value = serde_yaml::from_str(&fixture("forest_suite.yaml")).unwrap();
        let scene = display(value.as_mapping().unwrap());
        assert_eq!(scene.sections.len(), 4);
        assert_eq!(scene.sections[2].tempo, Some(132.0));
        assert_eq!(scene.sections[0].mute, vec![3, 4]);
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
