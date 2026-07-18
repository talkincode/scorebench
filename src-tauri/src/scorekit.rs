//! Subprocess boundary to the `scorekit` CLI.
//!
//! Contract (recorded from scorekit 0.1.0, see `tests/fixtures/`):
//! - success: exit 0; `build` writes `<output stem>.meta.json` as the machine-readable result
//! - failure: stderr carries one JSON object `{code, exit_code, field, location, message}`
//! - `doctor --json`: stdout JSON report
//!
//! scorebench never parses human-oriented stdout text.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::BenchError;

/// Environment variable that pins the scorekit binary explicitly.
pub const SCOREKIT_ENV: &str = "SCOREBENCH_SCOREKIT";

/// Locate the scorekit binary: explicit env override, then PATH, then the
/// well-known install prefixes (GUI apps on macOS get a stripped PATH).
pub fn locate() -> Result<PathBuf, BenchError> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let candidates = well_known_candidates(home.as_deref());
    locate_with(
        std::env::var_os(SCOREKIT_ENV).map(PathBuf::from),
        std::env::var_os("PATH"),
        &candidates,
    )
}

fn well_known_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".local/bin/scorekit"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin/scorekit"));
    dirs.push(PathBuf::from("/usr/local/bin/scorekit"));
    dirs
}

/// Pure locator core, unit-testable without touching the real environment.
pub fn locate_with(
    env_override: Option<PathBuf>,
    path_var: Option<std::ffi::OsString>,
    well_known: &[PathBuf],
) -> Result<PathBuf, BenchError> {
    if let Some(explicit) = env_override {
        if is_executable(&explicit) {
            return Ok(explicit);
        }
        return Err(BenchError::ScorekitMissing {
            message: format!(
                "{SCOREKIT_ENV} points to `{}` but it is not an executable file",
                explicit.display()
            ),
        });
    }
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join("scorekit");
            if is_executable(&candidate) {
                return Ok(candidate);
            }
        }
    }
    for candidate in well_known {
        if is_executable(candidate) {
            return Ok(candidate.clone());
        }
    }
    Err(BenchError::ScorekitMissing {
        message: format!(
            "scorekit not found on PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin; \
             install it (`make install` in the scorekit repo) or set {SCOREKIT_ENV}"
        ),
    })
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && std::fs::metadata(path)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Parse scorekit's machine-readable stderr into a typed error.
/// Falls back to the raw stderr text when it isn't the expected JSON.
pub fn parse_error_output(stderr: &str, fallback_exit: i32) -> BenchError {
    #[derive(Deserialize)]
    struct Wire {
        code: String,
        exit_code: i32,
        field: Option<String>,
        location: Option<Value>,
        message: String,
    }
    for line in stderr.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(wire) = serde_json::from_str::<Wire>(line) {
            return BenchError::Scorekit {
                message: wire.message,
                code: wire.code,
                exit_code: wire.exit_code,
                field: wire.field,
                location: wire.location.map(|v| v.to_string()),
            };
        }
    }
    BenchError::Scorekit {
        message: if stderr.trim().is_empty() {
            format!("scorekit failed with exit code {fallback_exit}")
        } else {
            stderr.trim().to_string()
        },
        code: "unknown".into(),
        exit_code: fallback_exit,
        field: None,
        location: None,
    }
}

fn run(args: &[String]) -> Result<String, BenchError> {
    let bin = locate()?;
    let output = Command::new(&bin)
        .args(args)
        .output()
        .map_err(|e| BenchError::Io {
            message: format!("failed to spawn `{}`: {e}", bin.display()),
        })?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let exit = output.status.code().unwrap_or(-1);
    Err(parse_error_output(
        &String::from_utf8_lossy(&output.stderr),
        exit,
    ))
}

/// `scorekit doctor --json` — passed through verbatim to the frontend.
pub fn doctor() -> Result<Value, BenchError> {
    let stdout = run(&["doctor".into(), "--json".into()])?;
    serde_json::from_str(&stdout).map_err(|e| BenchError::Io {
        message: format!("doctor output was not valid JSON: {e}"),
    })
}

/// Render parameters exposed by the observation panel. Everything optional;
/// omitted fields keep scorekit's own defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildParams {
    pub renderer: Option<String>,
    pub sample_rate: Option<u32>,
    pub gain: Option<f32>,
    pub quality: Option<u8>,
    pub stems: Option<bool>,
    pub soundfont: Option<String>,
    pub profile: Option<String>,
}

impl BuildParams {
    pub fn to_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(renderer) = &self.renderer {
            args.extend(["--renderer".into(), renderer.clone()]);
        }
        if let Some(rate) = self.sample_rate {
            args.extend(["--sample-rate".into(), rate.to_string()]);
        }
        if let Some(gain) = self.gain {
            args.extend(["--gain".into(), gain.to_string()]);
        }
        if let Some(quality) = self.quality {
            args.extend(["--quality".into(), quality.to_string()]);
        }
        if self.stems.unwrap_or(false) {
            args.push("--stems".into());
        }
        if let Some(soundfont) = &self.soundfont {
            args.extend(["--soundfont".into(), soundfont.clone()]);
        }
        if let Some(profile) = &self.profile {
            args.extend(["--profile".into(), profile.clone()]);
        }
        args
    }
}

/// Successful build result: where the audio landed plus the meta.json scorekit wrote.
#[derive(Debug, Clone, Serialize)]
pub struct BuildResult {
    pub output: PathBuf,
    pub meta_path: PathBuf,
    pub meta: Value,
}

/// `scorekit build <scene> -o <output> ... --json`.
/// The machine-readable result is the `<stem>.meta.json` scorekit writes atomically.
pub fn build(scene: &Path, output: &Path, params: &BuildParams) -> Result<BuildResult, BenchError> {
    let mut args = vec![
        "build".into(),
        scene.to_string_lossy().into_owned(),
        "-o".into(),
        output.to_string_lossy().into_owned(),
    ];
    args.extend(params.to_args());
    args.push("--json".into());
    run(&args)?;

    let meta_path = meta_path_for(output);
    let meta_text = std::fs::read_to_string(&meta_path).map_err(|e| BenchError::Io {
        message: format!(
            "build succeeded but meta file `{}` is unreadable: {e}",
            meta_path.display()
        ),
    })?;
    let meta = serde_json::from_str(&meta_text).map_err(|e| BenchError::Io {
        message: format!("meta file `{}` is not valid JSON: {e}", meta_path.display()),
    })?;
    Ok(BuildResult {
        output: output.to_path_buf(),
        meta_path,
        meta,
    })
}

/// `forest.ogg` -> `forest.meta.json` (scorekit's naming convention).
pub fn meta_path_for(output: &Path) -> PathBuf {
    output.with_extension("meta.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read_to_string(path).expect("fixture readable")
    }

    #[test]
    fn parses_recorded_io_error() {
        let err = parse_error_output(&fixture("error_io.json"), 1);
        match err {
            BenchError::Scorekit {
                code, exit_code, ..
            } => {
                assert_eq!(code, "io");
                assert_eq!(exit_code, 1);
            }
            other => panic!("expected Scorekit error, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_on_non_json_stderr() {
        let err = parse_error_output("segfault or something", 4);
        match err {
            BenchError::Scorekit {
                code,
                exit_code,
                message,
                ..
            } => {
                assert_eq!(code, "unknown");
                assert_eq!(exit_code, 4);
                assert!(message.contains("segfault"));
            }
            other => panic!("expected fallback Scorekit error, got {other:?}"),
        }
    }

    #[test]
    fn doctor_fixture_shape_holds() {
        let value: Value = serde_json::from_str(&fixture("doctor.json")).unwrap();
        assert!(
            value.get("ready").is_some(),
            "doctor JSON must have `ready`"
        );
        assert!(
            value.get("tools").is_some(),
            "doctor JSON must have `tools`"
        );
    }

    #[test]
    fn meta_fixture_shape_holds() {
        let value: Value = serde_json::from_str(&fixture("forest.meta.json")).unwrap();
        for key in ["audio", "loop", "sample_rate", "total_samples", "tracks"] {
            assert!(value.get(key).is_some(), "meta.json must have `{key}`");
        }
    }

    #[test]
    fn locate_missing_everywhere_is_typed_error() {
        let err = locate_with(None, None, &[]).unwrap_err();
        assert!(matches!(err, BenchError::ScorekitMissing { .. }));
    }

    #[test]
    fn locate_env_override_must_be_executable() {
        let err = locate_with(Some(PathBuf::from("/definitely/not/here")), None, &[]).unwrap_err();
        match err {
            BenchError::ScorekitMissing { message } => {
                assert!(message.contains(SCOREKIT_ENV));
            }
            other => panic!("expected ScorekitMissing, got {other:?}"),
        }
    }

    #[test]
    fn build_params_render_full_arg_set() {
        let params = BuildParams {
            renderer: Some("timidity".into()),
            sample_rate: Some(48000),
            gain: Some(0.7),
            quality: Some(6),
            stems: Some(true),
            soundfont: None,
            profile: None,
        };
        assert_eq!(
            params.to_args(),
            vec![
                "--renderer",
                "timidity",
                "--sample-rate",
                "48000",
                "--gain",
                "0.7",
                "--quality",
                "6",
                "--stems"
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
        assert!(BuildParams::default().to_args().is_empty());
    }

    #[test]
    fn meta_path_follows_scorekit_convention() {
        assert_eq!(
            meta_path_for(Path::new("/x/out/forest.ogg")),
            PathBuf::from("/x/out/forest.meta.json")
        );
    }
}
