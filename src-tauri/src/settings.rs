use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::error::BenchError;
use crate::llm::types::{InputItem, InputRole, ResponseEvent, ResponsesRequest};
use crate::llm::{ApiProtocol, LlmClient, LlmConfig};

const SETTINGS_FILE: &str = "settings.json";
const API_KEY_FILE: &str = "api-key";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub api_protocol: ApiProtocol,
    pub base_url: String,
    pub model: String,
    pub context_budget_tokens: u64,
    pub max_turns: u32,
    /// Absolute path pinning the scorekit binary; `None` means auto-discovery
    /// (PATH, then well-known prefixes). Lets a machine with several scorekit
    /// versions choose one without env-var gymnastics.
    pub scorekit_path: Option<String>,
    pub spectrum_style: String,
    pub spectrum_bars: u16,
    /// Spectrum palette hue override in degrees; `None` follows `theme_hue`.
    pub spectrum_hue: Option<u16>,
    pub theme_hue: u16,
    /// Legacy persona text. No longer injected or shown in the UI (style
    /// packs replaced it); kept so older `settings.json` files still parse
    /// under `deny_unknown_fields` and user text is never destroyed.
    pub personal_instructions: String,
    /// UI language: "en" (default) or "zh".
    pub locale: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            api_protocol: ApiProtocol::Responses,
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-5.6".into(),
            context_budget_tokens: 128_000,
            max_turns: 16,
            scorekit_path: None,
            spectrum_style: "bars".into(),
            spectrum_bars: 64,
            spectrum_hue: None,
            theme_hue: 171,
            personal_instructions: String::new(),
            locale: "en".into(),
        }
    }
}

impl Settings {
    fn validate(&self) -> Result<(), BenchError> {
        let url = reqwest::Url::parse(&self.base_url).map_err(|err| {
            BenchError::settings("invalid_base_url", format!("base URL is invalid: {err}"))
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(BenchError::settings(
                "invalid_base_url",
                "base URL must use http or https",
            ));
        }
        if self.model.trim().is_empty() {
            return Err(BenchError::settings(
                "invalid_model",
                "model name cannot be empty",
            ));
        }
        if !(1_024..=2_000_000).contains(&self.context_budget_tokens) {
            return Err(BenchError::settings(
                "invalid_context_budget",
                "context budget must be between 1024 and 2000000 tokens",
            ));
        }
        if !(1..=128).contains(&self.max_turns) {
            return Err(BenchError::settings(
                "invalid_max_turns",
                "max turns must be between 1 and 128",
            ));
        }
        if let Some(path) = &self.scorekit_path {
            // Shape-only checks: a binary deleted later must not make the
            // settings file unloadable. Existence is verified at locate time.
            if path.trim().is_empty() {
                return Err(BenchError::settings(
                    "invalid_scorekit_path",
                    "scorekit path cannot be blank; remove it to use auto-discovery",
                ));
            }
            if !Path::new(path.as_str()).is_absolute() {
                return Err(BenchError::settings(
                    "invalid_scorekit_path",
                    "scorekit path must be an absolute path to the binary",
                ));
            }
        }
        if self.spectrum_style.trim().is_empty() {
            return Err(BenchError::settings(
                "invalid_spectrum_style",
                "spectrum style cannot be empty",
            ));
        }
        if !(16..=256).contains(&self.spectrum_bars) {
            return Err(BenchError::settings(
                "invalid_spectrum_bars",
                "spectrum bars must be between 16 and 256",
            ));
        }
        if matches!(self.spectrum_hue, Some(hue) if hue > 359) {
            return Err(BenchError::settings(
                "invalid_spectrum_hue",
                "spectrum hue must be between 0 and 359 degrees",
            ));
        }
        if self.theme_hue > 359 {
            return Err(BenchError::settings(
                "invalid_theme_hue",
                "theme hue must be between 0 and 359 degrees",
            ));
        }
        if self.personal_instructions.chars().count() > 20_000 {
            return Err(BenchError::settings(
                "invalid_personal_instructions",
                "personal instructions must stay under 20000 characters",
            ));
        }
        if !matches!(self.locale.as_str(), "en" | "zh") {
            return Err(BenchError::settings(
                "invalid_locale",
                "locale must be \"en\" or \"zh\"",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsView {
    pub settings: Settings,
    pub api_key_set: bool,
    pub warning: Option<String>,
}

pub fn settings_view(config_dir: &Path) -> Result<SettingsView, BenchError> {
    let (settings, mut warning) = load(config_dir)?;
    let api_key_set = match load_api_key(config_dir) {
        Ok(value) => value.is_some(),
        Err(err) => {
            append_warning(&mut warning, err.to_string());
            false
        }
    };
    Ok(SettingsView {
        settings,
        api_key_set,
        warning,
    })
}

pub fn load(config_dir: &Path) -> Result<(Settings, Option<String>), BenchError> {
    let path = config_dir.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok((Settings::default(), None));
    }
    let bytes = fs::read(&path).map_err(BenchError::io)?;
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(settings) => {
            settings.validate()?;
            Ok((settings, None))
        }
        Err(err) => {
            let backup = backup_path(&path);
            fs::rename(&path, &backup).map_err(BenchError::io)?;
            Ok((
                Settings::default(),
                Some(format!(
                    "settings were corrupt and preserved at {}: {err}",
                    backup.display()
                )),
            ))
        }
    }
}

pub fn save(config_dir: &Path, settings: &Settings) -> Result<(), BenchError> {
    settings.validate()?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(BenchError::io)?;
    atomic_write(&config_dir.join(SETTINGS_FILE), &bytes, |_| Ok(())).map_err(BenchError::io)
}

pub fn store_api_key(config_dir: &Path, api_key: &str) -> Result<(), BenchError> {
    if api_key.trim().is_empty() {
        return Err(BenchError::settings(
            "empty_api_key",
            "API key cannot be empty",
        ));
    }
    atomic_write(&config_dir.join(API_KEY_FILE), api_key.as_bytes(), |_| {
        Ok(())
    })
    .map_err(BenchError::io)
}

pub fn load_api_key(config_dir: &Path) -> Result<Option<String>, BenchError> {
    let path = config_dir.join(API_KEY_FILE);
    match fs::read_to_string(&path) {
        Ok(value) => Ok(Some(value)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(BenchError::io(err)),
    }
}

pub async fn test_connection(app: &AppHandle) -> Result<String, BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    let (settings, _) = load(&config_dir)?;
    let api_key = load_api_key(&config_dir)?.ok_or_else(|| {
        BenchError::settings(
            "api_key_missing",
            "set an API key before testing the connection",
        )
    })?;
    let client = LlmClient::new(
        settings.api_protocol,
        LlmConfig {
            base_url: settings.base_url,
            api_key,
            model: settings.model,
            timeout: Duration::from_secs(15),
        },
    )?;
    let request = connection_probe_request();
    let mut stream = client.stream(request, CancellationToken::new()).await?;
    while let Some(event) = stream.next().await {
        match event? {
            ResponseEvent::Completed { .. } => return Ok("connection ok".into()),
            ResponseEvent::Failed { message, .. } | ResponseEvent::Error { message, .. } => {
                return Err(BenchError::llm(message));
            }
            ResponseEvent::Incomplete { reason, .. } => {
                return Err(BenchError::llm(format!(
                    "LLM connection probe was incomplete ({})",
                    reason.as_deref().unwrap_or("unknown reason")
                )));
            }
            _ => {}
        }
    }
    Err(BenchError::llm(
        "LLM endpoint closed the stream before a completion event",
    ))
}

fn connection_probe_request() -> ResponsesRequest {
    ResponsesRequest {
        model: String::new(),
        instructions: Some("Reply with OK.".into()),
        input: vec![InputItem::Message {
            role: InputRole::User,
            content: "ping".into(),
        }],
        tools: vec![],
        // Responses rejects values below 16; Chat Completions accepts this too.
        max_output_tokens: Some(16),
        stream: true,
        store: false,
    }
}

fn append_warning(warning: &mut Option<String>, next: String) {
    match warning {
        Some(existing) => {
            existing.push_str("; ");
            existing.push_str(&next);
        }
        None => *warning = Some(next),
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let plain = path.with_extension("json.bak");
    if !plain.exists() {
        return plain;
    }
    path.with_extension(format!("json.bak.{}", unique_suffix()))
}

fn atomic_write<F>(path: &Path, bytes: &[u8], before_rename: F) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("data"),
        unique_suffix()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        set_private_permissions(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        before_rename(&temp)?;
        fs::rename(&temp, path)?;
        sync_dir(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        ^ u128::from(std::process::id())
}

#[cfg(unix)]
fn set_private_permissions(file: &fs::File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_permissions(_file: &fs::File) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("scorebench-{name}-{}", unique_suffix()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn settings_round_trip() {
        let dir = test_dir("settings-round-trip");
        let value = Settings {
            api_protocol: ApiProtocol::ChatCompletions,
            base_url: "http://localhost:9000/v1".into(),
            model: "local-model".into(),
            context_budget_tokens: 32_000,
            max_turns: 8,
            scorekit_path: Some("/usr/local/bin/scorekit-0.3".into()),
            spectrum_style: "mood".into(),
            spectrum_bars: 96,
            spectrum_hue: Some(318),
            theme_hue: 202,
            personal_instructions: "Prefer lush jazz voicings.".into(),
            locale: "zh".into(),
        };
        save(&dir, &value).unwrap();
        assert_eq!(load(&dir).unwrap(), (value, None));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_settings_default_to_responses_protocol() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("api_protocol");
        let settings: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(settings.api_protocol, ApiProtocol::Responses);
    }

    #[test]
    fn rejects_spectrum_hue_outside_css_hue_range() {
        let dir = test_dir("settings-spectrum-hue");
        let value = Settings {
            spectrum_hue: Some(360),
            ..Settings::default()
        };
        let error = save(&dir, &value).unwrap_err();
        assert!(
            matches!(error, BenchError::Settings { code, .. } if code == "invalid_spectrum_hue")
        );
        assert!(!dir.join(SETTINGS_FILE).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_relative_or_blank_scorekit_path() {
        let dir = test_dir("settings-scorekit-path");
        for bad in ["scorekit", "   "] {
            let value = Settings {
                scorekit_path: Some(bad.into()),
                ..Settings::default()
            };
            let error = save(&dir, &value).unwrap_err();
            assert!(
                matches!(error, BenchError::Settings { code, .. } if code == "invalid_scorekit_path")
            );
        }
        assert!(!dir.join(SETTINGS_FILE).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_theme_hue_outside_css_hue_range() {
        let dir = test_dir("settings-theme-hue");
        let value = Settings {
            theme_hue: 360,
            ..Settings::default()
        };
        let error = save(&dir, &value).unwrap_err();
        assert!(matches!(error, BenchError::Settings { code, .. } if code == "invalid_theme_hue"));
        assert!(!dir.join(SETTINGS_FILE).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_atomic_write_preserves_previous_settings() {
        let dir = test_dir("settings-atomic");
        let path = dir.join(SETTINGS_FILE);
        fs::write(&path, b"previous").unwrap();
        let error =
            atomic_write(&path, b"next", |_| Err(io::Error::other("kill point"))).unwrap_err();
        assert_eq!(error.to_string(), "kill point");
        assert_eq!(fs::read(&path).unwrap(), b"previous");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_settings_are_preserved_and_defaults_load() {
        let dir = test_dir("settings-corrupt");
        fs::write(dir.join(SETTINGS_FILE), b"{broken").unwrap();
        let (settings, warning) = load(&dir).unwrap();
        assert_eq!(settings, Settings::default());
        assert!(warning.unwrap().contains("preserved"));
        assert_eq!(fs::read(dir.join("settings.json.bak")).unwrap(), b"{broken");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn api_key_write_read_round_trip() {
        let dir = test_dir("apikey");
        let api_key = "secret-abc-123";
        store_api_key(&dir, api_key).unwrap();
        assert_eq!(load_api_key(&dir).unwrap().as_deref(), Some(api_key));
        assert!(dir.join(API_KEY_FILE).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn api_key_missing_returns_none() {
        let dir = test_dir("apikey-missing");
        assert!(load_api_key(&dir).unwrap().is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn api_key_empty_is_rejected() {
        let dir = test_dir("apikey-empty");
        let err = store_api_key(&dir, "").unwrap_err();
        assert!(matches!(err, BenchError::Settings { code, .. } if code == "empty_api_key"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn api_key_whitespace_only_is_rejected() {
        let dir = test_dir("apikey-ws");
        let err = store_api_key(&dir, "   ").unwrap_err();
        assert!(matches!(err, BenchError::Settings { code, .. } if code == "empty_api_key"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn api_key_overwrite_replaces_previous() {
        let dir = test_dir("apikey-overwrite");
        store_api_key(&dir, "old-key").unwrap();
        store_api_key(&dir, "new-key").unwrap();
        assert_eq!(load_api_key(&dir).unwrap().as_deref(), Some("new-key"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn api_key_file_is_mode_0600() {
        let dir = test_dir("apikey-perms");
        store_api_key(&dir, "secret-456").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join(API_KEY_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_view_reports_api_key_set() {
        let dir = test_dir("apikey-view");
        store_api_key(&dir, "sk-123").unwrap();
        let view = settings_view(&dir).unwrap();
        assert!(view.api_key_set);
        assert_eq!(view.warning, None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_view_reports_api_key_not_set() {
        let dir = test_dir("apikey-view-missing");
        let view = settings_view(&dir).unwrap();
        assert!(!view.api_key_set);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn connection_probe_uses_api_minimum_output_budget() {
        let request = connection_probe_request();

        assert_eq!(request.max_output_tokens, Some(16));
        assert!(request.tools.is_empty());
        assert!(!request.store);
    }
}
