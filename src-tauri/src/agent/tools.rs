use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::BenchError;
use crate::llm::types::{FunctionCall, ToolDefinition};
use crate::{manifest, observation, project, scorekit};

pub struct ToolBelt {
    root: PathBuf,
}

#[derive(Debug)]
pub struct ToolResult {
    pub output: String,
    pub summary: String,
    pub detail: Option<String>,
}

impl ToolBelt {
    pub fn new(root: PathBuf) -> Result<Self, BenchError> {
        Ok(Self {
            root: root.canonicalize().map_err(BenchError::io)?,
        })
    }

    pub async fn execute(&self, call: FunctionCall) -> Result<ToolResult, BenchError> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || execute_sync(&root, &call))
            .await
            .map_err(BenchError::io)?
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
            "write_scene",
            "Atomically write one scene YAML file inside the project. Runs `scorekit validate` and the renderer-profile compatibility check afterwards and reports the result inline; pass validate:false only when writing non-scene YAML (grammar or renderer profile files).",
            json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"validate":{"type":"boolean","description":"Validate the written file as a scene (default true)."}},"required":["path","content"]}),
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
                    "sample_rate":{"type":"integer","minimum":8000,"maximum":192000},
                    "gain":{"type":"number","minimum":0},
                    "quality":{"type":"integer","minimum":0,"maximum":10},
                    "stems":{"type":"boolean"},
                    "soundfont":{"type":"string"},
                    "profile":{"type":"string"}
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

fn execute_sync(root: &Path, call: &FunctionCall) -> Result<ToolResult, BenchError> {
    match call.name.as_str() {
        "read_scene" => {
            let args: PathArgs = args(call)?;
            require_scene_path(&args.path)?;
            let content = project::read_text_inside(root, &args.path)?;
            success(
                json!({"ok":true,"path":args.path,"content":content}),
                "scene read",
            )
        }
        "write_scene" => {
            let args: WriteArgs = args(call)?;
            require_scene_path(&args.path)?;
            write_scene(root, args)
        }
        "validate_scene" => {
            let args: PathArgs = args(call)?;
            let path = scene(root, &args.path)?;
            scorekit::validate(&path)?;
            let mut output = json!({"ok":true,"path":args.path});
            let mut summary = String::from("scene valid");
            if let Some(compat) = profile_check(root, &path) {
                if !compat.is_compatible() {
                    summary = format!("scene valid, but {}", compat.message());
                }
                output["render_profile"] = serde_json::to_value(&compat).map_err(BenchError::io)?;
            }
            success(output, summary)
        }
        "lint_scene" => {
            let args: LintArgs = args(call)?;
            let path = scene(root, &args.path)?;
            let grammar = project::resolve_inside(root, &args.grammar)?;
            scorekit::lint(&path, &grammar)?;
            success(json!({"ok":true,"path":args.path}), "scene passes grammar")
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
            let inherited_profile =
                inherit_render_config(&mut renderer, &args.profile, &project_render);
            let profile = match (resolve_optional(root, args.profile)?, inherited_profile) {
                (Some(explicit), _) => Some(explicit),
                // The project profile may live outside the root (GUI allows
                // it), so resolve like the GUI render path does.
                (None, Some(inherited)) => Some(
                    manifest::resolve_profile_path(root, &inherited)
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
                profile,
            };
            let result = scorekit::build(&path, &output, &params)?;
            success(
                json!({
                    "ok":true,
                    "output":rel_output,
                    "renderer":params.renderer,
                    "profile":params.profile,
                    "meta_path":result.meta_path.strip_prefix(root).unwrap_or(&result.meta_path),
                    "meta":result.meta
                }),
                format!("built {rel_output}"),
            )
        }
        "diff_scenes" => {
            let args: DiffArgs = args(call)?;
            let old = scene(root, &args.old)?;
            let new = scene(root, &args.new)?;
            let diff = scorekit::diff(&old, &new)?;
            success(json!({"ok":true,"diff":diff}), "semantic diff ready")
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
    let mut summary = String::from("scene written atomically");
    let mut output = json!({
        "ok": true,
        "path": args.path,
        "bytes": args.content.len(),
        "diff": diff,
        "warnings": warnings
    });
    if args.validate.unwrap_or(true) {
        let validation = match scorekit::validate(&target) {
            Ok(()) => {
                summary = "scene written and validated".into();
                json!({"status": "valid"})
            }
            Err(error @ BenchError::Scorekit { .. }) => {
                summary = format!("scene written but INVALID: {error}");
                json!({
                    "status": "invalid",
                    "error": error,
                    "hint": "fix the scene with write_scene until validation passes"
                })
            }
            // scorekit missing or not runnable: the write itself stands.
            Err(error) => {
                summary = "scene written (validation unavailable)".into();
                json!({"status": "unavailable", "message": error.to_string()})
            }
        };
        output["validation"] = validation;
        if let Some(compat) = profile_check(root, &target) {
            if !compat.is_compatible() {
                summary = format!("{summary}; {}", compat.message());
            }
            output["render_profile"] = serde_json::to_value(&compat).map_err(BenchError::io)?;
        }
    } else {
        output["validation"] = json!({"status": "skipped"});
    }
    Ok(ToolResult {
        output: output.to_string(),
        summary,
        detail,
    })
}

/// Compatibility of one scene against the project's persisted render
/// configuration (bench.json). `None` when no sfizz profile is active.
fn profile_check(root: &Path, scene_path: &Path) -> Option<manifest::ProfileCompat> {
    let render = manifest::load(root).0.render?;
    manifest::check_scene_profile(root, scene_path, &render)
}

/// Fill build parameters the model omitted from the project render config.
/// Returns the inherited profile path, if any. Pure function for testing.
fn inherit_render_config(
    renderer: &mut Option<String>,
    explicit_profile: &Option<String>,
    project_render: &manifest::RenderConfig,
) -> Option<String> {
    if renderer.is_none() {
        renderer.clone_from(&project_render.renderer);
    }
    if explicit_profile.is_none() && renderer.as_deref() == Some("sfizz") {
        project_render.profile.clone()
    } else {
        None
    }
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
    #[serde(default)]
    validate: Option<bool>,
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
    profile: Option<String>,
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
    async fn history_failure_does_not_block_scene_edit() {
        let root = temp_project();
        std::fs::write(root.join("scene.yaml"), "title: Before\nbars: 8\n").unwrap();
        std::fs::write(root.join(".scorebench"), "blocks history directory").unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
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
    async fn write_scene_validate_false_skips_validation() {
        let root = temp_project();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let result = belt
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
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(output["validation"]["status"], "skipped");
        assert!(output.get("render_profile").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_scene_flags_instruments_unmapped_by_active_profile() {
        let root = temp_project();
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/open.yaml"),
            "name: scoredata-open\ninstruments:\n  piano:\n    sustain: piano.sfz\n",
        )
        .unwrap();
        std::fs::write(
            root.join(manifest::MANIFEST_FILE),
            r#"{"render":{"renderer":"sfizz","profile":"profiles/open.yaml"}}"#,
        )
        .unwrap();
        let belt = ToolBelt::new(root.clone()).unwrap();
        let result = belt
            .execute(FunctionCall {
                id: None,
                call_id: "call".into(),
                name: "write_scene".into(),
                arguments: serde_json::json!({
                    "path": "scene.yaml",
                    "content": "title: Hymn\ntracks:\n  - instrument: choir\n    pattern: pad\n"
                })
                .to_string(),
            })
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(output["render_profile"]["unmapped"][0], "choir");
        assert!(result.summary.contains("`choir`"), "{}", result.summary);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn build_inherits_project_render_config_unless_overridden() {
        let project_render = manifest::RenderConfig {
            renderer: Some("sfizz".into()),
            profile: Some("profiles/open.yaml".into()),
        };

        let mut renderer = None;
        let inherited = inherit_render_config(&mut renderer, &None, &project_render);
        assert_eq!(renderer.as_deref(), Some("sfizz"));
        assert_eq!(inherited.as_deref(), Some("profiles/open.yaml"));

        // Explicit renderer wins; a non-sfizz renderer takes no profile.
        let mut renderer = Some("fluidsynth".to_owned());
        let inherited = inherit_render_config(&mut renderer, &None, &project_render);
        assert_eq!(renderer.as_deref(), Some("fluidsynth"));
        assert!(inherited.is_none());

        // Explicit profile wins over the project profile.
        let mut renderer = None;
        let explicit = Some("other.yaml".to_owned());
        let inherited = inherit_render_config(&mut renderer, &explicit, &project_render);
        assert!(inherited.is_none());

        // Empty project config changes nothing.
        let mut renderer = None;
        let inherited =
            inherit_render_config(&mut renderer, &None, &manifest::RenderConfig::default());
        assert!(renderer.is_none());
        assert!(inherited.is_none());
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
        assert_eq!(names.len(), 8);
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

        let write = definitions()
            .into_iter()
            .find(|definition| definition.name == "write_scene")
            .unwrap();
        assert_eq!(
            write.parameters["properties"]["validate"]["type"],
            serde_json::json!(["boolean", "null"])
        );
    }
}
