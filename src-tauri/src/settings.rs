use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::error::BenchError;
use crate::llm::types::{InputItem, InputRole, ResponseEvent, ResponsesRequest};
use crate::llm::{LlmConfig, ResponsesClient};

const SETTINGS_FILE: &str = "settings.json";
const INSECURE_KEY_FILE: &str = "api-key";
const KEYRING_SERVICE: &str = "com.talkincode.scorebench";
const KEYRING_USER: &str = "openai-responses-api-key";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub base_url: String,
    pub model: String,
    pub context_budget_tokens: u64,
    pub max_turns: u32,
    pub spectrum_style: String,
    pub spectrum_bars: u16,
    pub theme_hue: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-5.6".into(),
            context_budget_tokens: 128_000,
            max_turns: 16,
            spectrum_style: "bars".into(),
            spectrum_bars: 64,
            theme_hue: 171,
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
        if self.theme_hue > 359 {
            return Err(BenchError::settings(
                "invalid_theme_hue",
                "theme hue must be between 0 and 359 degrees",
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

pub trait KeyringBackend {
    fn get(&self) -> SecretRead;
    fn set(&self, value: &str) -> Result<(), String>;
}

pub enum SecretRead {
    Found(String),
    Missing,
    Failed(String),
}

pub struct OsKeyring;

impl OsKeyring {
    #[cfg(not(target_os = "macos"))]
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|err| err.to_string())
    }
}

#[cfg(target_os = "macos")]
impl KeyringBackend for OsKeyring {
    fn get(&self) -> SecretRead {
        let output = match Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-a",
                KEYRING_USER,
                "-s",
                KEYRING_SERVICE,
                "-w",
            ])
            .stdin(Stdio::null())
            .output()
        {
            Ok(output) => output,
            Err(err) => return SecretRead::Failed(err.to_string()),
        };

        if output.status.success() {
            return match String::from_utf8(output.stdout) {
                Ok(value) => SecretRead::Found(value.trim_end_matches(['\r', '\n']).into()),
                Err(err) => SecretRead::Failed(format!("keychain returned invalid UTF-8: {err}")),
            };
        }
        if output.status.code() == Some(44) {
            return SecretRead::Missing;
        }
        SecretRead::Failed(security_command_error("read", &output.stderr))
    }

    fn set(&self, value: &str) -> Result<(), String> {
        let mut child = Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-U",
                "-a",
                KEYRING_USER,
                "-s",
                KEYRING_SERVICE,
                "-w",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| err.to_string())?;

        // `security -w` prompts twice when creating a new item and once when
        // updating one. Passing the secret through stdin keeps it out of argv,
        // process listings, logs, and project files.
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "keychain command stdin was unavailable".to_string())?;
        stdin
            .write_all(format!("{value}\n{value}\n").as_bytes())
            .map_err(|err| err.to_string())?;
        drop(child.stdin.take());

        let output = child.wait_with_output().map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(security_command_error("write", &output.stderr))
        }
    }
}

#[cfg(target_os = "macos")]
fn security_command_error(operation: &str, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        format!("macOS Keychain {operation} failed")
    } else {
        format!("macOS Keychain {operation} failed: {detail}")
    }
}

#[cfg(not(target_os = "macos"))]
impl KeyringBackend for OsKeyring {
    fn get(&self) -> SecretRead {
        let entry = match Self::entry() {
            Ok(entry) => entry,
            Err(err) => return SecretRead::Failed(err),
        };
        match entry.get_password() {
            Ok(value) => SecretRead::Found(value),
            Err(keyring::Error::NoEntry) => SecretRead::Missing,
            Err(err) => SecretRead::Failed(err.to_string()),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        Self::entry()?
            .set_password(value)
            .map_err(|err| err.to_string())
    }
}

pub fn settings_view(
    config_dir: &Path,
    keyring: &impl KeyringBackend,
) -> Result<SettingsView, BenchError> {
    let (settings, mut warning) = load(config_dir)?;
    let api_key_set = match load_api_key(config_dir, keyring) {
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

pub fn store_api_key(
    config_dir: &Path,
    api_key: &str,
    allow_insecure_storage: bool,
    keyring: &impl KeyringBackend,
) -> Result<(), BenchError> {
    if api_key.trim().is_empty() {
        return Err(BenchError::settings(
            "empty_api_key",
            "API key cannot be empty",
        ));
    }
    match keyring.set(api_key) {
        Ok(()) => {
            match keyring.get() {
                SecretRead::Found(stored) if stored == api_key => {}
                SecretRead::Found(_) | SecretRead::Missing if allow_insecure_storage => {
                    store_insecure_api_key(config_dir, api_key)?;
                    return Ok(());
                }
                SecretRead::Found(_) | SecretRead::Missing => {
                    return Err(BenchError::settings(
                        "keychain_write_not_persisted",
                        "OS keychain reported success but the credential could not be verified",
                    ));
                }
                SecretRead::Failed(_) if allow_insecure_storage => {
                    store_insecure_api_key(config_dir, api_key)?;
                    return Ok(());
                }
                SecretRead::Failed(err) => {
                    return Err(BenchError::settings(
                        "keychain_write_not_verified",
                        format!("OS keychain write could not be verified: {err}"),
                    ));
                }
            }
            let insecure = config_dir.join(INSECURE_KEY_FILE);
            if insecure.exists() {
                fs::remove_file(insecure).map_err(BenchError::io)?;
            }
            Ok(())
        }
        Err(_keyring_error) if allow_insecure_storage => {
            store_insecure_api_key(config_dir, api_key)?;
            Ok(())
        }
        Err(keyring_error) => Err(BenchError::settings(
            "keychain_unavailable",
            format!(
                "OS keychain is unavailable ({keyring_error}); explicitly opt in to insecure local storage to continue"
            ),
        )),
    }
}

fn store_insecure_api_key(config_dir: &Path, api_key: &str) -> Result<(), BenchError> {
    atomic_write(
        &config_dir.join(INSECURE_KEY_FILE),
        api_key.as_bytes(),
        |_| Ok(()),
    )
    .map_err(BenchError::io)
}

pub fn load_api_key(
    config_dir: &Path,
    keyring: &impl KeyringBackend,
) -> Result<Option<String>, BenchError> {
    // The fallback is created only by explicit user opt-in. If it exists, it
    // represents the newest verified write and must outrank a stale keychain
    // value left behind by a failed update.
    let fallback = config_dir.join(INSECURE_KEY_FILE);
    match fs::read_to_string(&fallback) {
        Ok(value) => return Ok(Some(value)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(BenchError::io(err)),
    }
    match keyring.get() {
        SecretRead::Found(value) => Ok(Some(value)),
        SecretRead::Missing => Ok(None),
        SecretRead::Failed(err) => Err(BenchError::settings(
            "keychain_unavailable",
            format!("OS keychain is unavailable: {err}"),
        )),
    }
}

pub async fn test_connection(app: &AppHandle) -> Result<String, BenchError> {
    let config_dir = app.path().app_config_dir().map_err(BenchError::io)?;
    let (settings, _) = load(&config_dir)?;
    let api_key = load_api_key(&config_dir, &OsKeyring)?.ok_or_else(|| {
        BenchError::settings(
            "api_key_missing",
            "set an API key before testing the connection",
        )
    })?;
    let client = ResponsesClient::new(LlmConfig {
        base_url: settings.base_url,
        api_key,
        model: settings.model,
        timeout: Duration::from_secs(15),
    })?;
    let request = connection_probe_request();
    let mut stream = client.stream(request, CancellationToken::new()).await?;
    while let Some(event) = stream.next().await {
        match event? {
            ResponseEvent::Completed { .. } => return Ok("connection ok".into()),
            ResponseEvent::Failed { message, .. } | ResponseEvent::Error { message, .. } => {
                return Err(BenchError::llm(message));
            }
            _ => {}
        }
    }
    Err(BenchError::llm(
        "LLM endpoint closed the stream before response.completed",
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
        // The Responses API rejects values below 16, including for a probe.
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
    use std::sync::Mutex;

    use super::*;

    struct FakeKeyring {
        value: Mutex<SecretRead>,
        set_error: Option<String>,
        discard_writes: bool,
    }

    impl FakeKeyring {
        fn missing() -> Self {
            Self {
                value: Mutex::new(SecretRead::Missing),
                set_error: None,
                discard_writes: false,
            }
        }

        fn unavailable() -> Self {
            Self {
                value: Mutex::new(SecretRead::Failed("locked".into())),
                set_error: Some("locked".into()),
                discard_writes: false,
            }
        }

        fn discards_writes() -> Self {
            Self {
                value: Mutex::new(SecretRead::Missing),
                set_error: None,
                discard_writes: true,
            }
        }

        fn keeps_stale_value() -> Self {
            Self {
                value: Mutex::new(SecretRead::Found("old-secret".into())),
                set_error: None,
                discard_writes: true,
            }
        }
    }

    impl KeyringBackend for FakeKeyring {
        fn get(&self) -> SecretRead {
            match &*self.value.lock().unwrap() {
                SecretRead::Found(value) => SecretRead::Found(value.clone()),
                SecretRead::Missing => SecretRead::Missing,
                SecretRead::Failed(err) => SecretRead::Failed(err.clone()),
            }
        }

        fn set(&self, value: &str) -> Result<(), String> {
            if let Some(err) = &self.set_error {
                return Err(err.clone());
            }
            if self.discard_writes {
                return Ok(());
            }
            *self.value.lock().unwrap() = SecretRead::Found(value.into());
            Ok(())
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("scorebench-{name}-{}", unique_suffix()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn settings_round_trip() {
        let dir = test_dir("settings-round-trip");
        let value = Settings {
            base_url: "http://localhost:9000/v1".into(),
            model: "local-model".into(),
            context_budget_tokens: 32_000,
            max_turns: 8,
            spectrum_style: "wave".into(),
            spectrum_bars: 96,
            theme_hue: 202,
        };
        save(&dir, &value).unwrap();
        assert_eq!(load(&dir).unwrap(), (value, None));
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
    fn keychain_storage_never_writes_key_to_config_dir() {
        let dir = test_dir("keychain");
        let keyring = FakeKeyring::missing();
        store_api_key(&dir, "secret-123", false, &keyring).unwrap();
        assert_eq!(
            load_api_key(&dir, &keyring).unwrap().as_deref(),
            Some("secret-123")
        );
        assert!(!dir.join(INSECURE_KEY_FILE).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unverified_keychain_write_fails_closed() {
        let dir = test_dir("keychain-discarded-write");
        let keyring = FakeKeyring::discards_writes();

        let error = store_api_key(&dir, "secret-123", false, &keyring).unwrap_err();

        assert!(matches!(
            error,
            BenchError::Settings { code, .. } if code == "keychain_write_not_persisted"
        ));
        assert!(!dir.join(INSECURE_KEY_FILE).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unverified_keychain_write_uses_opted_in_fallback() {
        let dir = test_dir("keychain-discarded-write-fallback");
        let keyring = FakeKeyring::discards_writes();

        store_api_key(&dir, "secret-123", true, &keyring).unwrap();

        assert_eq!(
            load_api_key(&dir, &keyring).unwrap().as_deref(),
            Some("secret-123")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join(INSECURE_KEY_FILE))
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
    fn opted_in_fallback_overrides_stale_keychain_value() {
        let dir = test_dir("keychain-stale-value-fallback");
        let keyring = FakeKeyring::keeps_stale_value();

        store_api_key(&dir, "new-secret", true, &keyring).unwrap();

        assert_eq!(
            load_api_key(&dir, &keyring).unwrap().as_deref(),
            Some("new-secret")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn connection_probe_uses_api_minimum_output_budget() {
        let request = connection_probe_request();

        assert_eq!(request.max_output_tokens, Some(16));
        assert!(request.tools.is_empty());
        assert!(!request.store);
    }

    #[test]
    fn insecure_fallback_requires_opt_in_and_is_private() {
        let dir = test_dir("insecure-key");
        let keyring = FakeKeyring::unavailable();
        let error = store_api_key(&dir, "secret-456", false, &keyring).unwrap_err();
        assert!(matches!(error, BenchError::Settings { .. }));
        assert!(!dir.join(INSECURE_KEY_FILE).exists());

        store_api_key(&dir, "secret-456", true, &keyring).unwrap();
        assert_eq!(
            load_api_key(&dir, &keyring).unwrap().as_deref(),
            Some("secret-456")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join(INSECURE_KEY_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(dir);
    }
}
