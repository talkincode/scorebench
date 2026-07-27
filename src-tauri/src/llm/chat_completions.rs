use std::collections::{BTreeMap, VecDeque};

use bytes::Bytes;
use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::error::BenchError;

use super::sse::SseDecoder;
use super::types::{
    ContentPart, FunctionCall, InputItem, InputRole, MessageContent, ResponseEvent,
    ResponsesRequest, Usage,
};
use super::{
    authorized_post, build_http_client, ensure_success, network_error, LlmConfig, ResponseStream,
};

#[derive(Clone)]
pub(super) struct ChatCompletionsClient {
    http: reqwest::Client,
    config: LlmConfig,
}

impl ChatCompletionsClient {
    pub(super) fn new(config: LlmConfig) -> Result<Self, BenchError> {
        let http = build_http_client(&config)?;
        Ok(Self { http, config })
    }

    pub(super) async fn stream(
        &self,
        request: ResponsesRequest,
        cancellation: CancellationToken,
    ) -> Result<ResponseStream, BenchError> {
        let body = request_body(request, &self.config.model);
        let send = authorized_post(&self.http, &self.config, self.config.chat_completions_url())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(BenchError::cancelled()),
            response = send => response.map_err(network_error)?,
        };
        let response = ensure_success(response).await?;

        let state = ChatStreamState {
            bytes: response.bytes_stream().boxed(),
            decoder: SseDecoder::default(),
            queued: VecDeque::new(),
            cancellation,
            finished: false,
            response_id: None,
            usage: None,
            finish_reason: None,
            tool_calls: BTreeMap::new(),
            terminal_queued: false,
            saw_done: false,
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
                        if !state.terminal_queued {
                            finish_stream(&mut state)?;
                        }
                        state.finished = true;
                    }
                }
            }
        });
        Ok(Box::pin(events))
    }
}

fn request_body(request: ResponsesRequest, model: &str) -> Value {
    let mut messages = Vec::new();
    if let Some(instructions) = request.instructions {
        messages.push(json!({
            "role": "system",
            "content": instructions,
        }));
    }
    messages.extend(request.input.into_iter().map(input_message));

    let tools = request
        .tools
        .into_iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            })
        })
        .collect::<Vec<_>>();

    let mut body = Map::from_iter([
        ("model".into(), Value::String(model.to_owned())),
        ("messages".into(), Value::Array(messages)),
        ("stream".into(), Value::Bool(true)),
    ]);
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
    }
    if let Some(max_tokens) = request.max_output_tokens {
        body.insert("max_tokens".into(), Value::from(max_tokens));
    }
    Value::Object(body)
}

fn input_message(item: InputItem) -> Value {
    match item {
        InputItem::Message { role, content } => json!({
            "role": match role {
                InputRole::User => "user",
                InputRole::Assistant => "assistant",
            },
            "content": message_content(content),
        }),
        InputItem::FunctionCall {
            call_id,
            name,
            arguments,
        } => json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": arguments,
                },
            }],
        }),
        InputItem::FunctionCallOutput { call_id, output } => json!({
            "role": "tool",
            "tool_call_id": call_id,
            "content": output,
        }),
    }
}

fn message_content(content: MessageContent) -> Value {
    match content {
        MessageContent::Text(text) => Value::String(text),
        MessageContent::Parts(parts) => Value::Array(
            parts
                .into_iter()
                .map(|part| match part {
                    ContentPart::InputText { text } => json!({
                        "type": "text",
                        "text": text,
                    }),
                    ContentPart::InputImage { image_url } => json!({
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                        },
                    }),
                    ContentPart::InputFile {
                        filename,
                        file_data,
                    } => json!({
                        "type": "file",
                        "file": {
                            "filename": filename,
                            "file_data": file_data,
                        },
                    }),
                })
                .collect(),
        ),
    }
}

#[derive(Default)]
struct PendingToolCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

struct ChatStreamState {
    bytes: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    decoder: SseDecoder,
    queued: VecDeque<ResponseEvent>,
    cancellation: CancellationToken,
    finished: bool,
    response_id: Option<String>,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    tool_calls: BTreeMap<u64, PendingToolCall>,
    terminal_queued: bool,
    saw_done: bool,
}

fn queue_frames(state: &mut ChatStreamState, frames: Vec<String>) -> Result<(), BenchError> {
    for frame in frames {
        if frame == "[DONE]" {
            state.saw_done = true;
            finish_stream(state)?;
            state.finished = true;
            break;
        }
        queue_chunk(
            state,
            serde_json::from_str(&frame).map_err(|err| {
                BenchError::llm(format!("malformed JSON in Chat Completions stream: {err}"))
            })?,
        )?;
        if state.terminal_queued {
            state.finished = true;
            break;
        }
    }
    Ok(())
}

fn queue_chunk(state: &mut ChatStreamState, value: Value) -> Result<(), BenchError> {
    if let Some(error) = value.get("error") {
        state.queued.push_back(ResponseEvent::Error {
            code: string_or_number(error.get("code")),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Chat Completions API stream error")
                .to_owned(),
        });
        state.terminal_queued = true;
        return Ok(());
    }

    if let Some(id) = value.get("id").and_then(Value::as_str) {
        state.response_id = Some(id.to_owned());
    }
    if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
        state.usage = Some(Usage {
            input_tokens: token_count(usage, "prompt_tokens", "input_tokens"),
            output_tokens: token_count(usage, "completion_tokens", "output_tokens"),
            total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
        });
    }

    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        if value.get("usage").is_some() {
            return Ok(());
        }
        return Err(BenchError::llm(
            "Chat Completions stream chunk has no `choices`",
        ));
    };
    for choice in choices {
        let choice_index = choice.get("index").and_then(Value::as_u64).unwrap_or(0);
        if choice_index != 0 {
            return Err(BenchError::llm(format!(
                "Chat Completions returned unsupported choice index {choice_index}"
            )));
        }
        if let Some(delta) = choice.get("delta") {
            queue_delta(state, delta)?;
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if state
                .finish_reason
                .as_deref()
                .is_some_and(|known| known != reason)
            {
                return Err(BenchError::llm(
                    "Chat Completions stream changed its finish reason",
                ));
            }
            state.finish_reason = Some(reason.to_owned());
        }
    }
    Ok(())
}

fn queue_delta(state: &mut ChatStreamState, delta: &Value) -> Result<(), BenchError> {
    if let Some(content) = delta.get("content").filter(|content| !content.is_null()) {
        let text = content.as_str().ok_or_else(|| {
            BenchError::llm("Chat Completions delta `content` must be a string or null")
        })?;
        if !text.is_empty() {
            state.queued.push_back(ResponseEvent::OutputTextDelta {
                item_id: None,
                output_index: Some(0),
                delta: text.to_owned(),
            });
        }
    }

    let Some(tool_calls) = delta
        .get("tool_calls")
        .filter(|tool_calls| !tool_calls.is_null())
    else {
        return Ok(());
    };
    let tool_calls = tool_calls
        .as_array()
        .ok_or_else(|| BenchError::llm("Chat Completions delta `tool_calls` must be an array"))?;
    for (position, value) in tool_calls.iter().enumerate() {
        let index = value
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(position as u64);
        let pending = state.tool_calls.entry(index).or_default();
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            if pending.id.as_deref().is_some_and(|known| known != id) {
                return Err(BenchError::llm(format!(
                    "Chat Completions tool call {index} changed its id"
                )));
            }
            pending.id = Some(id.to_owned());
        }
        if let Some(function) = value.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                pending.name.push_str(name);
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                pending.arguments.push_str(arguments);
            }
        }
    }
    Ok(())
}

fn finish_stream(state: &mut ChatStreamState) -> Result<(), BenchError> {
    if state.terminal_queued {
        return Ok(());
    }

    match state.finish_reason.as_deref() {
        Some("stop" | "tool_calls" | "function_call") => {
            flush_tool_calls(state)?;
            state.queued.push_back(ResponseEvent::Completed {
                response_id: state.response_id.clone(),
                usage: state.usage.clone(),
            });
        }
        None if state.saw_done => {
            flush_tool_calls(state)?;
            state.queued.push_back(ResponseEvent::Completed {
                response_id: state.response_id.clone(),
                usage: state.usage.clone(),
            });
        }
        Some("length") => state.queued.push_back(ResponseEvent::Incomplete {
            response_id: state.response_id.clone(),
            reason: Some("max_tokens".into()),
        }),
        Some(reason) => state.queued.push_back(ResponseEvent::Incomplete {
            response_id: state.response_id.clone(),
            reason: Some(reason.to_owned()),
        }),
        None => {
            return Err(BenchError::llm(
                "Chat Completions stream ended before `finish_reason` or `[DONE]`",
            ));
        }
    }
    state.terminal_queued = true;
    Ok(())
}

fn flush_tool_calls(state: &mut ChatStreamState) -> Result<(), BenchError> {
    for (output_index, pending) in std::mem::take(&mut state.tool_calls) {
        let call_id = pending.id.ok_or_else(|| {
            BenchError::llm(format!(
                "Chat Completions tool call {output_index} has no id"
            ))
        })?;
        if pending.name.is_empty() {
            return Err(BenchError::llm(format!(
                "Chat Completions tool call {output_index} has no function name"
            )));
        }
        let name = pending.name;
        let arguments = pending.arguments;
        let item = json!({
            "type": "function_call",
            "id": call_id,
            "call_id": call_id,
            "name": name,
            "arguments": arguments,
        });
        state.queued.push_back(ResponseEvent::OutputItemDone {
            output_index,
            function_call: Some(FunctionCall {
                id: Some(call_id.clone()),
                call_id,
                name,
                arguments,
            }),
            item,
        });
    }
    Ok(())
}

fn token_count(value: &Value, primary: &str, fallback: &str) -> Option<u64> {
    value
        .get(primary)
        .and_then(Value::as_u64)
        .or_else(|| value.get(fallback).and_then(Value::as_u64))
}

fn string_or_number(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::types::{ToolDefinition, Usage};
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
    fn translates_messages_tools_and_token_limit() {
        let body = request_body(
            ResponsesRequest {
                model: String::new(),
                instructions: Some("compose".into()),
                input: vec![
                    InputItem::Message {
                        role: InputRole::User,
                        content: "hello".into(),
                    },
                    InputItem::FunctionCall {
                        call_id: "call_1".into(),
                        name: "doctor".into(),
                        arguments: "{}".into(),
                    },
                    InputItem::FunctionCallOutput {
                        call_id: "call_1".into(),
                        output: "{\"ok\":true}".into(),
                    },
                ],
                tools: vec![ToolDefinition::function(
                    "doctor",
                    "Check scorekit",
                    json!({"type": "object", "properties": {}}),
                )],
                max_output_tokens: Some(16),
                stream: true,
                store: false,
            },
            "fixture-model",
        );

        assert_eq!(body["model"], "fixture-model");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(body["messages"][3]["role"], "tool");
        assert_eq!(body["tools"][0]["function"]["name"], "doctor");
        assert!(body["tools"][0]["function"].get("strict").is_none());
        assert_eq!(body["max_tokens"], 16);
        assert!(body.get("store").is_none());
    }

    #[tokio::test]
    async fn streams_recorded_text_fixture() {
        let base = serve_once(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            fixture("chat_completions_text.sse"),
        )
        .await;
        let client = ChatCompletionsClient::new(config(base)).unwrap();
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
        assert_eq!(
            usage,
            Some(Usage {
                input_tokens: Some(6),
                output_tokens: Some(4),
                total_tokens: Some(10),
            })
        );
    }

    #[tokio::test]
    async fn streams_recorded_parallel_tool_calls() {
        let base = serve_once(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            fixture("chat_completions_multi_tool.sse"),
        )
        .await;
        let client = ChatCompletionsClient::new(config(base)).unwrap();
        let mut stream = client
            .stream(ResponsesRequest::default(), CancellationToken::new())
            .await
            .unwrap();
        let mut calls = Vec::new();
        let mut completed = false;
        while let Some(event) = stream.next().await {
            match event.unwrap() {
                ResponseEvent::OutputItemDone {
                    function_call: Some(call),
                    ..
                } => calls.push(call),
                ResponseEvent::Completed { .. } => completed = true,
                _ => {}
            }
        }
        assert!(completed);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read_scene");
        assert_eq!(calls[0].arguments, "{\"path\":\"scenes/a.yaml\"}");
        assert_eq!(calls[1].name, "validate_scene");
        assert_eq!(calls[1].arguments, "{\"path\":\"scenes/a.yaml\"}");
    }

    #[tokio::test]
    async fn length_finish_reason_is_incomplete() {
        let body = concat!(
            "data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"cut\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let base = serve_once(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            body.into(),
        )
        .await;
        let client = ChatCompletionsClient::new(config(base)).unwrap();
        let events = client
            .stream(ResponsesRequest::default(), CancellationToken::new())
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.into_iter().any(|event| matches!(
            event.unwrap(),
            ResponseEvent::Incomplete {
                reason: Some(reason),
                ..
            } if reason == "max_tokens"
        )));
    }

    #[tokio::test]
    async fn stream_without_terminal_marker_fails() {
        let base = serve_once(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            "data: {\"id\":\"chat_1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n".into(),
        )
        .await;
        let client = ChatCompletionsClient::new(config(base)).unwrap();
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
    async fn surfaces_http_failure_metadata() {
        let base = serve_once("401 Unauthorized", &[("Retry-After", "7")], "denied".into()).await;
        let client = ChatCompletionsClient::new(config(base)).unwrap();
        let error = match client
            .stream(ResponsesRequest::default(), CancellationToken::new())
            .await
        {
            Ok(_) => panic!("HTTP failure must not produce a stream"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            BenchError::Llm {
                status: Some(401),
                retry_after: Some(value),
                body_excerpt: Some(body),
                ..
            } if value == "7" && body == "denied"
        ));
    }

    #[tokio::test]
    async fn surfaces_stream_error_event() {
        let base = serve_once(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            "data: {\"error\":{\"code\":\"server_error\",\"message\":\"provider failed\"}}\n\n"
                .into(),
        )
        .await;
        let client = ChatCompletionsClient::new(config(base)).unwrap();
        let mut stream = client
            .stream(ResponsesRequest::default(), CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            ResponseEvent::Error {
                code: Some(code),
                message,
            } if code == "server_error" && message == "provider failed"
        ));
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn cancellation_ends_stream_and_drops_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer_closed = Arc::new(AtomicBool::new(false));
        let peer_closed_server = Arc::clone(&peer_closed);
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 16 * 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let mut probe = [0_u8; 1];
            let result =
                tokio::time::timeout(Duration::from_secs(1), socket.read(&mut probe)).await;
            peer_closed_server.store(matches!(result, Ok(Ok(0))), Ordering::SeqCst);
        });

        let client = ChatCompletionsClient::new(config(format!("http://{address}"))).unwrap();
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
