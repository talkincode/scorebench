mod agent;
mod attachments;
mod error;
mod llm;
mod memory;
mod observation;
mod project;
mod scorekit;
mod sessions;
mod settings;
mod watcher;

use std::path::PathBuf;

use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};

use error::BenchError;

/// Where the scorekit binary was found (or a typed error telling the user how to fix it).
#[tauri::command]
fn scorekit_status() -> Result<String, BenchError> {
    scorekit::locate().map(|p| p.display().to_string())
}

#[derive(serde::Serialize)]
struct VersionInfo {
    scorebench_version: String,
    scorekit: scorekit::Handshake,
}

#[tauri::command]
fn version_info(app: AppHandle) -> VersionInfo {
    VersionInfo {
        scorebench_version: app.package_info().version.to_string(),
        scorekit: scorekit::handshake(),
    }
}

#[tauri::command]
async fn scorekit_doctor() -> Result<serde_json::Value, BenchError> {
    tauri::async_runtime::spawn_blocking(scorekit::doctor)
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn open_project(
    app: AppHandle,
    watcher: State<'_, watcher::ProjectWatcher>,
    path: PathBuf,
) -> Result<project::ProjectInfo, BenchError> {
    let info = tauri::async_runtime::spawn_blocking(move || project::scan(&path))
        .await
        .map_err(BenchError::io)??;
    watcher.watch(app, info.root.clone())?;
    Ok(info)
}

#[tauri::command]
async fn refresh_project(path: PathBuf) -> Result<project::ProjectInfo, BenchError> {
    tauri::async_runtime::spawn_blocking(move || project::scan(&path))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn inspect_scene(
    root: PathBuf,
    rel_path: String,
) -> Result<observation::SceneInspection, BenchError> {
    tauri::async_runtime::spawn_blocking(move || observation::inspect_scene(&root, &rel_path))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn read_meta(root: PathBuf, rel_path: String) -> Result<serde_json::Value, BenchError> {
    tauri::async_runtime::spawn_blocking(move || observation::read_meta(&root, &rel_path))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn send_chat(
    app: AppHandle,
    state: State<'_, agent::AgentState>,
    root: PathBuf,
    session: String,
    message: String,
    attachments: Vec<String>,
    events: Channel<agent::AgentEvent>,
) -> Result<(), BenchError> {
    sessions::validate_id(&session)?;
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    let prompt_root = root.clone();
    let prompt_session = session.clone();
    let (settings, api_key, instructions) = tauri::async_runtime::spawn_blocking(move || {
        let (settings, _) = settings::load(&config_dir)?;
        let api_key =
            settings::load_api_key(&config_dir, &settings::OsKeyring)?.ok_or_else(|| {
                BenchError::settings(
                    "api_key_missing",
                    "set an API key in Settings before chatting",
                )
            })?;
        let instructions = agent::system_prompt(
            &prompt_root,
            &prompt_session,
            &settings.personal_instructions,
        )?;
        Ok::<_, BenchError>((settings, api_key, instructions))
    })
    .await
    .map_err(BenchError::io)??;
    let max_turns = settings.max_turns;
    let context_budget_tokens = settings.context_budget_tokens;
    let client = llm::ResponsesClient::new(llm::LlmConfig {
        base_url: settings.base_url,
        api_key,
        model: settings.model,
        timeout: std::time::Duration::from_secs(120),
    })?;
    if message.trim() == "/compact" {
        let (root, history, warnings) = state.history(&root, &session)?;
        for text in warnings {
            let _ = events.send(agent::AgentEvent::Warning { text });
        }
        let cancellation = state.activate(&root, &session)?;
        match agent::compact_project(&client, &root, &session, history, cancellation, |event| {
            let _ = events.send(event);
        })
        .await
        {
            Ok(kept) => state.replace_history(&root, &session, kept)?,
            Err(error) => {
                let _ = events.send(agent::AgentEvent::Warning {
                    text: format!(
                        "Compaction failed; the full transcript is still active: {error}"
                    ),
                });
            }
        }
        state.clear_active(&root, &session)?;
        let _ = events.send(agent::AgentEvent::Done);
        return Ok(());
    }

    let content = attachments::build_content(&message, &attachments)?;
    let (root, history, cancellation, warnings) = state.begin(&root, &session, content)?;
    let _ = sessions::touch(&root, &session, None);
    for text in warnings {
        let _ = events.send(agent::AgentEvent::Warning { text });
    }
    let result = agent::run_project(
        &client,
        root.clone(),
        instructions,
        history,
        max_turns,
        cancellation.clone(),
        |event| {
            let _ = events.send(event);
        },
    )
    .await;
    let result = match result {
        Ok(outcome) => {
            let prompt_tokens = outcome
                .prompt_tokens
                .unwrap_or_else(|| memory::estimate_tokens(&outcome.history));
            state.complete(&root, &session, outcome.history.clone())?;
            if prompt_tokens > context_budget_tokens {
                match agent::compact_project(
                    &client,
                    &root,
                    &session,
                    outcome.history,
                    cancellation,
                    |event| {
                        let _ = events.send(event);
                    },
                )
                .await
                {
                    Ok(kept) => state.replace_history(&root, &session, kept)?,
                    Err(error) => {
                        let _ = events.send(agent::AgentEvent::Warning {
                            text: format!(
                                "Automatic compaction failed; continuing with the full transcript: {error}"
                            ),
                        });
                    }
                }
            }
            state.clear_active(&root, &session)?;
            Ok(())
        }
        Err(BenchError::Cancelled { .. }) => {
            state.clear_active(&root, &session)?;
            Ok(())
        }
        Err(error) => {
            state.clear_active(&root, &session)?;
            Err(error)
        }
    };
    let _ = events.send(agent::AgentEvent::Done);
    result
}

#[tauri::command]
fn cancel_agent(
    root: PathBuf,
    session: String,
    state: State<'_, agent::AgentState>,
) -> Result<bool, BenchError> {
    state.cancel(&root, &session)
}

#[tauri::command]
async fn list_sessions(root: PathBuf) -> Result<sessions::SessionsIndex, BenchError> {
    tauri::async_runtime::spawn_blocking(move || sessions::load(&root))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn create_session(
    root: PathBuf,
    title: Option<String>,
    scene: Option<String>,
) -> Result<sessions::SessionMeta, BenchError> {
    tauri::async_runtime::spawn_blocking(move || sessions::create(&root, title, scene))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn select_session(root: PathBuf, session: String) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || sessions::set_active(&root, &session))
        .await
        .map_err(BenchError::io)?
}

#[derive(Clone, serde::Serialize)]
struct TranscriptMessage {
    role: String,
    text: String,
}

/// Display projection of one session transcript for the chat pane.
#[tauri::command]
async fn session_transcript(
    root: PathBuf,
    session: String,
) -> Result<Vec<TranscriptMessage>, BenchError> {
    sessions::validate_id(&session)?;
    tauri::async_runtime::spawn_blocking(move || {
        use llm::types::{InputItem, InputRole};
        let loaded = memory::load_transcript(&root, &session)?;
        Ok(loaded
            .items
            .iter()
            .filter_map(|item| match item {
                InputItem::Message { role, content } => Some(TranscriptMessage {
                    role: match role {
                        InputRole::User => "user".into(),
                        InputRole::Assistant => "agent".into(),
                    },
                    text: content.display_text(),
                }),
                InputItem::FunctionCall { name, .. } => Some(TranscriptMessage {
                    role: "tool".into(),
                    text: name.clone(),
                }),
                InputItem::FunctionCallOutput { .. } => None,
            })
            .collect())
    })
    .await
    .map_err(BenchError::io)?
}

/// Raw scene YAML for the read-only source view. Containment-checked.
#[tauri::command]
async fn read_scene_source(root: PathBuf, rel_path: String) -> Result<String, BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = project::resolve_inside(&root, &rel_path)?;
        if !matches!(
            resolved.extension().and_then(|e| e.to_str()),
            Some("yaml" | "yml")
        ) {
            return Err(BenchError::invalid("only scene YAML files can be read"));
        }
        let meta = std::fs::metadata(&resolved).map_err(BenchError::io)?;
        if meta.len() > 1024 * 1024 {
            return Err(BenchError::invalid("scene file is larger than 1 MB"));
        }
        std::fs::read_to_string(&resolved).map_err(BenchError::io)
    })
    .await
    .map_err(BenchError::io)?
}

/// Delete one scene YAML file. Containment-checked; UI confirms first.
#[tauri::command]
async fn delete_scene(root: PathBuf, rel_path: String) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = project::resolve_inside(&root, &rel_path)?;
        if !matches!(
            resolved.extension().and_then(|e| e.to_str()),
            Some("yaml" | "yml")
        ) {
            return Err(BenchError::invalid("only scene YAML files can be deleted"));
        }
        std::fs::remove_file(&resolved).map_err(BenchError::io)
    })
    .await
    .map_err(BenchError::io)?
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BuildEvent {
    Started { command: String },
    Finished { result: scorekit::BuildResult },
    Failed { error: BenchError },
}

/// Render one scene into `out/<stem>.<format>` inside the project, streaming
/// lifecycle events. The heavy lifting — and atomicity on failure — is scorekit's.
#[tauri::command]
async fn run_build(
    root: PathBuf,
    scene_rel: String,
    params: scorekit::BuildParams,
    format: Option<String>,
    events: Channel<BuildEvent>,
) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let scene_path = root.join(&scene_rel);
        let stem = scene_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "scene".into());
        let ext = match format.as_deref() {
            Some("wav") => "wav",
            _ => "ogg",
        };
        let output = root.join(project::OUT_DIR).join(format!("{stem}.{ext}"));

        let _ = events.send(BuildEvent::Started {
            command: format!("scorekit build {scene_rel} -o out/{stem}.{ext}"),
        });
        if let Err(err) = std::fs::create_dir_all(root.join(project::OUT_DIR)) {
            let _ = events.send(BuildEvent::Failed {
                error: BenchError::io(err),
            });
            return;
        }
        match scorekit::build(&scene_path, &output, &params) {
            Ok(result) => {
                let _ = events.send(BuildEvent::Finished { result });
            }
            Err(error) => {
                let _ = events.send(BuildEvent::Failed { error });
            }
        }
    })
    .await
    .map_err(BenchError::io)
}

/// Raw bytes of a project asset (audio/meta) for WebAudio decoding.
/// Path containment is enforced; binary IPC avoids JSON-encoding megabytes.
#[tauri::command]
async fn read_asset(root: PathBuf, rel_path: String) -> Result<Response, BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = project::resolve_inside(&root, &rel_path)?;
        let bytes = std::fs::read(&resolved).map_err(BenchError::io)?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(BenchError::io)?
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<settings::SettingsView, BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    tauri::async_runtime::spawn_blocking(move || {
        settings::settings_view(&config_dir, &settings::OsKeyring)
    })
    .await
    .map_err(BenchError::io)?
}

#[tauri::command]
async fn save_settings(app: AppHandle, value: settings::Settings) -> Result<(), BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    tauri::async_runtime::spawn_blocking(move || settings::save(&config_dir, &value))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn set_api_key(
    app: AppHandle,
    api_key: String,
    allow_insecure_storage: bool,
) -> Result<(), BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    tauri::async_runtime::spawn_blocking(move || {
        settings::store_api_key(
            &config_dir,
            &api_key,
            allow_insecure_storage,
            &settings::OsKeyring,
        )
    })
    .await
    .map_err(BenchError::io)?
}

#[tauri::command]
async fn test_connection(app: AppHandle) -> Result<String, BenchError> {
    settings::test_connection(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(agent::AgentState::default())
        .manage(watcher::ProjectWatcher::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scorekit_status,
            version_info,
            scorekit_doctor,
            open_project,
            refresh_project,
            inspect_scene,
            read_meta,
            send_chat,
            cancel_agent,
            list_sessions,
            create_session,
            select_session,
            session_transcript,
            read_scene_source,
            delete_scene,
            run_build,
            read_asset,
            get_settings,
            save_settings,
            set_api_key,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
