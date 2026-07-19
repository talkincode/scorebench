//! Boundary guard: Tauri APIs are confined to the host layer.
//!
//! Iron rule (docs/roadmap.md): core modules stay framework-free so a second
//! host (e.g. an HTTP server) would remain a mechanical extraction. If this
//! test fails, move the Tauri-dependent code into a host-layer file or pass
//! the capability in as a parameter (as `agent::run` does with `emit`).

use std::fs;
use std::path::{Path, PathBuf};

const HOST_LAYER: &[&str] = &["lib.rs", "main.rs", "watcher.rs", "settings.rs"];

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("readable src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn core_modules_are_tauri_free() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    rust_sources(&src, &mut sources);
    assert!(!sources.is_empty(), "expected Rust sources under src/");

    let offenders: Vec<String> = sources
        .iter()
        .filter(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Host-layer files must sit directly in src/ — no nested bypass.
            !(HOST_LAYER.contains(&name) && path.parent() == Some(src.as_path()))
        })
        .filter(|path| {
            fs::read_to_string(path)
                .expect("readable source file")
                .contains("tauri")
        })
        .map(|path| {
            path.strip_prefix(&src)
                .unwrap_or(path)
                .display()
                .to_string()
        })
        .collect();

    assert!(
        offenders.is_empty(),
        "`tauri` referenced outside the host layer {HOST_LAYER:?}: {offenders:?}"
    );
}
