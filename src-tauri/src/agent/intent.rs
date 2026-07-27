use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

use crate::{error::BenchError, project};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMode {
    NewScene,
    Revision,
    Repair,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SceneField {
    Title,
    Story,
    Tempo,
    Key,
    TimeSignature,
    Bars,
    #[serde(rename = "loop")]
    LoopEnabled,
    Harmony,
    Performance,
    Motifs,
    Tracks,
    Sections,
    Textures,
}

impl SceneField {
    fn key(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Story => "story",
            Self::Tempo => "tempo",
            Self::Key => "key",
            Self::TimeSignature => "time_signature",
            Self::Bars => "bars",
            Self::LoopEnabled => "loop",
            Self::Harmony => "harmony",
            Self::Performance => "performance",
            Self::Motifs => "motifs",
            Self::Tracks => "tracks",
            Self::Sections => "sections",
            Self::Textures => "textures",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IntentArgs {
    pub path: String,
    pub task_mode: TaskMode,
    pub goal: String,
    pub form_intent: String,
    pub palette_intent: String,
    pub expected_changes: Vec<SceneField>,
    pub invariants: Vec<SceneField>,
}

#[derive(Debug, Clone)]
struct IntentContract {
    args: IntentArgs,
    target: PathBuf,
    baseline: Option<String>,
    write_started: bool,
}

#[derive(Debug, Clone)]
pub struct IntentHandle {
    target: PathBuf,
    path: String,
}

pub struct IntentDeclaration {
    pub output: JsonValue,
    pub gate_path: String,
}

impl IntentHandle {
    pub fn target(&self) -> &Path {
        &self.target
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct IntentAlignment {
    pub status: &'static str,
    pub task_mode: TaskMode,
    pub expected_changes: Vec<SceneField>,
    pub actual_changes: Vec<SceneField>,
    pub missing_changes: Vec<SceneField>,
    pub unexpected_changes: Vec<SceneField>,
    pub invariant_violations: Vec<SceneField>,
}

impl IntentAlignment {
    pub fn aligned(&self) -> bool {
        self.status == "aligned"
    }

    pub fn summary(&self) -> String {
        if self.aligned() {
            return "write matches declared arrangement intent".into();
        }
        let mut findings = Vec::new();
        if !self.missing_changes.is_empty() {
            findings.push(format!(
                "declared fields unchanged: {}",
                field_list(&self.missing_changes)
            ));
        }
        if !self.unexpected_changes.is_empty() {
            findings.push(format!(
                "undeclared fields changed: {}",
                field_list(&self.unexpected_changes)
            ));
        }
        if !self.invariant_violations.is_empty() {
            findings.push(format!(
                "invariants changed: {}",
                field_list(&self.invariant_violations)
            ));
        }
        if findings.is_empty() {
            "written scene could not be compared with the declared arrangement intent".into()
        } else {
            findings.join("; ")
        }
    }
}

#[derive(Default)]
pub struct IntentTracker {
    contracts: Mutex<BTreeMap<PathBuf, IntentContract>>,
    read_scenes: Mutex<BTreeMap<PathBuf, String>>,
}

impl IntentTracker {
    pub fn mark_read(&self, root: &Path, path: &str, content: &str) -> Result<(), BenchError> {
        let target = intent_target(root, path)?;
        self.read_scenes
            .lock()
            .map_err(|_| {
                BenchError::agent("state_poisoned", "arrangement scene-read lock is poisoned")
            })?
            .insert(target, content.to_owned());
        Ok(())
    }

    pub fn declare(&self, root: &Path, args: IntentArgs) -> Result<IntentDeclaration, BenchError> {
        validate_args(&args)?;
        let target = intent_target(root, &args.path)?;
        let baseline = match std::fs::read_to_string(&target) {
            Ok(content) => Some(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(BenchError::io(error)),
        };
        match (args.task_mode, baseline.is_some()) {
            (TaskMode::NewScene, true) => {
                return Err(BenchError::agent(
                    "arrangement_intent_mode_mismatch",
                    format!(
                        "`{}` already exists; declare `revision` or `repair`, not `new_scene`",
                        args.path
                    ),
                ));
            }
            (TaskMode::Revision | TaskMode::Repair, false) => {
                return Err(BenchError::agent(
                    "arrangement_intent_mode_mismatch",
                    format!(
                        "`{}` does not exist; declare `new_scene`, not `revision` or `repair`",
                        args.path
                    ),
                ));
            }
            _ => {}
        }
        if matches!(args.task_mode, TaskMode::Revision | TaskMode::Repair) {
            let read_scenes = self.read_scenes.lock().map_err(|_| {
                BenchError::agent("state_poisoned", "arrangement scene-read lock is poisoned")
            })?;
            let read_content = read_scenes.get(&target).ok_or_else(|| {
                BenchError::agent(
                    "arrangement_scene_not_read",
                    format!(
                        "call `read_scene` for `{}` before declaring a revision or repair intent",
                        args.path
                    ),
                )
            })?;
            if baseline.as_deref() != Some(read_content.as_str()) {
                return Err(BenchError::agent(
                    "arrangement_scene_changed_after_read",
                    format!(
                        "`{}` changed after read_scene; read it again before declaring intent",
                        args.path
                    ),
                ));
            }
        }

        let mut contracts = self.contracts.lock().map_err(|_| {
            BenchError::agent(
                "state_poisoned",
                "arrangement intent contract lock is poisoned",
            )
        })?;
        if contracts
            .get(&target)
            .is_some_and(|contract| contract.write_started)
        {
            return Err(BenchError::agent(
                "arrangement_intent_locked",
                format!(
                    "the arrangement intent for `{}` is locked after the first write",
                    args.path
                ),
            ));
        }
        let gate_path = project_relative_target(root, &target)?;
        contracts.insert(
            target.clone(),
            IntentContract {
                args: args.clone(),
                target,
                baseline,
                write_started: false,
            },
        );
        let output = serde_json::to_value(&args).map_err(BenchError::io)?;
        Ok(IntentDeclaration { output, gate_path })
    }

    pub fn require_for_write(&self, root: &Path, path: &str) -> Result<IntentHandle, BenchError> {
        let target = intent_target(root, path)?;
        let contracts = self.contracts.lock().map_err(|_| {
            BenchError::agent(
                "state_poisoned",
                "arrangement intent contract lock is poisoned",
            )
        })?;
        let contract = contracts.get(&target).ok_or_else(|| {
            BenchError::agent(
                "arrangement_intent_required",
                format!("call `declare_arrangement_intent` for `{path}` before `write_scene`"),
            )
        })?;
        if matches!(contract.args.task_mode, TaskMode::NewScene)
            && !contract.write_started
            && contract.target.exists()
        {
            return Err(BenchError::agent(
                "arrangement_intent_stale",
                format!("`{path}` appeared after its new-scene intent was declared"),
            ));
        }
        if !contract.write_started {
            if let Some(baseline) = &contract.baseline {
                let current = std::fs::read_to_string(&contract.target).map_err(BenchError::io)?;
                if current != *baseline {
                    return Err(BenchError::agent(
                        "arrangement_intent_stale",
                        format!(
                            "`{path}` changed after its arrangement intent was declared; read it again in a new run"
                        ),
                    ));
                }
            }
        }
        Ok(IntentHandle {
            target,
            path: path.to_owned(),
        })
    }

    pub fn record_write(
        &self,
        handle: &IntentHandle,
        content: &str,
    ) -> Result<IntentAlignment, BenchError> {
        let mut contracts = self.contracts.lock().map_err(|_| {
            BenchError::agent(
                "state_poisoned",
                "arrangement intent contract lock is poisoned",
            )
        })?;
        let contract = contracts.get_mut(&handle.target).ok_or_else(|| {
            BenchError::agent(
                "arrangement_intent_required",
                format!(
                    "call `declare_arrangement_intent` for `{}` before `write_scene`",
                    handle.path
                ),
            )
        })?;
        let alignment = compare(contract, content);
        contract.write_started = true;
        Ok(alignment)
    }
}

fn validate_args(args: &IntentArgs) -> Result<(), BenchError> {
    for (field, value) in [
        ("goal", args.goal.as_str()),
        ("form_intent", args.form_intent.as_str()),
        ("palette_intent", args.palette_intent.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(BenchError::agent(
                "invalid_tool_args",
                format!("arrangement intent `{field}` must not be empty"),
            ));
        }
    }
    if args.expected_changes.is_empty() {
        return Err(BenchError::agent(
            "invalid_tool_args",
            "arrangement intent needs at least one expected scene field change",
        ));
    }
    let expected = args
        .expected_changes
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if expected.len() != args.expected_changes.len() {
        return Err(BenchError::agent(
            "invalid_tool_args",
            "arrangement intent expected_changes must not contain duplicates",
        ));
    }
    let invariants = args.invariants.iter().copied().collect::<BTreeSet<_>>();
    if invariants.len() != args.invariants.len() {
        return Err(BenchError::agent(
            "invalid_tool_args",
            "arrangement intent invariants must not contain duplicates",
        ));
    }
    if let Some(field) = expected.intersection(&invariants).next() {
        return Err(BenchError::agent(
            "invalid_tool_args",
            format!(
                "scene field `{}` cannot be both an expected change and an invariant",
                field.key()
            ),
        ));
    }
    Ok(())
}

fn compare(contract: &IntentContract, content: &str) -> IntentAlignment {
    let expected = contract
        .args
        .expected_changes
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let invariants = contract
        .args
        .invariants
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let actual = match &contract.baseline {
        Some(before) => changed_fields(before, content),
        None => present_fields(content),
    };
    let missing = expected.difference(&actual).copied().collect::<Vec<_>>();
    let unexpected = if matches!(contract.args.task_mode, TaskMode::NewScene) {
        Vec::new()
    } else {
        actual.difference(&expected).copied().collect::<Vec<_>>()
    };
    let invariant_violations = actual
        .intersection(&invariants)
        .copied()
        .collect::<Vec<_>>();
    let aligned = missing.is_empty()
        && invariant_violations.is_empty()
        && (matches!(contract.args.task_mode, TaskMode::NewScene) || unexpected.is_empty());
    IntentAlignment {
        status: if aligned { "aligned" } else { "blocked" },
        task_mode: contract.args.task_mode,
        expected_changes: expected.into_iter().collect(),
        actual_changes: actual.into_iter().collect(),
        missing_changes: missing,
        unexpected_changes: unexpected,
        invariant_violations,
    }
}

fn present_fields(content: &str) -> BTreeSet<SceneField> {
    let Ok(serde_yaml::Value::Mapping(mapping)) =
        serde_yaml::from_str::<serde_yaml::Value>(content)
    else {
        return BTreeSet::new();
    };
    all_fields()
        .filter(|field| mapping.contains_key(serde_yaml::Value::String(field.key().into())))
        .collect()
}

fn changed_fields(before: &str, after: &str) -> BTreeSet<SceneField> {
    let Ok(serde_yaml::Value::Mapping(before)) = serde_yaml::from_str::<serde_yaml::Value>(before)
    else {
        return BTreeSet::new();
    };
    let Ok(serde_yaml::Value::Mapping(after)) = serde_yaml::from_str::<serde_yaml::Value>(after)
    else {
        return BTreeSet::new();
    };
    all_fields()
        .filter(|field| {
            let key = serde_yaml::Value::String(field.key().into());
            before.get(&key) != after.get(&key)
        })
        .collect()
}

fn all_fields() -> impl Iterator<Item = SceneField> {
    [
        SceneField::Title,
        SceneField::Story,
        SceneField::Tempo,
        SceneField::Key,
        SceneField::TimeSignature,
        SceneField::Bars,
        SceneField::LoopEnabled,
        SceneField::Harmony,
        SceneField::Performance,
        SceneField::Motifs,
        SceneField::Tracks,
        SceneField::Sections,
        SceneField::Textures,
    ]
    .into_iter()
}

fn intent_target(root: &Path, path: &str) -> Result<PathBuf, BenchError> {
    let target = project::resolve_for_write(root, path)?;
    if target.exists() {
        project::resolve_inside(root, path)
    } else {
        Ok(target)
    }
}

fn project_relative_target(root: &Path, target: &Path) -> Result<String, BenchError> {
    let root = root.canonicalize().map_err(BenchError::io)?;
    target
        .strip_prefix(&root)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| {
            BenchError::invalid(format!(
                "`{}` is outside project `{}`",
                target.display(),
                root.display()
            ))
        })
}

fn field_list(fields: &[SceneField]) -> String {
    fields
        .iter()
        .map(|field| field.key())
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn declaration_output(args: JsonValue) -> JsonValue {
    json!({"ok": true, "intent": args})
}
