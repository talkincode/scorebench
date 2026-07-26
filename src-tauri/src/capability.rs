//! Pure, offline capability evaluation for arrangement intent cases.
//!
//! A case names one `before` scene, one or more candidate `after` scenes, and
//! the musical directions that every candidate should satisfy. Evaluation only
//! reads YAML and computes structural metrics; it never invokes a model,
//! `scorekit`, or an audio renderer.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const FLOAT_EPSILON: f64 = 1.0e-9;

/// A complete capability-case evaluation.
#[derive(Debug, Serialize)]
pub struct CapabilityReport {
    pub schema_version: u32,
    pub case_id: String,
    pub intent: String,
    pub sample_count: usize,
    pub passed_samples: usize,
    pub pass_rate: f64,
    pub samples: Vec<SampleResult>,
}

impl CapabilityReport {
    /// Return whether the report satisfies a pass-rate threshold in `[0, 1]`.
    pub fn meets_threshold(&self, minimum_pass_rate: f64) -> bool {
        minimum_pass_rate.is_finite()
            && (0.0..=1.0).contains(&minimum_pass_rate)
            && self.pass_rate + FLOAT_EPSILON >= minimum_pass_rate
    }
}

/// Evaluation details for one candidate scene.
#[derive(Debug, Serialize)]
pub struct SampleResult {
    pub id: String,
    pub path: String,
    pub passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub assertions: Vec<AssertionResult>,
}

/// One measurable expectation evaluated against a candidate scene.
#[derive(Debug, Serialize)]
pub struct AssertionResult {
    pub name: String,
    pub expectation: String,
    pub passed: bool,
    pub before: JsonValue,
    pub after: JsonValue,
}

/// An input, schema, or baseline error that prevents case evaluation.
#[derive(Debug)]
pub struct CapabilityError {
    message: String,
}

impl CapabilityError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for CapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CapabilityError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CapabilityCase {
    schema_version: u32,
    id: String,
    intent: String,
    before: PathBuf,
    after_samples: Vec<AfterSample>,
    assertions: Assertions,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AfterSample {
    id: String,
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Assertions {
    tempo: Direction,
    track_count: Direction,
    melody_rest_ratio: Direction,
    mode: ModeExpectation,
    r#loop: Preservation,
    motif_contour: Preservation,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Direction {
    Increase,
    Decrease,
    Preserve,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Increase => "increase",
            Self::Decrease => "decrease",
            Self::Preserve => "preserve",
        }
    }

    fn compare_f64(self, before: f64, after: f64) -> bool {
        match self {
            Self::Increase => after > before + FLOAT_EPSILON,
            Self::Decrease => after < before - FLOAT_EPSILON,
            Self::Preserve => (after - before).abs() <= FLOAT_EPSILON,
        }
    }

    fn compare_usize(self, before: usize, after: usize) -> bool {
        match self {
            Self::Increase => after > before,
            Self::Decrease => after < before,
            Self::Preserve => after == before,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModeExpectation {
    ToMinor,
    ToMajor,
    Preserve,
}

impl ModeExpectation {
    fn as_str(self) -> &'static str {
        match self {
            Self::ToMinor => "to_minor",
            Self::ToMajor => "to_major",
            Self::Preserve => "preserve",
        }
    }

    fn compare(self, before: Mode, after: Mode) -> bool {
        match self {
            Self::ToMinor => after == Mode::Minor,
            Self::ToMajor => after == Mode::Major,
            Self::Preserve => after == before,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Preservation {
    Preserve,
}

impl Preservation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preserve => "preserve",
        }
    }
}

#[derive(Debug, Deserialize)]
struct Scene {
    tempo: f64,
    key: String,
    #[serde(rename = "loop")]
    loop_enabled: bool,
    motifs: BTreeMap<String, Vec<MotifNote>>,
    tracks: Vec<Track>,
}

#[derive(Debug, Deserialize)]
struct MotifNote {
    degree: i64,
    beats: f64,
}

#[derive(Debug, Deserialize)]
struct Track {
    pattern: String,
    motif: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Major,
    Minor,
}

#[derive(Debug)]
struct SceneMetrics {
    tempo: f64,
    track_count: usize,
    melody_rest_ratio: f64,
    mode: Mode,
    loop_enabled: bool,
    motif_contours: BTreeMap<String, Vec<i8>>,
}

/// Evaluate a YAML capability case and every candidate it references.
///
/// Paths in the case are resolved relative to the case file. A malformed
/// candidate is counted as a failed sample and is represented with an `error`
/// field so one bad generation does not discard the rest of the run.
pub fn evaluate_case_file(path: &Path) -> Result<CapabilityReport, CapabilityError> {
    let case: CapabilityCase = read_yaml(path, "capability case")?;
    validate_case(&case)?;

    let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let before_path = resolve_path(base_dir, &case.before);
    let before = read_scene_metrics(&before_path).map_err(|error| {
        CapabilityError::new(format!(
            "cannot evaluate baseline '{}': {error}",
            before_path.display()
        ))
    })?;

    if !before
        .motif_contours
        .values()
        .any(|contour| !contour.is_empty())
    {
        return Err(CapabilityError::new(format!(
            "baseline '{}' has no motif with at least two pitched notes",
            before_path.display()
        )));
    }

    let samples = case
        .after_samples
        .iter()
        .map(|sample| evaluate_sample(base_dir, sample, &before, &case.assertions))
        .collect::<Vec<_>>();
    let sample_count = samples.len();
    let passed_samples = samples.iter().filter(|sample| sample.passed).count();
    let pass_rate = passed_samples as f64 / sample_count as f64;

    Ok(CapabilityReport {
        schema_version: case.schema_version,
        case_id: case.id,
        intent: case.intent,
        sample_count,
        passed_samples,
        pass_rate,
        samples,
    })
}

fn validate_case(case: &CapabilityCase) -> Result<(), CapabilityError> {
    if case.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(CapabilityError::new(format!(
            "unsupported capability case schema_version {}; expected {}",
            case.schema_version, SUPPORTED_SCHEMA_VERSION
        )));
    }
    if case.id.trim().is_empty() {
        return Err(CapabilityError::new("capability case id must not be empty"));
    }
    if case.intent.trim().is_empty() {
        return Err(CapabilityError::new(
            "capability case intent must not be empty",
        ));
    }
    if case.after_samples.is_empty() {
        return Err(CapabilityError::new(
            "capability case must contain at least one after sample",
        ));
    }

    let mut ids = BTreeSet::new();
    for sample in &case.after_samples {
        if sample.id.trim().is_empty() {
            return Err(CapabilityError::new("after sample id must not be empty"));
        }
        if !ids.insert(sample.id.as_str()) {
            return Err(CapabilityError::new(format!(
                "duplicate after sample id '{}'",
                sample.id
            )));
        }
    }
    Ok(())
}

fn evaluate_sample(
    base_dir: &Path,
    sample: &AfterSample,
    before: &SceneMetrics,
    expected: &Assertions,
) -> SampleResult {
    let path = resolve_path(base_dir, &sample.path);
    let path_text = sample.path.to_string_lossy().into_owned();

    match read_scene_metrics(&path) {
        Ok(after) => {
            let assertions = evaluate_assertions(before, &after, expected);
            let passed = assertions.iter().all(|assertion| assertion.passed);
            SampleResult {
                id: sample.id.clone(),
                path: path_text,
                passed,
                error: None,
                assertions,
            }
        }
        Err(error) => SampleResult {
            id: sample.id.clone(),
            path: path_text,
            passed: false,
            error: Some(format!("cannot evaluate '{}': {error}", path.display())),
            assertions: Vec::new(),
        },
    }
}

fn evaluate_assertions(
    before: &SceneMetrics,
    after: &SceneMetrics,
    expected: &Assertions,
) -> Vec<AssertionResult> {
    vec![
        AssertionResult {
            name: "tempo".to_owned(),
            expectation: expected.tempo.as_str().to_owned(),
            passed: expected.tempo.compare_f64(before.tempo, after.tempo),
            before: json!(before.tempo),
            after: json!(after.tempo),
        },
        AssertionResult {
            name: "track_count".to_owned(),
            expectation: expected.track_count.as_str().to_owned(),
            passed: expected
                .track_count
                .compare_usize(before.track_count, after.track_count),
            before: json!(before.track_count),
            after: json!(after.track_count),
        },
        AssertionResult {
            name: "melody_rest_ratio".to_owned(),
            expectation: expected.melody_rest_ratio.as_str().to_owned(),
            passed: expected
                .melody_rest_ratio
                .compare_f64(before.melody_rest_ratio, after.melody_rest_ratio),
            before: json!(before.melody_rest_ratio),
            after: json!(after.melody_rest_ratio),
        },
        AssertionResult {
            name: "mode".to_owned(),
            expectation: expected.mode.as_str().to_owned(),
            passed: expected.mode.compare(before.mode, after.mode),
            before: json!(before.mode),
            after: json!(after.mode),
        },
        AssertionResult {
            name: "loop".to_owned(),
            expectation: expected.r#loop.as_str().to_owned(),
            passed: before.loop_enabled == after.loop_enabled,
            before: json!(before.loop_enabled),
            after: json!(after.loop_enabled),
        },
        AssertionResult {
            name: "motif_contour".to_owned(),
            expectation: expected.motif_contour.as_str().to_owned(),
            passed: before.motif_contours == after.motif_contours,
            before: json!(before.motif_contours),
            after: json!(after.motif_contours),
        },
    ]
}

fn read_scene_metrics(path: &Path) -> Result<SceneMetrics, CapabilityError> {
    let scene: Scene = read_yaml(path, "scene")?;

    if !scene.tempo.is_finite() || scene.tempo <= 0.0 {
        return Err(CapabilityError::new(format!(
            "scene '{}' tempo must be a positive finite number",
            path.display()
        )));
    }
    if scene.motifs.is_empty() {
        return Err(CapabilityError::new(format!(
            "scene '{}' must contain at least one motif",
            path.display()
        )));
    }

    let mode = parse_mode(&scene.key).ok_or_else(|| {
        CapabilityError::new(format!(
            "scene '{}' key '{}' does not identify major or minor mode",
            path.display(),
            scene.key
        ))
    })?;
    let melody_rest_ratio = melody_rest_ratio(&scene, path)?;
    let motif_contours = motif_contours(&scene, path)?;

    Ok(SceneMetrics {
        tempo: scene.tempo,
        track_count: scene.tracks.len(),
        melody_rest_ratio,
        mode,
        loop_enabled: scene.loop_enabled,
        motif_contours,
    })
}

fn melody_rest_ratio(scene: &Scene, path: &Path) -> Result<f64, CapabilityError> {
    let mut total_beats = 0.0;
    let mut rest_beats = 0.0;
    let mut melody_tracks = 0_usize;

    for track in &scene.tracks {
        if !track.pattern.eq_ignore_ascii_case("melody") {
            continue;
        }
        melody_tracks += 1;
        let motif_name = track.motif.as_deref().ok_or_else(|| {
            CapabilityError::new(format!(
                "scene '{}' melody track is missing a motif reference",
                path.display()
            ))
        })?;
        let notes = scene.motifs.get(motif_name).ok_or_else(|| {
            CapabilityError::new(format!(
                "scene '{}' melody track references missing motif '{}'",
                path.display(),
                motif_name
            ))
        })?;

        for note in notes {
            validate_note_duration(note, path, motif_name)?;
            total_beats += note.beats;
            if note.degree == 0 {
                rest_beats += note.beats;
            }
        }
    }

    if melody_tracks == 0 || total_beats <= 0.0 {
        return Err(CapabilityError::new(format!(
            "scene '{}' needs at least one non-empty melody track",
            path.display()
        )));
    }
    Ok(rest_beats / total_beats)
}

fn motif_contours(
    scene: &Scene,
    path: &Path,
) -> Result<BTreeMap<String, Vec<i8>>, CapabilityError> {
    scene
        .motifs
        .iter()
        .map(|(name, notes)| {
            for note in notes {
                validate_note_duration(note, path, name)?;
            }

            let pitched_degrees = notes
                .iter()
                .filter(|note| note.degree != 0)
                .map(|note| note.degree)
                .collect::<Vec<_>>();
            let contour = pitched_degrees
                .windows(2)
                .map(|pair| (pair[1] - pair[0]).signum() as i8)
                .collect::<Vec<_>>();
            Ok((name.clone(), contour))
        })
        .collect()
}

fn validate_note_duration(
    note: &MotifNote,
    path: &Path,
    motif_name: &str,
) -> Result<(), CapabilityError> {
    if !note.beats.is_finite() || note.beats <= 0.0 {
        return Err(CapabilityError::new(format!(
            "scene '{}' motif '{}' contains a non-positive or non-finite duration",
            path.display(),
            motif_name
        )));
    }
    Ok(())
}

fn parse_mode(key: &str) -> Option<Mode> {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.ends_with("minor") {
        Some(Mode::Minor)
    } else if normalized.ends_with("major") {
        Some(Mode::Major)
    } else {
        None
    }
}

fn resolve_path(base_dir: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        base_dir.join(path)
    }
}

fn read_yaml<T>(path: &Path, kind: &str) -> Result<T, CapabilityError>
where
    T: for<'de> Deserialize<'de>,
{
    let contents = fs::read_to_string(path).map_err(|error| {
        CapabilityError::new(format!("cannot read {kind} '{}': {error}", path.display()))
    })?;
    serde_yaml::from_str(&contents).map_err(|error| {
        CapabilityError::new(format!("cannot parse {kind} '{}': {error}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn one_passing_and_one_failing_sample_produce_half_pass_rate() {
        let case = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/capability/lonelier.case.yaml");

        let report = evaluate_case_file(&case).expect("fixture case evaluates");

        assert_eq!(report.case_id, "lonelier");
        assert_eq!(
            report.intent,
            "Make it lonelier without losing the motif or loop."
        );
        assert_eq!(report.sample_count, 2);
        assert_eq!(report.passed_samples, 1);
        assert_eq!(report.pass_rate, 0.5);
        assert!(report.samples[0].passed);
        assert!(!report.samples[1].passed);
        assert_eq!(report.samples[0].assertions.len(), 6);
        assert!(report.meets_threshold(0.5));
        assert!(!report.meets_threshold(0.75));
    }
}
