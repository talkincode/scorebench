//! `bench.json` project manifest (docs/roadmap.md: plain-file project state)
//! plus the render-profile compatibility check the agent toolchain runs
//! before scorekit's build would fail.
//!
//! The manifest is written by the GUI render panel and read by the agent
//! core, so the agent composes for the same renderer configuration the user
//! renders with. Reads are tolerant: a missing or corrupt manifest never
//! blocks chat or scene writes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::BenchError;
use crate::project;

pub const MANIFEST_FILE: &str = "bench.json";

/// Persisted render selection. Only the semantic fields the agent needs;
/// transient knobs (gain, quality, ...) stay in the GUI.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<String>,
    /// Renderer profile path: project-relative when inside the project,
    /// absolute otherwise (mirrors the GUI build parameter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

/// Persisted style pack selection: the id of a pack in the global style
/// library (`styles.rs`). Per-project so each project keeps its own style;
/// the agent injects the referenced pack into every run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StyleRef {
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BenchManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render: Option<RenderConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<StyleRef>,
    /// Fields written by future scorebench versions survive a round trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Read `bench.json`. Missing file -> default; corrupt file -> default plus
/// a warning, never an error (the manifest must not brick the project).
pub fn load(root: &Path) -> (BenchManifest, Option<String>) {
    let path = root.join(MANIFEST_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (BenchManifest::default(), None);
        }
        Err(error) => {
            return (
                BenchManifest::default(),
                Some(format!("bench.json unreadable: {error}")),
            );
        }
    };
    match serde_json::from_str(&raw) {
        Ok(manifest) => (manifest, None),
        Err(error) => (
            BenchManifest::default(),
            Some(format!("bench.json is not valid JSON: {error}")),
        ),
    }
}

pub fn save(root: &Path, manifest: &BenchManifest) -> Result<(), BenchError> {
    let text = serde_json::to_string_pretty(manifest).map_err(BenchError::io)?;
    project::write_text_atomic(root, MANIFEST_FILE, &format!("{text}\n"))?;
    Ok(())
}

/// Update only the render section, preserving everything else in the file.
pub fn save_render(root: &Path, render: Option<RenderConfig>) -> Result<(), BenchError> {
    let (mut manifest, _) = load(root);
    manifest.render = render;
    save(root, &manifest)
}

/// Update only the style selection, preserving everything else in the file.
pub fn save_style(root: &Path, style: Option<StyleRef>) -> Result<(), BenchError> {
    let (mut manifest, _) = load(root);
    manifest.style = style;
    save(root, &manifest)
}

/// Result of checking one scene against the active renderer profile.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileCompat {
    /// Profile path as stored in the manifest.
    pub profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    /// Instrument keys the profile maps (sorted, deduplicated).
    pub mapped: Vec<String>,
    /// Scene track instruments with no mapping (sorted, deduplicated).
    pub unmapped: Vec<String>,
    /// Profile file could not be read or parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ProfileCompat {
    pub fn is_compatible(&self) -> bool {
        self.unmapped.is_empty() && self.error.is_none()
    }

    /// One-line report for tool summaries and prompts.
    pub fn message(&self) -> String {
        let name = self.profile_name.as_deref().unwrap_or(&self.profile);
        if let Some(error) = &self.error {
            return format!("renderer profile `{name}` is unusable: {error}");
        }
        if self.unmapped.is_empty() {
            format!("all track instruments are mapped by renderer profile `{name}`")
        } else {
            format!(
                "renderer profile `{name}` has no mapping for instrument(s) {}; the sfizz build will fail",
                self.unmapped
                    .iter()
                    .map(|key| format!("`{key}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    }
}

/// The profile only matters for the sfizz backend (SF2 renderers take a
/// soundfont instead), matching scorekit's `--profile` contract.
fn active_profile(render: &RenderConfig) -> Option<&str> {
    match (render.renderer.as_deref(), render.profile.as_deref()) {
        (Some("sfizz"), Some(profile)) if !profile.trim().is_empty() => Some(profile),
        _ => None,
    }
}

pub fn resolve_profile_path(root: &Path, profile: &str) -> PathBuf {
    let path = Path::new(profile);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

/// Load the instrument keys a renderer profile maps. This reads the same
/// YAML scorekit loads and compares keys only — no musical semantics.
pub fn profile_instruments(
    root: &Path,
    profile: &str,
) -> Result<(Option<String>, Vec<String>), String> {
    #[derive(Deserialize)]
    struct ProfileWire {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        instruments: BTreeMap<String, Value>,
    }
    let path = resolve_profile_path(root, profile);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let wire: ProfileWire = serde_yaml::from_str(&raw)
        .map_err(|error| format!("`{}` is not a renderer profile: {error}", path.display()))?;
    Ok((wire.name, wire.instruments.into_keys().collect()))
}

/// Cross-check a scene's track instruments against the manifest's active
/// renderer profile. `None` when no sfizz profile is configured or the scene
/// YAML does not parse (scorekit validate owns that failure).
pub fn check_scene_profile(
    root: &Path,
    scene: &Path,
    render: &RenderConfig,
) -> Option<ProfileCompat> {
    let profile = active_profile(render)?;
    let (profile_name, mapped) = match profile_instruments(root, profile) {
        Ok(loaded) => loaded,
        Err(error) => {
            return Some(ProfileCompat {
                profile: profile.to_owned(),
                profile_name: None,
                mapped: Vec::new(),
                unmapped: Vec::new(),
                error: Some(error),
            });
        }
    };
    let instruments = scene_instruments(scene)?;
    let mut unmapped: Vec<String> = instruments
        .into_iter()
        .filter(|instrument| !mapped.contains(instrument))
        .collect();
    unmapped.sort_unstable();
    unmapped.dedup();
    Some(ProfileCompat {
        profile: profile.to_owned(),
        profile_name,
        mapped,
        unmapped,
        error: None,
    })
}

/// Track instrument names from scene YAML. Tolerant reader: unparseable
/// scenes or tracks without a string instrument yield nothing here because
/// `scorekit validate` is the authority for scene shape errors.
fn scene_instruments(scene: &Path) -> Option<Vec<String>> {
    let raw = std::fs::read_to_string(scene).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&raw).ok()?;
    let tracks = value.get("tracks")?.as_sequence()?;
    Some(
        tracks
            .iter()
            .filter_map(|track| track.get("instrument")?.as_str().map(ToOwned::to_owned))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_profile(root: &Path) {
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/open.yaml"),
            "name: scoredata-open\ninstruments:\n  piano:\n    sustain: piano.sfz\n  strings:\n    sustain: strings.sfz\n",
        )
        .unwrap();
    }

    fn sfizz_render() -> RenderConfig {
        RenderConfig {
            renderer: Some("sfizz".into()),
            profile: Some("profiles/open.yaml".into()),
        }
    }

    #[test]
    fn missing_manifest_loads_default_without_warning() {
        let root = temp_project();
        let (manifest, warning) = load(&root);
        assert!(manifest.render.is_none());
        assert!(warning.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_manifest_degrades_to_default_with_warning() {
        let root = temp_project();
        std::fs::write(root.join(MANIFEST_FILE), "{not json").unwrap();
        let (manifest, warning) = load(&root);
        assert!(manifest.render.is_none());
        assert!(warning.unwrap().contains("not valid JSON"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn render_round_trip_preserves_unknown_fields() {
        let root = temp_project();
        std::fs::write(
            root.join(MANIFEST_FILE),
            r#"{"future_field": {"keep": true}}"#,
        )
        .unwrap();
        save_render(&root, Some(sfizz_render())).unwrap();
        let (manifest, warning) = load(&root);
        assert!(warning.is_none());
        assert_eq!(manifest.render, Some(sfizz_render()));
        assert_eq!(
            manifest.extra.get("future_field"),
            Some(&serde_json::json!({"keep": true}))
        );
        save_render(&root, None).unwrap();
        let (manifest, _) = load(&root);
        assert!(manifest.render.is_none());
        assert!(manifest.extra.contains_key("future_field"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn style_round_trip_preserves_render_and_unknown_fields() {
        let root = temp_project();
        std::fs::write(
            root.join(MANIFEST_FILE),
            r#"{"future_field": {"keep": true}}"#,
        )
        .unwrap();
        save_render(&root, Some(sfizz_render())).unwrap();
        save_style(
            &root,
            Some(StyleRef {
                id: "chinese-campus-folk-90s".into(),
            }),
        )
        .unwrap();
        let (manifest, warning) = load(&root);
        assert!(warning.is_none());
        assert_eq!(manifest.render, Some(sfizz_render()));
        assert_eq!(
            manifest.style,
            Some(StyleRef {
                id: "chinese-campus-folk-90s".into()
            })
        );
        assert!(manifest.extra.contains_key("future_field"));
        save_style(&root, None).unwrap();
        let (manifest, _) = load(&root);
        assert!(manifest.style.is_none());
        assert_eq!(manifest.render, Some(sfizz_render()));
        assert!(manifest.extra.contains_key("future_field"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unmapped_instrument_is_detected() {
        let root = temp_project();
        write_profile(&root);
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - instrument: piano\n  - instrument: choir\n  - instrument: choir\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(!compat.is_compatible());
        assert_eq!(compat.unmapped, vec!["choir"]);
        assert_eq!(compat.profile_name.as_deref(), Some("scoredata-open"));
        assert!(compat.message().contains("`choir`"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fully_mapped_scene_is_compatible() {
        let root = temp_project();
        write_profile(&root);
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - instrument: piano\n  - instrument: strings\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(compat.is_compatible());
        assert_eq!(compat.mapped, vec!["piano", "strings"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_sfizz_or_missing_profile_skips_check() {
        let root = temp_project();
        write_profile(&root);
        std::fs::write(root.join("scene.yaml"), "tracks:\n  - instrument: choir\n").unwrap();
        let scene = root.join("scene.yaml");
        let fluidsynth = RenderConfig {
            renderer: Some("fluidsynth".into()),
            profile: Some("profiles/open.yaml".into()),
        };
        assert!(check_scene_profile(&root, &scene, &fluidsynth).is_none());
        let no_profile = RenderConfig {
            renderer: Some("sfizz".into()),
            profile: None,
        };
        assert!(check_scene_profile(&root, &scene, &no_profile).is_none());
        assert!(check_scene_profile(&root, &scene, &RenderConfig::default()).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_profile_is_reported_not_fatal() {
        let root = temp_project();
        std::fs::write(root.join("scene.yaml"), "tracks:\n  - instrument: piano\n").unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(!compat.is_compatible());
        assert!(compat.error.as_deref().unwrap().contains("cannot read"));
        assert!(compat.message().contains("unusable"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unparseable_scene_defers_to_scorekit_validate() {
        let root = temp_project();
        write_profile(&root);
        std::fs::write(root.join("scene.yaml"), "tracks: [unterminated").unwrap();
        assert!(check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
