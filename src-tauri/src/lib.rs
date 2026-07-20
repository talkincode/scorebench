mod agent;
mod attachments;
mod error;
mod llm;
mod manifest;
mod memory;
mod observation;
mod project;
mod review;
mod scorekit;
mod sessions;
mod settings;
mod styles;
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

/// Resolve the project's active style pack (bench.json `style.id` → global
/// library). A dangling reference degrades to no pack plus a warning — a
/// deleted pack must never block chat or review.
fn active_style(
    config_dir: &std::path::Path,
    root: &std::path::Path,
) -> (Option<styles::StylePack>, Option<String>) {
    match manifest::load(root).0.style {
        Some(style) => match styles::find(config_dir, &style.id) {
            Some(pack) => (Some(pack), None),
            None => (
                None,
                Some(format!(
                    "style pack `{}` referenced by bench.json was not found; composing without it",
                    style.id
                )),
            ),
        },
        None => (None, None),
    }
}

/// Persist bytes pasted into the chat composer to a temp file so the normal
/// path-based attachment pipeline can pick them up. Returns the stashed path.
#[tauri::command]
async fn stash_attachment(file_name: String, data_base64: String) -> Result<String, BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|_| BenchError::invalid("pasted attachment is not valid base64"))?;
        let path = attachments::stash(&file_name, &bytes)?;
        Ok(path.display().to_string())
    })
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
    let (settings, api_key, instructions, style_warning) =
        tauri::async_runtime::spawn_blocking(move || {
            let (settings, _) = settings::load(&config_dir)?;
            let api_key =
                settings::load_api_key(&config_dir, &settings::OsKeyring)?.ok_or_else(|| {
                    BenchError::settings(
                        "api_key_missing",
                        "set an API key in Settings before chatting",
                    )
                })?;
            let (style, style_warning) = active_style(&config_dir, &prompt_root);
            let instructions = agent::system_prompt(&prompt_root, &prompt_session, style.as_ref())?;
            Ok::<_, BenchError>((settings, api_key, instructions, style_warning))
        })
        .await
        .map_err(BenchError::io)??;
    if let Some(text) = style_warning {
        let _ = events.send(agent::AgentEvent::Warning { text });
    }
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

/// One-shot multi-perspective review of a scene. Streams text deltas over the
/// channel and returns the parsed structured report. The reviewer has no
/// tools and never writes; the composing agent stays the only writer.
#[tauri::command]
async fn run_review(
    app: AppHandle,
    state: State<'_, agent::AgentState>,
    root: PathBuf,
    session: String,
    scene_rel: String,
    perspectives: Vec<String>,
    events: Channel<review::ReviewEvent>,
) -> Result<review::ReviewReport, BenchError> {
    sessions::validate_id(&session)?;
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    let evidence_root = root.clone();
    let (settings, api_key, evidence) = tauri::async_runtime::spawn_blocking(move || {
        let (settings, _) = settings::load(&config_dir)?;
        let api_key =
            settings::load_api_key(&config_dir, &settings::OsKeyring)?.ok_or_else(|| {
                BenchError::settings(
                    "api_key_missing",
                    "set an API key in Settings before reviewing",
                )
            })?;
        let evidence = {
            let (style, _) = active_style(&config_dir, &evidence_root);
            review::gather_evidence(&evidence_root, &session, &scene_rel, style.as_ref())?
        };
        Ok::<_, BenchError>((settings, api_key, evidence))
    })
    .await
    .map_err(BenchError::io)??;
    let instructions = review::instructions(&perspectives, &settings.locale)?;
    let client = llm::ResponsesClient::new(llm::LlmConfig {
        base_url: settings.base_url,
        api_key,
        model: settings.model,
        timeout: std::time::Duration::from_secs(120),
    })?;
    let root = root.canonicalize().map_err(BenchError::io)?;
    let cancellation = state.activate(&root, review::CANCEL_KEY)?;
    let result = review::run_review(&client, instructions, &evidence, cancellation, |event| {
        let _ = events.send(event);
    })
    .await;
    state.clear_active(&root, review::CANCEL_KEY)?;
    result
}

#[tauri::command]
fn cancel_review(root: PathBuf, state: State<'_, agent::AgentState>) -> Result<bool, BenchError> {
    state.cancel(&root, review::CANCEL_KEY)
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

/// Create a new scene YAML from the starter template (manual workflow).
#[tauri::command]
async fn create_scene(root: PathBuf, rel_path: String) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        project::create_scene(&root, &rel_path).map(|_| ())
    })
    .await
    .map_err(BenchError::io)?
}

/// Explicit manual save of scene source (the editor never autosaves).
/// Returns non-fatal warnings (e.g. a failed history snapshot).
#[tauri::command]
async fn save_scene_source(
    root: PathBuf,
    rel_path: String,
    content: String,
) -> Result<Vec<String>, BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        project::save_scene_source(&root, &rel_path, &content)
    })
    .await
    .map_err(BenchError::io)?
}

/// Validate unsaved editor content via `scorekit validate --json`.
#[tauri::command]
async fn validate_scene_content(
    root: PathBuf,
    content: String,
) -> Result<observation::ValidationDisplay, BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        observation::validate_scene_content(&root, &content)
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

/// Load the persisted render configuration from bench.json (tolerant read).
#[tauri::command]
async fn load_render_config(
    root: PathBuf,
) -> Result<(Option<manifest::RenderConfig>, Option<String>), BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (loaded, warning) = manifest::load(&root);
        Ok((loaded.render, warning))
    })
    .await
    .map_err(BenchError::io)?
}

/// Persist the render panel selection so the agent composes for the same
/// renderer/profile the user renders with.
#[tauri::command]
async fn save_render_config(
    root: PathBuf,
    render: Option<manifest::RenderConfig>,
) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || manifest::save_render(&root, render))
        .await
        .map_err(BenchError::io)?
}

/// The style pack library: built-in presets plus user packs, with warnings
/// for files that were skipped (corrupt or id-colliding).
#[tauri::command]
async fn list_style_packs(
    app: AppHandle,
) -> Result<(Vec<styles::StylePack>, Vec<String>), BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    tauri::async_runtime::spawn_blocking(move || Ok(styles::list(&config_dir)))
        .await
        .map_err(BenchError::io)?
}

/// Create or update a user style pack from raw YAML. `previous_id` lets a
/// rename move the pack file instead of duplicating it.
#[tauri::command]
async fn save_style_pack(
    app: AppHandle,
    yaml: String,
    previous_id: Option<String>,
) -> Result<styles::StylePack, BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    tauri::async_runtime::spawn_blocking(move || {
        styles::save(&config_dir, &yaml, previous_id.as_deref())
    })
    .await
    .map_err(BenchError::io)?
}

/// Delete a user style pack (built-ins are read-only). UI confirms first.
#[tauri::command]
async fn delete_style_pack(app: AppHandle, id: String) -> Result<(), BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    tauri::async_runtime::spawn_blocking(move || styles::delete(&config_dir, &id))
        .await
        .map_err(BenchError::io)?
}

/// Load the project's style selection from bench.json (tolerant read).
#[tauri::command]
async fn load_style_config(
    root: PathBuf,
) -> Result<(Option<manifest::StyleRef>, Option<String>), BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (loaded, warning) = manifest::load(&root);
        Ok((loaded.style, warning))
    })
    .await
    .map_err(BenchError::io)?
}

/// Persist the style selector choice so the agent and reviewer follow the
/// same style pack the user picked.
#[tauri::command]
async fn save_style_config(
    root: PathBuf,
    style: Option<manifest::StyleRef>,
) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || manifest::save_style(&root, style))
        .await
        .map_err(BenchError::io)?
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

/// One-shot handoff of the user-approved export destination between
/// `choose_recording_path` and `save_recording`: the raw-body IPC used for
/// the video bytes carries no JSON args, and keeping the path Rust-side means
/// the webview never names a write target.
#[derive(Default)]
struct RecordingSink(std::sync::Mutex<Option<PathBuf>>);

/// Save-dialog filter derived from the suggested file name's extension.
fn recording_filter(suggested_name: &str) -> (&'static str, &'static [&'static str]) {
    if suggested_name.ends_with(".webm") {
        ("WebM video", &["webm"])
    } else {
        ("MP4 video", &["mp4"])
    }
}

/// Native save dialog for an exported visualizer video. The chosen path is
/// held in [`RecordingSink`] for the follow-up `save_recording` call; only a
/// display string goes back to the webview.
#[tauri::command]
async fn choose_recording_path(
    app: AppHandle,
    sink: State<'_, RecordingSink>,
    suggested_name: String,
) -> Result<Option<String>, BenchError> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let (label, extensions) = recording_filter(&suggested_name);
        app.dialog()
            .file()
            .add_filter(label, extensions)
            .set_file_name(&suggested_name)
            .blocking_save_file()
    })
    .await
    .map_err(BenchError::io)?;
    let Some(path) = picked else {
        *sink.0.lock().expect("recording sink lock") = None;
        return Ok(None);
    };
    let path = path.into_path().map_err(BenchError::io)?;
    *sink.0.lock().expect("recording sink lock") = Some(path.clone());
    Ok(Some(path.display().to_string()))
}

/// Write recorded video bytes (raw IPC body — encoded entirely by the
/// webview's MediaRecorder, the core never touches media samples) to the path
/// approved by the preceding `choose_recording_path` call. `async` keeps the
/// blocking write off the main thread.
#[tauri::command(async)]
fn save_recording(
    sink: State<'_, RecordingSink>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, BenchError> {
    let path = sink
        .0
        .lock()
        .expect("recording sink lock")
        .take()
        .ok_or_else(|| BenchError::io("no export destination chosen"))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(BenchError::io("expected raw video bytes in request body"));
    };
    std::fs::write(&path, bytes).map_err(BenchError::io)?;
    Ok(path.display().to_string())
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
        .manage(RecordingSink::default())
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
            stash_attachment,
            send_chat,
            cancel_agent,
            run_review,
            cancel_review,
            list_sessions,
            create_session,
            select_session,
            session_transcript,
            read_scene_source,
            delete_scene,
            create_scene,
            save_scene_source,
            validate_scene_content,
            run_build,
            load_render_config,
            save_render_config,
            list_style_packs,
            save_style_pack,
            delete_style_pack,
            load_style_config,
            save_style_config,
            read_asset,
            choose_recording_path,
            save_recording,
            get_settings,
            save_settings,
            set_api_key,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_filter_follows_suggested_extension() {
        assert_eq!(
            recording_filter("a-visualizer.mp4"),
            ("MP4 video", &["mp4"][..])
        );
        assert_eq!(
            recording_filter("a-visualizer.webm"),
            ("WebM video", &["webm"][..])
        );
        // Unknown extensions fall back to the mp4 filter rather than failing.
        assert_eq!(recording_filter("clip.mov").0, "MP4 video");
    }

    #[test]
    fn recording_sink_hands_over_exactly_once() {
        let sink = RecordingSink::default();
        *sink.0.lock().unwrap() = Some(PathBuf::from("/tmp/out.mp4"));
        assert_eq!(
            sink.0.lock().unwrap().take(),
            Some(PathBuf::from("/tmp/out.mp4"))
        );
        assert_eq!(sink.0.lock().unwrap().take(), None);
    }
}
