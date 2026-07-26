//! `bench.json` project manifest (docs/roadmap.md: plain-file project state)
//! plus the orchestration compatibility check the agent toolchain runs
//! before scorekit's sfizz build would fail.
//!
//! The manifest is written by the GUI render panel and read by the agent
//! core, so the agent composes for the same renderer configuration the user
//! renders with. Reads are tolerant: a missing or corrupt manifest never
//! blocks chat or scene writes.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
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
    /// Structured v0.6 sources declare the scheduling modes they support.
    /// Legacy path-only bindings have no declaration and therefore do not
    /// participate in this local preflight.
    pub mode_mismatches: Vec<TextureModeMismatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextureModeMismatch {
    pub source: String,
    pub requested: String,
    pub available: Vec<String>,
}

impl TextureProfileCompat {
    pub fn is_compatible(&self) -> bool {
        self.profile.is_some()
            && self.missing.is_empty()
            && self.mode_mismatches.is_empty()
            && self.error.is_none()
    }

    pub fn message(&self) -> String {
        let Some(profile) = self.profile.as_deref() else {
            return "scene uses textures but no texture profile is configured; the scorekit build will fail".into();
        };
        let name = self.profile_name.as_deref().unwrap_or(profile);
        if let Some(error) = &self.error {
            return format!("texture profile `{name}` is unusable: {error}");
        }
        let mut problems = Vec::new();
        if !self.missing.is_empty() {
            problems.push(format!(
                "texture profile `{name}` has no mapping for source(s) {}",
                self.missing
                    .iter()
                    .map(|key| format!("`{key}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        for mismatch in &self.mode_mismatches {
            problems.push(format!(
                "source `{}` only declares mode(s) {}; requested `{}`",
                mismatch.source,
                mismatch
                    .available
                    .iter()
                    .map(|mode| format!("`{mode}`"))
                    .collect::<Vec<_>>()
                    .join(", "),
                mismatch.requested
            ));
        }
        if problems.is_empty() {
            format!("all texture sources and playback modes are mapped by texture profile `{name}`")
        } else {
            format!("{}; the scorekit build will fail", problems.join("; "))
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

#[derive(Debug, Clone)]
enum TextureSourceBinding {
    LegacyPath(String),
    Discoverable(TextureSource),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextureSource {
    path: String,
    description: String,
    category: String,
    tags: Vec<String>,
    playback: TexturePlayback,
    use_cases: Vec<String>,
    provenance: TextureProvenance,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TexturePlayback {
    modes: Vec<String>,
    default_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextureProvenance {
    library: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextureProfile {
    #[serde(default = "default_texture_profile_schema_version")]
    schema_version: u16,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    root: Option<String>,
    sources: BTreeMap<String, TextureSourceBinding>,
}

fn default_texture_profile_schema_version() -> u16 {
    1
}

impl<'de> Deserialize<'de> for TextureSourceBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct BindingVisitor;

        impl<'de> Visitor<'de> for BindingVisitor {
            type Value = TextureSourceBinding;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an audio path string or a structured texture source")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(TextureSourceBinding::LegacyPath(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(TextureSourceBinding::LegacyPath(value))
            }

            fn visit_map<M>(self, map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                TextureSource::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(TextureSourceBinding::Discoverable)
            }
        }

        deserializer.deserialize_any(BindingVisitor)
    }
}

impl TextureSourceBinding {
    fn declared_modes(&self) -> Option<&[String]> {
        match self {
            Self::LegacyPath(_) => None,
            Self::Discoverable(source) => Some(source.playback.modes.as_slice()),
        }
    }

    fn validate(&self, field: &str) -> Result<(), String> {
        match self {
            Self::LegacyPath(path) if path.trim().is_empty() => {
                Err(format!("{field} audio path must not be empty"))
            }
            Self::LegacyPath(_) => Ok(()),
            Self::Discoverable(source) => source.validate(field),
        }
    }
}

impl TextureSource {
    fn validate(&self, field: &str) -> Result<(), String> {
        if self.path.trim().is_empty() {
            return Err(format!("{field}.path must not be empty"));
        }
        if self.description.trim().is_empty() {
            return Err(format!("{field}.description must not be empty"));
        }
        if !matches!(
            self.category.as_str(),
            "ambience"
                | "foley"
                | "impact"
                | "transition"
                | "tonal"
                | "industrial"
                | "organic"
                | "sound_design"
        ) {
            return Err(format!(
                "{field}.category `{}` is not a ScoreKit category",
                self.category
            ));
        }
        validate_texture_tokens(&format!("{field}.tags"), &self.tags)?;
        validate_texture_tokens(&format!("{field}.use_cases"), &self.use_cases)?;
        if !valid_texture_library_identity(&self.provenance.library) {
            return Err(format!(
                "{field}.provenance.library `{}` must match <library>@<version>",
                self.provenance.library
            ));
        }
        if self.playback.modes.is_empty() {
            return Err(format!("{field}.playback.modes must not be empty"));
        }
        let mut modes = BTreeSet::new();
        for mode in &self.playback.modes {
            if !matches!(mode.as_str(), "loop" | "one_shot") {
                return Err(format!(
                    "{field}.playback.modes contains unsupported mode `{mode}`"
                ));
            }
            if !modes.insert(mode) {
                return Err(format!(
                    "{field}.playback.modes contains duplicate mode `{mode}`"
                ));
            }
        }
        if !self.playback.modes.contains(&self.playback.default_mode) {
            return Err(format!(
                "{field}.playback.default_mode `{}` is not listed in modes",
                self.playback.default_mode
            ));
        }
        Ok(())
    }
}

impl TextureProfile {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "schema_version {} is unsupported; expected 1",
                self.schema_version
            ));
        }
        if self.name.trim().is_empty() {
            return Err("name must not be empty".into());
        }
        if self.sources.is_empty() {
            return Err("sources must not be empty".into());
        }
        // These fields are optional and intentionally unconstrained by
        // ScoreKit v0.6; reading them keeps this mirror explicit.
        let _ = (&self.description, &self.root);
        for (name, source) in &self.sources {
            if !valid_texture_token(name, 64) {
                return Err(format!("sources.{name} must match [a-z][a-z0-9_-]{{0,63}}"));
            }
            source.validate(&format!("sources.{name}"))?;
        }
        Ok(())
    }
}

fn valid_texture_token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'_' | b'-')))
        })
}

fn validate_texture_tokens(field: &str, values: &[String]) -> Result<(), String> {
    if values.is_empty() {
        return Err(format!("{field} must list at least one entry"));
    }
    if values.len() > 16 {
        return Err(format!("{field} exceeds the maximum of 16 entries"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        if !valid_texture_token(value, 32) {
            return Err(format!(
                "{field} entry `{value}` must match [a-z][a-z0-9_-]{{0,31}}"
            ));
        }
        if !unique.insert(value) {
            return Err(format!("{field} contains duplicate entry `{value}`"));
        }
    }
    Ok(())
}

fn valid_texture_library_identity(identity: &str) -> bool {
    let Some((library, version)) = identity.split_once('@') else {
        return false;
    };
    !library.is_empty()
        && !version.is_empty()
        && !version.contains('@')
        && library.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-' | b'/'))
        })
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn load_texture_profile(root: &Path, profile: &str) -> Result<TextureProfile, String> {
    let path = resolve_config_path(root, profile);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let wire: TextureProfile = serde_yaml::from_str(&raw)
        .map_err(|error| format!("`{}` is not a texture profile: {error}", path.display()))?;
    wire.validate().map_err(|error| {
        format!(
            "`{}` is not a valid texture profile: {error}",
            path.display()
        )
    })?;
    Ok(wire)
}

/// Load the portable source keys a scorekit texture profile exposes. Both the
/// v0.5 path-only form and v0.6 discoverable object form remain readable.
pub fn texture_profile_sources(
    root: &Path,
    profile: &str,
) -> Result<(Option<String>, Vec<String>), String> {
    let wire = load_texture_profile(root, profile)?;
    Ok((Some(wire.name), wire.sources.into_keys().collect()))
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
    let used = scene_texture_uses(scene)?;
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
            missing: used.into_iter().map(|texture| texture.source).collect(),
            mode_mismatches: Vec::new(),
            error: None,
        });
    };
    let loaded = match load_texture_profile(root, profile) {
        Ok(loaded) => loaded,
        Err(error) => {
            return Some(TextureProfileCompat {
                profile: Some(profile.to_owned()),
                profile_name: None,
                available: Vec::new(),
                missing: Vec::new(),
                mode_mismatches: Vec::new(),
                error: Some(error),
            });
        }
    };
    let profile_name = loaded.name;
    let available = loaded.sources.keys().cloned().collect::<Vec<_>>();
    let mut missing = used
        .iter()
        .filter(|texture| !loaded.sources.contains_key(&texture.source))
        .map(|texture| texture.source.clone())
        .collect::<Vec<_>>();
    missing.sort_unstable();
    missing.dedup();
    let mode_mismatches = used
        .into_iter()
        .filter_map(|texture| {
            let requested = texture.mode?;
            let available = loaded.sources.get(&texture.source)?.declared_modes()?;
            (!available.iter().any(|mode| mode == &requested)).then(|| TextureModeMismatch {
                source: texture.source,
                requested,
                available: available.to_vec(),
            })
        })
        .collect();
    Some(TextureProfileCompat {
        profile: Some(profile.to_owned()),
        profile_name: Some(profile_name),
        available,
        missing,
        mode_mismatches,
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

struct SceneTextureUse {
    source: String,
    mode: Option<String>,
}

fn scene_texture_uses(scene: &Path) -> Option<Vec<SceneTextureUse>> {
    let raw = std::fs::read_to_string(scene).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&raw).ok()?;
    let Some(textures) = value.get("textures") else {
        return Some(Vec::new());
    };
    let textures = textures.as_sequence()?;
    Some(
        textures
            .iter()
            .filter_map(|texture| {
                let source = texture.get("source")?.as_str()?.to_owned();
                let mode = texture
                    .get("mode")
                    .and_then(serde_yaml::Value::as_str)
                    .map(ToOwned::to_owned);
                Some(SceneTextureUse { source, mode })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    /// The wall clock is too coarse to separate two roots created in the same
    /// instant, so parallel tests would share a directory and delete each
    /// other's files; the counter makes each root unique by construction.
    fn temp_project() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-manifest-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
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

    /// The sound library scorekit documents lives outside the project, with
    /// `profiles/orchestrations/<name>.yaml` binding palettes to sibling
    /// `../renderers/<name>.yaml` files. Leaf paths must therefore resolve
    /// against the orchestration file's own directory — resolving them against
    /// the project root would report every palette as unusable.
    #[test]
    fn leaf_profiles_resolve_against_the_orchestration_directory() {
        let root = temp_project();
        let library = root.join("library");
        std::fs::create_dir_all(library.join("profiles/orchestrations")).unwrap();
        std::fs::create_dir_all(library.join("profiles/renderers")).unwrap();
        std::fs::write(
            library.join("profiles/renderers/scoredata-chamber.yaml"),
            "name: scoredata-chamber\ninstruments:\n  cello:\n    sustain: cello.sfz\n",
        )
        .unwrap();
        std::fs::write(
            library.join("profiles/orchestrations/hybrid-cinematic.yaml"),
            "schema_version: 1\nname: hybrid-cinematic\ndefault_palette: solo\npalettes:\n  solo: { profile: ../renderers/scoredata-chamber.yaml }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("scene.yaml"),
            "tracks:\n  - { id: solo_line, instrument: cello }\n",
        )
        .unwrap();
        let render = RenderConfig {
            renderer: Some("sfizz".into()),
            // Absolute, the way the GUI file picker stores an out-of-project library.
            orchestration: Some(
                library
                    .join("profiles/orchestrations/hybrid-cinematic.yaml")
                    .to_string_lossy()
                    .into_owned(),
            ),
            texture_profile: None,
        };
        let compat = check_scene_profile(&root, &root.join("scene.yaml"), &render).unwrap();
        assert!(compat.is_compatible(), "{}", compat.message());
        let track = &compat.tracks[0];
        assert_eq!(track.palette, "solo");
        assert_eq!(track.profile_name.as_deref(), Some("scoredata-chamber"));
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
    fn scorekit_06_structured_texture_sources_are_loaded_and_modes_are_enforced() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/forest-textures.yaml"),
            "schema_version: 1\nname: forest\nsources:\n  birds:\n    path: audio/birds.wav\n    description: A short flock call\n    category: organic\n    tags: [wildlife, chirping]\n    playback:\n      modes: [one_shot]\n      default_mode: one_shot\n    use_cases: [forest]\n    provenance:\n      library: field-recordings@1.0.0\n",
        )
        .unwrap();
        let (_, sources) = texture_profile_sources(&root, "profiles/forest-textures.yaml").unwrap();
        assert_eq!(sources, vec!["birds"]);

        std::fs::write(
            root.join("scene.yaml"),
            "textures:\n  - { source: birds, mode: loop }\n",
        )
        .unwrap();
        let compat =
            check_scene_texture_profile(&root, &root.join("scene.yaml"), &textured_render())
                .unwrap();
        assert!(!compat.is_compatible());
        let serialized = serde_json::to_value(&compat).unwrap();
        assert_eq!(
            serialized["mode_mismatches"][0]["source"],
            serde_json::json!("birds")
        );
        assert_eq!(
            serialized["mode_mismatches"][0]["requested"],
            serde_json::json!("loop")
        );
        assert_eq!(
            serialized["mode_mismatches"][0]["available"],
            serde_json::json!(["one_shot"])
        );
        assert!(compat.message().contains("one_shot"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_scorekit_06_texture_metadata_blocks_compatibility() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/forest-textures.yaml"),
            "schema_version: 1\nname: forest\nsources:\n  birds:\n    path: audio/birds.wav\n    description: A short flock call\n    category: organic\n    tags: [wildlife]\n    use_cases: [forest]\n    provenance:\n      library: field-recordings@1.0.0\n",
        )
        .unwrap();
        std::fs::write(
            root.join("scene.yaml"),
            "textures:\n  - { source: birds, mode: loop }\n",
        )
        .unwrap();

        let error = texture_profile_sources(&root, "profiles/forest-textures.yaml").unwrap_err();
        assert!(error.contains("playback"), "{error}");
        let compat =
            check_scene_texture_profile(&root, &root.join("scene.yaml"), &textured_render())
                .unwrap();
        assert!(!compat.is_compatible());
        assert!(
            compat
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("playback"),
            "{}",
            compat.message()
        );
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
