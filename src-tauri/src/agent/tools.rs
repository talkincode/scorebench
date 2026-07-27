use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::{json, Value};

use super::intent::{declaration_output, IntentArgs, IntentTracker};
use crate::error::BenchError;
use crate::llm::types::{FunctionCall, ToolDefinition};
use crate::{manifest, observation, project, scorekit};

pub struct ToolBelt {
    root: PathBuf,
    intents: Arc<IntentTracker>,
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub output: String,
    pub summary: String,
    pub detail: Option<String>,
    pub scene_gates: Vec<SceneGateUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneGateKind {
    /// Schema validation plus compatibility with the active bench.json render
    /// configuration.
    Readiness,
    /// A requested build must be retried successfully; validation alone cannot
    /// erase a renderer/export failure.
    Build,
    /// ScoreKit instrument resolution, including exact-only world identities.
    InstrumentResolution,
    /// The write must match the run-local, pre-write arrangement intent.
    IntentAlignment,
    /// One concrete scene/grammar pair.
    Grammar { grammar: String },
}

#[derive(Debug, Clone)]
pub struct SceneGateUpdate {
    pub kind: SceneGateKind,
    pub path: String,
    pub ready: bool,
    pub reason: String,
}

impl ToolBelt {
    pub fn new(root: PathBuf) -> Result<Self, BenchError> {
        Ok(Self {
            root: root.canonicalize().map_err(BenchError::io)?,
            intents: Arc::new(IntentTracker::default()),
        })
    }

    pub async fn execute(&self, call: FunctionCall) -> Result<ToolResult, BenchError> {
        let root = self.root.clone();
        let intents = Arc::clone(&self.intents);
        tokio::task::spawn_blocking(move || execute_sync(&root, &intents, &call))
            .await
            .map_err(BenchError::io)?
    }

    pub fn failure_gates(&self, call: &FunctionCall, error: &BenchError) -> Vec<SceneGateUpdate> {
        failure_gates(call, error)
            .into_iter()
            .map(|mut update| {
                if let Ok(path) = scene(&self.root, &update.path) {
                    if let Ok(relative) = scene_gate_path(&self.root, &path) {
                        update.path = relative;
                    }
                }
                update
            })
            .collect()
    }
}

/// Convert a failed scene-scoped tool call into a durable request-local gate.
/// The tool error remains the authoritative payload; this only prevents a
/// later text-only response from pretending the failed check never happened.
pub fn failure_gates(call: &FunctionCall, error: &BenchError) -> Vec<SceneGateUpdate> {
    let reason = format!("{} failed: {error}", call.name);
    let update = |kind, path| SceneGateUpdate {
        kind,
        path,
        ready: false,
        reason: reason.clone(),
    };
    match call.name.as_str() {
        "write_scene" => serde_json::from_str::<WriteArgs>(&call.arguments)
            .ok()
            .map(|args| {
                vec![
                    update(SceneGateKind::Readiness, args.path.clone()),
                    update(SceneGateKind::IntentAlignment, args.path),
                ]
            })
            .unwrap_or_default(),
        "validate_scene" => serde_json::from_str::<PathArgs>(&call.arguments)
            .ok()
            .map(|args| update(SceneGateKind::Readiness, args.path))
            .into_iter()
            .collect(),
        "build_scene" => serde_json::from_str::<BuildArgs>(&call.arguments)
            .ok()
            .map(|args| update(SceneGateKind::Build, args.path))
            .into_iter()
            .collect(),
        "inspect_instruments" => serde_json::from_str::<InspectInstrumentsArgs>(&call.arguments)
            .ok()
            .map(|args| update(SceneGateKind::InstrumentResolution, args.path))
            .into_iter()
            .collect(),
        "declare_arrangement_intent" => serde_json::from_str::<IntentArgs>(&call.arguments)
            .ok()
            .map(|args| update(SceneGateKind::IntentAlignment, args.path))
            .into_iter()
            .collect(),
        "lint_scene" => serde_json::from_str::<LintArgs>(&call.arguments)
            .ok()
            .map(|args| {
                update(
                    SceneGateKind::Grammar {
                        grammar: args.grammar,
                    },
                    args.path,
                )
            })
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        function(
            "read_scene",
            "Read one scene YAML file inside the project.",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        function(
            "declare_arrangement_intent",
            "Declare one concise, auditable decision record before write_scene. Use new_scene for a missing target; for revision or repair, read_scene must come first. expected_changes and invariants are top-level ScoreKit scene fields. The declaration locks after the first write so later edits are always compared with the original baseline.",
            json!({
                "type":"object",
                "properties":{
                    "path":{"type":"string"},
                    "task_mode":{"type":"string","enum":["new_scene","revision","repair"]},
                    "goal":{"type":"string"},
                    "form_intent":{"type":"string"},
                    "palette_intent":{"type":"string","description":"Creative instrumentation decision, never a Scene palette routing key unless the active orchestration lists that exact key."},
                    "expected_changes":{
                        "type":"array",
                        "minItems":1,
                        "uniqueItems":true,
                        "items":{"type":"string","enum":["title","story","tempo","key","time_signature","bars","loop","harmony","performance","motifs","tracks","sections","textures"]}
                    },
                    "invariants":{
                        "type":"array",
                        "uniqueItems":true,
                        "items":{"type":"string","enum":["title","story","tempo","key","time_signature","bars","loop","harmony","performance","motifs","tracks","sections","textures"]}
                    }
                },
                "required":["path","task_mode","goal","form_intent","palette_intent","expected_changes","invariants"]
            }),
        ),
        function(
            "write_scene",
            "Atomically write one scene YAML file inside the project after declare_arrangement_intent. The write is compared with that declaration's original baseline. Intent alignment, validation, and active orchestration/texture-profile compatibility are mandatory; repair every failed gate before finishing.",
            json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}),
        ),
        function(
            "validate_scene",
            "Validate a scene with scorekit's machine error contract.",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        function(
            "lint_scene",
            "Lint a scene against a project-local scorekit grammar.",
            json!({"type":"object","properties":{"path":{"type":"string"},"grammar":{"type":"string"}},"required":["path","grammar"]}),
        ),
        function(
            "build_scene",
            "Build a scene through scorekit into project out/ and return meta JSON.",
            json!({
                "type":"object",
                "properties":{
                    "path":{"type":"string"},
                    "format":{"type":"string","enum":["ogg","wav"]},
                    "renderer":{"type":"string"},
                    "sample_rate":{"type":"integer","minimum":8000,"maximum":384000},
                    "gain":{"type":"number","minimum":0},
                    "quality":{"type":"integer","minimum":0,"maximum":10},
                    "stems":{"type":"boolean"},
                    "soundfont":{"type":"string"},
                    "orchestration":{"type":"string","description":"Project-relative scorekit orchestration profile path (--renderer sfizz only). Omit to inherit bench.json."},
                    "texture_profile":{"type":"string","description":"Project-relative scorekit texture profile path. Omit to inherit bench.json."}
                },
                "required":["path"]
            }),
        ),
        function(
            "diff_scenes",
            "Return scorekit's semantic JSON diff for two project scenes.",
            json!({"type":"object","properties":{"old":{"type":"string"},"new":{"type":"string"}},"required":["old","new"]}),
        ),
        function(
            "inspect_instruments",
            "Resolve every scene track through scorekit before building. Use this for palette selection and all world instruments; some schema-valid instruments require an exact external profile and cannot fall back to General MIDI.",
            json!({
                "type":"object",
                "properties":{
                    "path":{"type":"string"},
                    "orchestration":{"type":"string","description":"Project-relative orchestration profile. Omit to inherit bench.json."},
                    "resolver":{"type":"string","description":"Optional project-relative scorekit resolver policy."},
                    "fallback_mode":{"type":"string","enum":["strict","conservative","flexible"]},
                    "verbose":{"type":"boolean"}
                },
                "required":["path"]
            }),
        ),
        function(
            "inspect_textures",
            "Query scorekit's structured texture catalog with exact conjunctive filters. A `no_match` result is authoritative: change the musical plan or filters, never invent a source key.",
            json!({
                "type":"object",
                "properties":{
                    "profile":{"type":"string","description":"Project-relative texture profile. Omit to inherit bench.json."},
                    "source":{"type":"string"},
                    "category":{"type":"string","enum":["ambience","foley","impact","transition","tonal","industrial","organic","sound_design"]},
                    "tags":{"type":"array","items":{"type":"string"}},
                    "mode":{"type":"string","enum":["loop","one_shot"]},
                    "use_case":{"type":"string"}
                },
                "required":[]
            }),
        ),
        function(
            "check_texture_profile",
            "Ask scorekit to decode and certify every structured texture source. Use before relying on a new or changed profile.",
            json!({
                "type":"object",
                "properties":{
                    "profile":{"type":"string","description":"Project-relative texture profile. Omit to inherit bench.json."},
                    "sample_rate":{"type":"integer","minimum":8000,"maximum":384000}
                },
                "required":[]
            }),
        ),
        function(
            "doctor",
            "Return scorekit doctor --json verbatim.",
            json!({"type":"object","properties":{}}),
        ),
        function(
            "list_project",
            "List current project scenes and rendered assets.",
            json!({"type":"object","properties":{}}),
        ),
    ]
}

fn function(name: &str, description: &str, mut parameters: Value) -> ToolDefinition {
    if let Some(object) = parameters.as_object_mut() {
        let originally_required = object
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<std::collections::HashSet<_>>();
        let mut all_properties = Vec::new();
        if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
            for (property, schema) in properties {
                all_properties.push(Value::String(property.clone()));
                if !originally_required.contains(property) {
                    make_nullable(schema);
                }
            }
        }
        object.insert("required".into(), Value::Array(all_properties));
        object.insert("additionalProperties".into(), Value::Bool(false));
    }
    ToolDefinition::function(name, description, parameters)
}

fn make_nullable(schema: &mut Value) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    if let Some(kind) = object.get_mut("type") {
        match kind {
            Value::String(value) => {
                *kind = serde_json::json!([value.clone(), "null"]);
            }
            Value::Array(values) if !values.iter().any(|value| value == "null") => {
                values.push(Value::String("null".into()));
            }
            _ => {}
        }
    }
    if let Some(values) = object.get_mut("enum").and_then(Value::as_array_mut) {
        if !values.iter().any(Value::is_null) {
            values.push(Value::Null);
        }
    }
}

fn execute_sync(
    root: &Path,
    intents: &IntentTracker,
    call: &FunctionCall,
) -> Result<ToolResult, BenchError> {
    match call.name.as_str() {
        "read_scene" => {
            let args: PathArgs = args(call)?;
            require_scene_path(&args.path)?;
            let content = project::read_text_inside(root, &args.path)?;
            intents.mark_read(root, &args.path, &content)?;
            success(
                json!({"ok":true,"path":args.path,"content":content}),
                "scene read",
            )
        }
        "declare_arrangement_intent" => {
            let args: IntentArgs = args(call)?;
            require_scene_path(&args.path)?;
            let declared = intents.declare(root, args)?;
            success_with_gate(
                declaration_output(declared.output),
                "arrangement intent declared; write pending",
                SceneGateKind::IntentAlignment,
                declared.gate_path,
                false,
            )
        }
        "write_scene" => {
            let args: WriteArgs = args(call)?;
            require_scene_path(&args.path)?;
            let intent = intents.require_for_write(root, &args.path)?;
            let content = args.content.clone();
            let mut result = write_scene(root, args)?;
            let alignment = intents.record_write(&intent, &content)?;
            let alignment_summary = alignment.summary();
            let alignment_ready = alignment.aligned();
            let mut output: Value = serde_json::from_str(&result.output).map_err(BenchError::io)?;
            output["intent_alignment"] =
                serde_json::to_value(&alignment).map_err(BenchError::io)?;
            result.output = output.to_string();
            if !alignment_ready {
                result.summary = format!("{}; INTENT BLOCKED: {alignment_summary}", result.summary);
            }
            result.scene_gates.push(SceneGateUpdate {
                kind: SceneGateKind::IntentAlignment,
                path: scene_gate_path(root, intent.target())?,
                ready: alignment_ready,
                reason: alignment_summary,
            });
            Ok(result)
        }
        "validate_scene" => {
            let args: PathArgs = args(call)?;
            let path = scene(root, &args.path)?;
            scorekit::validate(&path)?;
            let mut output = json!({"ok":true,"path":args.path});
            let mut summary = String::from("scene valid");
            let mut ready = true;
            if let Some(compat) = profile_check(root, &path) {
                if !compat.is_compatible() {
                    ready = false;
                    summary = format!("{summary}; {}", compat.message());
                }
                output["orchestration"] = serde_json::to_value(&compat).map_err(BenchError::io)?;
            }
            if let Some(compat) = texture_profile_check(root, &path) {
                if !compat.is_compatible() {
                    ready = false;
                    summary = format!("{summary}; {}", compat.message());
                }
                output["texture_profile"] =
                    serde_json::to_value(&compat).map_err(BenchError::io)?;
            }
            success_with_gate(
                output,
                summary,
                SceneGateKind::Readiness,
                scene_gate_path(root, &path)?,
                ready,
            )
        }
        "lint_scene" => {
            let args: LintArgs = args(call)?;
            let path = scene(root, &args.path)?;
            let grammar = project::resolve_inside(root, &args.grammar)?;
            scorekit::lint(&path, &grammar)?;
            success_with_gate(
                json!({"ok":true,"path":args.path}),
                "scene passes grammar",
                SceneGateKind::Grammar {
                    grammar: args.grammar,
                },
                scene_gate_path(root, &path)?,
                true,
            )
        }
        "build_scene" => {
            let args: BuildArgs = args(call)?;
            let path = scene(root, &args.path)?;
            let format = args.format.as_deref().unwrap_or("ogg");
            if !matches!(format, "ogg" | "wav") {
                return Err(BenchError::agent(
                    "invalid_tool_args",
                    "build format must be ogg or wav",
                ));
            }
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("scene");
            let rel_output = format!("{}/{stem}.{format}", project::OUT_DIR);
            let output = project::resolve_for_write(root, &rel_output)?;
            let project_render = manifest::load(root).0.render.unwrap_or_default();
            let mut renderer = args.renderer;
            let (inherited_orchestration, inherited_texture_profile) = inherit_render_config(
                &mut renderer,
                &args.orchestration,
                &args.texture_profile,
                &project_render,
            );
            let orchestration = match (
                resolve_optional(root, args.orchestration)?,
                inherited_orchestration,
            ) {
                (Some(explicit), _) => Some(explicit),
                // The project orchestration may live outside the root (GUI
                // allows it), so resolve like the GUI render path does.
                (None, Some(inherited)) => Some(
                    manifest::resolve_config_path(root, &inherited)
                        .to_string_lossy()
                        .into_owned(),
                ),
                (None, None) => None,
            };
            let texture_profile = match (
                resolve_optional(root, args.texture_profile)?,
                inherited_texture_profile,
            ) {
                (Some(explicit), _) => Some(explicit),
                (None, Some(inherited)) => Some(
                    manifest::resolve_config_path(root, &inherited)
                        .to_string_lossy()
                        .into_owned(),
                ),
                (None, None) => None,
            };
            let params = scorekit::BuildParams {
                renderer,
                sample_rate: args.sample_rate,
                gain: args.gain,
                quality: args.quality,
                stems: args.stems,
                soundfont: resolve_optional(root, args.soundfont)?,
                orchestration,
                texture_profile,
            };
            let result = scorekit::build(&path, &output, &params)?;
            let gate_path = scene_gate_path(root, &path)?;
            let mut summary = format!("built {rel_output}");
            let mut result_output = json!({
                    "ok":true,
                    "output":rel_output,
                    "renderer":params.renderer,
                    "orchestration":params.orchestration,
                    "texture_profile":params.texture_profile,
                    "meta_path":result.meta_path.strip_prefix(root).unwrap_or(&result.meta_path),
                    "meta":result.meta
            });
            let active_ready =
                append_active_compatibility(root, &path, &mut result_output, &mut summary)?;
            Ok(ToolResult {
                output: result_output.to_string(),
                summary: summary.clone(),
                detail: None,
                scene_gates: vec![
                    SceneGateUpdate {
                        kind: SceneGateKind::Build,
                        path: gate_path.clone(),
                        ready: true,
                        reason: format!("built {rel_output}"),
                    },
                    SceneGateUpdate {
                        kind: SceneGateKind::Readiness,
                        path: gate_path,
                        ready: active_ready,
                        reason: summary,
                    },
                ],
            })
        }
        "diff_scenes" => {
            let args: DiffArgs = args(call)?;
            let old = scene(root, &args.old)?;
            let new = scene(root, &args.new)?;
            let diff = scorekit::diff(&old, &new)?;
            success(json!({"ok":true,"diff":diff}), "semantic diff ready")
        }
        "inspect_instruments" => {
            let args: InspectInstrumentsArgs = args(call)?;
            let path = scene(root, &args.path)?;
            let render = manifest::load(root).0.render.unwrap_or_default();
            let orchestration = resolve_explicit_or_config(
                root,
                args.orchestration,
                render.orchestration.as_deref(),
            )?;
            let resolver = resolve_optional_path(root, args.resolver)?;
            let report = scorekit::inspect_instruments(
                &path,
                orchestration.as_deref(),
                resolver.as_deref(),
                args.fallback_mode.as_deref(),
                args.verbose.unwrap_or(false),
            )?;
            success_with_gate(
                json!({"ok":true,"path":args.path,"report":report}),
                "instrument resolution inspected",
                SceneGateKind::InstrumentResolution,
                scene_gate_path(root, &path)?,
                true,
            )
        }
        "inspect_textures" => {
            let args: InspectTexturesArgs = args(call)?;
            let profile = active_texture_profile(root, args.profile)?;
            let params = scorekit::TextureInspectParams {
                source: args.source,
                category: args.category,
                tags: args.tags.unwrap_or_default(),
                mode: args.mode,
                use_case: args.use_case,
            };
            let report = scorekit::inspect_textures(&profile, &params)?;
            let status = report
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            success(
                json!({"ok":true,"profile":profile,"report":report}),
                format!("texture inspection: {status}"),
            )
        }
        "check_texture_profile" => {
            let args: CheckTextureProfileArgs = args(call)?;
            let profile = active_texture_profile(root, args.profile)?;
            let report = scorekit::check_texture_profile(&profile, args.sample_rate)?;
            success(
                json!({"ok":true,"profile":profile,"report":report}),
                "texture profile certified",
            )
        }
        "doctor" => success(
            json!({"ok":true,"report":scorekit::doctor()?}),
            "doctor report ready",
        ),
        "list_project" => success(
            json!({"ok":true,"project":project::scan(root)?}),
            "project listed",
        ),
        unknown => Err(BenchError::agent(
            "unknown_tool",
            format!("model requested unknown tool `{unknown}`"),
        )),
    }
}

fn args<T: for<'de> Deserialize<'de>>(call: &FunctionCall) -> Result<T, BenchError> {
    serde_json::from_str(&call.arguments).map_err(|err| {
        BenchError::agent(
            "invalid_tool_args",
            format!("invalid arguments for `{}`: {err}", call.name),
        )
    })
}

fn success(output: Value, summary: impl Into<String>) -> Result<ToolResult, BenchError> {
    Ok(ToolResult {
        output: output.to_string(),
        summary: summary.into(),
        detail: None,
        scene_gates: Vec::new(),
    })
}

fn success_with_gate(
    output: Value,
    summary: impl Into<String>,
    kind: SceneGateKind,
    path: String,
    ready: bool,
) -> Result<ToolResult, BenchError> {
    let summary = summary.into();
    Ok(ToolResult {
        output: output.to_string(),
        summary: summary.clone(),
        detail: None,
        scene_gates: vec![SceneGateUpdate {
            kind,
            path,
            ready,
            reason: summary,
        }],
    })
}

fn write_scene(root: &Path, args: WriteArgs) -> Result<ToolResult, BenchError> {
    let target = project::resolve_for_write(root, &args.path)?;
    let previous = match std::fs::read_to_string(&target) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(BenchError::io(error)),
    };
    let mut warnings = Vec::new();
    let mut history_path = None;
    if let Some(previous) = &previous {
        match project::snapshot_history(root, &args.path, previous) {
            Ok(path) => history_path = Some(path),
            Err(error) => warnings.push(format!("history snapshot failed: {error}")),
        }
    }

    project::write_text_atomic(root, &args.path, &args.content)?;
    let mut diff = None;
    if let Some(history) = history_path {
        match scorekit::diff(&history, &target) {
            Ok(value) => {
                let diff_rel = observation::diff_rel_path(&args.path);
                match serde_json::to_string_pretty(&value)
                    .map_err(BenchError::io)
                    .and_then(|text| project::write_text_atomic(root, &diff_rel, &text).map(|_| ()))
                {
                    Ok(()) => diff = Some(value),
                    Err(error) => warnings.push(format!("last diff save failed: {error}")),
                }
            }
            Err(error) => warnings.push(format!("semantic diff unavailable: {error}")),
        }
    }
    let detail = match (&diff, warnings.is_empty()) {
        (Some(value), true) => serde_json::to_string_pretty(value).ok(),
        (Some(value), false) => Some(format!(
            "{}\n{}",
            serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
            warnings.join("\n")
        )),
        (None, false) => Some(warnings.join("\n")),
        (None, true) => None,
    };
    let mut output = json!({
        "ok": true,
        "path": args.path,
        "bytes": args.content.len(),
        "diff": diff,
        "warnings": warnings
    });
    let (mut summary, mut ready, validation) = match scorekit::validate(&target) {
        Ok(()) => (
            String::from("scene written and validated"),
            true,
            json!({"status": "valid"}),
        ),
        Err(error @ BenchError::Scorekit { .. }) => (
            format!("scene written but INVALID: {error}"),
            false,
            json!({
                "status": "invalid",
                "error": error,
                "hint": "fix the scene with write_scene until validation passes"
            }),
        ),
        // scorekit missing or not runnable: the write itself stands, but the
        // agent may not claim completion without an authoritative result.
        Err(error) => (
            String::from("scene written (validation unavailable)"),
            false,
            json!({"status": "unavailable", "message": error.to_string()}),
        ),
    };
    output["validation"] = validation;
    if let Some(compat) = profile_check(root, &target) {
        if !compat.is_compatible() {
            ready = false;
            summary = format!("{summary}; {}", compat.message());
        }
        output["orchestration"] = serde_json::to_value(&compat).map_err(BenchError::io)?;
    }
    if let Some(compat) = texture_profile_check(root, &target) {
        if !compat.is_compatible() {
            ready = false;
            summary = format!("{summary}; {}", compat.message());
        }
        output["texture_profile"] = serde_json::to_value(&compat).map_err(BenchError::io)?;
    }
    Ok(ToolResult {
        output: output.to_string(),
        summary: summary.clone(),
        detail,
        scene_gates: vec![SceneGateUpdate {
            kind: SceneGateKind::Readiness,
            path: scene_gate_path(root, &target)?,
            ready,
            reason: summary,
        }],
    })
}

/// Compatibility of one scene against the project's persisted orchestration
/// configuration (bench.json). `None` when no sfizz orchestration is active.
fn profile_check(root: &Path, scene_path: &Path) -> Option<manifest::OrchestrationCompat> {
    let render = manifest::load(root).0.render?;
    manifest::check_scene_profile(root, scene_path, &render)
}

fn texture_profile_check(root: &Path, scene_path: &Path) -> Option<manifest::TextureProfileCompat> {
    let render = manifest::load(root).0.render.unwrap_or_default();
    manifest::check_scene_texture_profile(root, scene_path, &render)
}

/// A build may use one-shot explicit overrides, but clearing the terminal
/// readiness gate must always reflect the project's persisted bench.json
/// configuration — the configuration the next GUI/default Agent build uses.
fn append_active_compatibility(
    root: &Path,
    scene_path: &Path,
    output: &mut Value,
    summary: &mut String,
) -> Result<bool, BenchError> {
    let mut ready = true;
    if let Some(compat) = profile_check(root, scene_path) {
        if !compat.is_compatible() {
            ready = false;
            *summary = format!("{summary}; active {}", compat.message());
        }
        output["active_orchestration_compat"] =
            serde_json::to_value(&compat).map_err(BenchError::io)?;
    }
    if let Some(compat) = texture_profile_check(root, scene_path) {
        if !compat.is_compatible() {
            ready = false;
            *summary = format!("{summary}; active {}", compat.message());
        }
        output["active_texture_profile_compat"] =
            serde_json::to_value(&compat).map_err(BenchError::io)?;
    }
    Ok(ready)
}

fn scene_gate_path(root: &Path, scene_path: &Path) -> Result<String, BenchError> {
    let root = root.canonicalize().map_err(BenchError::io)?;
    let scene = scene_path.canonicalize().map_err(BenchError::io)?;
    let relative = scene.strip_prefix(&root).map_err(|_| {
        BenchError::invalid(format!(
            "`{}` is outside project `{}`",
            scene.display(),
            root.display()
        ))
    })?;
    Ok(relative.to_string_lossy().into_owned())
}

/// Fill build parameters the model omitted from the project render config.
/// Returns inherited orchestration and texture profile paths. Pure for testing.
fn inherit_render_config(
    renderer: &mut Option<String>,
    explicit_orchestration: &Option<String>,
    explicit_texture_profile: &Option<String>,
    project_render: &manifest::RenderConfig,
) -> (Option<String>, Option<String>) {
    if renderer.is_none() {
        renderer.clone_from(&project_render.renderer);
    }
    let orchestration = if explicit_orchestration.is_none() && renderer.as_deref() == Some("sfizz")
    {
        project_render.orchestration.clone()
    } else {
        None
    };
    let texture_profile = if explicit_texture_profile.is_none() {
        project_render.texture_profile.clone()
    } else {
        None
    };
    (orchestration, texture_profile)
}

fn require_scene_path(path: &str) -> Result<(), BenchError> {
    if path.ends_with(".yaml") || path.ends_with(".yml") {
        Ok(())
    } else {
        Err(BenchError::agent(
            "invalid_tool_args",
            "scene path must end in .yaml or .yml",
        ))
    }
}

fn scene(root: &Path, rel: &str) -> Result<PathBuf, BenchError> {
    require_scene_path(rel)?;
    project::resolve_inside(root, rel)
}

fn resolve_optional(root: &Path, rel: Option<String>) -> Result<Option<String>, BenchError> {
    rel.map(|value| {
        project::resolve_inside(root, &value).map(|path| path.to_string_lossy().into_owned())
    })
    .transpose()
}

fn resolve_optional_path(root: &Path, rel: Option<String>) -> Result<Option<PathBuf>, BenchError> {
    rel.map(|value| project::resolve_inside(root, &value))
        .transpose()
}

fn resolve_explicit_or_config(
    root: &Path,
    explicit: Option<String>,
    configured: Option<&str>,
) -> Result<Option<PathBuf>, BenchError> {
    match explicit {
        Some(path) => project::resolve_inside(root, &path).map(Some),
        None => Ok(configured
            .filter(|path| !path.trim().is_empty())
            .map(|path| manifest::resolve_config_path(root, path))),
    }
}

fn active_texture_profile(root: &Path, explicit: Option<String>) -> Result<PathBuf, BenchError> {
    if let Some(path) = explicit {
        return project::resolve_inside(root, &path);
    }
    let configured = manifest::load(root)
        .0
        .render
        .and_then(|render| render.texture_profile)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| {
            BenchError::agent(
                "invalid_tool_args",
                "no texture profile supplied and bench.json has no active texture_profile",
            )
        })?;
    Ok(manifest::resolve_config_path(root, &configured))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LintArgs {
    path: String,
    grammar: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiffArgs {
    old: String,
    new: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildArgs {
    path: String,
    format: Option<String>,
    renderer: Option<String>,
    sample_rate: Option<u32>,
    gain: Option<f32>,
    quality: Option<u8>,
    stems: Option<bool>,
    soundfont: Option<String>,
    orchestration: Option<String>,
    texture_profile: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectInstrumentsArgs {
    path: String,
    orchestration: Option<String>,
    resolver: Option<String>,
    fallback_mode: Option<String>,
    verbose: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectTexturesArgs {
    profile: Option<String>,
    source: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
    mode: Option<String>,
    use_case: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckTextureProfileArgs {
    profile: Option<String>,
    sample_rate: Option<u32>,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn temp_project() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-tools-{}-{}-{}",
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

    async fn declare_new_scene(belt: &ToolBelt, path: &str) {
        belt.execute(FunctionCall {
            id: None,
            call_id: "intent".into(),
            name: "declare_arrangement_intent".into(),
            arguments: serde_json::json!({
                "path": path,
                "task_mode": "new_scene",
                "goal": "Create the requested scene.",
                "form_intent": "Use the form declared in the scene.",
                "palette_intent": "Use live-schema instruments appropriate to the request.",
                "expected_changes": ["tracks"],
                "invariants": []
            })
            .to_string(),
        })
        .await
        .unwrap();
    }

    async fn declare_revision(
        belt: &ToolBelt,
        path: &str,
        expected_changes: &[&str],
        invariants: &[&str],
    ) {
        belt.execute(FunctionCall {
            id: None,
            call_id: "read".into(),
            name: "read_scene".into(),
            arguments: serde_json::json!({"path":path}).to_string(),
        })
        .await
        .unwrap();
        belt.execute(FunctionCall {
            id: None,
            call_id: "intent".into(),
            name: "declare_arrangement_intent".into(),
            arguments: serde_json::json!({
                "path": path,
                "task_mode": "revision",
                "goal": "Apply only the requested semantic revision.",
                "form_intent": "Preserve the existing form unless declared otherwise.",
                "palette_intent": "Preserve the existing instrumentation unless declared otherwise.",
                "expected_changes": expected_changes,
                "invariants": invariants
            })
            .to_string(),
        })
        .await
        .unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn scene_gate_paths_do_not_collapse_backslash_filenames() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("dir")).unwrap();
        let backslash = root.join(r"dir\scene.yaml");
        let nested = root.join("dir/scene.yaml");
        std::fs::write(&backslash, "tracks: []\n").unwrap();
        std::fs::write(&nested, "tracks: []\n").unwrap();

        assert_ne!(
            scene_gate_path(&root, &backslash).unwrap(),
            scene_gate_path(&root, &nested).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn failed_tool_gate_uses_the_canonical_project_relative_scene_identity() {
        use std::os::unix::fs::symlink;

        let root = temp_project();
        std::fs::write(root.join("scene.yaml"), "tracks: []\n").unwrap();
        symlink("scene.yaml", root.join("alias.yaml")).unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let call = FunctionCall {
            id: None,
            call_id: "validate".into(),
            name: "validate_scene".into(),
            arguments: r#"{"path":"alias.yaml"}"#.into(),
        };
        let gates = belt.failure_gates(&call, &BenchError::agent("fixture", "invalid"));

        assert_eq!(gates.len(), 1);
        assert_eq!(gates[0].path, "scene.yaml");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn require_scorekit_06_contract() -> bool {
        let handshake = scorekit::handshake();
        if handshake.compatible == Some(true) {
            return true;
        }
        if std::env::var("SCOREBENCH_REQUIRE_SCOREKIT_CONTRACT").as_deref() == Ok("1") {
            panic!(
                "ScoreKit contract test was required, but the active CLI is not compatible: {:?}",
                handshake.warning
            );
        }
        false
    }

    fn write_tiny_wav(path: &Path) {
        let sample_rate = 8_000_u32;
        let samples = (0..800_i16)
            .map(|index| {
                if index % 20 < 10 {
                    2_000_i16
                } else {
                    -2_000_i16
                }
            })
            .collect::<Vec<_>>();
        let data_size = (samples.len() * 2) as u32;
        let mut bytes = Vec::with_capacity(44 + data_size as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[tokio::test]
    async fn malformed_arguments_are_typed_errors() {
        let root = temp_project();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let error = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: "not-json".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(error, BenchError::Agent { ref code, .. } if code == "invalid_tool_args"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn new_scene_write_requires_a_declared_arrangement_intent() {
        let root = temp_project();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let content = include_str!("../../tests/fixtures/scenes/forest.yaml");
        let write = || FunctionCall {
            id: None,
            call_id: "write".into(),
            name: "write_scene".into(),
            arguments: serde_json::json!({"path":"forest.yaml","content":content}).to_string(),
        };

        let error = belt.execute(write()).await.unwrap_err();
        assert!(
            matches!(error, BenchError::Agent { ref code, .. } if code == "arrangement_intent_required")
        );
        assert!(!root.join("forest.yaml").exists());

        let declaration = belt
            .execute(FunctionCall {
                id: None,
                call_id: "intent".into(),
                name: "declare_arrangement_intent".into(),
                arguments: serde_json::json!({
                    "path": "forest.yaml",
                    "task_mode": "new_scene",
                    "goal": "Create a restrained forest exploration loop.",
                    "form_intent": "A seamless loop with one gentle rise and return.",
                    "palette_intent": "Airy woodwinds over a light acoustic foundation.",
                    "expected_changes": ["tempo", "key", "loop", "tracks"],
                    "invariants": []
                })
                .to_string(),
            })
            .await
            .unwrap();
        assert!(declaration
            .scene_gates
            .iter()
            .any(|gate| { gate.kind == SceneGateKind::IntentAlignment && !gate.ready }));

        let result = belt.execute(write()).await.unwrap();
        let output: Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(
            output["intent_alignment"]["status"], "aligned",
            "{output:#}"
        );
        assert_eq!(
            output["intent_alignment"]["unexpected_changes"],
            serde_json::json!([])
        );
        assert!(root.join("forest.yaml").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn revision_intent_requires_the_existing_scene_to_be_read_first() {
        let root = temp_project();
        let content = include_str!("../../tests/fixtures/scenes/forest.yaml");
        std::fs::write(root.join("forest.yaml"), content).unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let intent = || FunctionCall {
            id: None,
            call_id: "intent".into(),
            name: "declare_arrangement_intent".into(),
            arguments: serde_json::json!({
                "path": "forest.yaml",
                "task_mode": "revision",
                "goal": "Make the cue slightly more urgent.",
                "form_intent": "Preserve the existing loop form.",
                "palette_intent": "Preserve the existing instrumentation.",
                "expected_changes": ["tempo"],
                "invariants": ["loop", "tracks"]
            })
            .to_string(),
        };

        let error = belt.execute(intent()).await.unwrap_err();
        assert!(
            matches!(error, BenchError::Agent { ref code, .. } if code == "arrangement_scene_not_read")
        );

        belt.execute(FunctionCall {
            id: None,
            call_id: "read".into(),
            name: "read_scene".into(),
            arguments: serde_json::json!({"path":"forest.yaml"}).to_string(),
        })
        .await
        .unwrap();
        belt.execute(intent()).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn revision_write_refuses_a_baseline_changed_after_intent_declaration() {
        let root = temp_project();
        let content = include_str!("../../tests/fixtures/scenes/forest.yaml");
        std::fs::write(root.join("forest.yaml"), content).unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        belt.execute(FunctionCall {
            id: None,
            call_id: "read".into(),
            name: "read_scene".into(),
            arguments: serde_json::json!({"path":"forest.yaml"}).to_string(),
        })
        .await
        .unwrap();
        belt.execute(FunctionCall {
            id: None,
            call_id: "intent".into(),
            name: "declare_arrangement_intent".into(),
            arguments: serde_json::json!({
                "path": "forest.yaml",
                "task_mode": "revision",
                "goal": "Increase urgency through tempo only.",
                "form_intent": "Preserve the seamless loop.",
                "palette_intent": "Preserve the existing instrumentation.",
                "expected_changes": ["tempo"],
                "invariants": ["loop", "tracks"]
            })
            .to_string(),
        })
        .await
        .unwrap();

        let external = content.replace("tempo: 92", "tempo: 94");
        std::fs::write(root.join("forest.yaml"), &external).unwrap();
        let intended = content.replace("tempo: 92", "tempo: 96");
        let error = belt
            .execute(FunctionCall {
                id: None,
                call_id: "write".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"forest.yaml","content":intended}).to_string(),
            })
            .await
            .unwrap_err();
        assert!(
            matches!(error, BenchError::Agent { ref code, .. } if code == "arrangement_intent_stale")
        );
        assert_eq!(
            std::fs::read_to_string(root.join("forest.yaml")).unwrap(),
            external
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn revision_intent_keeps_its_canonical_identity_across_an_alias_write() {
        use std::os::unix::fs::symlink;

        let root = temp_project();
        let content = include_str!("../../tests/fixtures/scenes/forest.yaml");
        std::fs::write(root.join("forest.yaml"), content).unwrap();
        symlink("forest.yaml", root.join("alias.yaml")).unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        declare_revision(&belt, "alias.yaml", &["tempo"], &["tracks"]).await;

        let revised = content.replace("tempo: 92", "tempo: 96");
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "write".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"alias.yaml","content":revised}).to_string(),
            })
            .await
            .unwrap();
        let output: Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(output["intent_alignment"]["status"], "aligned");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn revision_alignment_compares_every_retry_with_the_declared_baseline() {
        let root = temp_project();
        let content = include_str!("../../tests/fixtures/scenes/forest.yaml");
        std::fs::write(root.join("forest.yaml"), content).unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        belt.execute(FunctionCall {
            id: None,
            call_id: "read".into(),
            name: "read_scene".into(),
            arguments: serde_json::json!({"path":"forest.yaml"}).to_string(),
        })
        .await
        .unwrap();
        belt.execute(FunctionCall {
            id: None,
            call_id: "intent".into(),
            name: "declare_arrangement_intent".into(),
            arguments: serde_json::json!({
                "path": "forest.yaml",
                "task_mode": "revision",
                "goal": "Increase urgency through tempo only.",
                "form_intent": "Preserve the seamless loop.",
                "palette_intent": "Preserve the existing instrumentation.",
                "expected_changes": ["tempo"],
                "invariants": ["loop", "tracks"]
            })
            .to_string(),
        })
        .await
        .unwrap();

        let drifted = content
            .replace("tempo: 92", "tempo: 96")
            .replace("intensity: 0.4", "intensity: 0.8");
        let blocked = belt
            .execute(FunctionCall {
                id: None,
                call_id: "drift".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"forest.yaml","content":drifted}).to_string(),
            })
            .await
            .unwrap();
        let output: Value = serde_json::from_str(&blocked.output).unwrap();
        assert_eq!(output["intent_alignment"]["status"], "blocked");
        assert_eq!(
            output["intent_alignment"]["unexpected_changes"],
            serde_json::json!(["tracks"])
        );
        assert_eq!(
            output["intent_alignment"]["invariant_violations"],
            serde_json::json!(["tracks"])
        );
        assert!(blocked
            .scene_gates
            .iter()
            .any(|gate| { gate.kind == SceneGateKind::IntentAlignment && !gate.ready }));

        let repaired = content.replace("tempo: 92", "tempo: 96");
        let aligned = belt
            .execute(FunctionCall {
                id: None,
                call_id: "repair".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"forest.yaml","content":repaired}).to_string(),
            })
            .await
            .unwrap();
        let output: Value = serde_json::from_str(&aligned.output).unwrap();
        assert_eq!(output["intent_alignment"]["status"], "aligned");
        assert!(aligned
            .scene_gates
            .iter()
            .any(|gate| { gate.kind == SceneGateKind::IntentAlignment && gate.ready }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn history_failure_does_not_block_scene_edit() {
        let root = temp_project();
        std::fs::write(root.join("scene.yaml"), "title: Before\nbars: 8\n").unwrap();
        std::fs::write(root.join(".scorebench"), "blocks history directory").unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        declare_revision(&belt, "scene.yaml", &["title"], &["bars"]).await;
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({
                    "path": "scene.yaml",
                    "content": "title: After\nbars: 8\n"
                })
                .to_string(),
            })
            .await
            .unwrap();
        assert!(std::fs::read_to_string(root.join("scene.yaml"))
            .unwrap()
            .contains("After"));
        assert!(result.detail.unwrap().contains("history snapshot failed"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_scene_records_scorekit_semantic_diff() {
        if scorekit::locate().is_err() {
            return;
        }
        let root = temp_project();
        let before = include_str!("../../tests/fixtures/scenes/forest.yaml");
        std::fs::write(root.join("forest.yaml"), before).unwrap();
        let after = before.replace("tempo: 92", "tempo: 96");
        let belt = ToolBelt::new(root.clone()).unwrap();
        declare_revision(&belt, "forest.yaml", &["tempo"], &["tracks"]).await;
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"forest.yaml","content":after}).to_string(),
            })
            .await
            .unwrap();
        assert!(result
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("tempo"));
        assert!(root
            .join(observation::diff_rel_path("forest.yaml"))
            .is_file());
        assert!(std::fs::read_dir(root.join(".scorebench/history"))
            .unwrap()
            .next()
            .is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_scene_reports_validation_inline() {
        if scorekit::locate().is_err() {
            return;
        }
        let root = temp_project();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let valid = include_str!("../../tests/fixtures/scenes/forest.yaml");
        declare_new_scene(&belt, "forest.yaml").await;
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"forest.yaml","content":valid}).to_string(),
            })
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(output["validation"]["status"], "valid");
        assert_eq!(result.summary, "scene written and validated");

        let invalid = valid.replace("tempo: 92", "tempo: -4");
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({"path":"forest.yaml","content":invalid}).to_string(),
            })
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(output["ok"], true, "write persists even when invalid");
        assert_eq!(output["validation"]["status"], "invalid");
        assert_eq!(output["validation"]["error"]["kind"], "scorekit");
        assert!(result.summary.contains("INVALID"));
        assert!(std::fs::read_to_string(root.join("forest.yaml"))
            .unwrap()
            .contains("tempo: -4"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_scene_rejects_the_removed_validation_bypass() {
        let root = temp_project();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let error = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({
                    "path": "profiles/open.yaml",
                    "content": "name: open\ninstruments: {}\n",
                    "validate": false
                })
                .to_string(),
            })
            .await
            .unwrap_err();
        assert!(matches!(error, BenchError::Agent { ref code, .. } if code == "invalid_tool_args"));
        assert!(
            !root.join("profiles/open.yaml").exists(),
            "rejected arguments must not write a non-scene YAML file"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_scene_flags_instruments_unmapped_by_active_orchestration() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/open.yaml"),
            "name: scoredata-open\ninstruments:\n  piano:\n    sustain: piano.sfz\n",
        )
        .unwrap();
        std::fs::write(
            root.join("hybrid.yaml"),
            "schema_version: 1\nname: hybrid-cinematic\ndefault_palette: default\npalettes:\n  default: { profile: profiles/open.yaml }\n",
        )
        .unwrap();
        std::fs::write(
            root.join(manifest::MANIFEST_FILE),
            r#"{"render":{"renderer":"sfizz","orchestration":"hybrid.yaml"}}"#,
        )
        .unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        declare_new_scene(&belt, "scene.yaml").await;
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({
                    "path": "scene.yaml",
                    "content": "title: Hymn\ntracks:\n  - { id: choir_pad, instrument: choir, pattern: pad }\n"
                })
                .to_string(),
            })
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(
            output["orchestration"]["tracks"][0]["track_id"],
            "choir_pad"
        );
        assert!(output["orchestration"]["tracks"][0]["error"]
            .as_str()
            .unwrap()
            .contains("choir"));
        assert!(result.summary.contains("`choir_pad`"), "{}", result.summary);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_scene_tools_create_independent_retry_gates() {
        let error = BenchError::agent("fixture", "failed");
        let cases = [
            (
                FunctionCall {
                    id: None,
                    call_id: "validate".into(),
                    name: "validate_scene".into(),
                    arguments: r#"{"path":"scene.yaml"}"#.into(),
                },
                SceneGateKind::Readiness,
            ),
            (
                FunctionCall {
                    id: None,
                    call_id: "build".into(),
                    name: "build_scene".into(),
                    arguments: r#"{"path":"scene.yaml"}"#.into(),
                },
                SceneGateKind::Build,
            ),
            (
                FunctionCall {
                    id: None,
                    call_id: "instruments".into(),
                    name: "inspect_instruments".into(),
                    arguments: r#"{"path":"scene.yaml"}"#.into(),
                },
                SceneGateKind::InstrumentResolution,
            ),
            (
                FunctionCall {
                    id: None,
                    call_id: "intent".into(),
                    name: "declare_arrangement_intent".into(),
                    arguments: r#"{"path":"scene.yaml","task_mode":"new_scene","goal":"Create a cue.","form_intent":"Loop.","palette_intent":"Piano.","expected_changes":["tracks"],"invariants":[]}"#.into(),
                },
                SceneGateKind::IntentAlignment,
            ),
        ];

        for (call, expected) in cases {
            let updates = failure_gates(&call, &error);
            assert_eq!(updates.len(), 1);
            assert_eq!(updates[0].kind, expected);
            assert_eq!(updates[0].path, "scene.yaml");
            assert!(!updates[0].ready);
        }

        let write = FunctionCall {
            id: None,
            call_id: "write".into(),
            name: "write_scene".into(),
            arguments: r#"{"path":"scene.yaml","content":"tracks: []"}"#.into(),
        };
        let updates = failure_gates(&write, &error);
        assert_eq!(updates.len(), 2);
        assert!(updates
            .iter()
            .any(|update| update.kind == SceneGateKind::Readiness));
        assert!(updates
            .iter()
            .any(|update| update.kind == SceneGateKind::IntentAlignment));
    }

    #[test]
    fn explicit_build_override_cannot_clear_incompatible_active_texture_profile() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("scene.yaml"),
            "textures:\n  - { source: birds, mode: loop }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("profiles/active.yaml"),
            "schema_version: 1\nname: active\nsources:\n  birds:\n    path: birds.wav\n    description: One bird call\n    category: organic\n    tags: [bird]\n    playback:\n      modes: [one_shot]\n      default_mode: one_shot\n    use_cases: [forest]\n    provenance:\n      library: fixture@1.0.0\n",
        )
        .unwrap();
        std::fs::write(
            root.join(manifest::MANIFEST_FILE),
            r#"{"render":{"texture_profile":"profiles/active.yaml"}}"#,
        )
        .unwrap();

        let mut output = json!({"ok": true, "texture_profile": "profiles/override.yaml"});
        let mut summary = "built out/scene.ogg".to_owned();
        let ready =
            append_active_compatibility(&root, &root.join("scene.yaml"), &mut output, &mut summary)
                .unwrap();

        assert!(!ready);
        assert_eq!(
            output["active_texture_profile_compat"]["mode_mismatches"][0]["requested"],
            "loop"
        );
        assert!(summary.contains("active"));
        assert!(summary.contains("one_shot"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn scorekit_06_contract_tools_query_live_capabilities() {
        if !require_scorekit_06_contract() {
            return;
        }
        let root = temp_project();
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("forest.yaml"),
            include_str!("../../tests/fixtures/scenes/forest.yaml"),
        )
        .unwrap();
        write_tiny_wav(&root.join("profiles/tone.wav"));
        std::fs::write(
            root.join("profiles/textures.yaml"),
            "schema_version: 1\nname: contract-textures\nsources:\n  tone:\n    path: tone.wav\n    description: Deterministic contract tone\n    category: tonal\n    tags: [tone, test]\n    playback:\n      modes: [loop]\n      default_mode: loop\n    use_cases: [test]\n    provenance:\n      library: scorebench-contract@1.0.0\n",
        )
        .unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();

        let instruments = belt
            .execute(FunctionCall {
                id: None,
                call_id: "instruments".into(),
                name: "inspect_instruments".into(),
                arguments: serde_json::json!({
                    "path":"forest.yaml",
                    "orchestration":null,
                    "resolver":null,
                    "fallback_mode":"conservative",
                    "verbose":false
                })
                .to_string(),
            })
            .await
            .unwrap();
        let instruments: Value = serde_json::from_str(&instruments.output).unwrap();
        assert_eq!(instruments["report"]["summary"]["missing"], 0);
        assert_eq!(instruments["report"]["tracks"][0]["status"], "exact");

        std::fs::write(
            root.join("world.yaml"),
            "tempo: 80\nbars: 2\ntracks:\n  - { id: lead, instrument: erhu, pattern: sustain }\n",
        )
        .unwrap();
        let world_error = belt
            .execute(FunctionCall {
                id: None,
                call_id: "world".into(),
                name: "inspect_instruments".into(),
                arguments: serde_json::json!({
                    "path":"world.yaml",
                    "orchestration":null,
                    "resolver":null,
                    "fallback_mode":"flexible",
                    "verbose":false
                })
                .to_string(),
            })
            .await
            .unwrap_err();
        let BenchError::Scorekit { code, report, .. } = world_error else {
            panic!("world-instrument resolution must be a structured scorekit error");
        };
        assert_eq!(code, "resolution");
        assert_eq!(
            report.unwrap()["tracks"][0]["best_candidate"]["rejected"],
            "world_instrument_requires_exact_source"
        );

        let textures = belt
            .execute(FunctionCall {
                id: None,
                call_id: "textures".into(),
                name: "inspect_textures".into(),
                arguments: serde_json::json!({
                    "profile":"profiles/textures.yaml",
                    "source":null,
                    "category":"tonal",
                    "tags":["tone"],
                    "mode":"loop",
                    "use_case":"test"
                })
                .to_string(),
            })
            .await
            .unwrap();
        let textures: Value = serde_json::from_str(&textures.output).unwrap();
        assert_eq!(textures["report"]["status"], "match");
        assert_eq!(textures["report"]["sources"][0]["source"], "tone");

        let no_match = belt
            .execute(FunctionCall {
                id: None,
                call_id: "no-match".into(),
                name: "inspect_textures".into(),
                arguments: serde_json::json!({
                    "profile":"profiles/textures.yaml",
                    "source":null,
                    "category":null,
                    "tags":["absent"],
                    "mode":null,
                    "use_case":null
                })
                .to_string(),
            })
            .await
            .unwrap();
        let no_match: Value = serde_json::from_str(&no_match.output).unwrap();
        assert_eq!(no_match["report"]["status"], "no_match");
        assert_eq!(no_match["report"]["matched"], 0);

        let check = belt
            .execute(FunctionCall {
                id: None,
                call_id: "check".into(),
                name: "check_texture_profile".into(),
                arguments: serde_json::json!({
                    "profile":"profiles/textures.yaml",
                    "sample_rate":8000
                })
                .to_string(),
            })
            .await
            .unwrap();
        let check: Value = serde_json::from_str(&check.output).unwrap();
        assert_eq!(check["report"]["passed"], 1);
        assert_eq!(check["report"]["failed"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn build_inherits_project_render_config_unless_overridden() {
        let project_render = manifest::RenderConfig {
            renderer: Some("sfizz".into()),
            orchestration: Some("hybrid.yaml".into()),
            texture_profile: Some("profiles/forest-textures.yaml".into()),
        };

        let mut renderer = None;
        let (inherited, texture) =
            inherit_render_config(&mut renderer, &None, &None, &project_render);
        assert_eq!(renderer.as_deref(), Some("sfizz"));
        assert_eq!(inherited.as_deref(), Some("hybrid.yaml"));
        assert_eq!(texture.as_deref(), Some("profiles/forest-textures.yaml"));

        // Explicit renderer wins; texture profiles are renderer-independent.
        let mut renderer = Some("fluidsynth".to_owned());
        let (inherited, texture) =
            inherit_render_config(&mut renderer, &None, &None, &project_render);
        assert_eq!(renderer.as_deref(), Some("fluidsynth"));
        assert!(inherited.is_none());
        assert_eq!(texture.as_deref(), Some("profiles/forest-textures.yaml"));

        // Explicit orchestration wins over the project orchestration.
        let mut renderer = None;
        let explicit = Some("other.yaml".to_owned());
        let (inherited, texture) =
            inherit_render_config(&mut renderer, &explicit, &explicit, &project_render);
        assert!(inherited.is_none());
        assert!(texture.is_none());

        // Empty project config changes nothing.
        let mut renderer = None;
        let (inherited, texture) = inherit_render_config(
            &mut renderer,
            &None,
            &None,
            &manifest::RenderConfig::default(),
        );
        assert!(renderer.is_none());
        assert!(inherited.is_none());
        assert!(texture.is_none());
    }

    #[test]
    fn tool_names_are_stable_and_unique() {
        let definitions = definitions();
        let mut names = definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 12);
        for expected in [
            "declare_arrangement_intent",
            "inspect_instruments",
            "inspect_textures",
            "check_texture_profile",
        ] {
            assert!(names.contains(&expected), "missing tool `{expected}`");
        }
    }

    #[test]
    fn strict_tool_schemas_require_every_property_and_make_options_nullable() {
        for definition in definitions() {
            let properties = definition.parameters["properties"].as_object().unwrap();
            let required = definition.parameters["required"].as_array().unwrap();
            let mut property_names = properties.keys().cloned().collect::<Vec<_>>();
            let mut required_names = required
                .iter()
                .map(|value| value.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            property_names.sort_unstable();
            required_names.sort_unstable();
            assert_eq!(required_names, property_names, "{}", definition.name);
        }

        let build = definitions()
            .into_iter()
            .find(|definition| definition.name == "build_scene")
            .unwrap();
        assert_eq!(
            build.parameters["properties"]["format"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(
            build.parameters["properties"]["format"]["enum"],
            serde_json::json!(["ogg", "wav", null])
        );
        assert_eq!(
            build.parameters["properties"]["path"]["type"],
            serde_json::json!("string")
        );
        assert_eq!(
            build.parameters["properties"]["texture_profile"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(
            build.parameters["properties"]["orchestration"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(
            build.parameters["properties"]["sample_rate"]["maximum"],
            serde_json::json!(384_000)
        );

        let write = definitions()
            .into_iter()
            .find(|definition| definition.name == "write_scene")
            .unwrap();
        assert!(
            write.parameters["properties"].get("validate").is_none(),
            "scene validation must not be model-optional"
        );

        let intent = definitions()
            .into_iter()
            .find(|definition| definition.name == "declare_arrangement_intent")
            .unwrap();
        assert_eq!(
            intent.parameters["properties"]["task_mode"]["enum"],
            serde_json::json!(["new_scene", "revision", "repair"])
        );
        assert_eq!(
            intent.parameters["properties"]["expected_changes"]["minItems"],
            serde_json::json!(1)
        );
        assert_eq!(
            intent.parameters["properties"]["expected_changes"]["uniqueItems"],
            serde_json::json!(true)
        );

        let texture_check = definitions()
            .into_iter()
            .find(|definition| definition.name == "check_texture_profile")
            .unwrap();
        assert_eq!(
            texture_check.parameters["properties"]["sample_rate"]["maximum"],
            serde_json::json!(384_000)
        );
    }
}
