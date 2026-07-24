//! `bench.json` project manifest (docs/roadmap.md: plain-file project state)
//! plus the orchestration compatibility check the agent toolchain runs
//! before scorekit's sfizz build would fail.
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
    /// Orchestration profile path: project-relative when inside the
    /// project, absolute otherwise (mirrors the GUI build parameter).
    /// Routes scene track palettes to leaf renderer profiles; only
    /// meaningful for `--renderer sfizz` (see `scorekit schema
    /// --orchestration`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration: Option<String>,
    /// Texture profile path, independent of the synthesizer backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_profile: Option<String>,
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

/// One scene track's routing outcome under the active orchestration: which
/// palette it resolved to (declared `palette` or the orchestration's
/// `default_palette`), the leaf renderer profile that palette binds to, and
/// any problem that would make the sfizz build fail for this track.
#[derive(Debug, Clone, Serialize)]
pub struct TrackOrchestrationCompat {
    pub track_id: String,
    /// Palette this track resolved to (declared, or the orchestration default).
    pub palette: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instrument: Option<String>,
    /// Leaf renderer profile path the palette binds to, once resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    /// Missing palette, unreadable leaf profile, or unmapped instrument —
    /// whichever applies. `None` means this track's routing is sound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of checking a scene's tracks against the active multi-profile
/// orchestration: per-track palette resolution, leaf profile mapping, and
/// instrument coverage. Replaces the single-profile `ProfileCompat` model
/// now that scenes route tracks through logical palettes.
#[derive(Debug, Clone, Serialize)]
pub struct OrchestrationCompat {
    /// Orchestration path as stored in the manifest.
    pub orchestration: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestration_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_palette: Option<String>,
    pub tracks: Vec<TrackOrchestrationCompat>,
    /// The orchestration file itself could not be read or parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OrchestrationCompat {
    pub fn is_compatible(&self) -> bool {
        self.error.is_none() && self.tracks.iter().all(|track| track.error.is_none())
    }

    /// One-line report for tool summaries and prompts.
    pub fn message(&self) -> String {
        let name = self
            .orchestration_name
            .as_deref()
            .unwrap_or(&self.orchestration);
        if let Some(error) = &self.error {
            return format!("orchestration `{name}` is unusable: {error}");
        }
        let problems: Vec<String> = self
            .tracks
            .iter()
            .filter_map(|track| {
                track
                    .error
                    .as_ref()
                    .map(|error| format!("track `{}`: {error}", track.track_id))
            })
            .collect();
        if problems.is_empty() {
            format!("all track instruments are mapped by orchestration `{name}`")
        } else {
            format!(
                "orchestration `{name}` has unresolved track(s), the sfizz build will fail: {}",
                problems.join("; ")
            )
        }
    }
}

/// Result of checking a scene's texture source keys against the active texture
/// profile. A scene with no textures produces no compatibility result.
#[derive(Debug, Clone, Serialize)]
pub struct TextureProfileCompat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    /// Portable source keys offered by the profile.
    pub available: Vec<String>,
    /// Source keys used by the scene but absent from the profile.
    pub missing: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TextureProfileCompat {
    pub fn is_compatible(&self) -> bool {
        self.profile.is_some() && self.missing.is_empty() && self.error.is_none()
    }

    pub fn message(&self) -> String {
        let Some(profile) = self.profile.as_deref() else {
            return "scene uses textures but no texture profile is configured; the scorekit build will fail".into();
        };
        let name = self.profile_name.as_deref().unwrap_or(profile);
        if let Some(error) = &self.error {
            return format!("texture profile `{name}` is unusable: {error}");
        }
        if self.missing.is_empty() {
            format!("all texture sources are mapped by texture profile `{name}`")
        } else {
            format!(
                "texture profile `{name}` has no mapping for source(s) {}; the scorekit build will fail",
                self.missing
                    .iter()
                    .map(|key| format!("`{key}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    }
}

/// Orchestration only matters for the sfizz backend (SF2 renderers take a
/// soundfont instead), matching scorekit's `--orchestration` contract.
fn active_orchestration(render: &RenderConfig) -> Option<&str> {
    match (render.renderer.as_deref(), render.orchestration.as_deref()) {
        (Some("sfizz"), Some(orchestration)) if !orchestration.trim().is_empty() => {
            Some(orchestration)
        }
        _ => None,
    }
}

/// Resolve a manifest-stored path (orchestration, texture profile, ...)
/// against the project root: project-relative when relative, used as-is
/// when absolute (mirrors the GUI's file picker output).
pub fn resolve_config_path(root: &Path, path: &str) -> PathBuf {
    resolve_relative(root, path)
}

fn resolve_relative(base: &Path, path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base.join(candidate)
    }
}

/// Load the instrument keys one leaf renderer profile maps. This reads the
/// same YAML scorekit loads and compares keys only — no musical semantics.
fn load_profile_instruments(path: &Path) -> Result<(Option<String>, Vec<String>), String> {
    #[derive(Deserialize)]
    struct ProfileWire {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        instruments: BTreeMap<String, Value>,
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let wire: ProfileWire = serde_yaml::from_str(&raw)
        .map_err(|error| format!("`{}` is not a renderer profile: {error}", path.display()))?;
    Ok((wire.name, wire.instruments.into_keys().collect()))
}

/// One palette as declared by an orchestration, with its leaf renderer
/// profile resolved (or the error that made it unusable).
#[derive(Debug, Clone)]
pub struct PaletteInfo {
    pub name: String,
    /// Leaf profile path exactly as declared in the orchestration.
    pub declared_profile: String,
    pub profile_name: Option<String>,
    pub instruments: Vec<String>,
    pub error: Option<String>,
}

/// An orchestration profile loaded for compatibility checking and prompt
/// injection: its declared name, default palette, and every palette's
/// resolved leaf renderer profile.
#[derive(Debug, Clone)]
pub struct OrchestrationInfo {
    pub name: Option<String>,
    pub default_palette: Option<String>,
    palettes: BTreeMap<String, PaletteInfo>,
}

/// Load an orchestration profile and every palette's leaf renderer profile.
/// Leaf `profile` paths are resolved relative to the orchestration file's
/// own directory (scorekit's contract), never the project root.
pub fn load_orchestration(root: &Path, orchestration: &str) -> Result<OrchestrationInfo, String> {
    #[derive(Deserialize)]
    struct PaletteWire {
        profile: String,
    }
    #[derive(Deserialize)]
    struct OrchestrationWire {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        default_palette: Option<String>,
        #[serde(default)]
        palettes: BTreeMap<String, PaletteWire>,
    }
    let path = resolve_config_path(root, orchestration);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let wire: OrchestrationWire = serde_yaml::from_str(&raw).map_err(|error| {
        format!(
            "`{}` is not an orchestration profile: {error}",
            path.display()
        )
    })?;
    let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let palettes = wire
        .palettes
        .into_iter()
        .map(|(name, binding)| {
            let leaf_path = resolve_relative(base_dir, &binding.profile);
            let (profile_name, instruments, error) = match load_profile_instruments(&leaf_path) {
                Ok((profile_name, instruments)) => (profile_name, instruments, None),
                Err(error) => (None, Vec::new(), Some(error)),
            };
            (
                name.clone(),
                PaletteInfo {
                    name,
                    declared_profile: binding.profile,
                    profile_name,
                    instruments,
                    error,
                },
            )
        })
        .collect();
    Ok(OrchestrationInfo {
        name: wire.name,
        default_palette: wire.default_palette,
        palettes,
    })
}

impl OrchestrationInfo {
    /// Palettes in name order, for prompt injection.
    pub fn palettes(&self) -> impl Iterator<Item = &PaletteInfo> {
        self.palettes.values()
    }
}

/// Load the portable source keys a scorekit texture profile exposes.
pub fn texture_profile_sources(
    root: &Path,
    profile: &str,
) -> Result<(Option<String>, Vec<String>), String> {
    #[derive(Deserialize)]
    struct ProfileWire {
        #[serde(default)]
        name: Option<String>,
        sources: BTreeMap<String, String>,
    }
    let path = resolve_config_path(root, profile);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let wire: ProfileWire = serde_yaml::from_str(&raw)
        .map_err(|error| format!("`{}` is not a texture profile: {error}", path.display()))?;
    Ok((wire.name, wire.sources.into_keys().collect()))
}

/// Cross-check a scene's tracks against the manifest's active orchestration:
/// each track's declared or default palette must exist, that palette's leaf
/// renderer profile must be readable, and the track's instrument must be
/// mapped by it. `None` when no sfizz orchestration is configured or the
/// scene YAML does not parse (scorekit validate owns that failure).
pub fn check_scene_profile(
    root: &Path,
    scene: &Path,
    render: &RenderConfig,
) -> Option<OrchestrationCompat> {
    let orchestration = active_orchestration(render)?;
    let info = match load_orchestration(root, orchestration) {
        Ok(info) => info,
        Err(error) => {
            return Some(OrchestrationCompat {
                orchestration: orchestration.to_owned(),
                orchestration_name: None,
                default_palette: None,
                tracks: Vec::new(),
                error: Some(error),
            });
        }
    };
    let scene_tracks = scene_tracks(scene)?;
    let orchestration_label = info.name.as_deref().unwrap_or(orchestration).to_owned();
    let tracks = scene_tracks
        .into_iter()
        .map(|track| {
            let palette_name = track
                .palette
                .or_else(|| info.default_palette.clone())
                .unwrap_or_default();
            let Some(palette) = info.palettes.get(&palette_name) else {
                return TrackOrchestrationCompat {
                    track_id: track.id,
                    palette: palette_name.clone(),
                    instrument: track.instrument,
                    profile: None,
                    profile_name: None,
                    error: Some(format!(
                        "orchestration `{orchestration_label}` has no palette `{palette_name}` (defined: {:?})",
                        info.palettes.keys().collect::<Vec<_>>()
                    )),
                };
            };
            let error = if let Some(profile_error) = &palette.error {
                Some(format!(
                    "renderer profile `{}` is unusable: {profile_error}",
                    palette.declared_profile
                ))
            } else {
                track.instrument.as_ref().and_then(|instrument| {
                    if palette.instruments.contains(instrument) {
                        None
                    } else {
                        let name = palette.profile_name.as_deref().unwrap_or(&palette.declared_profile);
                        Some(format!(
                            "renderer profile `{name}` has no mapping for instrument `{instrument}`"
                        ))
                    }
                })
            };
            TrackOrchestrationCompat {
                track_id: track.id,
                palette: palette_name,
                instrument: track.instrument,
                profile: Some(palette.declared_profile.clone()),
                profile_name: palette.profile_name.clone(),
                error,
            }
        })
        .collect();
    Some(OrchestrationCompat {
        orchestration: orchestration.to_owned(),
        orchestration_name: info.name,
        default_palette: info.default_palette,
        tracks,
        error: None,
    })
}

/// Cross-check a scene's portable texture source keys against the profile that
/// scorekit will receive through `--texture-profile`.
pub fn check_scene_texture_profile(
    root: &Path,
    scene: &Path,
    render: &RenderConfig,
) -> Option<TextureProfileCompat> {
    let used = scene_texture_sources(scene)?;
    if used.is_empty() {
        return None;
    }
    let Some(profile) = render
        .texture_profile
        .as_deref()
        .filter(|profile| !profile.trim().is_empty())
    else {
        return Some(TextureProfileCompat {
            profile: None,
            profile_name: None,
            available: Vec::new(),
            missing: used,
            error: None,
        });
    };
    let (profile_name, available) = match texture_profile_sources(root, profile) {
        Ok(loaded) => loaded,
        Err(error) => {
            return Some(TextureProfileCompat {
                profile: Some(profile.to_owned()),
                profile_name: None,
                available: Vec::new(),
                missing: Vec::new(),
                error: Some(error),
            });
        }
    };
    let mut missing = used
        .into_iter()
        .filter(|source| !available.contains(source))
        .collect::<Vec<_>>();
    missing.sort_unstable();
    missing.dedup();
    Some(TextureProfileCompat {
        profile: Some(profile.to_owned()),
        profile_name,
        available,
        missing,
        error: None,
    })
}

/// One scene track's stable-ID identity as read from YAML for compatibility
/// checking. Tolerant reader: tracks without a string `id` are skipped
/// because `scorekit validate` is the authority for scene shape errors.
struct SceneTrack {
    id: String,
    instrument: Option<String>,
    palette: Option<String>,
}

fn scene_tracks(scene: &Path) -> Option<Vec<SceneTrack>> {
    let raw = std::fs::read_to_string(scene).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&raw).ok()?;
    let tracks = value.get("tracks")?.as_sequence()?;
    Some(
        tracks
            .iter()
            .filter_map(|track| {
                let id = track.get("id")?.as_str()?.to_owned();
                let instrument = track
                    .get("instrument")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned);
                let palette = track
                    .get("palette")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned);
                Some(SceneTrack {
                    id,
                    instrument,
                    palette,
                })
            })
            .collect(),
    )
}

fn scene_texture_sources(scene: &Path) -> Option<Vec<String>> {
    let raw = std::fs::read_to_string(scene).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&raw).ok()?;
    let Some(textures) = value.get("textures") else {
        return Some(Vec::new());
    };
    let textures = textures.as_sequence()?;
    Some(
        textures
            .iter()
            .filter_map(|texture| texture.get("source")?.as_str().map(ToOwned::to_owned))
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

    fn write_leaf_profile(root: &Path) {
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/open.yaml"),
            "name: scoredata-open\ninstruments:\n  piano:\n    sustain: piano.sfz\n  strings:\n    sustain: strings.sfz\n",
        )
        .unwrap();
    }

    fn write_orchestration(root: &Path) {
        write_leaf_profile(root);
        std::fs::write(
            root.join("hybrid.yaml"),
            "schema_version: 1\nname: hybrid-cinematic\ndefault_palette: default\npalettes:\n  default: { profile: profiles/open.yaml }\n",
        )
        .unwrap();
    }

    fn write_texture_profile(root: &Path) {
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/forest-textures.yaml"),
            "name: forest\nsources:\n  birds: audio/birds.wav\n  river: audio/river.flac\n",
        )
        .unwrap();
    }

    fn sfizz_render() -> RenderConfig {
        RenderConfig {
            renderer: Some("sfizz".into()),
            orchestration: Some("hybrid.yaml".into()),
            texture_profile: Some("profiles/forest-textures.yaml".into()),
        }
    }

    fn textured_render() -> RenderConfig {
        RenderConfig {
            renderer: Some("fluidsynth".into()),
            orchestration: None,
            texture_profile: Some("profiles/forest-textures.yaml".into()),
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
                id: "epic-new-age-instrumental".into(),
            }),
        )
        .unwrap();
        let (manifest, warning) = load(&root);
        assert!(warning.is_none());
        assert_eq!(manifest.render, Some(sfizz_render()));
        assert_eq!(
            manifest.style,
            Some(StyleRef {
                id: "epic-new-age-instrumental".into()
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
        write_orchestration(&root);
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: lead, instrument: piano }\n  - { id: pad, instrument: choir }\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(!compat.is_compatible());
        let pad = compat.tracks.iter().find(|t| t.track_id == "pad").unwrap();
        assert!(pad.error.as_deref().unwrap().contains("`choir`"));
        assert_eq!(pad.profile_name.as_deref(), Some("scoredata-open"));
        let lead = compat.tracks.iter().find(|t| t.track_id == "lead").unwrap();
        assert!(lead.error.is_none());
        assert!(compat.message().contains("`pad`"));
        assert!(compat.message().contains("`choir`"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fully_mapped_scene_is_compatible() {
        let root = temp_project();
        write_orchestration(&root);
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: lead, instrument: piano }\n  - { id: harmony, instrument: strings }\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(compat.is_compatible());
        assert_eq!(compat.tracks.len(), 2);
        assert!(compat
            .tracks
            .iter()
            .all(|t| t.palette == "default" && t.error.is_none()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn track_palette_overrides_default_and_missing_palette_is_reported() {
        let root = temp_project();
        write_leaf_profile(&root);
        std::fs::write(
            root.join("hybrid.yaml"),
            "schema_version: 1\nname: hybrid-cinematic\ndefault_palette: default\npalettes:\n  default: { profile: profiles/open.yaml }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: lead, instrument: piano }\n  - { id: solo, instrument: piano, palette: solo }\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(!compat.is_compatible());
        let solo = compat.tracks.iter().find(|t| t.track_id == "solo").unwrap();
        assert_eq!(solo.palette, "solo");
        assert!(solo.error.as_deref().unwrap().contains("no palette `solo`"));
        let lead = compat.tracks.iter().find(|t| t.track_id == "lead").unwrap();
        assert_eq!(lead.palette, "default");
        assert!(lead.error.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_sfizz_or_missing_orchestration_skips_check() {
        let root = temp_project();
        write_orchestration(&root);
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: pad, instrument: choir }\n",
        )
        .unwrap();
        let scene = root.join("scene.yaml");
        let fluidsynth = RenderConfig {
            renderer: Some("fluidsynth".into()),
            orchestration: Some("hybrid.yaml".into()),
            texture_profile: None,
        };
        assert!(check_scene_profile(&root, &scene, &fluidsynth).is_none());
        let no_orchestration = RenderConfig {
            renderer: Some("sfizz".into()),
            orchestration: None,
            texture_profile: None,
        };
        assert!(check_scene_profile(&root, &scene, &no_orchestration).is_none());
        assert!(check_scene_profile(&root, &scene, &RenderConfig::default()).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_orchestration_is_reported_not_fatal() {
        let root = temp_project();
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: lead, instrument: piano }\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(!compat.is_compatible());
        assert!(compat.error.as_deref().unwrap().contains("cannot read"));
        assert!(compat.message().contains("unusable"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_leaf_profile_is_reported_per_track() {
        let root = temp_project();
        std::fs::write(
            root.join("hybrid.yaml"),
            "schema_version: 1\nname: hybrid-cinematic\ndefault_palette: default\npalettes:\n  default: { profile: profiles/missing.yaml }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: lead, instrument: piano }\n",
        )
        .unwrap();
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).unwrap();
        assert!(compat.error.is_none(), "orchestration itself is readable");
        assert!(!compat.is_compatible());
        let lead = compat.tracks.iter().find(|t| t.track_id == "lead").unwrap();
        assert!(lead.error.as_deref().unwrap().contains("is unusable"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unparseable_scene_defers_to_scorekit_validate() {
        let root = temp_project();
        write_orchestration(&root);
        std::fs::write(root.join("scene.yaml"), "tracks: [unterminated").unwrap();
        assert!(check_scene_profile(&root, &root.join("scene.yaml"), &sfizz_render()).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn texture_sources_are_checked_against_independent_profile() {
        let root = temp_project();
        write_texture_profile(&root);
        std::fs::write(
            root.join("scene.yaml"),
            "textures:\n  - { source: river, mode: loop }\n  - { source: wind, mode: one_shot, at: [4] }\n",
        )
        .unwrap();
        let compat =
            check_scene_texture_profile(&root, &root.join("scene.yaml"), &textured_render())
                .unwrap();
        assert!(!compat.is_compatible());
        assert_eq!(compat.available, vec!["birds", "river"]);
        assert_eq!(compat.missing, vec!["wind"]);
        assert_eq!(compat.profile_name.as_deref(), Some("forest"));
        assert!(compat.message().contains("`wind`"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn textured_scene_requires_profile_but_plain_scene_does_not() {
        let root = temp_project();
        let scene = root.join("scene.yaml");
        std::fs::write(&scene, "textures:\n  - { source: river, mode: loop }\n").unwrap();
        let compat = check_scene_texture_profile(&root, &scene, &RenderConfig::default()).unwrap();
        assert!(!compat.is_compatible());
        assert!(compat.profile.is_none());
        assert!(compat.message().contains("no texture profile"));

        std::fs::write(&scene, "tracks: []\n").unwrap();
        assert!(check_scene_texture_profile(&root, &scene, &RenderConfig::default()).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
