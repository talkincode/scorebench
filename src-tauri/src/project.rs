//! Project directory model: one window = one directory of plain files.
//! Writes are explicit, containment-checked, and atomic; scorebench never
//! restructures the user's directory into an internal database.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Resolve a project-relative write target. The target may not exist yet, so
/// containment is proven from the canonical parent directory.
pub fn resolve_for_write(root: &Path, rel_path: &str) -> Result<PathBuf, BenchError> {
    let rel = Path::new(rel_path);
    if rel.as_os_str().is_empty()
        || rel.is_absolute()
        || rel.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(BenchError::invalid(format!(
            "`{rel_path}` is not a safe project-relative path"
        )));
    }
    let root = root.canonicalize().map_err(BenchError::io)?;
    let joined = root.join(rel);
    let parent = joined
        .parent()
        .ok_or_else(|| BenchError::invalid("write target has no parent"))?;
    std::fs::create_dir_all(parent).map_err(BenchError::io)?;
    let parent = parent.canonicalize().map_err(BenchError::io)?;
    if !parent.starts_with(&root) {
        return Err(BenchError::invalid(format!(
            "`{rel_path}` escapes the project directory"
        )));
    }
    Ok(joined)
}

pub fn read_text_inside(root: &Path, rel_path: &str) -> Result<String, BenchError> {
    let path = resolve_inside(root, rel_path)?;
    std::fs::read_to_string(&path)
        .map_err(|err| BenchError::io(format!("cannot read `{}`: {err}", path.display())))
}

fn require_scene_suffix(rel_path: &str) -> Result<(), BenchError> {
    let lower = rel_path.to_ascii_lowercase();
    if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        Ok(())
    } else {
        Err(BenchError::invalid("scene path must end in .yaml or .yml"))
    }
}

/// Starter content for a manually created scene.
pub const SCENE_TEMPLATE: &str = "title: New Scene\ntempo: 100\nkey: C_major\ntime_signature: \"4/4\"\nbars: 8\nloop: true\ntracks:\n  - instrument: piano\n    pattern: arpeggio\n    intensity: 0.5\n";

/// Create a new scene file from the starter template. Refuses to overwrite.
pub fn create_scene(root: &Path, rel_path: &str) -> Result<PathBuf, BenchError> {
    require_scene_suffix(rel_path)?;
    let target = resolve_for_write(root, rel_path)?;
    if target.exists() {
        return Err(BenchError::invalid(format!("`{rel_path}` already exists")));
    }
    atomic_write_with(&target, SCENE_TEMPLATE.as_bytes(), |_| Ok(())).map_err(BenchError::io)?;
    Ok(target)
}

/// Snapshot the previous content of `rel_path` into `.scorebench/history/`.
pub fn snapshot_history(
    root: &Path,
    rel_path: &str,
    previous: &str,
) -> Result<PathBuf, BenchError> {
    let safe_name = rel_path
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rel = format!(".scorebench/history/{stamp}-{safe_name}");
    write_text_atomic(root, &rel, previous)
}

/// Explicit manual save of scene source (no autosave path exists). Snapshots
/// the previous content into history first; a failed snapshot degrades to a
/// warning, never blocks the save.
pub fn save_scene_source(
    root: &Path,
    rel_path: &str,
    content: &str,
) -> Result<Vec<String>, BenchError> {
    require_scene_suffix(rel_path)?;
    let target = resolve_for_write(root, rel_path)?;
    let mut warnings = Vec::new();
    match std::fs::read_to_string(&target) {
        Ok(previous) => {
            if let Err(error) = snapshot_history(root, rel_path, &previous) {
                warnings.push(format!("history snapshot failed: {error}"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(BenchError::io(error)),
    }
    write_text_atomic(root, rel_path, content)?;
    Ok(warnings)
}

pub fn write_text_atomic(root: &Path, rel_path: &str, text: &str) -> Result<PathBuf, BenchError> {
    let target = resolve_for_write(root, rel_path)?;
    atomic_write_with(&target, text.as_bytes(), |_| Ok(())).map_err(BenchError::io)?;
    Ok(target)
}

fn atomic_write_with<F>(target: &Path, bytes: &[u8], before_rename: F) -> std::io::Result<()>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    use std::io::Write;

    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent"))?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        ^ u128::from(std::process::id());
    let temp = parent.join(format!(
        ".{}.tmp-{suffix}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("scene")
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        before_rename(&temp)?;
        std::fs::rename(&temp, target)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
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
    fn create_scene_writes_template_and_refuses_overwrite() {
        let dir = temp_project();
        let path = create_scene(&dir, "manual.yaml").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCENE_TEMPLATE);
        assert!(create_scene(&dir, "manual.yaml").is_err());
        assert!(create_scene(&dir, "manual.txt").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_scene_source_snapshots_previous_content() {
        let dir = temp_project();
        let warnings = save_scene_source(&dir, "forest.yaml", "title: updated\n").unwrap();
        assert!(warnings.is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("forest.yaml")).unwrap(),
            "title: updated\n"
        );
        let history: Vec<_> = std::fs::read_dir(dir.join(".scorebench/history"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(history.len(), 1);
        assert_eq!(std::fs::read_to_string(&history[0]).unwrap(), "title: x");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_scene_source_creates_new_file_without_history() {
        let dir = temp_project();
        save_scene_source(&dir, "fresh.yml", "title: fresh\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("fresh.yml")).unwrap(),
            "title: fresh\n"
        );
        assert!(!dir.join(".scorebench/history").exists());
        assert!(save_scene_source(&dir, "../escape.yaml", "x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
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

    #[test]
    fn resolve_for_write_blocks_escape() {
        let dir = temp_project();
        assert!(resolve_for_write(&dir, "scenes/new.yaml").is_ok());
        assert!(resolve_for_write(&dir, "../escape.yaml").is_err());
        assert!(resolve_for_write(&dir, "/tmp/escape.yaml").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_atomic_scene_write_preserves_original() {
        let dir = temp_project();
        let target = dir.join("forest.yaml");
        let error = atomic_write_with(&target, b"replacement", |_| {
            Err(std::io::Error::other("rename kill point"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "rename kill point");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "title: x");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
