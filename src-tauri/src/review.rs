//! Review panel core: one LLM call producing a multi-perspective structured
//! critique of a single scene.
//!
//! Design (audited 2026-07): no parallel per-role fan-out, no consensus
//! engine, no numeric score averaging. One request covers the selected
//! perspectives and reasons explicitly about their tensions. The reviewer
//! gets no tools and never writes — the composing agent stays the only
//! writer. Evidence is assembled deterministically on this side (scene YAML,
//! the scene DSL schema, scorekit validation, last semantic diff, render
//! meta, project memory, recent user intent) so the critique is grounded in
//! facts, not vibes. The schema matters most: without it the reviewer
//! critiques in a general orchestration vocabulary (octave constraints,
//! per-track exceptions, intra-section ramps) that the DSL cannot express,
//! and the composing agent rightly rejects every such suggestion.
//! There is no audio signal in the evidence and the prompt says so.

use std::path::Path;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::agent::AgentTransport;
use crate::error::BenchError;
use crate::llm::types::{InputItem, InputRole, ResponseEvent, ResponsesRequest};
use crate::{memory, observation, project, scorekit, styles};

/// Cancellation-table key for the single in-flight review of a project.
/// Contains `:` so it can never collide with a user session id
/// (`sessions::validate_id` only allows lowercase, digits, and dashes).
pub const CANCEL_KEY: &str = "sys:review";

const SCENE_YAML_LIMIT: usize = 48 * 1024;
const INTENT_LIMIT: usize = 1_500;
const RECENT_INTENTS: usize = 3;

/// Perspective ids and reviewer briefs. Pure prompt material — adding a
/// perspective is a data change, not an architecture change.
const PERSPECTIVES: &[(&str, &str)] = &[
    (
        "composer",
        "Composer — melody, harmony, structure, thematic development. Does any motif develop or answer itself? Do sections relate or merely alternate?",
    ),
    (
        "arranger",
        "Arranger — instrument roles, density, layering, register conflicts. Do tracks crowd the same register? Does intensity layering leave room for a lead voice?",
    ),
    (
        "producer",
        "Producer — overall shape, emotional arc, listenability. Where does the energy peak? Would a listener notice when a section changes?",
    ),
    (
        "scoring",
        "Film/game scoring — narrative fit, scene function, loop seams. Does the music serve the scene named by the title/intent? Does the loop boundary land without a bump?",
    ),
    (
        "child",
        "Child listener — not an expert; reacts honestly. Is there a clear picture, something to remember, a surprise, a change you can actually hear?",
    ),
];

/// Everything the reviewer is allowed to reason from.
#[derive(Debug, Clone, Serialize)]
pub struct Evidence {
    pub scene_path: String,
    pub scene_yaml: String,
    /// The scorekit scene DSL JSON schema — the composing agent's entire
    /// expressive range. Suggestions outside it are unactionable by design.
    pub scene_schema: Value,
    pub validation: Value,
    pub last_diff: Option<Value>,
    pub render_meta: Option<Value>,
    /// The project's active style pack, when one is selected: its structured
    /// constraints and `review.criteria` become part of the judging basis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_pack: Option<Value>,
    pub project_memory: String,
    pub recent_user_intents: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReviewReport {
    #[serde(default)]
    pub perspectives: Vec<PerspectiveReview>,
    #[serde(default)]
    pub tensions: Vec<Tension>,
    #[serde(default)]
    pub consensus: Vec<String>,
    #[serde(default)]
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PerspectiveReview {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub headline: String,
    #[serde(default)]
    pub strengths: Vec<String>,
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub confidence: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tension {
    #[serde(default)]
    pub between: Vec<String>,
    #[serde(default)]
    pub point: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Suggestion {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub severity: String,
}

/// Streaming events for the host channel; the final report is the command's
/// return value, so the channel only carries progress.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReviewEvent {
    Delta { text: String },
}

/// Deterministically assemble the evidence pack for one scene.
/// Scene YAML is mandatory; every render-side artifact is best-effort
/// because a scene can be reviewed before it was ever built.
pub fn gather_evidence(
    root: &Path,
    session: &str,
    scene_rel: &str,
    style: Option<&styles::StylePack>,
) -> Result<Evidence, BenchError> {
    let scene_yaml = project::read_text_inside(root, scene_rel)?;
    let inspection = observation::inspect_scene(root, scene_rel)?;
    let validation = serde_json::to_value(&inspection.validation).map_err(BenchError::io)?;

    // Same fallback shape as the composing agent's system prompt: reviews
    // must still work when scorekit is missing, but degrade honestly.
    let scene_schema = scorekit::schema().unwrap_or_else(|error| {
        serde_json::json!({
            "unavailable": true,
            "error": error,
            "note": "Schema unavailable: only suggest adjusting values already present in the scene YAML; never propose new fields.",
        })
    });

    // Build outputs land at `out/<stem>.<format>`; scorekit writes the meta
    // sidecar as `out/<stem>.meta.json` regardless of format.
    let stem = Path::new(scene_rel)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("scene");
    let meta_rel = format!("{}/{stem}.meta.json", project::OUT_DIR);
    let render_meta = observation::read_meta(root, &meta_rel).ok();

    let project_memory = memory::read_memory(root, session).unwrap_or_default();
    let recent_user_intents = memory::load_transcript(root, session)
        .map(|loaded| {
            loaded
                .items
                .iter()
                .filter_map(|item| match item {
                    InputItem::Message {
                        role: InputRole::User,
                        content,
                    } => Some(clip(&content.display_text(), INTENT_LIMIT)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
        .into_iter()
        .rev()
        .take(RECENT_INTENTS)
        .rev()
        .collect();

    Ok(Evidence {
        scene_path: scene_rel.to_owned(),
        scene_yaml: clip(&scene_yaml, SCENE_YAML_LIMIT),
        scene_schema,
        validation,
        last_diff: inspection.last_diff,
        render_meta,
        style_pack: style.map(styles::to_json),
        project_memory: clip(&project_memory, SCENE_YAML_LIMIT),
        recent_user_intents,
    })
}

/// Build the review-mode system prompt for the selected perspective ids.
/// Rejects unknown ids so a stale frontend cannot invent reviewers.
pub fn instructions(selected: &[String], locale: &str) -> Result<String, BenchError> {
    if selected.is_empty() {
        return Err(BenchError::agent(
            "review_no_perspectives",
            "select at least one review perspective",
        ));
    }
    let mut briefs = Vec::new();
    for id in selected {
        let brief = PERSPECTIVES
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, brief)| *brief)
            .ok_or_else(|| {
                BenchError::agent(
                    "review_unknown_perspective",
                    format!("unknown review perspective `{id}`"),
                )
            })?;
        briefs.push(format!("- `{id}`: {brief}"));
    }
    let language = if locale == "zh" {
        "Simplified Chinese"
    } else {
        "English"
    };
    let briefs = briefs.join("\n");
    Ok(format!(
        "You are the scorebench review panel: one critic writing a multi-perspective review of one scorekit scene.\n\
         Ground every observation in the evidence provided by the user message. There is NO audio signal in the evidence: never claim to have heard anything; reason from scene data, validation, diff, and render metadata only, and say so when a judgement would need ears.\n\
         Cite concrete evidence (section names, track instruments, intensity values, bar counts) for every issue you raise.\n\
         Cover exactly these perspectives, one entry each, in this order:\n{briefs}\n\
         After the perspectives, reason about where they genuinely pull against each other (tensions), then what they agree on (consensus). Do not manufacture disagreement; an empty tensions list is honest when the perspectives align.\n\
         Finish with concrete suggestions the composing agent could evaluate. Reference exact scene fields. Suggestions are proposals, not commands. Label each with `priority` (how soon it should be acted on) and `severity` (how much the underlying problem hurts the scene); they may differ — a cheap fix for a mild problem is high priority, low severity.\n\
         HARD CONSTRAINT on suggestions: the evidence field `scene_schema` is the complete JSON schema of the scene DSL — the composing agent's entire expressive range. Every suggestion must be implementable by editing fields that exist in that schema (changing values, adding schema-legal entries). Do NOT suggest octave/register/voicing constraints, per-track performance exceptions, intra-section ramps, per-bar changes, or any control the schema lacks — the agent can only reject those. When a musical goal cannot be expressed in the schema, keep it out of `suggestions`: name it in the relevant perspective's `issues` together with the schema limitation, so the human can decide whether the toolchain should grow.\n\
         When the evidence includes `style_pack`, the project composes under that active style pack: in every perspective, additionally judge the scene against the pack's structured constraints and its `review.criteria`; cite the pack field for any violation (an instrument on `arrangement.avoid`, tempo outside `defaults.tempo_bpm`, a density or character the pack excludes). Weigh violations against `recent_user_intents` — a deviation the user explicitly asked for is a choice to note, not an issue.\n\
         Write every natural-language string value in {language}.\n\
         Output exactly one fenced ```json code block and nothing else, matching this shape:\n\
         ```json\n\
         {{\n\
           \"perspectives\": [\n\
             {{\"role\": \"composer\", \"headline\": \"one-sentence verdict\", \"strengths\": [\"...\"], \"issues\": [\"...\"], \"severity\": \"medium\", \"confidence\": \"medium\"}}\n\
           ],\n\
           \"tensions\": [{{\"between\": [\"composer\", \"scoring\"], \"point\": \"...\"}}],\n\
           \"consensus\": [\"...\"],\n\
           \"suggestions\": [{{\"text\": \"...\", \"rationale\": \"...\", \"priority\": \"high\", \"severity\": \"medium\"}}]\n\
         }}\n\
         ```\n\
         `severity`, `confidence` and `priority` must be one of \"low\", \"medium\", \"high\"."
    ))
}

/// Run the single review request: no tools, streamed text, parsed report.
pub async fn run_review<T: AgentTransport>(
    transport: &T,
    instructions: String,
    evidence: &Evidence,
    cancellation: CancellationToken,
    mut emit: impl FnMut(ReviewEvent),
) -> Result<ReviewReport, BenchError> {
    let payload = serde_json::to_string_pretty(evidence).map_err(BenchError::io)?;
    let request = ResponsesRequest {
        model: String::new(),
        instructions: Some(instructions),
        input: vec![InputItem::Message {
            role: InputRole::User,
            content: format!("EVIDENCE:\n{payload}").into(),
        }],
        tools: vec![],
        // No cap: the report length scales with selected perspectives and a
        // Chinese-locale report easily exceeds a fixed budget. Truncation is
        // handled explicitly via `Incomplete` below.
        max_output_tokens: None,
        stream: true,
        store: false,
    };
    let mut stream = transport.stream(request, cancellation.clone()).await?;
    let mut text = String::new();
    let mut terminal = false;
    while let Some(event) = stream.next().await {
        if cancellation.is_cancelled() {
            return Err(BenchError::cancelled());
        }
        match event? {
            ResponseEvent::OutputTextDelta { delta, .. } => {
                text.push_str(&delta);
                emit(ReviewEvent::Delta { text: delta });
            }
            ResponseEvent::Completed { .. } => terminal = true,
            // A truncated report is almost certainly cut mid-JSON; a parse
            // error would mislead. Name the real cause instead.
            ResponseEvent::Incomplete { reason, .. } => {
                return Err(BenchError::agent(
                    "review_truncated",
                    format!(
                        "review output was truncated by the endpoint ({}); try fewer perspectives",
                        reason.as_deref().unwrap_or("unknown reason")
                    ),
                ));
            }
            ResponseEvent::Failed { code, message, .. }
            | ResponseEvent::Error { code, message } => {
                return Err(BenchError::Llm {
                    message,
                    status: None,
                    retry_after: None,
                    body_excerpt: code,
                });
            }
            _ => {}
        }
    }
    if !terminal {
        return Err(BenchError::llm(
            "review stream ended before a terminal event",
        ));
    }
    parse_report(&text)
}

/// Extract and validate the fenced JSON report from the model output.
pub fn parse_report(text: &str) -> Result<ReviewReport, BenchError> {
    let body = fenced_json(text).unwrap_or_else(|| text.trim().to_owned());
    let mut report: ReviewReport = serde_json::from_str(&body).map_err(|error| {
        BenchError::agent(
            "review_parse",
            format!("review output is not the expected JSON report: {error}"),
        )
    })?;
    if report.perspectives.is_empty() {
        return Err(BenchError::agent(
            "review_parse",
            "review report contains no perspectives",
        ));
    }
    // Stable sort: high-priority suggestions first, model order within a tier,
    // unlabeled ones last so labeled advice is never buried.
    report
        .suggestions
        .sort_by_key(|s| priority_rank(&s.priority));
    Ok(report)
}

fn priority_rank(level: &str) -> u8 {
    match level {
        "high" => 0,
        "medium" => 1,
        "low" => 2,
        _ => 3,
    }
}

/// Return the contents of the first fenced code block, tolerating a
/// language tag (```json) and prose around the fence.
fn fenced_json(text: &str) -> Option<String> {
    let open = text.find("```")?;
    let after_fence = &text[open + 3..];
    let body_start = after_fence.find('\n')? + 1;
    let body = &after_fence[body_start..];
    let close = body.find("```")?;
    Some(body[..close].trim().to_owned())
}

fn clip(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &value[..end])
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::sync::Mutex;

    use futures_util::stream;

    use super::*;
    use crate::llm::ResponseStream;

    /// Recorded model output for the review contract (prose + fenced JSON).
    const RECORDED_RESPONSE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/review_response.txt"
    ));

    struct ScriptedTransport {
        turns: Mutex<VecDeque<Result<Vec<ResponseEvent>, BenchError>>>,
    }

    impl ScriptedTransport {
        fn new(turns: Vec<Result<Vec<ResponseEvent>, BenchError>>) -> Self {
            Self {
                turns: Mutex::new(turns.into()),
            }
        }
    }

    impl AgentTransport for ScriptedTransport {
        fn stream<'a>(
            &'a self,
            _request: ResponsesRequest,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<ResponseStream, BenchError>> + Send + 'a>> {
            Box::pin(async move {
                match self.turns.lock().unwrap().pop_front().unwrap() {
                    Ok(events) => {
                        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))) as ResponseStream)
                    }
                    Err(error) => Err(error),
                }
            })
        }
    }

    fn completed() -> ResponseEvent {
        ResponseEvent::Completed {
            response_id: Some("response_fixture".into()),
            usage: None,
        }
    }

    fn delta(text: &str) -> ResponseEvent {
        ResponseEvent::OutputTextDelta {
            item_id: None,
            output_index: Some(0),
            delta: text.into(),
        }
    }

    fn evidence() -> Evidence {
        Evidence {
            scene_path: "forest.yaml".into(),
            scene_yaml: "title: Forest\nbars: 8\n".into(),
            scene_schema: serde_json::json!({"type": "object", "properties": {"tempo": {}}}),
            validation: serde_json::json!({"status": "unavailable"}),
            last_diff: None,
            render_meta: None,
            style_pack: None,
            project_memory: String::new(),
            recent_user_intents: vec!["a calm forest scene".into()],
        }
    }

    fn temp_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "scorebench-review-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn recorded_response_streams_and_parses() {
        // Split the recorded fixture into chunks to prove reassembly does
        // not depend on delta boundaries.
        let events = RECORDED_RESPONSE
            .as_bytes()
            .chunks(37)
            .map(|chunk| delta(std::str::from_utf8(chunk).unwrap_or("")))
            .chain(std::iter::once(completed()))
            .collect::<Vec<_>>();
        // Chunking on byte boundaries can split UTF-8; the fixture is ASCII.
        assert!(RECORDED_RESPONSE.is_ascii(), "fixture must stay ASCII");
        let transport = ScriptedTransport::new(vec![Ok(events)]);
        let mut streamed = String::new();
        let report = run_review(
            &transport,
            "fixture prompt".into(),
            &evidence(),
            CancellationToken::new(),
            |event| {
                let ReviewEvent::Delta { text } = event;
                streamed.push_str(&text);
            },
        )
        .await
        .unwrap();
        assert_eq!(streamed, RECORDED_RESPONSE);
        assert_eq!(report.perspectives.len(), 3);
        assert_eq!(report.perspectives[0].role, "composer");
        assert_eq!(report.perspectives[0].severity, "medium");
        assert_eq!(report.tensions.len(), 1);
        assert_eq!(report.tensions[0].between, vec!["composer", "scoring"]);
        assert!(!report.consensus.is_empty());
        assert_eq!(report.suggestions.len(), 2);
        // The recorded fixture lists the medium-priority suggestion first;
        // parse_report must surface the high-priority one on top.
        assert_eq!(report.suggestions[0].priority, "high");
        assert!(report.suggestions[0].text.contains("high-register"));
        assert_eq!(report.suggestions[0].severity, "low");
        assert!(report.suggestions[1].text.contains("bass"));
    }

    #[test]
    fn suggestions_sort_by_priority_with_unlabeled_last() {
        let report = parse_report(
            r#"{
                "perspectives": [{"role": "composer"}],
                "suggestions": [
                    {"text": "unlabeled"},
                    {"text": "low", "priority": "low"},
                    {"text": "high-b", "priority": "high"},
                    {"text": "medium", "priority": "medium"},
                    {"text": "high-a", "priority": "high"}
                ]
            }"#,
        )
        .expect("report parses");
        let order: Vec<&str> = report.suggestions.iter().map(|s| s.text.as_str()).collect();
        // Stable within a tier: high-b stays ahead of high-a.
        assert_eq!(order, ["high-b", "high-a", "medium", "low", "unlabeled"]);
    }

    #[tokio::test]
    async fn non_json_output_is_a_typed_parse_error() {
        let transport = ScriptedTransport::new(vec![Ok(vec![
            delta("I feel this scene is nice but I forgot the format."),
            completed(),
        ])]);
        let error = run_review(
            &transport,
            "fixture".into(),
            &evidence(),
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&error, BenchError::Agent { code, .. } if code == "review_parse"),
            "unexpected error: {error:?}"
        );
    }

    #[tokio::test]
    async fn empty_perspectives_report_is_rejected() {
        let transport = ScriptedTransport::new(vec![Ok(vec![
            delta("```json\n{\"perspectives\": []}\n```"),
            completed(),
        ])]);
        let error = run_review(
            &transport,
            "fixture".into(),
            &evidence(),
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(&error, BenchError::Agent { code, .. } if code == "review_parse"));
    }

    #[tokio::test]
    async fn missing_terminal_event_is_an_llm_error() {
        let transport = ScriptedTransport::new(vec![Ok(vec![delta("partial")])]);
        let error = run_review(
            &transport,
            "fixture".into(),
            &evidence(),
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(error, BenchError::Llm { .. }));
    }

    #[tokio::test]
    async fn truncated_review_names_the_real_cause() {
        let transport = ScriptedTransport::new(vec![Ok(vec![
            delta("{\"perspectives\": [{\"role\": \"comp"),
            ResponseEvent::Incomplete {
                response_id: None,
                reason: Some("max_output_tokens".into()),
            },
        ])]);
        let error = run_review(
            &transport,
            "fixture".into(),
            &evidence(),
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(&error, BenchError::Agent { code, message, .. }
                if code == "review_truncated" && message.contains("max_output_tokens")));
    }

    #[tokio::test]
    async fn transport_failure_propagates() {
        let transport = ScriptedTransport::new(vec![Err(BenchError::llm("endpoint down"))]);
        let error = run_review(
            &transport,
            "fixture".into(),
            &evidence(),
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(matches!(error, BenchError::Llm { .. }));
    }

    #[test]
    fn instructions_cover_selection_language_and_reject_unknowns() {
        let selected = vec!["composer".to_string(), "child".to_string()];
        let prompt = instructions(&selected, "zh").unwrap();
        assert!(prompt.contains("`composer`"));
        assert!(prompt.contains("`child`"));
        assert!(!prompt.contains("`arranger`"));
        assert!(prompt.contains("Simplified Chinese"));
        assert!(prompt.contains("NO audio signal"));
        assert!(prompt.contains("scene_schema"));
        assert!(prompt.contains("style_pack"));
        assert!(prompt.contains("review.criteria"));

        let error = instructions(&["conductor".to_string()], "en").unwrap_err();
        assert!(
            matches!(&error, BenchError::Agent { code, .. } if code == "review_unknown_perspective")
        );
        let error = instructions(&[], "en").unwrap_err();
        assert!(
            matches!(&error, BenchError::Agent { code, .. } if code == "review_no_perspectives")
        );
    }

    #[test]
    fn parse_report_accepts_bare_json_without_fence() {
        let report =
            parse_report(r#"{"perspectives": [{"role": "producer", "headline": "ok"}]}"#).unwrap();
        assert_eq!(report.perspectives[0].role, "producer");
        // Missing optional fields default instead of failing.
        assert!(report.perspectives[0].strengths.is_empty());
        assert!(report.tensions.is_empty());
    }

    #[test]
    fn gather_evidence_tolerates_unbuilt_unchatted_projects() {
        let root = temp_project("evidence");
        std::fs::write(
            root.join("forest.yaml"),
            "title: Forest\ntempo: 84\nbars: 8\n",
        )
        .unwrap();
        let evidence = gather_evidence(&root, "main", "forest.yaml", None).unwrap();
        assert_eq!(evidence.scene_path, "forest.yaml");
        assert!(evidence.scene_yaml.contains("tempo: 84"));
        // Real schema when scorekit is on PATH, honest marker when it is not
        // — either way the reviewer always receives an object.
        assert!(evidence.scene_schema.is_object());
        assert!(evidence.render_meta.is_none());
        assert!(evidence.last_diff.is_none());
        assert!(evidence.style_pack.is_none());
        assert!(evidence.project_memory.is_empty());
        assert!(evidence.recent_user_intents.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gather_evidence_embeds_active_style_pack_criteria() {
        let root = temp_project("style-evidence");
        std::fs::write(root.join("forest.yaml"), "title: Forest\nbars: 8\n").unwrap();
        let pack = crate::styles::builtins()
            .into_iter()
            .find(|pack| pack.id == "epic-new-age-instrumental")
            .unwrap();
        let evidence = gather_evidence(&root, "main", "forest.yaml", Some(&pack)).unwrap();
        let style = evidence.style_pack.unwrap();
        assert_eq!(style["id"], "epic-new-age-instrumental");
        assert_eq!(style["review"]["criteria"][0], "climax_clarity");
        assert_eq!(style["arrangement"]["preferred"][0], "piano");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gather_evidence_collects_recent_user_intents_and_meta() {
        let root = temp_project("intents");
        std::fs::write(root.join("forest.yaml"), "title: Forest\nbars: 8\n").unwrap();
        std::fs::create_dir_all(root.join(project::OUT_DIR)).unwrap();
        std::fs::write(
            root.join(project::OUT_DIR).join("forest.meta.json"),
            r#"{"duration_seconds": 21.5}"#,
        )
        .unwrap();
        let turns = ["first idea", "second idea", "third idea", "fourth idea"]
            .iter()
            .map(|text| InputItem::Message {
                role: InputRole::User,
                content: (*text).into(),
            })
            .collect::<Vec<_>>();
        memory::append_items(&root, "main", &turns).unwrap();
        let evidence = gather_evidence(&root, "main", "forest.yaml", None).unwrap();
        assert_eq!(
            evidence.recent_user_intents,
            vec!["second idea", "third idea", "fourth idea"]
        );
        assert_eq!(
            evidence.render_meta.unwrap()["duration_seconds"],
            serde_json::json!(21.5)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gather_evidence_rejects_paths_outside_the_project() {
        let base = temp_project("containment");
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("outside.yaml"), "title: Outside\n").unwrap();
        let error = gather_evidence(&root, "main", "../outside.yaml", None).unwrap_err();
        assert!(matches!(error, BenchError::InvalidProject { .. }));
        std::fs::remove_dir_all(base).unwrap();
    }
}
