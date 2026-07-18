//! M0 stub agent: proves the chat ↔ core ↔ tool seams that the real ReACT
//! loop (M1, OpenAI Responses API) will flow through. No LLM calls here.

use std::path::Path;

use serde::Serialize;

use crate::error::BenchError;
use crate::project;
use crate::scorekit;

/// Events streamed to the chat panel over a Tauri channel. The M1 loop will
/// emit the same shapes, so the frontend contract is settled now.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Text { text: String },
    ToolStart { name: String, detail: String },
    ToolOk { name: String, summary: String },
    ToolErr { name: String, error: BenchError },
    Done,
}

/// What the stub decided to do with a user message.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Doctor,
    Build { scene: String },
    Chat,
}

/// Deterministic message routing: slash-commands dispatch tools, anything
/// else gets the canned M0 reply.
pub fn plan(message: &str) -> Plan {
    let trimmed = message.trim();
    if trimmed == "/doctor" {
        return Plan::Doctor;
    }
    if let Some(rest) = trimmed.strip_prefix("/build") {
        let scene = rest.trim();
        if !scene.is_empty() {
            return Plan::Build {
                scene: scene.to_string(),
            };
        }
    }
    Plan::Chat
}

pub fn respond(project_root: &Path, message: &str, mut emit: impl FnMut(AgentEvent)) {
    match plan(message) {
        Plan::Doctor => {
            emit(AgentEvent::ToolStart {
                name: "scorekit_doctor".into(),
                detail: "scorekit doctor --json".into(),
            });
            match scorekit::doctor() {
                Ok(report) => {
                    let ready = report
                        .get("ready")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    emit(AgentEvent::ToolOk {
                        name: "scorekit_doctor".into(),
                        summary: serde_json::to_string_pretty(&report)
                            .unwrap_or_else(|_| report.to_string()),
                    });
                    emit(AgentEvent::Text {
                        text: if ready {
                            "Toolchain ready: renderer and FFmpeg are healthy.".into()
                        } else {
                            "Toolchain incomplete — see the doctor report above.".into()
                        },
                    });
                }
                Err(err) => {
                    let text = err.to_string();
                    emit(AgentEvent::ToolErr {
                        name: "scorekit_doctor".into(),
                        error: err,
                    });
                    emit(AgentEvent::Text {
                        text: format!("Doctor failed: {text}"),
                    });
                }
            }
        }
        Plan::Build { scene } => {
            let scene_path = project_root.join(&scene);
            let stem = scene_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "scene".into());
            let output = project_root
                .join(project::OUT_DIR)
                .join(format!("{stem}.ogg"));
            emit(AgentEvent::ToolStart {
                name: "scorekit_build".into(),
                detail: format!("scorekit build {scene} -o out/{stem}.ogg"),
            });
            if let Err(err) = std::fs::create_dir_all(project_root.join(project::OUT_DIR)) {
                let err = BenchError::io(err);
                emit(AgentEvent::ToolErr {
                    name: "scorekit_build".into(),
                    error: err,
                });
                emit(AgentEvent::Done);
                return;
            }
            match scorekit::build(&scene_path, &output, &scorekit::BuildParams::default()) {
                Ok(result) => {
                    let summary = result
                        .meta
                        .get("total_samples")
                        .and_then(|v| v.as_u64())
                        .map(|n| format!("wrote out/{stem}.ogg ({n} samples)"))
                        .unwrap_or_else(|| format!("wrote out/{stem}.ogg"));
                    emit(AgentEvent::ToolOk {
                        name: "scorekit_build".into(),
                        summary,
                    });
                    emit(AgentEvent::Text {
                        text: format!(
                            "Rendered `{scene}` → `out/{stem}.ogg`. Load it in the player to listen."
                        ),
                    });
                }
                Err(err) => {
                    let text = err.to_string();
                    emit(AgentEvent::ToolErr {
                        name: "scorekit_build".into(),
                        error: err,
                    });
                    emit(AgentEvent::Text {
                        text: format!("Build failed: {text}"),
                    });
                }
            }
        }
        Plan::Chat => {
            emit(AgentEvent::Text {
                text: "The composing agent arrives in M1. For now: `/doctor` checks the \
                       toolchain, `/build <scene.yaml>` renders a scene."
                    .into(),
            });
        }
    }
    emit(AgentEvent::Done);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_routes_slash_commands() {
        assert_eq!(plan("/doctor"), Plan::Doctor);
        assert_eq!(
            plan("  /build forest.yaml  "),
            Plan::Build {
                scene: "forest.yaml".into()
            }
        );
        assert_eq!(plan("/build"), Plan::Chat);
        assert_eq!(plan("write me a sad theme"), Plan::Chat);
    }

    #[test]
    fn chat_message_gets_canned_reply_and_done() {
        let mut events = Vec::new();
        respond(Path::new("/tmp"), "hello", |e| events.push(e));
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AgentEvent::Text { .. }));
        assert!(matches!(events[1], AgentEvent::Done));
    }

    #[test]
    fn build_missing_scene_emits_tool_err_not_panic() {
        // Requires a real scorekit; skip silently when absent (CI without it).
        if scorekit::locate().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("scorebench-agent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut events = Vec::new();
        respond(&dir, "/build nope.yaml", |e| events.push(e));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolErr { .. })));
        // Failure must not leave a partial artifact behind (scorekit renders
        // via temp file + atomic rename; the out dir stays clean).
        let leftover = std::fs::read_dir(dir.join(project::OUT_DIR))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(leftover, 0, "failed build must not leave artifacts");
        std::fs::remove_dir_all(&dir).ok();
    }
}
