//! PreToolUse is the decision point; every failure denies the call.
use crate::runs::{
    api::{Failure, Result, RunApi},
    helpers::text,
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Mutex};
use tokio_util::sync::CancellationToken;

pub const HOOK_TIMEOUT_SECONDS: u64 = 90_000;
const UNAVAILABLE: &str = "The platform could not take this request, so the call did not run.";
const ABORTED: &str = "The run is ending, so the call did not run.";
pub fn tool_key(name: &str, servers: &[String]) -> String {
    let lower = name.to_lowercase();
    match lower.as_str() {
        "multiedit" => return "edit".into(),
        "webfetch" => return "web_fetch".into(),
        "websearch" => return "web_search".into(),
        "bash" | "edit" | "read" | "run_script" | "run_skill_script" | "web_fetch"
        | "web_search" | "write" => return lower,
        _ => {}
    }
    servers
        .iter()
        .filter_map(|key| {
            name.strip_prefix(&format!("mcp__{key}__"))
                .filter(|suffix| !suffix.is_empty())
                .map(|suffix| (key, suffix))
        })
        .max_by_key(|(key, _)| key.len())
        .map(|(key, suffix)| format!("{key}/{suffix}"))
        .unwrap_or(lower)
}
pub fn approval_summary(name: &str, input: &Value) -> String {
    let mut summary = format!("Use {name}");
    if name.contains('/') {
        summary = format!("Call {name}");
    } else if input.is_object() {
        if name == "a2a_send" && input["peer"].is_string() {
            summary = format!("Send a message to {}", text(&input["peer"]));
        } else if name.eq_ignore_ascii_case("bash") && input["command"].is_string() {
            summary = format!("Run `{}`", text(&input["command"]));
        } else if let Some(detail) = ["file_path", "url", "query"]
            .iter()
            .find_map(|key| input[key].as_str().filter(|s| !s.is_empty()))
        {
            summary = format!("{name} {detail}");
        }
    }
    let summary = regex::Regex::new("[\r\n\u{2028}\u{2029}]+")
        .unwrap()
        .replace_all(&summary, " ")
        .into_owned();
    if summary.encode_utf16().count() > 200 {
        format!(
            "{}…",
            String::from_utf16_lossy(&summary.encode_utf16().take(199).collect::<Vec<_>>())
        )
    } else {
        summary
    }
}
pub fn outcome_text(kind: &str, outcome: &Value) -> Result<Option<String>> {
    if kind == "takeover" {
        let message = match text(&outcome["status"]) {
            "expired" => "Nobody took over the computer in time. Go on without it or stop and say what you need.".into(),
            "cancelled" => "The person cancelled the takeover request. Go on without the computer or stop and say what you need.".into(),
            "answered" if outcome["answer"].is_object() && outcome["answer"].get("decision").is_none() && outcome["answer"].get("answers").is_none() => { let note = text(&outcome["answer"]["note"]);format!("A person took over the computer and handed it back.{}",if note.is_empty(){String::new()}else{format!(" Note: {note}")}) },
            _ => return Err(Failure::local(UNAVAILABLE)),
        };
        return Ok(Some(message));
    }
    let approval = kind == "approval";
    match text(&outcome["status"]) {
        "expired"=>Ok(Some(if approval{"Nobody answered within the time limit, so the call did not run."}else{"Nobody answered the question in time. Go on without it or stop and say what you need."}.into())),
        "cancelled"=>Ok(Some(if approval{"The call was withdrawn because the run is ending."}else{"The question was withdrawn because the run is ending."}.into())),
        "answered" if approval=>match text(&outcome["answer"]["decision"]) {
            "deny"=>{let note=text(&outcome["answer"]["note"]);Ok(Some(format!("A person denied this call.{}",if note.is_empty(){String::new()}else{format!(" {note}")})))},
            "allow_once"|"always_allow"=>Ok(None),_=>Err(Failure::local(UNAVAILABLE))
        },
        "answered"=>outcome["answer"]["answers"].as_object().map(|a|Some(a.iter().map(|(q,a)|format!("Q: {q} A: {}",text(a))).collect::<Vec<_>>().join("\n"))).ok_or_else(||Failure::local(UNAVAILABLE)),
        _=>Err(Failure::local(UNAVAILABLE))
    }
}
pub fn question_answers(input: &Value, answer: &Value) -> Value {
    let mut answers = serde_json::Map::new();
    if let Some(questions) = input["questions"].as_array() {
        for question in questions {
            if let Some(q) = question["question"].as_str()
                && let Some(a) = answer["answers"][q].as_str()
            {
                answers.insert(q.into(), json!(a));
            }
        }
    }
    Value::Object(answers)
}
// Only deliberate gate verdicts may reach Claude as denial reasons. Transport
// errors are always rendered with the platform-unavailable message.
enum Denial {
    Unavailable,
    Reason(String),
}
impl From<Failure> for Denial {
    fn from(_: Failure) -> Self {
        Self::Unavailable
    }
}
pub struct Gate {
    api: RunApi,
    asking: Mutex<HashSet<String>>,
    servers: Vec<String>,
    current: bool,
}
impl Gate {
    pub fn new(api: RunApi, claim: &Value) -> Self {
        Self {
            api,
            asking: Mutex::new(
                claim["toolRules"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
            ),
            servers: claim["mcpServers"]
                .as_object()
                .into_iter()
                .flat_map(|o| o.keys().cloned())
                .collect(),
            current: claim["currentApprovals"] == true,
        }
    }
    async fn retry<T, F, Fut>(&self, cancel: &CancellationToken, mut work: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        for attempt in 0..=10 {
            let result = tokio::select! {_ = cancel.cancelled()=>return Err(Failure::local(ABORTED)),result=work()=>result};
            match result {
                Err(e) if e.transient() && attempt < 10 => {
                    let delay = crate::relay::retry_delay(
                        crate::relay::SocketRole::AgentHost,
                        attempt,
                        false,
                        rand::random(),
                    );
                    tokio::select! {_ = cancel.cancelled()=>return Err(Failure::local(ABORTED)),_=tokio::time::sleep(delay)=>{}}
                }
                other => return other,
            }
        }
        unreachable!()
    }
    async fn decide(
        &self,
        input: &Value,
        cancel: &CancellationToken,
    ) -> std::result::Result<Value, Denial> {
        let name = text(&input["tool_name"]);
        let key = tool_key(name, &self.servers);
        let asks = matches!(name, "AskUserQuestion" | "ask_user");
        let api = self.api.with_cancel(cancel.clone());
        let required = if self.current && !asks {
            let response = api
                .call("needs-approval", Some(&json!({"toolKey":key})))
                .await?;
            response["required"]
                .as_bool()
                .ok_or_else(|| Failure::local(UNAVAILABLE))?
        } else {
            self.asking.lock().unwrap().contains(&key)
        };
        if !asks && !required {
            return Ok(json!({}));
        }
        let empty_input = json!({});
        let tool_input = if input["tool_input"].is_null() {
            &empty_input
        } else {
            &input["tool_input"]
        };
        let display = if asks {
            let questions=tool_input["questions"].as_array().filter(|a|(1..=4).contains(&a.len())).ok_or_else(||Denial::Reason("AskUserQuestion needs one to four questions, each with its text. Ask again with that shape.".into()))?;
            let mut shown = vec![];
            for q in questions {
                let question=q["question"].as_str().filter(|q|!q.is_empty()).ok_or_else(||Denial::Reason("AskUserQuestion needs one to four questions, each with its text. Ask again with that shape.".into()))?;
                let choices = q["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v["label"].as_str().filter(|s| !s.is_empty()))
                    .collect::<Vec<_>>();
                if choices.len() > 6 {
                    return Err(Denial::Unavailable);
                }
                let mut item = json!({"question":question});
                if !choices.is_empty() {
                    item["choices"] = json!(choices);
                }
                if let Some(header) = q["header"].as_str().filter(|s| !s.is_empty()) {
                    item["header"] = json!(header);
                }
                if let Some(multi) = q["multiSelect"].as_bool() {
                    item["multiSelect"] = json!(multi);
                }
                shown.push(item);
            }
            json!({"questions":shown})
        } else {
            let serialized = tool_input.to_string();
            let displayed = if serialized.len() > 8192 {
                json!(format!(
                    "{}… [truncated]",
                    String::from_utf16_lossy(
                        &serialized.encode_utf16().take(1300).collect::<Vec<_>>()
                    )
                ))
            } else {
                tool_input.clone()
            };
            json!({"input":displayed,"summary":approval_summary(if key.contains('/') {&key}else{name},tool_input),"toolKey":key,"toolName":name})
        };
        let kind = if asks { "question" } else { "approval" };
        let body =
            json!({"kind":kind,"toolName":name,"toolUseId":input["tool_use_id"],"display":display});
        let opened = self
            .retry(cancel, || api.call("requests", Some(&body)))
            .await?;
        let mut outcome = opened["outcome"].clone();
        if outcome.is_null() && !opened["requestId"].is_string() {
            return Err(Denial::Unavailable);
        }
        while outcome.is_null() {
            outcome = self
                .retry(cancel, || api.wait(text(&opened["requestId"])))
                .await?["outcome"]
                .clone();
        }
        let reason = outcome_text(kind, &outcome)?;
        let mut result = json!({"hookEventName":"PreToolUse","permissionDecision":"allow"});
        if asks {
            if !outcome["answer"]["answers"].is_object() {
                return Err(Denial::Reason(reason.unwrap_or_else(|| UNAVAILABLE.into())));
            }
            let mut updated = tool_input.clone();
            updated["answers"] = question_answers(tool_input, &outcome["answer"]);
            result["updatedInput"] = updated;
        } else if let Some(reason) = reason {
            return Err(Denial::Reason(reason));
        } else if outcome["answer"]["decision"] == "always_allow" {
            self.asking.lock().unwrap().remove(&key);
        }
        Ok(json!({"hookSpecificOutput":result}))
    }
    pub async fn hook(&self, input: &Value, cancel: CancellationToken) -> Value {
        if input["hook_event_name"] != "PreToolUse" {
            return json!({});
        }
        match self.decide(input, &cancel).await {
            Ok(v) => v,
            Err(denial) => {
                let reason = if cancel.is_cancelled() {
                    ABORTED.to_owned()
                } else {
                    match denial {
                        Denial::Unavailable => UNAVAILABLE.into(),
                        Denial::Reason(reason) => reason,
                    }
                };
                json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}})
            }
        }
    }
}
