//! Minimal hand-rolled ReACT loop over the OpenAI Responses API contract.
//!
//! The loop owns orchestration only. HTTP/SSE lives in `llm`; deterministic
//! project and scorekit operations live in `tools`.

mod intent;
mod tools;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::error::BenchError;
use crate::llm::types::{InputItem, InputRole, MessageContent, ResponseEvent, ResponsesRequest};
use crate::llm::{ResponseStream, ResponsesClient};
use crate::{arrangement, manifest, memory, project, scorekit, styles};
use tools::{SceneGateKind, SceneGateUpdate, ToolBelt, ToolResult};

const TOOL_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Text {
        text: String,
    },
    /// Accepts the current streamed draft into this in-flight run. It remains
    /// transactional in the frontend until `TextFinalize` follows persistence.
    TextCommit,
    /// Drops the preceding streamed draft because a tool failed or a scene
    /// validation gate remains active.
    TextDiscard,
    /// Confirms that every accepted draft from this run is now on disk.
    TextFinalize,
    /// Removes every accepted/provisional draft from a run that later failed.
    TextRollback,
    Warning {
        text: String,
    },
    Compacted {
        turns: u32,
    },
    ToolStart {
        name: String,
        detail: String,
    },
    ToolOk {
        name: String,
        summary: String,
        detail: Option<String>,
    },
    ToolErr {
        name: String,
        error: BenchError,
    },
    Done,
}

pub trait AgentTransport: Sync {
    fn stream<'a>(
        &'a self,
        request: ResponsesRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<ResponseStream, BenchError>> + Send + 'a>>;
}

impl AgentTransport for ResponsesClient {
    fn stream<'a>(
        &'a self,
        request: ResponsesRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<ResponseStream, BenchError>> + Send + 'a>> {
        Box::pin(async move { ResponsesClient::stream(self, request, cancellation).await })
    }
}

pub trait ToolExecutor: Sync {
    fn execute<'a>(
        &'a self,
        call: crate::llm::types::FunctionCall,
    ) -> Pin<Box<dyn Future<Output = Result<ToolResult, BenchError>> + Send + 'a>>;

    fn failure_gates(
        &self,
        call: &crate::llm::types::FunctionCall,
        error: &BenchError,
    ) -> Vec<SceneGateUpdate> {
        tools::failure_gates(call, error)
    }
}

impl ToolExecutor for ToolBelt {
    fn execute<'a>(
        &'a self,
        call: crate::llm::types::FunctionCall,
    ) -> Pin<Box<dyn Future<Output = Result<ToolResult, BenchError>> + Send + 'a>> {
        Box::pin(async move { ToolBelt::execute(self, call).await })
    }

    fn failure_gates(
        &self,
        call: &crate::llm::types::FunctionCall,
        error: &BenchError,
    ) -> Vec<SceneGateUpdate> {
        ToolBelt::failure_gates(self, call, error)
    }
}

type SessionKey = (PathBuf, String);

#[derive(Default)]
pub struct AgentState {
    histories: Mutex<HashMap<SessionKey, Vec<InputItem>>>,
    active: Mutex<HashMap<SessionKey, CancellationToken>>,
}

impl AgentState {
    pub fn begin(
        &self,
        root: &Path,
        session: &str,
        content: MessageContent,
    ) -> Result<(PathBuf, Vec<InputItem>, CancellationToken, Vec<String>), BenchError> {
        let root = root.canonicalize().map_err(BenchError::io)?;
        let key = (root.clone(), session.to_owned());
        let mut histories = self
            .histories
            .lock()
            .map_err(|_| BenchError::agent("state_poisoned", "agent history lock is poisoned"))?;
        let loaded = if histories.contains_key(&key) {
            memory::LoadedTranscript::default()
        } else {
            memory::load_transcript(&root, session)?
        };
        if !histories.contains_key(&key) {
            histories.insert(key.clone(), loaded.items);
        }
        let item = InputItem::Message {
            role: InputRole::User,
            content,
        };
        memory::append_items(&root, session, std::slice::from_ref(&item))?;
        let history = histories.get_mut(&key).expect("history inserted");
        history.push(item);
        let history = history.clone();
        drop(histories);
        let token = self.activate(&root, session)?;
        Ok((root, history, token, loaded.warnings))
    }

    pub fn complete(
        &self,
        root: &Path,
        session: &str,
        history: Vec<InputItem>,
    ) -> Result<(), BenchError> {
        let key = (root.to_owned(), session.to_owned());
        let mut histories = self
            .histories
            .lock()
            .map_err(|_| BenchError::agent("state_poisoned", "agent history lock is poisoned"))?;
        let persisted = histories.get(&key).map(Vec::len).unwrap_or(0);
        if history.len() < persisted {
            return Err(BenchError::agent(
                "history_diverged",
                "agent history became shorter before persistence",
            ));
        }
        memory::append_items(root, session, &history[persisted..])?;
        histories.insert(key, history);
        drop(histories);
        Ok(())
    }

    pub fn history(
        &self,
        root: &Path,
        session: &str,
    ) -> Result<(PathBuf, Vec<InputItem>, Vec<String>), BenchError> {
        let root = root.canonicalize().map_err(BenchError::io)?;
        let key = (root.clone(), session.to_owned());
        let mut histories = self
            .histories
            .lock()
            .map_err(|_| BenchError::agent("state_poisoned", "agent history lock is poisoned"))?;
        let loaded = if histories.contains_key(&key) {
            memory::LoadedTranscript::default()
        } else {
            memory::load_transcript(&root, session)?
        };
        let history = histories.entry(key).or_insert(loaded.items).clone();
        Ok((root, history, loaded.warnings))
    }

    pub fn replace_history(
        &self,
        root: &Path,
        session: &str,
        history: Vec<InputItem>,
    ) -> Result<(), BenchError> {
        self.histories
            .lock()
            .map_err(|_| BenchError::agent("state_poisoned", "agent history lock is poisoned"))?
            .insert((root.to_owned(), session.to_owned()), history);
        Ok(())
    }

    pub fn activate(&self, root: &Path, session: &str) -> Result<CancellationToken, BenchError> {
        let token = CancellationToken::new();
        let mut active = self.active.lock().map_err(|_| {
            BenchError::agent("state_poisoned", "agent cancellation lock is poisoned")
        })?;
        if let Some(previous) = active.insert((root.to_owned(), session.to_owned()), token.clone())
        {
            previous.cancel();
        }
        Ok(token)
    }

    pub fn clear_active(&self, root: &Path, session: &str) -> Result<(), BenchError> {
        self.active
            .lock()
            .map_err(|_| {
                BenchError::agent("state_poisoned", "agent cancellation lock is poisoned")
            })?
            .remove(&(root.to_owned(), session.to_owned()));
        Ok(())
    }

    pub fn cancel(&self, root: &Path, session: &str) -> Result<bool, BenchError> {
        let root = root.canonicalize().map_err(BenchError::io)?;
        let token = self
            .active
            .lock()
            .map_err(|_| {
                BenchError::agent("state_poisoned", "agent cancellation lock is poisoned")
            })?
            .get(&(root, session.to_owned()))
            .cloned();
        if let Some(token) = token {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

pub fn system_prompt(
    root: &Path,
    session: &str,
    style: Option<&styles::StylePack>,
) -> Result<String, BenchError> {
    let snapshot = project::scan(root)?;
    let schema = match scorekit::schema() {
        Ok(schema) => schema,
        Err(error) => serde_json::json!({
            "unavailable": true,
            "error": error,
            "instruction": "Use doctor and validation tools to diagnose scorekit before writing."
        }),
    };
    let snapshot = serde_json::to_string_pretty(&snapshot).map_err(BenchError::io)?;
    let schema = serde_json::to_string(&schema).map_err(BenchError::io)?;
    let project_memory = memory::read_memory(root, session)?;
    let project_memory = if project_memory.is_empty() {
        "(empty)"
    } else {
        &project_memory
    };
    let style_section = style.map(styles::prompt_section).unwrap_or_default();
    let render_section = render_config_section(root);
    let arrangement_section = arrangement::prompt_section();
    let capability_section = scorekit_capability_section();
    Ok(format!(
        "You are scorebench, the composing agent for one scorekit project.\n\
         You are the only writer of scene YAML. Never invent an editing UI or render audio yourself.\n\
         Use the provided tools; scorekit validation errors are authoritative.\n\
         Keep paths project-relative. Before changing an existing scene, follow \
         read_scene -> declare_arrangement_intent -> write_scene. For a missing target, declare \
         new_scene intent before write_scene. The declaration is a concise, auditable decision \
         record, not private chain-of-thought.\n\
         For new_scene, choose form and creative instrumentation deliberately; apply cross-piece \
         diversity only when real comparison evidence exists. For revision or repair, preserve \
         declared invariants and make the smallest semantic diff that satisfies the request; do \
         not re-palette merely to satisfy new-piece diversity advice.\n\
         write_scene validates automatically and compares the result with the original declared \
         baseline. Repair every intent-alignment or toolchain gate before building or finishing, \
         and explain musical decisions concisely.\n\
         Authority order: live ScoreKit schema and machine failures are mandatory; explicit user \
         constraints govern the musical result; the Arrangement Canon supplies hard source/delivery \
         rules plus advisory craft defaults; the active StylePack narrows stylistic choices. \
         Disclose and justify any user-requested exception to a non-machine Canon rule.\n\
         For textures, inspect exact catalog matches before writing source keys; no_match never authorizes invention.\n\
         For world instruments and non-default palettes, inspect instrument resolution before promising or building.\n\n\
         {capability_section}{arrangement_section}\n\
         CURRENT PROJECT SNAPSHOT:\n{snapshot}\n\n{render_section}{style_section}\
         ROLLING PROJECT MEMORY:\n{project_memory}\n\n\
         SCOREKIT SCENE JSON SCHEMA:\n{schema}"
    ))
}

fn scorekit_capability_section() -> String {
    let handshake = scorekit::handshake();
    let live_version = handshake.version.as_deref().unwrap_or("(unavailable)");
    let compatibility = match handshake.compatible {
        Some(true) => "compatible",
        Some(false) => "outside-tested-range",
        None => "unverified",
    };
    let warning = handshake
        .warning
        .as_deref()
        .map(|warning| format!("\nwarning: {warning}"))
        .unwrap_or_default();
    format!(
        "LIVE SCOREKIT CAPABILITY:\n\
         version: {live_version}\n\
         tested range: {}\n\
         toolchain ready: {}\n\
         compatibility: {compatibility}{warning}\n\
         deterministic read-only preflights: inspect_instruments, inspect_textures, check_texture_profile\n\
         General MIDI exact world identities: shakuhachi, shamisen, sitar.\n\
         erhu, pipa, guzheng, dizi, tabla, oud, ney, and duduk require an exact active source; never rely on fallback.\n\n",
        scorekit::TESTED_SCOREKIT_RANGE,
        handshake.ready
    )
}

/// Prompt block describing the render configuration persisted in bench.json,
/// including the instrument and texture source keys active profiles map, so
/// the model only composes material the configured toolchain can build.
fn render_config_section(root: &Path) -> String {
    let Some(render) = manifest::load(root).0.render else {
        return String::new();
    };
    let renderer = render.renderer.as_deref().unwrap_or("(default)");
    let mut section = format!("ACTIVE RENDER CONFIGURATION (bench.json):\nrenderer: {renderer}\n");
    match (render.renderer.as_deref(), render.orchestration.as_deref()) {
        (Some("sfizz"), Some(orchestration)) if !orchestration.trim().is_empty() => {
            match manifest::load_orchestration(root, orchestration) {
                Ok(info) => {
                    section.push_str(&format!(
                        "orchestration: {orchestration}{}\n\
                         default palette: {}\n",
                        info.name
                            .as_deref()
                            .map(|name| format!(" ({name})"))
                            .unwrap_or_default(),
                        info.default_palette.as_deref().unwrap_or("(none)"),
                    ));
                    for palette in info.palettes() {
                        if let Some(error) = &palette.error {
                            section.push_str(&format!(
                                "palette `{}` -> {} : WARNING unusable ({error}); builds routed through it will fail.\n",
                                palette.name, palette.declared_profile
                            ));
                        } else {
                            let name = palette
                                .profile_name
                                .as_deref()
                                .unwrap_or(&palette.declared_profile);
                            section.push_str(&format!(
                                "palette `{}` -> {} ({name}): instruments mapped: {}\n",
                                palette.name,
                                palette.declared_profile,
                                palette.instruments.join(", ")
                            ));
                        }
                    }
                    section.push_str(
                        "Give each track a stable `id` and, when it should use a palette other \
                         than the default, a `palette` matching one listed above. A track \
                         instrument outside its resolved palette's mapped list will FAIL the \
                         sfizz build.\n",
                    );
                }
                Err(error) => {
                    section.push_str(&format!(
                        "orchestration: {orchestration}\nWARNING: the orchestration could not be read ({error}); builds will fail until it is fixed.\n"
                    ));
                }
            }
        }
        _ => {}
    }
    if let Some(profile) = render
        .texture_profile
        .as_deref()
        .filter(|profile| !profile.trim().is_empty())
    {
        match manifest::texture_profile_sources(root, profile) {
            Ok((name, sources)) => {
                let name = name.unwrap_or_else(|| profile.to_owned());
                let catalog = if sources.len() <= 12 {
                    sources.join(", ")
                } else {
                    format!(
                        "{} source keys (omitted from the prompt; query them with inspect_textures)",
                        sources.len()
                    )
                };
                section.push_str(&format!(
                    "texture profile: {profile} ({name})\n\
                     texture sources mapped by this profile: {}\n\
                     Names alone are not selection evidence: call inspect_textures with exact filters \
                     before writing a source, and honor its declared playback modes. Any unmapped key \
                     or unsupported mode will FAIL the build.\n",
                    catalog
                ));
            }
            Err(error) => {
                section.push_str(&format!(
                    "texture profile: {profile}\nWARNING: the texture profile could not be read ({error}); textured builds will fail until it is fixed.\n"
                ));
            }
        }
    }
    section.push('\n');
    section
}

#[derive(Debug)]
pub struct RunOutcome {
    pub history: Vec<InputItem>,
    pub prompt_tokens: Option<u64>,
    pub status: RunStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Complete,
    MaxTurns,
    Blocked,
}

pub async fn run_project<T: AgentTransport>(
    transport: &T,
    root: PathBuf,
    instructions: String,
    input: Vec<InputItem>,
    max_turns: u32,
    cancellation: CancellationToken,
    emit: impl FnMut(AgentEvent),
) -> Result<RunOutcome, BenchError> {
    let belt = ToolBelt::new(root)?;
    run_loop(
        transport,
        &belt,
        instructions,
        input,
        max_turns,
        cancellation,
        emit,
    )
    .await
}

pub async fn run_loop<T: AgentTransport, E: ToolExecutor>(
    transport: &T,
    tool_belt: &E,
    instructions: String,
    mut input: Vec<InputItem>,
    max_turns: u32,
    cancellation: CancellationToken,
    mut emit: impl FnMut(AgentEvent),
) -> Result<RunOutcome, BenchError> {
    let mut prompt_tokens = None;
    let mut scene_gate = HashMap::<String, String>::new();
    for _ in 0..max_turns {
        if cancellation.is_cancelled() {
            return Err(BenchError::cancelled());
        }
        let gate_was_active = !scene_gate.is_empty();
        let mut request_input = input.clone();
        if gate_was_active {
            request_input.push(InputItem::Message {
                role: InputRole::User,
                content: validation_gate_message(&scene_gate).into(),
            });
        }
        let request = ResponsesRequest {
            model: String::new(),
            instructions: Some(instructions.clone()),
            input: request_input,
            tools: tools::definitions(),
            max_output_tokens: None,
            stream: true,
            store: false,
        };
        let mut stream = transport.stream(request, cancellation.clone()).await?;
        let mut text = String::new();
        let mut calls = Vec::new();
        let mut terminal = false;

        while let Some(event) = stream.next().await {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    if !text.is_empty() {
                        emit(AgentEvent::TextDiscard);
                    }
                    return Err(error);
                }
            };
            match event {
                ResponseEvent::OutputTextDelta { delta, .. } => {
                    text.push_str(&delta);
                    emit(AgentEvent::Text { text: delta });
                }
                ResponseEvent::OutputItemDone {
                    function_call: Some(call),
                    ..
                } => calls.push(call),
                ResponseEvent::Completed { usage, .. } => {
                    terminal = true;
                    if let Some(tokens) = usage.and_then(|value| value.input_tokens) {
                        prompt_tokens = Some(prompt_tokens.unwrap_or(0).max(tokens));
                    }
                }
                ResponseEvent::Incomplete { reason, .. } => {
                    if !text.is_empty() {
                        emit(AgentEvent::TextDiscard);
                    }
                    return Err(BenchError::agent(
                        "response_incomplete",
                        format!(
                            "response was incomplete ({})",
                            reason.as_deref().unwrap_or("unknown reason")
                        ),
                    ));
                }
                ResponseEvent::Failed { code, message, .. }
                | ResponseEvent::Error { code, message } => {
                    if !text.is_empty() {
                        emit(AgentEvent::TextDiscard);
                    }
                    return Err(BenchError::Llm {
                        message,
                        status: None,
                        retry_after: None,
                        body_excerpt: code,
                    });
                }
                _ => {}
            }
        }
        if !terminal {
            if !text.is_empty() {
                emit(AgentEvent::TextDiscard);
            }
            return Err(BenchError::llm(
                "Responses stream ended before a terminal event",
            ));
        }

        if calls.is_empty() {
            if !scene_gate.is_empty() {
                if !text.is_empty() {
                    emit(AgentEvent::TextDiscard);
                }
                emit(AgentEvent::Warning {
                    text: format!(
                        "Agent completion withheld: {}. Repair and revalidate every listed scene before finishing.",
                        gate_summary(&scene_gate)
                    ),
                });
                continue;
            }
            if !text.is_empty() {
                emit(AgentEvent::TextCommit);
                input.push(InputItem::Message {
                    role: InputRole::Assistant,
                    content: text.into(),
                });
            }
            return Ok(RunOutcome {
                history: input,
                prompt_tokens,
                status: RunStatus::Complete,
            });
        }

        // A model may emit a success claim and a tool call in the same
        // response. Deltas remain an explicitly unverified UI draft until
        // every tool result is known; otherwise an invalid write or failed
        // repair could be committed before it opens (or preserves) the gate.
        let assistant_text_index = input.len();
        let mut all_tools_succeeded = true;
        for call in calls {
            if cancellation.is_cancelled() {
                if !text.is_empty() {
                    emit(AgentEvent::TextDiscard);
                }
                return Err(BenchError::cancelled());
            }
            input.push(InputItem::FunctionCall {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            });
            emit(AgentEvent::ToolStart {
                name: call.name.clone(),
                detail: truncate(&call.arguments, 2_048),
            });
            match tool_belt.execute(call.clone()).await {
                Ok(result) => {
                    for update in result.scene_gates {
                        apply_gate_update(&mut scene_gate, update);
                    }
                    emit(AgentEvent::ToolOk {
                        name: call.name,
                        summary: result.summary,
                        detail: result.detail,
                    });
                    input.push(InputItem::FunctionCallOutput {
                        call_id: call.call_id,
                        output: truncate(&result.output, TOOL_OUTPUT_LIMIT),
                    });
                }
                Err(error) => {
                    all_tools_succeeded = false;
                    for update in tool_belt.failure_gates(&call, &error) {
                        apply_gate_update(&mut scene_gate, update);
                    }
                    emit(AgentEvent::ToolErr {
                        name: call.name,
                        error: error.clone(),
                    });
                    let output = serde_json::json!({"ok": false, "error": error});
                    input.push(InputItem::FunctionCallOutput {
                        call_id: call.call_id,
                        output: truncate(&output.to_string(), TOOL_OUTPUT_LIMIT),
                    });
                }
            }
        }
        if cancellation.is_cancelled() {
            if !text.is_empty() {
                emit(AgentEvent::TextDiscard);
            }
            return Err(BenchError::cancelled());
        }
        if !text.is_empty() && all_tools_succeeded && scene_gate.is_empty() {
            emit(AgentEvent::TextCommit);
            input.insert(
                assistant_text_index,
                InputItem::Message {
                    role: InputRole::Assistant,
                    content: text.into(),
                },
            );
        } else if !text.is_empty() {
            emit(AgentEvent::TextDiscard);
        }
    }

    let status = if scene_gate.is_empty() {
        RunStatus::MaxTurns
    } else {
        emit(AgentEvent::Warning {
            text: format!(
                "Validation gate remains blocked after {max_turns} model turns: {}.",
                gate_summary(&scene_gate)
            ),
        });
        RunStatus::Blocked
    };
    emit(AgentEvent::Warning {
        text: format!(
            "Agent stopped after the configured {max_turns} model turns. Increase the limit in Settings or continue with a new message."
        ),
    });
    Ok(RunOutcome {
        history: input,
        prompt_tokens,
        status,
    })
}

fn apply_gate_update(scene_gate: &mut HashMap<String, String>, update: SceneGateUpdate) {
    let path = scene_gate_key(&update.path);
    let (key, label) = match update.kind {
        SceneGateKind::Readiness => (format!("readiness:{path}"), format!("`{path}` readiness")),
        SceneGateKind::Build => (format!("build:{path}"), format!("`{path}` build")),
        SceneGateKind::InstrumentResolution => (
            format!("instrument-resolution:{path}"),
            format!("`{path}` instrument resolution"),
        ),
        SceneGateKind::IntentAlignment => (
            format!("intent-alignment:{path}"),
            format!("`{path}` arrangement intent alignment"),
        ),
        SceneGateKind::Grammar { grammar } => {
            let grammar = scene_gate_key(&grammar);
            (
                format!("grammar:{grammar}:{path}"),
                format!("`{path}` grammar `{grammar}`"),
            )
        }
    };
    if update.ready {
        scene_gate.remove(&key);
    } else {
        scene_gate.insert(key, format!("{label} ({})", update.reason));
    }
}

fn validation_gate_message(scene_gate: &HashMap<String, String>) -> String {
    format!(
        "[SCOREBENCH VALIDATION GATE]\nNormal completion is blocked for: {}.\n\
         Repair the scene or configuration, then re-run each named check. Do not claim success while any blocker remains.",
        gate_summary(scene_gate)
    )
}

fn gate_summary(scene_gate: &HashMap<String, String>) -> String {
    let mut entries = scene_gate.values().cloned().collect::<Vec<_>>();
    entries.sort_unstable();
    entries.join("; ")
}

fn scene_gate_key(path: &str) -> String {
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => normalized.push(part),
            // Tool results originate from the project-confined ToolBelt. Keep
            // unexpected components visible rather than silently resolving a
            // path outside that trust boundary.
            _ => return path.to_owned(),
        }
    }
    normalized.to_string_lossy().into_owned()
}

pub async fn compact_project<T: AgentTransport>(
    transport: &T,
    root: &Path,
    session: &str,
    history: Vec<InputItem>,
    cancellation: CancellationToken,
    mut emit: impl FnMut(AgentEvent),
) -> Result<Vec<InputItem>, BenchError> {
    let Some(split) = compaction_split(&history) else {
        emit(AgentEvent::Warning {
            text: "There is not enough transcript history to compact yet.".into(),
        });
        return Ok(history);
    };
    let folded = &history[..split];
    let kept = &history[split..];
    let previous_memory = memory::read_memory(root, session)?;
    let payload = serde_json::to_string(folded).map_err(BenchError::io)?;
    let request = ResponsesRequest {
        model: String::new(),
        instructions: Some(
            "Update the rolling scorebench project memory. Return concise Markdown only. Preserve musical intent, decisions, scene inventory, failures, and open threads. Do not invent facts."
                .into(),
        ),
        input: vec![InputItem::Message {
            role: InputRole::User,
            content: format!(
                "EXISTING MEMORY:\n{}\n\nTRANSCRIPT TO FOLD:\n{}",
                if previous_memory.is_empty() {
                    "(empty)"
                } else {
                    &previous_memory
                },
                payload
            )
            .into(),
        }],
        tools: vec![],
        max_output_tokens: Some(2_048),
        stream: true,
        store: false,
    };
    let mut stream = transport.stream(request, cancellation).await?;
    let mut summary = String::new();
    let mut terminal = false;
    while let Some(event) = stream.next().await {
        match event? {
            ResponseEvent::OutputTextDelta { delta, .. } => summary.push_str(&delta),
            ResponseEvent::Completed { .. } => terminal = true,
            // A truncated summary would silently lose project history.
            ResponseEvent::Incomplete { reason, .. } => {
                return Err(BenchError::llm(format!(
                    "compaction summary was truncated ({})",
                    reason.as_deref().unwrap_or("unknown reason")
                )));
            }
            ResponseEvent::Failed { message, .. } | ResponseEvent::Error { message, .. } => {
                return Err(BenchError::llm(format!(
                    "compaction summary failed: {message}"
                )));
            }
            _ => {}
        }
    }
    if !terminal || summary.trim().is_empty() {
        return Err(BenchError::llm(
            "compaction summary ended without a complete Markdown summary",
        ));
    }
    memory::compact(root, session, summary.trim(), folded, kept)?;
    let turns = folded
        .iter()
        .filter(|item| {
            matches!(
                item,
                InputItem::Message {
                    role: InputRole::User,
                    ..
                }
            )
        })
        .count() as u32;
    emit(AgentEvent::Compacted { turns });
    Ok(kept.to_vec())
}

fn compaction_split(history: &[InputItem]) -> Option<usize> {
    let user_indices = history
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            matches!(
                item,
                InputItem::Message {
                    role: InputRole::User,
                    ..
                }
            )
            .then_some(index)
        })
        .collect::<Vec<_>>();
    const RECENT_USER_TURNS: usize = 4;
    if user_indices.len() <= RECENT_USER_TURNS {
        None
    } else {
        Some(user_indices[user_indices.len() - RECENT_USER_TURNS])
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}[truncated]", &value[..end])
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use futures_util::stream;

    use super::*;
    use crate::llm::types::{FunctionCall, Usage};

    struct ScriptedTransport {
        turns: Mutex<VecDeque<Result<Vec<ResponseEvent>, BenchError>>>,
        requests: Mutex<Vec<ResponsesRequest>>,
    }

    impl ScriptedTransport {
        fn new(turns: Vec<Result<Vec<ResponseEvent>, BenchError>>) -> Self {
            Self {
                turns: Mutex::new(turns.into()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<ResponsesRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl AgentTransport for ScriptedTransport {
        fn stream<'a>(
            &'a self,
            request: ResponsesRequest,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<ResponseStream, BenchError>> + Send + 'a>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request);
                match self.turns.lock().unwrap().pop_front().unwrap() {
                    Ok(events) => {
                        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))) as ResponseStream)
                    }
                    Err(error) => Err(error),
                }
            })
        }
    }

    struct ScriptedTools {
        results: Mutex<VecDeque<Result<ToolResult, BenchError>>>,
    }

    impl ScriptedTools {
        fn new(results: Vec<Result<ToolResult, BenchError>>) -> Self {
            Self {
                results: Mutex::new(results.into()),
            }
        }
    }

    impl ToolExecutor for ScriptedTools {
        fn execute<'a>(
            &'a self,
            _call: FunctionCall,
        ) -> Pin<Box<dyn Future<Output = Result<ToolResult, BenchError>> + Send + 'a>> {
            Box::pin(async move { self.results.lock().unwrap().pop_front().unwrap() })
        }
    }

    fn scripted_tool_result(path: &str, ready: bool, reason: &str) -> ToolResult {
        ToolResult {
            output: serde_json::json!({
                "ok": true,
                "path": path,
                "validation": {"status": if ready { "valid" } else { "invalid" }}
            })
            .to_string(),
            summary: reason.into(),
            detail: None,
            scene_gates: vec![tools::SceneGateUpdate {
                kind: tools::SceneGateKind::Readiness,
                path: path.into(),
                ready,
                reason: reason.into(),
            }],
        }
    }

    fn scripted_plain_tool_result(reason: &str) -> ToolResult {
        ToolResult {
            output: serde_json::json!({"ok": true}).to_string(),
            summary: reason.into(),
            detail: None,
            scene_gates: Vec::new(),
        }
    }

    fn completed() -> ResponseEvent {
        ResponseEvent::Completed {
            response_id: Some("response_fixture".into()),
            usage: Some(Usage {
                input_tokens: Some(2),
                output_tokens: Some(2),
                total_tokens: Some(4),
            }),
        }
    }

    fn call(name: &str, arguments: &str) -> ResponseEvent {
        ResponseEvent::OutputItemDone {
            output_index: 0,
            item: serde_json::Value::Null,
            function_call: Some(FunctionCall {
                id: Some("fc_1".into()),
                call_id: "call_1".into(),
                name: name.into(),
                arguments: arguments.into(),
            }),
        }
    }

    fn temp_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-agent-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    #[cfg(unix)]
    fn scene_gate_keys_preserve_distinct_unix_backslash_filenames() {
        assert_ne!(
            scene_gate_key(r"dir\scene.yaml"),
            scene_gate_key("dir/scene.yaml")
        );
        assert_eq!(scene_gate_key("./scene.yaml"), scene_gate_key("scene.yaml"));
    }

    #[tokio::test]
    async fn plain_text_remains_streamed_as_individual_deltas() {
        let transport = ScriptedTransport::new(vec![Ok(vec![
            ResponseEvent::OutputTextDelta {
                item_id: None,
                output_index: Some(0),
                delta: "First".into(),
            },
            ResponseEvent::OutputTextDelta {
                item_id: None,
                output_index: Some(0),
                delta: " second".into(),
            },
            completed(),
        ])]);
        let tools = ScriptedTools::new(vec![]);
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &tools,
            "fixture prompt".into(),
            vec![],
            1,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, RunStatus::Complete);
        let deltas = events
            .iter()
            .filter_map(|event| match event {
                AgentEvent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(deltas, vec!["First", " second"]);
        assert!(matches!(events.last(), Some(AgentEvent::TextCommit)));
        assert!(matches!(
            outcome.history.last(),
            Some(InputItem::Message {
                role: InputRole::Assistant,
                content,
            }) if content.display_text() == "First second"
        ));
    }

    #[tokio::test]
    async fn incomplete_response_discards_streamed_text_and_fails() {
        let transport = ScriptedTransport::new(vec![Ok(vec![
            ResponseEvent::OutputTextDelta {
                item_id: None,
                output_index: Some(0),
                delta: "Cut off mid-sentence".into(),
            },
            ResponseEvent::Incomplete {
                response_id: Some("response_fixture".into()),
                reason: Some("max_output_tokens".into()),
            },
        ])]);
        let tools = ScriptedTools::new(vec![]);
        let mut events = Vec::new();
        let error = run_loop(
            &transport,
            &tools,
            "fixture prompt".into(),
            vec![],
            1,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            BenchError::Agent { ref code, .. } if code == "response_incomplete"
        ));
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextDiscard)));
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextCommit)));
    }

    #[tokio::test]
    async fn failed_scene_preflight_blocks_a_later_text_only_completion() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![
                call("validate_scene", r#"{"path":"broken.yaml"}"#),
                completed(),
            ]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Everything is complete.".into(),
                },
                completed(),
            ]),
        ]);
        let tools = ScriptedTools::new(vec![Err(BenchError::agent(
            "fixture_validation",
            "scene is invalid",
        ))]);
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &tools,
            "fixture prompt".into(),
            vec![],
            2,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, RunStatus::Blocked);
        let requests = transport.requests();
        assert!(requests[1].input.iter().any(|item| matches!(
            item,
            InputItem::Message {
                role: InputRole::User,
                content,
            } if content.display_text().contains("SCOREBENCH VALIDATION GATE")
                && content.display_text().contains("broken.yaml")
        )));
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextDiscard)));
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextCommit)));
    }

    #[tokio::test]
    async fn invalid_scene_cannot_finish_as_a_successful_turn() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Scene written.".into(),
                },
                call(
                    "declare_arrangement_intent",
                    r#"{"path":"forest.yaml","task_mode":"new_scene","goal":"Create a forest cue.","form_intent":"Eight-bar scene.","palette_intent":"Use live ScoreKit instruments.","expected_changes":["title","bars"],"invariants":[]}"#,
                ),
                call(
                    "write_scene",
                    r#"{"path":"forest.yaml","content":"title: Forest\nbars: 8\n"}"#,
                ),
                completed(),
            ]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Scene written.".into(),
                },
                completed(),
            ]),
        ]);
        let root = temp_project("write");
        let belt = ToolBelt::new(root.clone()).unwrap();
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &belt,
            "fixture prompt".into(),
            vec![InputItem::Message {
                role: InputRole::User,
                content: "write a scene".into(),
            }],
            2,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, RunStatus::Blocked);
        assert!(std::fs::read_to_string(root.join("forest.yaml"))
            .unwrap()
            .contains("Forest"));
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::ToolOk { name, .. } if name == "write_scene")
        ));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                AgentEvent::Warning { text }
                    if text.contains("completion withheld")
                        && text.contains("forest.yaml")
            )
        }));
        assert!(
            outcome.history.iter().all(|item| {
                !matches!(
                    item,
                    InputItem::Message {
                        role: InputRole::User,
                        content,
                    } if content.display_text().contains("SCOREBENCH VALIDATION GATE")
                )
            }),
            "the internal gate reminder must be ephemeral, not transcript history"
        );
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Text { text } if text == "Scene written.")));
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextCommit)));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::TextDiscard))
                .count(),
            2,
            "both the invalid tool-turn draft and blocked completion draft are discarded"
        );
        assert!(
            outcome.history.iter().all(|item| !matches!(
                item,
                InputItem::Message { content, .. }
                    if content.display_text() == "Scene written."
            )),
            "a blocked completion claim must not enter persistent history"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn declared_arrangement_intent_cannot_finish_without_a_matching_write() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![
                call(
                    "declare_arrangement_intent",
                    r#"{"path":"forest.yaml","task_mode":"new_scene","goal":"Create a forest cue.","form_intent":"Eight-bar loop.","palette_intent":"Airy woodwinds.","expected_changes":["tracks"],"invariants":[]}"#,
                ),
                completed(),
            ]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "The arrangement is ready.".into(),
                },
                completed(),
            ]),
        ]);
        let root = temp_project("intent-without-write");
        let belt = ToolBelt::new(root.clone()).unwrap();
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &belt,
            "fixture prompt".into(),
            vec![],
            2,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, RunStatus::Blocked);
        assert!(!root.join("forest.yaml").exists());
        assert!(events.iter().any(|event| {
            matches!(
                event,
                AgentEvent::Warning { text }
                    if text.contains("arrangement intent alignment")
                        && text.contains("forest.yaml")
            )
        }));
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextCommit)));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn gate_remains_ephemeral_until_the_same_scene_is_repaired() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![
                call("write_scene", r#"{"path":"forest.yaml","content":"bad"}"#),
                completed(),
            ]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Fixed too early.".into(),
                },
                call(
                    "write_scene",
                    r#"{"path":"./forest.yaml","content":"still bad"}"#,
                ),
                completed(),
            ]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Finished too early.".into(),
                },
                completed(),
            ]),
            Ok(vec![
                call(
                    "write_scene",
                    r#"{"path":"./forest.yaml","content":"repaired"}"#,
                ),
                completed(),
            ]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Validated and finished.".into(),
                },
                completed(),
            ]),
        ]);
        let tools = ScriptedTools::new(vec![
            Ok(scripted_tool_result("forest.yaml", false, "scene invalid")),
            Ok(scripted_tool_result(
                "./forest.yaml",
                false,
                "scene still invalid",
            )),
            Ok(scripted_tool_result("./forest.yaml", true, "scene valid")),
        ]);
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &tools,
            "fixture prompt".into(),
            vec![],
            5,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, RunStatus::Complete);
        let requests = transport.requests();
        assert_eq!(requests.len(), 5);
        let has_gate = |request: &ResponsesRequest| {
            request.input.iter().any(|item| {
                matches!(
                    item,
                    InputItem::Message {
                        role: InputRole::User,
                        content,
                    } if content.display_text().contains("SCOREBENCH VALIDATION GATE")
                )
            })
        };
        assert!(!has_gate(&requests[0]));
        assert!(has_gate(&requests[1]));
        assert!(has_gate(&requests[2]));
        assert!(has_gate(&requests[3]));
        assert!(!has_gate(&requests[4]), "repair must clear the path gate");
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Warning { text } if text.contains("completion withheld"))
        ));
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Text { text } if text == "Fixed too early.")));
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Text { text } if text == "Finished too early.")
        ));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::TextDiscard))
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::TextCommit))
                .count(),
            1
        );
        assert!(
            outcome.history.iter().all(|item| {
                !matches!(
                    item,
                    InputItem::Message { content, .. }
                        if content.display_text().contains("SCOREBENCH VALIDATION GATE")
                )
            }),
            "internal gate reminders are request-local"
        );
        assert!(outcome.history.iter().all(|item| !matches!(
            item,
            InputItem::Message { content, .. }
                if content.display_text() == "Fixed too early."
        )));
        assert!(outcome.history.iter().all(|item| !matches!(
            item,
            InputItem::Message { content, .. }
                if content.display_text() == "Finished too early."
        )));
        assert!(matches!(
            outcome.history.last(),
            Some(InputItem::Message {
                role: InputRole::Assistant,
                content,
            }) if content.display_text() == "Validated and finished."
        ));
    }

    #[tokio::test]
    async fn unknown_tool_is_reported_and_loop_continues() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![call("invented_tool", "{}"), completed()]),
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "Recovered.".into(),
                },
                completed(),
            ]),
        ]);
        let root = temp_project("unknown");
        let belt = ToolBelt::new(root.clone()).unwrap();
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &belt,
            "fixture".into(),
            vec![],
            3,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, RunStatus::Complete);
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolErr { .. })));
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Text { text } if text == "Recovered.")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn max_turn_guard_emits_visible_warning() {
        let transport =
            ScriptedTransport::new(vec![Ok(vec![call("invented_tool", "{}"), completed()])]);
        let root = temp_project("max-turns");
        let belt = ToolBelt::new(root.clone()).unwrap();
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &belt,
            "fixture".into(),
            vec![],
            1,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, RunStatus::MaxTurns);
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Warning { .. })));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn early_committed_text_is_not_a_complete_outcome_after_max_turns() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![
                ResponseEvent::OutputTextDelta {
                    item_id: None,
                    output_index: Some(0),
                    delta: "I will inspect first.".into(),
                },
                call("doctor", "{}"),
                completed(),
            ]),
            Ok(vec![call("doctor", "{}"), completed()]),
        ]);
        let tools = ScriptedTools::new(vec![
            Ok(scripted_plain_tool_result("doctor ready")),
            Ok(scripted_plain_tool_result("doctor ready")),
        ]);
        let mut events = Vec::new();
        let outcome = run_loop(
            &transport,
            &tools,
            "fixture".into(),
            vec![],
            2,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, RunStatus::MaxTurns);
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::TextCommit)));
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::Warning { text } if text.contains("2 model turns"))
        ));
    }

    #[tokio::test]
    async fn transport_failure_stops_cleanly() {
        let transport = ScriptedTransport::new(vec![Err(BenchError::llm("offline"))]);
        let root = temp_project("offline");
        let belt = ToolBelt::new(root.clone()).unwrap();
        let error = run_loop(
            &transport,
            &belt,
            "fixture".into(),
            vec![],
            1,
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(error, BenchError::Llm { .. }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn scripted_compaction_updates_memory_and_keeps_recent_turns() {
        let transport = ScriptedTransport::new(vec![Ok(vec![
            ResponseEvent::OutputTextDelta {
                item_id: None,
                output_index: Some(0),
                delta: "# Project memory\nKeep the forest motif.".into(),
            },
            completed(),
        ])]);
        let root = temp_project("compact");
        let history = (0..5)
            .map(|turn| InputItem::Message {
                role: InputRole::User,
                content: format!("turn {turn}").into(),
            })
            .collect::<Vec<_>>();
        memory::append_items(&root, "main", &history).unwrap();
        let mut events = Vec::new();
        let kept = compact_project(
            &transport,
            &root,
            "main",
            history,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert_eq!(kept.len(), 4);
        assert!(memory::read_memory(&root, "main")
            .unwrap()
            .contains("forest motif"));
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Compacted { turns: 1 })));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn three_compaction_cycles_preserve_memory_and_recent_window() {
        let summaries = (1..=3)
            .map(|cycle| {
                Ok(vec![
                    ResponseEvent::OutputTextDelta {
                        item_id: None,
                        output_index: Some(0),
                        delta: format!(
                            "# Project memory\nForest motif preserved through compaction cycle {cycle}."
                        ),
                    },
                    completed(),
                ])
            })
            .collect();
        let transport = ScriptedTransport::new(summaries);
        let root = temp_project("compact-three-cycles");
        let mut history = (0..5)
            .map(|turn| InputItem::Message {
                role: InputRole::User,
                content: format!("initial turn {turn}").into(),
            })
            .collect::<Vec<_>>();
        memory::append_items(&root, "main", &history).unwrap();

        let mut compacted = 0;
        for cycle in 1..=3 {
            history = compact_project(
                &transport,
                &root,
                "main",
                history,
                CancellationToken::new(),
                |event| {
                    if matches!(event, AgentEvent::Compacted { .. }) {
                        compacted += 1;
                    }
                },
            )
            .await
            .unwrap();
            if cycle < 3 {
                let next = vec![
                    InputItem::Message {
                        role: InputRole::User,
                        content: format!("cycle {cycle} user turn").into(),
                    },
                    InputItem::Message {
                        role: InputRole::Assistant,
                        content: format!("cycle {cycle} assistant turn").into(),
                    },
                ];
                memory::append_items(&root, "main", &next).unwrap();
                history.extend(next);
            }
        }

        assert_eq!(compacted, 3);
        assert_eq!(
            history
                .iter()
                .filter(|item| matches!(
                    item,
                    InputItem::Message {
                        role: InputRole::User,
                        ..
                    }
                ))
                .count(),
            4
        );
        assert!(history.iter().any(|item| {
            matches!(item, InputItem::Message { content, .. } if content.display_text() == "cycle 2 assistant turn")
        }));
        assert!(memory::read_memory(&root, "main")
            .unwrap()
            .contains("compaction cycle 3"));
        assert_eq!(
            memory::load_transcript(&root, "main").unwrap().items,
            history
        );
        assert!(
            std::fs::read_to_string(
                root.join(".scorebench/sessions/main/transcript-archive.jsonl")
            )
            .unwrap()
            .lines()
            .count()
                >= 3
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn style_pack_is_injected_with_conflict_protocol() {
        let root = temp_project("style-pack");
        let pack = styles::builtins()
            .into_iter()
            .find(|pack| pack.id == "epic-new-age-instrumental")
            .unwrap();
        let with_style = system_prompt(&root, "main", Some(&pack)).unwrap();
        assert!(with_style.contains("ACTIVE STYLE PACK `epic-new-age-instrumental`"));
        assert!(
            with_style.contains("orchestral_percussion"),
            "structured body present"
        );
        assert!(with_style.contains("STYLE CONFLICT DETECTION"));
        let without = system_prompt(&root, "main", None).unwrap();
        assert!(!without.contains("ACTIVE STYLE PACK"));
        assert!(!without.contains("STYLE CONFLICT DETECTION"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn system_prompt_separates_arrangement_canon_style_and_live_capability() {
        let root = temp_project("arrangement-canon");
        let pack = styles::builtins().into_iter().next().unwrap();
        let prompt = system_prompt(&root, "main", Some(&pack)).unwrap();

        assert!(prompt.contains("ARRANGEMENT CANON `scorekit-arrangement-canon` v1.1.0"));
        assert!(prompt.contains("before_write"));
        assert!(prompt.contains("name_the_inertia_answer"));
        assert!(prompt.contains("Never guess textures[].source"));
        assert!(prompt.contains("LIVE SCOREKIT CAPABILITY"));
        assert!(prompt.contains(scorekit::TESTED_SCOREKIT_RANGE));
        assert!(prompt.contains("erhu, pipa, guzheng, dizi, tabla, oud, ney, and duduk"));
        assert!(prompt.contains("Authority order: live ScoreKit schema"));
        assert!(prompt.contains("ACTIVE STYLE PACK"));
        assert!(prompt.contains("read_scene -> declare_arrangement_intent -> write_scene"));
        assert!(prompt.contains("For new_scene"));
        assert!(prompt.contains("For revision or repair"));
        assert!(prompt.contains("decision record, not private chain-of-thought"));
        assert!(
            prompt.find("ARRANGEMENT CANON").unwrap() < prompt.find("ACTIVE STYLE PACK").unwrap(),
            "the global canon must remain a separate authority above the selected style"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn render_config_is_injected_with_mapped_instruments() {
        let root = temp_project("render-config");
        assert_eq!(render_config_section(&root), "");

        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles/open.yaml"),
            "name: scoredata-open\ninstruments:\n  piano:\n    sustain: p.sfz\n  strings:\n    sustain: s.sfz\n",
        )
        .unwrap();
        std::fs::write(
            root.join("profiles/forest-textures.yaml"),
            "name: forest\nsources:\n  birds: birds.wav\n  river: river.wav\n",
        )
        .unwrap();
        std::fs::write(
            root.join("hybrid.yaml"),
            "schema_version: 1\nname: hybrid-cinematic\ndefault_palette: default\npalettes:\n  default: { profile: profiles/open.yaml }\n",
        )
        .unwrap();
        std::fs::write(
            root.join("bench.json"),
            r#"{"render":{"renderer":"sfizz","orchestration":"hybrid.yaml","texture_profile":"profiles/forest-textures.yaml"}}"#,
        )
        .unwrap();
        let section = render_config_section(&root);
        assert!(section.contains("ACTIVE RENDER CONFIGURATION"));
        assert!(section.contains("renderer: sfizz"));
        assert!(section.contains("orchestration: hybrid.yaml (hybrid-cinematic)"));
        assert!(section.contains("default palette: default"));
        assert!(section.contains("palette `default`"));
        assert!(section.contains("piano, strings"));
        assert!(section.contains("stable `id`"));
        assert!(section.contains("birds, river"));
        assert!(section.contains("inspect_textures"));
        assert!(section.contains("playback modes"));
        let prompt = system_prompt(&root, "main", None).unwrap();
        assert!(prompt.contains("ACTIVE RENDER CONFIGURATION"));

        std::fs::write(
            root.join("bench.json"),
            r#"{"render":{"renderer":"sfizz","orchestration":"missing.yaml"}}"#,
        )
        .unwrap();
        let section = render_config_section(&root);
        assert!(section.contains("WARNING: the orchestration could not be read"));

        std::fs::write(
            root.join("bench.json"),
            r#"{"render":{"renderer":"fluidsynth"}}"#,
        )
        .unwrap();
        let section = render_config_section(&root);
        assert!(section.contains("renderer: fluidsynth"));
        assert!(!section.contains("mapped: "));
        std::fs::remove_dir_all(root).unwrap();
    }
}
