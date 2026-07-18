use crate::error::BenchError;

#[derive(Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, BenchError> {
        self.buffer.extend_from_slice(chunk);
        self.drain(false)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, BenchError> {
        self.drain(true)
    }

    fn drain(&mut self, finish: bool) -> Result<Vec<String>, BenchError> {
        let mut frames = Vec::new();
        while let Some((index, delimiter_len)) = find_boundary(&self.buffer) {
            let raw = self.buffer.drain(..index).collect::<Vec<_>>();
            self.buffer.drain(..delimiter_len);
            if let Some(data) = parse_frame(&raw)? {
                frames.push(data);
            }
        }
        if finish && !self.buffer.is_empty() {
            let raw = std::mem::take(&mut self.buffer);
            if let Some(data) = parse_frame(&raw)? {
                frames.push(data);
            }
        }
        Ok(frames)
    }
}

fn find_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    for index in 0..bytes.len().saturating_sub(1) {
        if bytes[index..].starts_with(b"\r\n\r\n") {
            return Some((index, 4));
        }
        if bytes[index..].starts_with(b"\n\n") {
            return Some((index, 2));
        }
    }
    None
}

fn parse_frame(raw: &[u8]) -> Result<Option<String>, BenchError> {
    let frame = std::str::from_utf8(raw)
        .map_err(|err| BenchError::llm(format!("Responses stream was not UTF-8: {err}")))?;
    let data = frame
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            line.strip_prefix("data:")
                .map(|value| value.strip_prefix(' ').unwrap_or(value))
        })
        .collect::<Vec<_>>();
    if data.is_empty() {
        Ok(None)
    } else {
        Ok(Some(data.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/responses_tool.sse"),
        )
        .unwrap()
    }

    fn decode(chunks: &[&[u8]]) -> Vec<String> {
        let mut decoder = SseDecoder::default();
        let mut frames = Vec::new();
        for chunk in chunks {
            frames.extend(decoder.push(chunk).unwrap());
        }
        frames.extend(decoder.finish().unwrap());
        frames
    }

    #[test]
    fn arbitrary_chunk_boundaries_are_equivalent() {
        let source = fixture();
        let expected = decode(&[source.as_bytes()]);
        for split in 0..=source.len() {
            assert_eq!(
                decode(&[&source.as_bytes()[..split], &source.as_bytes()[split..]]),
                expected,
                "split at byte {split}"
            );
        }
        let bytes = source
            .as_bytes()
            .iter()
            .map(std::slice::from_ref)
            .collect::<Vec<_>>();
        assert_eq!(decode(&bytes), expected);
    }

    #[test]
    fn ignores_comments_and_joins_multi_line_data() {
        let frames = decode(&[b": keepalive\r\ndata: one\r\ndata: two\r\n\r\n"]);
        assert_eq!(frames, vec!["one\ntwo"]);
    }
}
