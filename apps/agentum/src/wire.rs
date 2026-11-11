//! Read-side envelopes retain opaque payloads until the role's handler interprets them.
//! Send-side types have explicit fields: never flatten extra keys into a hello or enrol body.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MachineRole {
    AgentHost,
    Computer,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum Document {
    Object(Envelope),
    Batch(Vec<Document>),
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Envelope {
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollRequest {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<MachineRole>>,
    pub single_user: bool,
    pub arch: String,
    pub os: String,
    pub hostname: String,
    pub client_version: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub credential: String,
    pub machine_id: String,
    pub machine_name: String,
    pub roles: Vec<MachineRole>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHello {
    pub r#type: String,
    pub agents: Vec<String>,
    pub capabilities: DaemonCapabilities,
    pub daemon_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<String>>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonCapabilities {
    pub agent_sdk: String,
    pub container: bool,
}
#[derive(Deserialize, Serialize)]
pub struct ComputerHello {
    pub r#type: String,
    pub protocol_version: u8,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub version: String,
    pub run_as_user: String,
    pub workdir: String,
    pub capabilities: ComputerCapabilities,
}
#[derive(Deserialize, Serialize)]
pub struct ComputerCapabilities {
    pub python3: bool,
    pub git: bool,
    pub skills: bool,
    pub desktop: bool,
    /// The typed agent-desktop ops are on: the desktop runs and `allow_apps` names an app.
    /// Sent only when on, so a client without the opt-in says what it always said.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent_desktop: bool,
    pub desktop_unavailable_reason: Option<String>,
}
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}
pub fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}
pub fn hostname() -> String {
    nix::unistd::gethostname()
        .ok()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".into())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEnrollRequest {
    pub code: String,
    pub single_user: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEnrollResponse {
    pub machine_id: String,
    pub credential: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerEnrollRequest {
    pub code: String,
    pub arch: String,
    pub os: String,
    pub hostname: String,
    pub client_version: String,
    pub role: String,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayFrame {
    #[serde(rename_all = "camelCase")]
    HelloAck {
        machine_id: String,
        server_time: String,
    },
    #[serde(rename_all = "camelCase")]
    Offer {
        agent_id: String,
        run_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Cancel {
        run_id: String,
    },
    LibraryChanged {
        paths: Vec<String>,
    },
    #[serde(other)]
    Unknown,
}
#[derive(Deserialize, Serialize)]
pub struct Ping {
    pub r#type: String,
    pub at: String,
}
#[derive(Deserialize, Serialize)]
pub struct EventsRequest {
    pub events: Vec<RunEvent>,
}
#[derive(Deserialize, Serialize)]
pub struct RunEvent {
    pub seq: u64,
    pub r#type: String,
    pub payload: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsResponse {
    pub last_seq: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRequest {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub run: ClaimedRun,
    pub agent: ClaimedAgent,
    pub session: ClaimedSession,
    pub run_token: String,
    pub mcp_servers: std::collections::BTreeMap<String, Value>,
    pub input_file_ids: Vec<String>,
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_rules: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_approvals: Option<bool>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedRun {
    pub id: String,
    pub session_id: String,
    pub agent_id: String,
    pub input_text: String,
    pub workspace_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedAgent {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub model: String,
    pub runtime_config: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedSession {
    pub id: String,
    pub runtime_ref: Option<String>,
    pub runtime_machine_id: Option<String>,
}
#[derive(Deserialize, Serialize)]
pub struct Empty {}
#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ComputerRequest {
    Exec {
        id: String,
        command: String,
        cwd: Option<String>,
        env: std::collections::BTreeMap<String, String>,
        timeout_ms: u64,
    },
    Cancel {
        id: String,
        target_id: String,
    },
    FilePut {
        id: String,
        transfer_id: String,
        path: String,
        seq: u64,
        data_b64: String,
        r#final: bool,
        sha256: Option<String>,
    },
    FileGet {
        id: String,
        path: String,
        offset: u64,
        max_bytes: u64,
    },
    DesktopScreenshot {
        id: String,
        quality: Option<u8>,
    },
    DesktopInput {
        id: String,
        actions: Vec<DesktopAction>,
    },
    DesktopClipboardGet {
        id: String,
    },
    DesktopClipboardSet {
        id: String,
        text: String,
        selections: Vec<String>,
    },
    #[serde(other)]
    Unknown,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopAction {
    MouseMove {
        x: i32,
        y: i32,
    },
    MouseDown {
        button: String,
    },
    MouseUp {
        button: String,
    },
    Click {
        x: i32,
        y: i32,
        button: String,
        count: u32,
    },
    Scroll {
        x: i32,
        y: i32,
        dx: i32,
        dy: i32,
    },
    Key {
        keys: String,
    },
    Type {
        text: String,
    },
    #[serde(other)]
    Unknown,
}
#[derive(Deserialize, Serialize)]
pub struct ComputerReply {
    pub id: String,
    #[serde(flatten)]
    pub outcome: ComputerOutcome,
}
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum ComputerOutcome {
    Result { result: ComputerResult },
    Error { error: ComputerError },
}
#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum ComputerResult {
    Exec {
        exit_code: i32,
        stdout: String,
        stderr: String,
        bytes_total: u64,
        truncated: bool,
        duration_ms: u64,
    },
    FilePut {
        bytes_written: u64,
        sha256: Option<String>,
    },
    FileGet {
        data_b64: String,
        eof: bool,
        size: u64,
        sha256: Option<String>,
    },
    Screenshot {
        data_b64: String,
        width: u32,
        height: u32,
        media_type: String,
    },
    Cancel {
        cancelled: bool,
    },
    Text {
        text: String,
    },
    Ok {
        ok: bool,
    },
}
#[derive(Deserialize, Serialize)]
pub struct ComputerError {
    pub code: String,
    pub message: String,
}
#[derive(Deserialize, Serialize)]
pub struct ErrorCodes {
    pub comment: String,
    pub codes: Vec<String>,
}

pub fn daemon_hello(version: &str, claude_version: &str) -> DaemonHello {
    DaemonHello {
        r#type: "hello".into(),
        agents: vec![],
        daemon_version: version.into(),
        capabilities: DaemonCapabilities {
            agent_sdk: format!("claude-cli@{claude_version}"),
            container: false,
        },
        features: Some(
            [
                "library-sync",
                "requests",
                "library-live",
                "current-approvals",
                "parallel-subagents",
            ]
            .map(String::from)
            .to_vec(),
        ),
    }
}
