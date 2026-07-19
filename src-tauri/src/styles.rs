//! Style packs: structured, extensible creative-style definitions.
//!
//! A style pack is NOT a prompt snippet. It is a small YAML document with a
//! typed envelope (`id`, `name`, optional `name_en` / `category`) and a
//! free-form structured body (`defaults`, `harmony`, `melody`, `arrangement`,
//! `form`, `review`, ...) that the agent treats as the project's musical
//! constitution and the review panel treats as extra judging criteria.
//!
//! Storage model:
//! - Built-in packs are compiled into the binary (`../styles/builtin/*.yaml`)
//!   and are read-only; users duplicate them to customize.
//! - User packs live in the app config dir under `styles/<id>.yaml`, outside
//!   any project, mirroring where settings live. Projects reference a pack by
//!   id in `bench.json` (`manifest::StyleRef`), so the selection is
//!   per-project and diff-friendly while the library is shared.
//!
//! The body is intentionally schema-loose: unknown fields are allowed so
//! users can extend packs without a scorebench release. Only the envelope is
//! validated. The whole YAML is injected into the system prompt together
//! with a mandatory conflict-detection protocol, so the agent surfaces
//! request-vs-style conflicts instead of blindly implementing either side.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::BenchError;

/// Directory under the app config dir holding user-defined packs.
pub const STYLES_DIR: &str = "styles";

/// Keep packs prompt-sized: they are injected into every agent run.
const MAX_YAML_BYTES: usize = 16 * 1024;
const MAX_NAME_CHARS: usize = 120;

const BUILTIN_SOURCES: &[&str] = &[
    include_str!("../styles/builtin/epic-new-age-instrumental.yaml"),
    include_str!("../styles/builtin/chinese-campus-folk-90s.yaml"),
    include_str!("../styles/builtin/chiptune-adventure.yaml"),
    include_str!("../styles/builtin/cinematic-underscore.yaml"),
];

/// One style pack. `yaml` is the single authoritative representation; the
/// envelope fields are extracted for listing, display, and file naming.
#[derive(Debug, Clone, Serialize)]
pub struct StylePack {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub builtin: bool,
    pub yaml: String,
}

/// Reject ids that could escape the styles directory or collide with files.
/// Mirrors `sessions::validate_id`.
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
            "invalid style pack id {id:?}: expected lowercase letters, digits, and dashes"
        )))
    }
}

/// Parse and validate one pack source. The body stays free-form; only the
/// envelope is checked so packs remain extensible by hand.
pub fn parse(yaml: &str, builtin: bool) -> Result<StylePack, BenchError> {
    if yaml.len() > MAX_YAML_BYTES {
        return Err(BenchError::invalid(format!(
            "style pack YAML exceeds {MAX_YAML_BYTES} bytes; packs are injected into every prompt and must stay small"
        )));
    }
    let value: serde_yaml::Value = serde_yaml::from_str(yaml)
        .map_err(|err| BenchError::invalid(format!("style pack is not valid YAML: {err}")))?;
    let mapping = value
        .as_mapping()
        .ok_or_else(|| BenchError::invalid("style pack YAML must be a mapping"))?;
    let field = |key: &str| -> Result<Option<String>, BenchError> {
        match mapping.get(key) {
            None | Some(serde_yaml::Value::Null) => Ok(None),
            Some(serde_yaml::Value::String(text)) => Ok(Some(text.trim().to_owned())),
            Some(_) => Err(BenchError::invalid(format!(
                "style pack field `{key}` must be a string"
            ))),
        }
    };
    let id = field("id")?
        .filter(|id| !id.is_empty())
        .ok_or_else(|| BenchError::invalid("style pack needs a non-empty `id`"))?;
    validate_id(&id)?;
    let name = field("name")?
        .filter(|name| !name.is_empty())
        .ok_or_else(|| BenchError::invalid("style pack needs a non-empty `name`"))?;
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(BenchError::invalid(format!(
            "style pack `name` must stay under {MAX_NAME_CHARS} characters"
        )));
    }
    Ok(StylePack {
        id,
        name,
        name_en: field("name_en")?.filter(|v| !v.is_empty()),
        category: field("category")?.filter(|v| !v.is_empty()),
        builtin,
        yaml: yaml.to_owned(),
    })
}

/// The compiled-in preset library. Sources are validated by unit tests, so a
/// parse failure here is a build defect worth panicking over in tests; at
/// runtime malformed entries are skipped defensively.
pub fn builtins() -> Vec<StylePack> {
    BUILTIN_SOURCES
        .iter()
        .filter_map(|source| parse(source, true).ok())
        .collect()
}

fn user_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(STYLES_DIR)
}

fn user_pack_path(config_dir: &Path, id: &str) -> PathBuf {
    user_dir(config_dir).join(format!("{id}.yaml"))
}

/// All packs: built-ins first (fixed order), then user packs sorted by file
/// name. Corrupt or conflicting user files are skipped with a warning —
/// a broken pack must never brick the library.
pub fn list(config_dir: &Path) -> (Vec<StylePack>, Vec<String>) {
    let mut packs = builtins();
    let mut warnings = Vec::new();
    let dir = user_dir(config_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (packs, warnings),
        Err(error) => {
            warnings.push(format!("style library unreadable: {error}"));
            return (packs, warnings);
        }
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("yaml" | "yml")
            )
        })
        .collect();
    files.sort();
    for path in files {
        let display = path.file_name().unwrap_or_default().to_string_lossy();
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                warnings.push(format!("style pack {display} unreadable: {error}"));
                continue;
            }
        };
        match parse(&raw, false) {
            Ok(pack) => {
                if packs.iter().any(|known| known.id == pack.id) {
                    warnings.push(format!(
                        "style pack {display} skipped: id `{}` already exists",
                        pack.id
                    ));
                } else {
                    packs.push(pack);
                }
            }
            Err(error) => warnings.push(format!("style pack {display} skipped: {error}")),
        }
    }
    (packs, warnings)
}

/// Resolve one pack by id (built-ins win, matching `list` precedence).
pub fn find(config_dir: &Path, id: &str) -> Option<StylePack> {
    list(config_dir).0.into_iter().find(|pack| pack.id == id)
}

/// Create or update a user pack from raw YAML. `previous_id` is the id the
/// editor loaded, so renaming a pack in the YAML moves its file instead of
/// leaving a stale copy behind.
pub fn save(
    config_dir: &Path,
    yaml: &str,
    previous_id: Option<&str>,
) -> Result<StylePack, BenchError> {
    let pack = parse(yaml, false)?;
    if builtins().iter().any(|builtin| builtin.id == pack.id) {
        return Err(BenchError::invalid(format!(
            "`{}` is a built-in style pack and cannot be overwritten; pick another id",
            pack.id
        )));
    }
    let path = user_pack_path(config_dir, &pack.id);
    std::fs::create_dir_all(user_dir(config_dir)).map_err(BenchError::io)?;
    // Atomic replace: a crash mid-save must never corrupt an existing pack.
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, yaml).map_err(BenchError::io)?;
    std::fs::rename(&tmp, &path).map_err(BenchError::io)?;
    if let Some(previous) = previous_id {
        if previous != pack.id && validate_id(previous).is_ok() {
            let _ = std::fs::remove_file(user_pack_path(config_dir, previous));
        }
    }
    Ok(pack)
}

/// Delete a user pack. Built-ins are read-only by design.
pub fn delete(config_dir: &Path, id: &str) -> Result<(), BenchError> {
    validate_id(id)?;
    if builtins().iter().any(|builtin| builtin.id == id) {
        return Err(BenchError::invalid(format!(
            "`{id}` is a built-in style pack and cannot be deleted"
        )));
    }
    match std::fs::remove_file(user_pack_path(config_dir, id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(BenchError::invalid(
            format!("style pack `{id}` does not exist"),
        )),
        Err(error) => Err(BenchError::io(error)),
    }
}

/// The pack as a JSON value for the review evidence pack. Falls back to the
/// raw YAML text if the body cannot be represented as JSON.
pub fn to_json(pack: &StylePack) -> serde_json::Value {
    serde_yaml::from_str::<serde_json::Value>(&pack.yaml)
        .unwrap_or_else(|_| serde_json::json!({ "id": pack.id, "yaml": pack.yaml }))
}

/// `review.criteria` entries, if the pack declares any: style packs double
/// as review standards. Test-only today — production review flow embeds the
/// full pack via `to_json` and lets the reviewer read `review.criteria`.
#[cfg(test)]
pub fn review_criteria(pack: &StylePack) -> Vec<String> {
    serde_yaml::from_str::<serde_yaml::Value>(&pack.yaml)
        .ok()
        .and_then(|value| {
            value
                .get("review")?
                .get("criteria")?
                .as_sequence()
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| entry.as_str().map(str::to_owned))
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// System-prompt block for the active pack: the structured definition plus
/// the mandatory conflict-detection skill. The agent must surface conflicts
/// between a user request and the pack instead of silently implementing
/// either side.
pub fn prompt_section(pack: &StylePack) -> String {
    format!(
        "ACTIVE STYLE PACK `{id}` — {name} (bench.json: style.id):\n\
         The user selected this structured style for the whole project. Treat it as the project's musical constitution:\n\
         - `defaults` seed new scenes (tempo range, meters, density, dynamics) unless the user explicitly overrides them.\n\
         - `harmony` / `melody` / `arrangement` / `form` steer every compositional choice; `arrangement.preferred` is the default palette and `arrangement.avoid` is a hard avoid-list.\n\
         - `review.criteria` are the quality bars this project is judged by.\n\
         {yaml}\n\n\
         STYLE CONFLICT DETECTION (mandatory skill):\n\
         Before acting on any request, compare it with the active style pack. If they conflict — an avoided instrument or technique, a tempo outside the default range, a modulation, density, or character the pack excludes — never implement it silently:\n\
         1. Name the conflict in one short sentence, quoting the pack field it violates.\n\
         2. If a pack-consistent alternative exists, state it and proceed with that compromise.\n\
         3. If the conflict is fundamental, stop and ask the user whether to override the style pack or adapt the request.\n\
         An explicit, specific user instruction wins over the pack once you have acknowledged the conflict out loud; vague requests always defer to the pack.\n\n",
        id = pack.id,
        name = pack.name,
        yaml = pack.yaml.trim_end(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("scorebench-styles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const USER_PACK: &str = "id: my-folk\nname: 我的民谣\ncategory: popular\narrangement:\n  preferred:\n    - acoustic_guitar\nreview:\n  criteria:\n    - melody_singability\n";

    #[test]
    fn builtins_parse_with_unique_ids_and_review_criteria() {
        let packs = builtins();
        assert_eq!(packs.len(), BUILTIN_SOURCES.len());
        let mut ids: Vec<&str> = packs.iter().map(|pack| pack.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), packs.len(), "builtin ids must be unique");
        for pack in &packs {
            assert!(pack.builtin);
            assert!(
                pack.name_en.is_some(),
                "builtin `{}` needs name_en",
                pack.id
            );
            assert!(
                pack.category.is_some(),
                "builtin `{}` needs category",
                pack.id
            );
            assert!(
                !review_criteria(pack).is_empty(),
                "builtin `{}` must double as a review standard",
                pack.id
            );
        }
        assert!(packs.iter().any(|p| p.id == "epic-new-age-instrumental"));
        assert!(packs.iter().any(|p| p.id == "chinese-campus-folk-90s"));
    }

    #[test]
    fn save_list_find_round_trip() {
        let dir = test_dir("round-trip");
        let saved = save(&dir, USER_PACK, None).unwrap();
        assert_eq!(saved.id, "my-folk");
        assert!(!saved.builtin);
        let (packs, warnings) = list(&dir);
        assert!(warnings.is_empty());
        assert_eq!(packs.len(), builtins().len() + 1);
        let found = find(&dir, "my-folk").unwrap();
        assert_eq!(found.yaml, USER_PACK);
        assert_eq!(review_criteria(&found), vec!["melody_singability"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn renaming_a_pack_removes_the_old_file() {
        let dir = test_dir("rename");
        save(&dir, USER_PACK, None).unwrap();
        let renamed = USER_PACK.replace("id: my-folk", "id: my-folk-v2");
        save(&dir, &renamed, Some("my-folk")).unwrap();
        assert!(find(&dir, "my-folk").is_none());
        assert!(find(&dir, "my-folk-v2").is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_invalid_envelopes() {
        let dir = test_dir("invalid");
        for (yaml, hint) in [
            ("name: no id\n", "`id`"),
            ("id: Bad_ID\nname: x\n", "invalid style pack id"),
            ("id: ok\n", "`name`"),
            ("- just\n- a\n- list\n", "mapping"),
            ("id: [1]\nname: x\n", "must be a string"),
        ] {
            let error = save(&dir, yaml, None).unwrap_err();
            assert!(
                error.to_string().contains(hint),
                "expected {hint:?} in {error}"
            );
        }
        let oversized = format!(
            "id: big\nname: big\nnotes: {}\n",
            "x".repeat(MAX_YAML_BYTES)
        );
        assert!(save(&dir, &oversized, None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn builtin_packs_are_read_only() {
        let dir = test_dir("builtin-guard");
        let clash = "id: chinese-campus-folk-90s\nname: overwrite attempt\n";
        let error = save(&dir, clash, None).unwrap_err();
        assert!(error.to_string().contains("built-in"));
        let error = delete(&dir, "chinese-campus-folk-90s").unwrap_err();
        assert!(error.to_string().contains("built-in"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_removes_pack_and_rejects_missing() {
        let dir = test_dir("delete");
        save(&dir, USER_PACK, None).unwrap();
        delete(&dir, "my-folk").unwrap();
        assert!(find(&dir, "my-folk").is_none());
        let error = delete(&dir, "my-folk").unwrap_err();
        assert!(error.to_string().contains("does not exist"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_and_duplicate_user_packs_are_skipped_with_warnings() {
        let dir = test_dir("corrupt");
        std::fs::create_dir_all(dir.join(STYLES_DIR)).unwrap();
        std::fs::write(dir.join(STYLES_DIR).join("broken.yaml"), "id: [not\nvalid").unwrap();
        std::fs::write(
            dir.join(STYLES_DIR).join("clash.yaml"),
            "id: chinese-campus-folk-90s\nname: shadowing builtin\n",
        )
        .unwrap();
        let (packs, warnings) = list(&dir);
        assert_eq!(packs.len(), builtins().len(), "bad packs never load");
        assert_eq!(warnings.len(), 2);
        assert!(warnings.iter().any(|w| w.contains("broken.yaml")));
        assert!(warnings.iter().any(|w| w.contains("already exists")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prompt_section_carries_pack_and_conflict_protocol() {
        let pack = builtins()
            .into_iter()
            .find(|pack| pack.id == "chinese-campus-folk-90s")
            .unwrap();
        let section = prompt_section(&pack);
        assert!(section.contains("ACTIVE STYLE PACK `chinese-campus-folk-90s`"));
        assert!(section.contains("九十年代中国校园民谣"));
        assert!(
            section.contains("dense_brass"),
            "structured body is injected verbatim"
        );
        assert!(section.contains("STYLE CONFLICT DETECTION"));
        assert!(section.contains("never implement it silently"));
        assert!(section.contains("ask the user whether to override"));
    }

    #[test]
    fn to_json_exposes_structured_body() {
        let pack = builtins()
            .into_iter()
            .find(|pack| pack.id == "epic-new-age-instrumental")
            .unwrap();
        let value = to_json(&pack);
        assert_eq!(value["defaults"]["tempo_bpm"][0], 76);
        assert_eq!(value["arrangement"]["techniques"][0], "arpeggio");
    }
}
