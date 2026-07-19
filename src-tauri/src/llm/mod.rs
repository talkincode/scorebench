//! Hand-rolled OpenAI Responses API transport.
//!
//! The contract intentionally stops at HTTP + SSE. Agent orchestration lives in
//! `agent`; no SDK, provider abstraction, retry loop, or hidden conversation
//! state is introduced here.

mod sse;
pub mod types;

use std::collections::VecDeque;
use std::fmt;
use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::{self, BoxStream};
use futures_util::{Stream, StreamExt};
use reqwest::header::RETRY_AFTER;
use tokio_util::sync::CancellationToken;

use crate::error::BenchError;
use sse::SseDecoder;
use types::{ResponseEvent, ResponsesRequest};

const ERROR_BODY_LIMIT: usize = 2_048;

#[derive(Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// Idle timeout: connection establishment and the gap between response
    /// bytes. Deliberately NOT a whole-request deadline — a healthy SSE
    /// stream may take minutes to finish a long structured answer, and
    /// cutting it mid-stream surfaces as a spurious "timed out".
    pub timeout: Duration,
}

impl fmt::Debug for LlmConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LlmConfig")
            .field("base_url", &self.base_url)
            .field("api_key", &"[redacted]")
            .field("model", &self.model)
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl LlmConfig {
    fn responses_url(&self) -> String {
        format!("{}/responses", self.base_url.trim_end_matches('/'))
    }
}

pub type ResponseStream =
    Pin<Box<dyn Stream<Item = Result<ResponseEvent, BenchError>> + Send + 'static>>;

#[derive(Clone)]
pub struct ResponsesClient {
    http: reqwest::Client,
    config: LlmConfig,
}

impl ResponsesClient {
    pub fn new(config: LlmConfig) -> Result<Self, BenchError> {
        let http = reqwest::Client::builder()
            .connect_timeout(config.timeout)
            .read_timeout(config.timeout)
            .build()
            .map_err(|err| BenchError::llm(format!("failed to build HTTP client: {err}")))?;
        Ok(Self { http, config })
    }

    fn authenticated_post(&self) -> reqwest::RequestBuilder {
        let request = self.http.post(self.config.responses_url());
        if uses_azure_api_key_auth(&self.config.base_url) {
            request.header("api-key", &self.config.api_key)
        } else {
            request.bearer_auth(&self.config.api_key)
        }
    }

    pub async fn stream(
        &self,
        mut request: ResponsesRequest,
        cancellation: CancellationToken,
    ) -> Result<ResponseStream, BenchError> {
        request.model.clone_from(&self.config.model);
        request.stream = true;
        request.store = false;

        let send = self
            .authenticated_post()
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&request)
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(BenchError::cancelled()),
            response = send => response.map_err(network_error)?,
        };

        if !response.status().is_success() {
            let status = response.status();
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned);
            let body = response.text().await.unwrap_or_default();
            let excerpt = truncate(&body, ERROR_BODY_LIMIT);
            return Err(BenchError::Llm {
                message: match status.as_u16() {
                    401 | 403 => "LLM endpoint rejected the API key".into(),
                    429 => "LLM endpoint rate limit exceeded".into(),
                    code if code >= 500 => format!("LLM endpoint server error ({code})"),
                    code => format!("LLM endpoint returned HTTP {code}"),
                },
                status: Some(status.as_u16()),
                retry_after,
                body_excerpt: (!excerpt.is_empty()).then_some(excerpt),
            });
        }

        let state = StreamState {
            bytes: response.bytes_stream().boxed(),
            decoder: SseDecoder::default(),
            queued: VecDeque::new(),
            cancellation,
            finished: false,
        };
        let events = stream::try_unfold(state, |mut state| async move {
            loop {
                if let Some(event) = state.queued.pop_front() {
                    return Ok(Some((event, state)));
                }
                if state.finished {
                    return Ok(None);
                }

                let next = tokio::select! {
                    _ = state.cancellation.cancelled() => return Err(BenchError::cancelled()),
                    next = state.bytes.next() => next,
                };
                match next {
                    Some(Ok(chunk)) => {
                        let frames = state.decoder.push(&chunk)?;
                        queue_frames(&mut state, frames)?;
                    }
                    Some(Err(err)) => return Err(network_error(err)),
                    None => {
                        let frames = state.decoder.finish()?;
                        queue_frames(&mut state, frames)?;
                        state.finished = true;
                    }
                }
            }
        });
        Ok(Box::pin(events))
    }
}

fn uses_azure_api_key_auth(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| {
            host.ends_with(".openai.azure.com") || host.ends_with(".services.ai.azure.com")
        })
}

struct StreamState {
    bytes: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    decoder: SseDecoder,
    queued: VecDeque<ResponseEvent>,
    cancellation: CancellationToken,
    finished: bool,
}

fn queue_frames(state: &mut StreamState, frames: Vec<String>) -> Result<(), BenchError> {
    for frame in frames {
        if frame == "[DONE]" {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&frame)
            .map_err(|err| BenchError::llm(format!("malformed JSON in Responses stream: {err}")))?;
        let event = ResponseEvent::from_value(value)?;
        if matches!(event, ResponseEvent::Unknown { .. }) {
            eprintln!("scorebench: skipped unknown Responses stream event");
        }
        state.queued.push_back(event);
    }
    Ok(())
}

fn network_error(err: reqwest::Error) -> BenchError {
    BenchError::llm(if err.is_timeout() {
        "LLM endpoint request timed out".into()
    } else {
        format!("LLM endpoint network error: {err}")
    })
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}[truncated]", &value[..end])
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
        )
        .expect("fixture readable")
    }

    fn config(base_url: String) -> LlmConfig {
        LlmConfig {
            base_url,
            api_key: "test-secret-never-log".into(),
            model: "fixture-model".into(),
            timeout: Duration::from_secs(2),
        }
    }

    async fn serve_once(status: &str, headers: &[(&str, &str)], body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let headers = headers
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<Vec<_>>();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 16 * 1024];
            let _ = socket.read(&mut request).await;
            let mut response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            for (key, value) in headers {
                response.push_str(&format!("{key}: {value}\r\n"));
            }
            response.push_str("\r\n");
            response.push_str(&body);
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    #[test]
    fn config_debug_redacts_api_key() {
        let rendered = format!("{:?}", config("http://localhost".into()));
        assert!(rendered.contains("[redacted]"));
        assert!(!rendered.contains("test-secret-never-log"));
    }

    #[test]
    fn azure_foundry_requests_use_api_key_header() {
        let client = ResponsesClient::new(config(
            "https://example.services.ai.azure.com/openai/v1".into(),
        ))
        .unwrap();

        let request = client.authenticated_post().build().unwrap();

        assert_eq!(
            request.headers().get("api-key").unwrap(),
            "test-secret-never-log"
        );
        assert!(!request
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION));
    }

    #[test]
    fn openai_requests_keep_bearer_auth() {
        let client = ResponsesClient::new(config("https://api.openai.com/v1".into())).unwrap();

        let request = client.authenticated_post().build().unwrap();

        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer test-secret-never-log"
        );
        assert!(!request.headers().contains_key("api-key"));
    }

    #[tokio::test]
    async fn streams_recorded_text_fixture() {
        let body = fixture("responses_text.sse");
        let base = serve_once("200 OK", &[("Content-Type", "text/event-stream")], body).await;
        let client = ResponsesClient::new(config(base)).unwrap();
        let mut stream = client
            .stream(ResponsesRequest::default(), CancellationToken::new())
            .await
            .unwrap();
        let mut text = String::new();
        let mut usage = None;
        while let Some(event) = stream.next().await {
            match event.unwrap() {
                ResponseEvent::OutputTextDelta { delta, .. } => text.push_str(&delta),
                ResponseEvent::Completed { usage: value, .. } => usage = value,
                _ => {}
            }
        }
        assert_eq!(text, "hello scorebench");
        assert_eq!(usage.unwrap().total_tokens, Some(10));
    }

    #[tokio::test]
    async fn surfaces_auth_and_rate_limit_metadata() {
        for (status, expected) in [("401 Unauthorized", 401), ("429 Too Many Requests", 429)] {
            let base = serve_once(status, &[("Retry-After", "7")], "denied".into()).await;
            let client = ResponsesClient::new(config(base)).unwrap();
            let error = match client
                .stream(ResponsesRequest::default(), CancellationToken::new())
                .await
            {
                Ok(_) => panic!("HTTP failure must not produce a stream"),
                Err(error) => error,
            };
            match error {
                BenchError::Llm {
                    status,
                    retry_after,
                    body_excerpt,
                    ..
                } => {
                    assert_eq!(status, Some(expected));
                    assert_eq!(retry_after.as_deref(), Some("7"));
                    assert_eq!(body_excerpt.as_deref(), Some("denied"));
                }
                other => panic!("expected Llm error, got {other:?}"),
            }
        }
    }

    #[test]
    fn recorded_multi_tool_fixture_preserves_both_calls() {
        let body = fixture("responses_multi_tool.sse");
        let mut decoder = SseDecoder::default();
        let frames = decoder.push(body.as_bytes()).unwrap();
        let calls = frames
            .into_iter()
            .map(|frame| serde_json::from_str(&frame).unwrap())
            .map(ResponseEvent::from_value)
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .into_iter()
            .filter_map(|event| match event {
                ResponseEvent::OutputItemDone { function_call, .. } => function_call,
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read_scene");
        assert_eq!(calls[1].name, "validate_scene");
    }

    #[tokio::test]
    async fn mid_stream_disconnect_is_a_typed_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 16 * 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 9999\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                )
                .await
                .unwrap();
        });
        let client = ResponsesClient::new(config(format!("http://{address}"))).unwrap();
        let mut stream = client
            .stream(ResponsesRequest::default(), CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            ResponseEvent::OutputTextDelta { .. }
        ));
        assert!(matches!(
            stream.next().await.unwrap(),
            Err(BenchError::Llm { .. })
        ));
    }

    #[tokio::test]
    async fn dead_endpoint_fails_without_hanging() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = ResponsesClient::new(config(format!("http://{address}"))).unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            client.stream(ResponsesRequest::default(), CancellationToken::new()),
        )
        .await
        .expect("dead endpoint must fail promptly");
        assert!(matches!(result, Err(BenchError::Llm { .. })));
    }

    #[tokio::test]
    async fn cancellation_ends_stream_without_client_task() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer_closed = Arc::new(AtomicBool::new(false));
        let peer_closed_server = Arc::clone(&peer_closed);
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 16 * 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            let mut probe = [0_u8; 1];
            let result =
                tokio::time::timeout(Duration::from_secs(1), socket.read(&mut probe)).await;
            peer_closed_server.store(matches!(result, Ok(Ok(0))), Ordering::SeqCst);
        });

        let client = ResponsesClient::new(config(format!("http://{address}"))).unwrap();
        let cancellation = CancellationToken::new();
        let mut stream = client
            .stream(ResponsesRequest::default(), cancellation.clone())
            .await
            .unwrap();
        cancellation.cancel();
        let event = tokio::time::timeout(Duration::from_millis(250), stream.next())
            .await
            .expect("cancellation is prompt")
            .expect("stream emits cancellation");
        assert!(matches!(event, Err(BenchError::Cancelled { .. })));
        drop(stream);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(peer_closed.load(Ordering::SeqCst));
    }
}
