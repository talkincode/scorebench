mod agent;
mod error;
mod project;
mod scorekit;

use std::path::PathBuf;

use tauri::ipc::{Channel, Response};

use error::BenchError;

/// Where the scorekit binary was found (or a typed error telling the user how to fix it).
#[tauri::command]
fn scorekit_status() -> Result<String, BenchError> {
    scorekit::locate().map(|p| p.display().to_string())
}

#[tauri::command]
async fn scorekit_doctor() -> Result<serde_json::Value, BenchError> {
    tauri::async_runtime::spawn_blocking(scorekit::doctor)
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn open_project(path: PathBuf) -> Result<project::ProjectInfo, BenchError> {
    tauri::async_runtime::spawn_blocking(move || project::scan(&path))
        .await
        .map_err(BenchError::io)?
}

#[tauri::command]
async fn send_chat(
    root: PathBuf,
    message: String,
    events: Channel<agent::AgentEvent>,
) -> Result<(), BenchError> {
    tauri::async_runtime::spawn_blocking(move || {
        agent::respond(&root, &message, |event| {
            let _ = events.send(event);
        });
    })
    .await
    .map_err(BenchError::io)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scorekit_status,
            scorekit_doctor,
            open_project,
            send_chat,
            run_build,
            read_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
