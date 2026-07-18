//! Project-local transcript, rolling memory, and recoverable compaction.
//!
//! A compaction transaction keeps complete old and new generations under
//! `.scorebench/compaction-txn/`. Canonical files are installed one by one;
//! absence of a final commit marker means recovery restores the old generation.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::BenchError;
use crate::llm::types::InputItem;

const STATE_DIR: &str = ".scorebench";
const MEMORY_FILE: &str = "memory.md";
const TRANSCRIPT_FILE: &str = "transcript.jsonl";
const ARCHIVE_FILE: &str = "transcript-archive.jsonl";
const TXN_DIR: &str = "compaction-txn";

#[derive(Debug, Default)]
pub struct LoadedTranscript {
    pub items: Vec<InputItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    memory_existed: bool,
    transcript_existed: bool,
    archive_existed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KillPoint {
    Prepared,
    MemoryInstalled,
    ArchiveInstalled,
    TranscriptInstalled,
}

pub fn load_transcript(root: &Path) -> Result<LoadedTranscript, BenchError> {
    recover(root)?;
    let path = state_path(root, TRANSCRIPT_FILE)?;
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LoadedTranscript::default())
        }
        Err(error) => return Err(BenchError::io(error)),
    };
    let mut loaded = LoadedTranscript::default();
    for (index, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<InputItem>(line) {
            Ok(item) => loaded.items.push(item),
            Err(error) => loaded.warnings.push(format!(
                "Skipped corrupt transcript line {}: {error}",
                index + 1
            )),
        }
    }
    Ok(loaded)
}

pub fn append_items(root: &Path, items: &[InputItem]) -> Result<(), BenchError> {
    if items.is_empty() {
        return Ok(());
    }
    recover(root)?;
    let path = state_path(root, TRANSCRIPT_FILE)?;
    let parent = path.parent().expect("state path has parent");
    fs::create_dir_all(parent).map_err(BenchError::io)?;
    let mut payload = Vec::new();
    for item in items {
        serde_json::to_writer(&mut payload, item).map_err(BenchError::io)?;
        payload.push(b'\n');
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(BenchError::io)?;
    file.write_all(&payload).map_err(BenchError::io)?;
    file.sync_data().map_err(BenchError::io)
}

pub fn read_memory(root: &Path) -> Result<String, BenchError> {
    recover(root)?;
    match fs::read_to_string(state_path(root, MEMORY_FILE)?) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(BenchError::io(error)),
    }
}

pub fn estimate_tokens(items: &[InputItem]) -> u64 {
    let chars = serde_json::to_string(items)
        .map(|value| value.chars().count())
        .unwrap_or(0);
    (chars as u64).div_ceil(4)
}

pub fn compact(
    root: &Path,
    new_memory: &str,
    folded: &[InputItem],
    kept: &[InputItem],
) -> Result<(), BenchError> {
    match compact_with_kill(root, new_memory, folded, kept, None) {
        Ok(()) => Ok(()),
        Err(error) => {
            let recovery = recover(root);
            recovery.and(Err(error))
        }
    }
}

fn compact_with_kill(
    root: &Path,
    new_memory: &str,
    folded: &[InputItem],
    kept: &[InputItem],
    kill: Option<KillPoint>,
) -> Result<(), BenchError> {
    recover(root)?;
    let state = state_path(root, "")?;
    fs::create_dir_all(&state).map_err(BenchError::io)?;
    let txn = state.join(TXN_DIR);
    fs::create_dir(&txn).map_err(BenchError::io)?;

    let memory = state.join(MEMORY_FILE);
    let transcript = state.join(TRANSCRIPT_FILE);
    let archive = state.join(ARCHIVE_FILE);
    let old_memory = read_or_empty(&memory)?;
    let old_transcript = read_or_empty(&transcript)?;
    let old_archive = read_or_empty(&archive)?;
    let manifest = Manifest {
        memory_existed: memory.exists(),
        transcript_existed: transcript.exists(),
        archive_existed: archive.exists(),
    };

    write_stage(&txn.join("memory.old"), &old_memory)?;
    write_stage(&txn.join("transcript.old"), &old_transcript)?;
    write_stage(&txn.join("archive.old"), &old_archive)?;
    write_stage(&txn.join("memory.new"), new_memory.as_bytes())?;
    write_stage(&txn.join("transcript.new"), &encode_items(kept)?)?;
    let mut new_archive = old_archive;
    if !new_archive.is_empty() && !new_archive.ends_with(b"\n") {
        new_archive.push(b'\n');
    }
    new_archive.extend(encode_items(folded)?);
    write_stage(&txn.join("archive.new"), &new_archive)?;
    write_stage(
        &txn.join("manifest.json"),
        &serde_json::to_vec(&manifest).map_err(BenchError::io)?,
    )?;
    sync_dir(&txn).map_err(BenchError::io)?;
    fail_at(kill, KillPoint::Prepared)?;

    install(&txn.join("memory.new"), &memory)?;
    fail_at(kill, KillPoint::MemoryInstalled)?;
    install(&txn.join("archive.new"), &archive)?;
    fail_at(kill, KillPoint::ArchiveInstalled)?;
    install(&txn.join("transcript.new"), &transcript)?;
    fail_at(kill, KillPoint::TranscriptInstalled)?;
    write_stage(&txn.join("committed"), b"ok")?;
    sync_dir(&txn).map_err(BenchError::io)?;
    fs::remove_dir_all(&txn).map_err(BenchError::io)?;
    sync_dir(&state).map_err(BenchError::io)?;
    Ok(())
}

pub fn recover(root: &Path) -> Result<(), BenchError> {
    let state = state_path(root, "")?;
    let txn = state.join(TXN_DIR);
    if !txn.exists() {
        return Ok(());
    }
    if txn.join("committed").exists() {
        fs::remove_dir_all(&txn).map_err(BenchError::io)?;
        return Ok(());
    }
    let manifest_path = txn.join("manifest.json");
    if !manifest_path.exists() {
        fs::remove_dir_all(&txn).map_err(BenchError::io)?;
        return Ok(());
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(BenchError::io)?)
            .map_err(|error| BenchError::invalid(format!("invalid compaction journal: {error}")))?;
    restore(
        &txn.join("memory.old"),
        &state.join(MEMORY_FILE),
        manifest.memory_existed,
    )?;
    restore(
        &txn.join("archive.old"),
        &state.join(ARCHIVE_FILE),
        manifest.archive_existed,
    )?;
    restore(
        &txn.join("transcript.old"),
        &state.join(TRANSCRIPT_FILE),
        manifest.transcript_existed,
    )?;
    fs::remove_dir_all(&txn).map_err(BenchError::io)?;
    sync_dir(&state).map_err(BenchError::io)?;
    Ok(())
}

fn restore(stage: &Path, target: &Path, existed: bool) -> Result<(), BenchError> {
    if existed {
        install(stage, target)
    } else {
        match fs::remove_file(target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(BenchError::io(error)),
        }
    }
}

fn install(stage: &Path, target: &Path) -> Result<(), BenchError> {
    let bytes = fs::read(stage).map_err(BenchError::io)?;
    atomic_write(target, &bytes).map_err(BenchError::io)
}

fn fail_at(selected: Option<KillPoint>, point: KillPoint) -> Result<(), BenchError> {
    if selected == Some(point) {
        Err(BenchError::io(format!("injected crash at {point:?}")))
    } else {
        Ok(())
    }
}

fn state_path(root: &Path, name: &str) -> Result<PathBuf, BenchError> {
    let root = root.canonicalize().map_err(BenchError::io)?;
    Ok(root.join(STATE_DIR).join(name))
}

fn encode_items(items: &[InputItem]) -> Result<Vec<u8>, BenchError> {
    let mut bytes = Vec::new();
    for item in items {
        serde_json::to_writer(&mut bytes, item).map_err(BenchError::io)?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}

fn read_or_empty(path: &Path) -> Result<Vec<u8>, BenchError> {
    match fs::read(path) {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(BenchError::io(error)),
    }
}

fn write_stage(path: &Path, bytes: &[u8]) -> Result<(), BenchError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(BenchError::io)?;
    file.write_all(bytes).map_err(BenchError::io)?;
    file.sync_all().map_err(BenchError::io)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("state"),
        unique_suffix()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        sync_dir(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        ^ u128::from(std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::InputRole;

    fn item(content: &str) -> InputItem {
        InputItem::Message {
            role: InputRole::User,
            content: content.into(),
        }
    }

    fn project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-memory-{name}-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn append_and_corrupt_line_recovery() {
        let root = project("load");
        append_items(&root, &[item("one"), item("two")]).unwrap();
        let transcript = state_path(&root, TRANSCRIPT_FILE).unwrap();
        let mut file = OpenOptions::new().append(true).open(transcript).unwrap();
        writeln!(file, "not-json").unwrap();
        let loaded = load_transcript(&root).unwrap();
        assert_eq!(loaded.items.len(), 2);
        assert_eq!(loaded.warnings.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn token_estimator_uses_chars_over_four() {
        let items = vec![item(&"x".repeat(400))];
        let estimate = estimate_tokens(&items);
        assert!((100..=120).contains(&estimate));
    }

    #[test]
    fn every_kill_point_restores_previous_generation() {
        for kill in [
            KillPoint::Prepared,
            KillPoint::MemoryInstalled,
            KillPoint::ArchiveInstalled,
            KillPoint::TranscriptInstalled,
        ] {
            let root = project(&format!("kill-{kill:?}"));
            let old = vec![item("old-one"), item("old-two")];
            append_items(&root, &old).unwrap();
            compact_with_kill(&root, "new memory", &old[..1], &old[1..], Some(kill)).unwrap_err();
            recover(&root).unwrap();
            assert_eq!(load_transcript(&root).unwrap().items, old);
            assert_eq!(read_memory(&root).unwrap(), "");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn committed_compaction_archives_folded_items() {
        let root = project("commit");
        let old = vec![item("old"), item("recent")];
        append_items(&root, &old).unwrap();
        compact(&root, "summary", &old[..1], &old[1..]).unwrap();
        assert_eq!(read_memory(&root).unwrap(), "summary");
        assert_eq!(load_transcript(&root).unwrap().items, old[1..]);
        let archive = fs::read_to_string(state_path(&root, ARCHIVE_FILE).unwrap()).unwrap();
        assert!(archive.contains("old"));
        fs::remove_dir_all(root).unwrap();
    }
}
