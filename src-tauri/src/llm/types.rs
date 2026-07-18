use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::BenchError;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ResponsesRequest {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub input: Vec<InputItem>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    pub stream: bool,
    pub store: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputItem {
    Message {
        role: InputRole,
        content: String,
    },
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    FunctionCallOutput {
        call_id: String,
        output: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    kind: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub strict: bool,
}

impl ToolDefinition {
    pub fn function(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
    ) -> Self {
        Self {
            kind: "function".into(),
            name: name.into(),
            description: description.into(),
            parameters,
            strict: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionCall {
    pub id: Option<String>,
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponseEvent {
    Created {
        response_id: Option<String>,
    },
    InProgress {
        response_id: Option<String>,
    },
    OutputTextDelta {
        item_id: Option<String>,
        output_index: Option<u64>,
        delta: String,
    },
    OutputTextDone {
        text: String,
    },
    OutputItemAdded {
        output_index: u64,
        item: Value,
    },
    FunctionCallArgumentsDelta {
        item_id: String,
        output_index: u64,
        delta: String,
    },
    FunctionCallArgumentsDone {
        item_id: String,
        output_index: u64,
        arguments: String,
    },
    OutputItemDone {
        output_index: u64,
        item: Value,
        function_call: Option<FunctionCall>,
    },
    Completed {
        response_id: Option<String>,
        usage: Option<Usage>,
    },
    Failed {
        response_id: Option<String>,
        code: Option<String>,
        message: String,
    },
    Error {
        code: Option<String>,
        message: String,
    },
    Unknown {
        event_type: String,
        value: Value,
    },
}

impl ResponseEvent {
    pub fn from_value(value: Value) -> Result<Self, BenchError> {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| BenchError::llm("Responses stream event has no `type`"))?;
        let response = value.get("response");
        let response_id = || {
            value
                .get("response_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    response
                        .and_then(|item| item.get("id"))
                        .and_then(Value::as_str)
                })
                .map(ToOwned::to_owned)
        };
        let string = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        };
        let index = || value.get("output_index").and_then(Value::as_u64);

        Ok(match event_type {
            "response.created" => Self::Created {
                response_id: response_id(),
            },
            "response.in_progress" => Self::InProgress {
                response_id: response_id(),
            },
            "response.output_text.delta" => Self::OutputTextDelta {
                item_id: string("item_id"),
                output_index: index(),
                delta: required_string(&value, "delta")?,
            },
            "response.output_text.done" => Self::OutputTextDone {
                text: required_string(&value, "text")?,
            },
            "response.output_item.added" => Self::OutputItemAdded {
                output_index: required_index(&value)?,
                item: required_value(&value, "item")?,
            },
            "response.function_call_arguments.delta" => Self::FunctionCallArgumentsDelta {
                item_id: required_string(&value, "item_id")?,
                output_index: required_index(&value)?,
                delta: required_string(&value, "delta")?,
            },
            "response.function_call_arguments.done" => Self::FunctionCallArgumentsDone {
                item_id: required_string(&value, "item_id")?,
                output_index: required_index(&value)?,
                arguments: required_string(&value, "arguments")?,
            },
            "response.output_item.done" => {
                let item = required_value(&value, "item")?;
                let function_call = parse_function_call(&item)?;
                Self::OutputItemDone {
                    output_index: required_index(&value)?,
                    item,
                    function_call,
                }
            }
            "response.completed" => Self::Completed {
                response_id: response_id(),
                usage: response
                    .and_then(|item| item.get("usage"))
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|err| BenchError::llm(format!("invalid usage payload: {err}")))?,
            },
            "response.failed" => {
                let error = response
                    .and_then(|item| item.get("error"))
                    .or_else(|| value.get("error"));
                Self::Failed {
                    response_id: response_id(),
                    code: error
                        .and_then(|item| item.get("code"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    message: error
                        .and_then(|item| item.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Responses API reported a failed response")
                        .to_owned(),
                }
            }
            "error" => {
                let error = value.get("error").unwrap_or(&value);
                Self::Error {
                    code: error
                        .get("code")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Responses API stream error")
                        .to_owned(),
                }
            }
            _ => Self::Unknown {
                event_type: event_type.to_owned(),
                value,
            },
        })
    }
}

fn required_string(value: &Value, key: &str) -> Result<String, BenchError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| BenchError::llm(format!("Responses event is missing string `{key}`")))
}

fn required_index(value: &Value) -> Result<u64, BenchError> {
    value
        .get("output_index")
        .and_then(Value::as_u64)
        .ok_or_else(|| BenchError::llm("Responses event is missing `output_index`"))
}

fn required_value(value: &Value, key: &str) -> Result<Value, BenchError> {
    value
        .get(key)
        .cloned()
        .ok_or_else(|| BenchError::llm(format!("Responses event is missing `{key}`")))
}

fn parse_function_call(item: &Value) -> Result<Option<FunctionCall>, BenchError> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return Ok(None);
    }
    Ok(Some(FunctionCall {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        call_id: required_string(item, "call_id")?,
        name: required_string(item, "name")?,
        arguments: required_string(item, "arguments")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_deterministic_and_stateless() {
        let request = ResponsesRequest {
            model: "model".into(),
            instructions: Some("compose".into()),
            input: vec![InputItem::Message {
                role: InputRole::User,
                content: "hello".into(),
            }],
            tools: vec![],
            max_output_tokens: None,
            stream: true,
            store: false,
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(value["stream"], true);
        assert_eq!(value["store"], false);
        assert!(value.get("previous_response_id").is_none());
    }

    #[test]
    fn parses_completed_function_call() {
        let event = ResponseEvent::from_value(serde_json::json!({
            "type": "response.output_item.done",
            "output_index": 2,
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "doctor",
                "arguments": "{}"
            }
        }))
        .unwrap();
        match event {
            ResponseEvent::OutputItemDone { function_call, .. } => {
                assert_eq!(function_call.unwrap().name, "doctor");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn unknown_event_is_preserved() {
        let event = ResponseEvent::from_value(serde_json::json!({
            "type": "response.future_event",
            "answer": 42
        }))
        .unwrap();
        assert!(matches!(event, ResponseEvent::Unknown { .. }));
    }

    #[test]
    fn response_failed_preserves_machine_error() {
        let event = ResponseEvent::from_value(serde_json::json!({
            "type": "response.failed",
            "response": {
                "id": "resp_failed",
                "error": {"code":"server_error","message":"upstream failed"}
            }
        }))
        .unwrap();
        assert!(matches!(
            event,
            ResponseEvent::Failed { code: Some(code), message, .. }
                if code == "server_error" && message == "upstream failed"
        ));
    }
}
