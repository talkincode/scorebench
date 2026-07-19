//! Minimal hand-rolled ReACT loop over the OpenAI Responses API contract.
//!
//! The loop owns orchestration only. HTTP/SSE lives in `llm`; deterministic
//! project and scorekit operations live in `tools`.

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
use crate::{manifest, memory, project, scorekit, styles};
use tools::ToolBelt;

const TOOL_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Text {
        text: String,
    },
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
    Ok(format!(
        "You are scorebench, the composing agent for one scorekit project.\n\
         You are the only writer of scene YAML. Never invent an editing UI or render audio yourself.\n\
         Use the provided tools; scorekit validation errors are authoritative.\n\
         Keep paths project-relative. write_scene validates automatically and reports the result;\n\
         fix any reported problem before building and explain musical decisions concisely.\n\n\
         CURRENT PROJECT SNAPSHOT:\n{snapshot}\n\n{render_section}{style_section}\
         ROLLING PROJECT MEMORY:\n{project_memory}\n\n\
         SCOREKIT SCENE JSON SCHEMA:\n{schema}"
    ))
}

/// Prompt block describing the render configuration persisted in bench.json,
/// including the instrument keys the active sfizz profile maps, so the model
/// composes with instruments the user's renderer can actually play.
fn render_config_section(root: &Path) -> String {
    let Some(render) = manifest::load(root).0.render else {
        return String::new();
    };
    let renderer = render.renderer.as_deref().unwrap_or("(default)");
    let mut section = format!("ACTIVE RENDER CONFIGURATION (bench.json):\nrenderer: {renderer}\n");
    match (render.renderer.as_deref(), render.profile.as_deref()) {
        (Some("sfizz"), Some(profile)) if !profile.trim().is_empty() => {
            match manifest::profile_instruments(root, profile) {
                Ok((name, instruments)) => {
                    let name = name.unwrap_or_else(|| profile.to_owned());
                    section.push_str(&format!(
                        "profile: {profile} ({name})\n\
                         instruments mapped by this profile: {}\n\
                         Any track instrument outside this list will FAIL the sfizz build.\n\
                         Compose only with mapped instruments, or tell the user which mapping is missing.\n",
                        instruments.join(", ")
                    ));
                }
                Err(error) => {
                    section.push_str(&format!(
                        "profile: {profile}\nWARNING: the profile could not be read ({error}); builds will fail until it is fixed.\n"
                    ));
                }
            }
        }
        _ => {}
    }
    section.push('\n');
    section
}

#[derive(Debug)]
pub struct RunOutcome {
    pub history: Vec<InputItem>,
    pub prompt_tokens: Option<u64>,
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

pub async fn run_loop<T: AgentTransport>(
    transport: &T,
    tool_belt: &ToolBelt,
    instructions: String,
    mut input: Vec<InputItem>,
    max_turns: u32,
    cancellation: CancellationToken,
    mut emit: impl FnMut(AgentEvent),
) -> Result<RunOutcome, BenchError> {
    let mut prompt_tokens = None;
    for _ in 0..max_turns {
        if cancellation.is_cancelled() {
            return Err(BenchError::cancelled());
        }
        let request = ResponsesRequest {
            model: String::new(),
            instructions: Some(instructions.clone()),
            input: input.clone(),
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
            match event? {
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
                    terminal = true;
                    emit(AgentEvent::Warning {
                        text: format!(
                            "response truncated ({})",
                            reason.as_deref().unwrap_or("unknown reason")
                        ),
                    });
                }
                ResponseEvent::Failed { code, message, .. }
                | ResponseEvent::Error { code, message } => {
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
            return Err(BenchError::llm(
                "Responses stream ended before a terminal event",
            ));
        }

        if !text.is_empty() {
            input.push(InputItem::Message {
                role: InputRole::Assistant,
                content: text.into(),
            });
        }
        if calls.is_empty() {
            return Ok(RunOutcome {
                history: input,
                prompt_tokens,
            });
        }

        for call in calls {
            if cancellation.is_cancelled() {
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
    }

    emit(AgentEvent::Warning {
        text: format!(
            "Agent stopped after the configured {max_turns} model turns. Increase the limit in Settings or continue with a new message."
        ),
    });
    Ok(RunOutcome {
        history: input,
        prompt_tokens,
    })
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
    }

    impl ScriptedTransport {
        fn new(turns: Vec<Result<Vec<ResponseEvent>, BenchError>>) -> Self {
            Self {
                turns: Mutex::new(turns.into()),
            }
        }
    }

    impl AgentTransport for ScriptedTransport {
        fn stream<'a>(
            &'a self,
            _request: ResponsesRequest,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<ResponseStream, BenchError>> + Send + 'a>> {
            Box::pin(async move {
                match self.turns.lock().unwrap().pop_front().unwrap() {
                    Ok(events) => {
                        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))) as ResponseStream)
                    }
                    Err(error) => Err(error),
                }
            })
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

    #[tokio::test]
    async fn scripted_loop_writes_scene_then_finishes() {
        let transport = ScriptedTransport::new(vec![
            Ok(vec![
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
            4,
            CancellationToken::new(),
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert!(std::fs::read_to_string(root.join("forest.yaml"))
            .unwrap()
            .contains("Forest"));
        assert!(events.iter().any(
            |event| matches!(event, AgentEvent::ToolOk { name, .. } if name == "write_scene")
        ));
        assert!(matches!(
            outcome.history.last(),
            Some(InputItem::Message {
                role: InputRole::Assistant,
                ..
            })
        ));
        std::fs::remove_dir_all(root).unwrap();
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
        run_loop(
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
        run_loop(
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
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Warning { .. })));
        std::fs::remove_dir_all(root).unwrap();
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
            .find(|pack| pack.id == "chinese-campus-folk-90s")
            .unwrap();
        let with_style = system_prompt(&root, "main", Some(&pack)).unwrap();
        assert!(with_style.contains("ACTIVE STYLE PACK `chinese-campus-folk-90s`"));
        assert!(
            with_style.contains("dense_brass"),
            "structured body present"
        );
        assert!(with_style.contains("STYLE CONFLICT DETECTION"));
        let without = system_prompt(&root, "main", None).unwrap();
        assert!(!without.contains("ACTIVE STYLE PACK"));
        assert!(!without.contains("STYLE CONFLICT DETECTION"));
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
            root.join("bench.json"),
            r#"{"render":{"renderer":"sfizz","profile":"profiles/open.yaml"}}"#,
        )
        .unwrap();
        let section = render_config_section(&root);
        assert!(section.contains("ACTIVE RENDER CONFIGURATION"));
        assert!(section.contains("renderer: sfizz"));
        assert!(section.contains("piano, strings"));
        assert!(section.contains("FAIL the sfizz build"));
        let prompt = system_prompt(&root, "main", None).unwrap();
        assert!(prompt.contains("ACTIVE RENDER CONFIGURATION"));

        std::fs::write(
            root.join("bench.json"),
            r#"{"render":{"renderer":"sfizz","profile":"profiles/missing.yaml"}}"#,
        )
        .unwrap();
        let section = render_config_section(&root);
        assert!(section.contains("WARNING: the profile could not be read"));

        std::fs::write(
            root.join("bench.json"),
            r#"{"render":{"renderer":"fluidsynth"}}"#,
        )
        .unwrap();
        let section = render_config_section(&root);
        assert!(section.contains("renderer: fluidsynth"));
        assert!(!section.contains("mapped by this profile"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
