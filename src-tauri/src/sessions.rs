//! Chat sessions: plain-file index plus one state directory per session.
//!
//! Layout under the project root:
//! `.scorebench/sessions.json` — index (active id + metadata list)
//! `.scorebench/sessions/<id>/` — transcript, archive, memory, compaction txn
//!
//! A pre-session project (files directly under `.scorebench/`) is migrated
//! into `sessions/main/` the first time the index is loaded.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::BenchError;
use crate::memory;

const INDEX_FILE: &str = "sessions.json";
pub const DEFAULT_SESSION: &str = "main";
const MAX_SESSIONS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    /// Project-relative scene path this session is associated with, if any.
    pub scene: Option<String>,
    pub created_ms: u64,
    pub updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionsIndex {
    pub active: String,
    pub sessions: Vec<SessionMeta>,
}

/// Reject ids that could escape the sessions directory or collide with files.
pub fn validate_id(id: &str) -> Result<(), BenchError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(BenchError::invalid(format!(
            "invalid session id {id:?}: expected lowercase letters, digits, and dashes"
        )))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn state_dir(root: &Path) -> Result<PathBuf, BenchError> {
    let root = root.canonicalize().map_err(BenchError::io)?;
    Ok(root.join(memory::STATE_DIR))
}

fn index_path(root: &Path) -> Result<PathBuf, BenchError> {
    Ok(state_dir(root)?.join(INDEX_FILE))
}

/// Load the index, migrating legacy single-transcript state on first touch.
/// Guarantees at least one session and a valid `active` id.
pub fn load(root: &Path) -> Result<SessionsIndex, BenchError> {
    migrate_legacy(root)?;
    let path = index_path(root)?;
    let mut index = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<SessionsIndex>(&bytes).map_err(|error| {
            BenchError::invalid(format!("sessions.json is not readable: {error}"))
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => SessionsIndex {
            active: DEFAULT_SESSION.into(),
            sessions: vec![],
        },
        Err(error) => return Err(BenchError::io(error)),
    };
    if index.sessions.is_empty() {
        let now = now_ms();
        index.sessions.push(SessionMeta {
            id: DEFAULT_SESSION.into(),
            title: "Main session".into(),
            scene: None,
            created_ms: now,
            updated_ms: now,
        });
        index.active = DEFAULT_SESSION.into();
        save(root, &index)?;
    }
    if !index.sessions.iter().any(|s| s.id == index.active) {
        index.active = index.sessions[0].id.clone();
        save(root, &index)?;
    }
    Ok(index)
}

fn save(root: &Path, index: &SessionsIndex) -> Result<(), BenchError> {
    let path = index_path(root)?;
    let parent = path.parent().expect("index path has parent");
    fs::create_dir_all(parent).map_err(BenchError::io)?;
    let bytes = serde_json::to_vec_pretty(index).map_err(BenchError::io)?;
    let temp = parent.join(format!(".{INDEX_FILE}.tmp-{}", std::process::id()));
    fs::write(&temp, &bytes).map_err(BenchError::io)?;
    fs::rename(&temp, &path).map_err(BenchError::io)
}

/// Move pre-session state files into `sessions/main/` exactly once.
fn migrate_legacy(root: &Path) -> Result<(), BenchError> {
    let state = state_dir(root)?;
    let legacy_transcript = state.join(memory::TRANSCRIPT_FILE);
    if state.join(INDEX_FILE).exists() || !legacy_transcript.exists() {
        return Ok(());
    }
    let target = state.join(memory::SESSIONS_DIR).join(DEFAULT_SESSION);
    fs::create_dir_all(&target).map_err(BenchError::io)?;
    for name in [
        memory::TRANSCRIPT_FILE,
        memory::ARCHIVE_FILE,
        memory::MEMORY_FILE,
        memory::TXN_DIR,
    ] {
        let from = state.join(name);
        if from.exists() {
            fs::rename(&from, target.join(name)).map_err(BenchError::io)?;
        }
    }
    let now = now_ms();
    save(
        root,
        &SessionsIndex {
            active: DEFAULT_SESSION.into(),
            sessions: vec![SessionMeta {
                id: DEFAULT_SESSION.into(),
                title: "Main session".into(),
                scene: None,
                created_ms: now,
                updated_ms: now,
            }],
        },
    )
}

/// Create a session, mark it active, and return its metadata.
pub fn create(
    root: &Path,
    title: Option<String>,
    scene: Option<String>,
) -> Result<SessionMeta, BenchError> {
    let mut index = load(root)?;
    if index.sessions.len() >= MAX_SESSIONS {
        return Err(BenchError::invalid(format!(
            "session limit reached ({MAX_SESSIONS}); delete old sessions first"
        )));
    }
    let now = now_ms();
    let mut id = format!("s-{now}");
    let mut bump = 0u32;
    while index.sessions.iter().any(|s| s.id == id) {
        bump += 1;
        id = format!("s-{now}-{bump}");
    }
    validate_id(&id)?;
    let title = title
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("Session {}", index.sessions.len() + 1));
    let meta = SessionMeta {
        id: id.clone(),
        title,
        scene,
        created_ms: now,
        updated_ms: now,
    };
    index.sessions.push(meta.clone());
    index.active = id;
    save(root, &index)?;
    Ok(meta)
}

/// Mark an existing session active.
pub fn set_active(root: &Path, id: &str) -> Result<(), BenchError> {
    validate_id(id)?;
    let mut index = load(root)?;
    if !index.sessions.iter().any(|s| s.id == id) {
        return Err(BenchError::invalid(format!("unknown session {id:?}")));
    }
    index.active = id.into();
    save(root, &index)
}

/// Bump `updated_ms` (and optionally the scene association) after activity.
pub fn touch(root: &Path, id: &str, scene: Option<String>) -> Result<(), BenchError> {
    validate_id(id)?;
    let mut index = load(root)?;
    let Some(meta) = index.sessions.iter_mut().find(|s| s.id == id) else {
        return Err(BenchError::invalid(format!("unknown session {id:?}")));
    };
    meta.updated_ms = now_ms();
    if scene.is_some() {
        meta.scene = scene;
    }
    save(root, &index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{InputItem, InputRole};

    fn project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-sessions-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn empty_project_gets_default_session() {
        let root = project("fresh");
        let index = load(&root).unwrap();
        assert_eq!(index.active, DEFAULT_SESSION);
        assert_eq!(index.sessions.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_transcript_migrates_into_main_session() {
        let root = project("legacy");
        let state = root.join(memory::STATE_DIR);
        fs::create_dir_all(&state).unwrap();
        fs::write(
            state.join(memory::TRANSCRIPT_FILE),
            "{\"type\":\"message\",\"role\":\"user\",\"content\":\"legacy turn\"}\n",
        )
        .unwrap();
        fs::write(state.join(memory::MEMORY_FILE), "old memory").unwrap();

        let index = load(&root).unwrap();
        assert_eq!(index.active, DEFAULT_SESSION);
        assert!(!state.join(memory::TRANSCRIPT_FILE).exists());
        let loaded = memory::load_transcript(&root, DEFAULT_SESSION).unwrap();
        assert_eq!(loaded.items.len(), 1);
        assert!(matches!(
            &loaded.items[0],
            InputItem::Message { role: InputRole::User, content }
                if content.display_text() == "legacy turn"
        ));
        assert_eq!(
            memory::read_memory(&root, DEFAULT_SESSION).unwrap(),
            "old memory"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_select_and_touch_round_trip() {
        let root = project("crud");
        let created = create(
            &root,
            Some("Ballad ideas".into()),
            Some("scenes/b.yaml".into()),
        )
        .unwrap();
        assert_eq!(load(&root).unwrap().active, created.id);
        set_active(&root, DEFAULT_SESSION).unwrap();
        assert_eq!(load(&root).unwrap().active, DEFAULT_SESSION);
        touch(&root, &created.id, Some("scenes/other.yaml".into())).unwrap();
        let index = load(&root).unwrap();
        let meta = index.sessions.iter().find(|s| s.id == created.id).unwrap();
        assert_eq!(meta.scene.as_deref(), Some("scenes/other.yaml"));
        assert!(set_active(&root, "../escape").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transcripts_are_isolated_per_session() {
        let root = project("isolated");
        let a = create(&root, None, None).unwrap();
        let b = create(&root, None, None).unwrap();
        let item = InputItem::Message {
            role: InputRole::User,
            content: "only in a".into(),
        };
        memory::append_items(&root, &a.id, std::slice::from_ref(&item)).unwrap();
        assert_eq!(
            memory::load_transcript(&root, &a.id).unwrap().items.len(),
            1
        );
        assert!(memory::load_transcript(&root, &b.id)
            .unwrap()
            .items
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
