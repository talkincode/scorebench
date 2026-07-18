//! Project directory model: one window = one directory of plain files.
//! scorebench only observes; it never restructures the user's directory.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::BenchError;

pub const OUT_DIR: &str = "out";

#[derive(Debug, Clone, Serialize)]
pub struct SceneEntry {
    /// Path relative to the project root (stable identifier for the UI).
    pub rel_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetEntry {
    pub rel_path: String,
    pub name: String,
    /// `audio` (ogg/wav) or `meta` (meta.json).
    pub kind: String,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub name: String,
    pub scenes: Vec<SceneEntry>,
    pub assets: Vec<AssetEntry>,
}

/// Scan a project directory. Scenes are `*.yaml`/`*.yml` at the root or one
/// level deep (excluding `out/` and dot-directories); rendered assets live in
/// `out/` or next to scenes.
pub fn scan(root: &Path) -> Result<ProjectInfo, BenchError> {
    if !root.is_dir() {
        return Err(BenchError::invalid(format!(
            "`{}` is not a directory",
            root.display()
        )));
    }
    let root = root.canonicalize().map_err(BenchError::io)?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());

    let mut scenes = Vec::new();
    let mut assets = Vec::new();
    collect(&root, &root, 0, &mut scenes, &mut assets)?;
    scenes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    assets.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    Ok(ProjectInfo {
        root,
        name,
        scenes,
        assets,
    })
}

fn collect(
    root: &Path,
    dir: &Path,
    depth: usize,
    scenes: &mut Vec<SceneEntry>,
    assets: &mut Vec<AssetEntry>,
) -> Result<(), BenchError> {
    let entries = std::fs::read_dir(dir).map_err(BenchError::io)?;
    for entry in entries {
        let entry = entry.map_err(BenchError::io)?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            // Recurse one level into subdirectories; `out/` only contributes assets.
            if depth == 0 {
                collect(root, &path, 1, scenes, assets)?;
            }
            continue;
        }
        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let in_out_dir = rel_path.starts_with(&format!("{OUT_DIR}/"));
        let lower = file_name.to_lowercase();

        if (lower.ends_with(".yaml") || lower.ends_with(".yml")) && !in_out_dir {
            scenes.push(SceneEntry {
                rel_path,
                name: file_name,
            });
        } else if lower.ends_with(".ogg") || lower.ends_with(".wav") {
            assets.push(asset_entry(&path, rel_path, file_name, "audio"));
        } else if lower.ends_with(".meta.json") {
            assets.push(asset_entry(&path, rel_path, file_name, "meta"));
        }
    }
    Ok(())
}

fn asset_entry(path: &Path, rel_path: String, name: String, kind: &str) -> AssetEntry {
    let metadata = std::fs::metadata(path).ok();
    AssetEntry {
        rel_path,
        name,
        kind: kind.to_string(),
        size_bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
        modified_ms: metadata.and_then(|m| m.modified().ok()).and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as u64)
        }),
    }
}

/// Resolve a project-relative path and require the result to stay inside the
/// project root (containment check for asset reads from the webview).
pub fn resolve_inside(root: &Path, rel_path: &str) -> Result<PathBuf, BenchError> {
    let root = root.canonicalize().map_err(BenchError::io)?;
    let joined = root.join(rel_path);
    let resolved = joined
        .canonicalize()
        .map_err(|e| BenchError::io(format!("cannot access `{}`: {e}", joined.display())))?;
    if !resolved.starts_with(&root) {
        return Err(BenchError::invalid(format!(
            "`{rel_path}` escapes the project directory"
        )));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "scorebench-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::create_dir_all(dir.join("scenes")).unwrap();
        std::fs::write(dir.join("forest.yaml"), "title: x").unwrap();
        std::fs::write(dir.join("scenes/cave.yml"), "title: y").unwrap();
        std::fs::write(dir.join("out/forest.ogg"), b"OggS").unwrap();
        std::fs::write(dir.join("out/forest.meta.json"), "{}").unwrap();
        std::fs::write(dir.join("out/stale.yaml"), "not a scene").unwrap();
        std::fs::write(dir.join(".hidden.yaml"), "skip").unwrap();
        dir
    }

    #[test]
    fn scan_finds_scenes_and_assets() {
        let dir = temp_project();
        let info = scan(&dir).unwrap();
        let scene_paths: Vec<_> = info.scenes.iter().map(|s| s.rel_path.as_str()).collect();
        assert_eq!(scene_paths, vec!["forest.yaml", "scenes/cave.yml"]);
        let asset_paths: Vec<_> = info.assets.iter().map(|a| a.rel_path.as_str()).collect();
        assert_eq!(asset_paths, vec!["out/forest.meta.json", "out/forest.ogg"]);
        assert_eq!(info.assets[0].kind, "meta");
        assert_eq!(info.assets[1].kind, "audio");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_rejects_non_directory() {
        let err = scan(Path::new("/definitely/not/a/dir")).unwrap_err();
        assert!(matches!(err, BenchError::InvalidProject { .. }));
    }

    #[test]
    fn resolve_inside_blocks_escape() {
        let dir = temp_project();
        assert!(resolve_inside(&dir, "out/forest.ogg").is_ok());
        let err = resolve_inside(&dir, "../../etc/hosts").unwrap_err();
        assert!(matches!(
            err,
            BenchError::InvalidProject { .. } | BenchError::Io { .. }
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
