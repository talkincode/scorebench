use serde::Serialize;

/// Typed error surface for every Tauri command. Serialized as
/// `{ "kind": ..., "message": ..., ... }` so the frontend can branch on `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BenchError {
    /// The scorekit binary could not be located.
    ScorekitMissing { message: String },
    /// scorekit ran and failed; carries its machine-readable error verbatim.
    Scorekit {
        message: String,
        code: String,
        exit_code: i32,
        field: Option<String>,
        location: Option<String>,
    },
    /// Local I/O failure (project scan, asset read, ...).
    Io { message: String },
    /// The path is not a usable project directory or asset.
    InvalidProject { message: String },
}

impl BenchError {
    pub fn io(err: impl std::fmt::Display) -> Self {
        Self::Io {
            message: err.to_string(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidProject {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BenchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ScorekitMissing { message }
            | Self::Io { message }
            | Self::InvalidProject { message } => write!(f, "{message}"),
            Self::Scorekit { message, code, .. } => write!(f, "scorekit {code}: {message}"),
        }
    }
}

impl std::error::Error for BenchError {}
