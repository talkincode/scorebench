//! Turn user-picked file paths into Responses API content parts.
//!
//! Images become `input_image` data URLs, PDFs become `input_file`, and small
//! UTF-8 text files are inlined as labelled `input_text` blocks. Everything
//! else is rejected with a typed error before any network traffic happens.

use std::fs;
use std::path::Path;

use base64::Engine;

use crate::error::BenchError;
use crate::llm::types::ContentPart;

const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 24 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 256 * 1024;

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn check_size(path: &Path, limit: u64, kind: &str) -> Result<(), BenchError> {
    let size = fs::metadata(path).map_err(BenchError::io)?.len();
    if size > limit {
        return Err(BenchError::invalid(format!(
            "{kind} attachment {} is {size} bytes; the limit is {limit}",
            path.display()
        )));
    }
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".into())
}

/// Convert one absolute path into a content part.
pub fn content_part(path: &Path) -> Result<ContentPart, BenchError> {
    let ext = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if let Some(mime) = image_mime(&ext) {
        check_size(path, MAX_IMAGE_BYTES, "image")?;
        let bytes = fs::read(path).map_err(BenchError::io)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(ContentPart::InputImage {
            image_url: format!("data:{mime};base64,{encoded}"),
        });
    }
    if ext == "pdf" {
        check_size(path, MAX_PDF_BYTES, "pdf")?;
        let bytes = fs::read(path).map_err(BenchError::io)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(ContentPart::InputFile {
            filename: file_name(path),
            file_data: format!("data:application/pdf;base64,{encoded}"),
        });
    }
    check_size(path, MAX_TEXT_BYTES, "text")?;
    let bytes = fs::read(path).map_err(BenchError::io)?;
    let text = String::from_utf8(bytes).map_err(|_| {
        BenchError::invalid(format!(
            "attachment {} is not an image, PDF, or UTF-8 text file",
            path.display()
        ))
    })?;
    Ok(ContentPart::InputText {
        text: format!("[attached file: {}]\n{text}", file_name(path)),
    })
}

/// Build the user message content: the typed text plus one part per attachment.
pub fn build_content(
    message: &str,
    attachments: &[String],
) -> Result<crate::llm::types::MessageContent, BenchError> {
    use crate::llm::types::MessageContent;
    if attachments.is_empty() {
        return Ok(MessageContent::Text(message.into()));
    }
    let mut parts = vec![ContentPart::InputText {
        text: message.into(),
    }];
    for raw in attachments {
        parts.push(content_part(Path::new(raw))?);
    }
    Ok(MessageContent::Parts(parts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::MessageContent;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "scorebench-attach-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn png_becomes_input_image_data_url() {
        let path = temp_file("shot.png", &[0x89, 0x50, 0x4e, 0x47]);
        let part = content_part(&path).unwrap();
        match part {
            ContentPart::InputImage { image_url } => {
                assert!(image_url.starts_with("data:image/png;base64,"));
            }
            other => panic!("expected image part, got {other:?}"),
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn text_file_is_inlined_with_label() {
        let path = temp_file("notes.md", b"tempo up");
        let part = content_part(&path).unwrap();
        match part {
            ContentPart::InputText { text } => {
                assert!(text.contains("[attached file: notes.md]"));
                assert!(text.contains("tempo up"));
            }
            other => panic!("expected text part, got {other:?}"),
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn binary_non_image_is_rejected() {
        let path = temp_file("blob.bin", &[0xff, 0xfe, 0x00, 0x01]);
        assert!(content_part(&path).is_err());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn message_without_attachments_stays_plain_text() {
        let content = build_content("hello", &[]).unwrap();
        assert_eq!(content, MessageContent::Text("hello".into()));
    }

    #[test]
    fn message_with_attachment_serializes_as_parts() {
        let path = temp_file("brief.txt", b"ballad in G");
        let content = build_content("use this brief", &[path.to_string_lossy().into()]).unwrap();
        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json[0]["type"], "input_text");
        assert_eq!(json[0]["text"], "use this brief");
        assert_eq!(json[1]["type"], "input_text");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
