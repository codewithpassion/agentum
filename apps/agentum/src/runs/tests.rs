use super::*;
use serde_json::{Value, json};

#[test]
fn golden_normalization_and_completion() {
    let messages: Vec<Value> =
        serde_json::from_str(include_str!("../../testdata/tool-run/sdk-messages.json")).unwrap();
    let batches: Vec<Vec<Value>> =
        serde_json::from_str(include_str!("../../testdata/tool-run/events.json")).unwrap();
    let expected: Vec<Value> = batches.into_iter().flatten().collect();
    let mut actual = vec![];
    for message in &messages {
        for mut event in crate::claude::normalize(message) {
            event["seq"] = json!(actual.len() + 1);
            actual.push(event);
        }
    }
    assert_eq!(actual, expected);
    let complete: Vec<Value> =
        serde_json::from_str(include_str!("../../testdata/tool-run/complete.json")).unwrap();
    assert_eq!(
        crate::claude::completion(messages.last(), None, None, 100),
        complete[0]
    );
}

#[test]
fn normalization_edges_and_completion_states() {
    assert_eq!(
        crate::claude::normalize(
            &json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":" "},{"type":"text","text":""},{"type":"tool_use","id":"x","name":"Bash","input":[]} ]}})
        ),
        vec![
            json!({"type":"message.reasoning","payload":{"text":" "}}),
            json!({"type":"tool.call","payload":{"name":"Bash","toolUseId":"x","input":{}}})
        ]
    );
    let result = json!({"type":"result","subtype":"error_max_turns","session_id":"s","errors":[],"usage":{"input_tokens":-1},"total_cost_usd":0});
    assert_eq!(
        crate::claude::completion(Some(&result), None, None, 12),
        json!({"status":"failed","runtimeRef":"s","error":"Stopped after 12 turns, the agent's limit","stop":{"kind":"turn_limit","limit":12},"usage":{"costUsd":0}})
    );
    assert_eq!(
        crate::claude::completion(None, Some("oops"), Some("s"), 100),
        json!({"status":"failed","error":"oops","runtimeRef":"s"})
    );
}

#[tokio::test]
async fn work_disk_refuses_escapes_and_skips_links() {
    let temp = tempfile::tempdir().unwrap();
    let disk = crate::files::Disk::new(temp.path().into(), None);
    assert!(disk.write("../escape", b"no").await.is_err());
    disk.write("notes/file", b"yes").await.unwrap();
    std::os::unix::fs::symlink("/tmp", temp.path().join("link")).unwrap();
    assert!(disk.write("link/escape", b"no").await.is_err());
    assert_eq!(
        disk.list("").await.unwrap(),
        vec![("dir".into(), "notes".into())]
    );
}

#[derive(Clone, Default)]
struct Server {
    claim_override: Arc<Mutex<Option<Value>>>,
    library: MemoryRemote,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    conflict: Arc<std::sync::atomic::AtomicBool>,
    faults: Arc<Mutex<HashMap<String, u16>>>,
    blocked: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    outcome: Arc<Mutex<Option<Value>>>,
    must_exit: Arc<Mutex<Option<PathBuf>>>,
}
async fn server() -> (String, Server, tokio::task::JoinHandle<()>) {
    use axum::{
        Router,
        extract::{Request, State},
        response::IntoResponse,
        routing::any,
    };
    async fn handle(State(state): State<Server>, request: Request) -> axum::response::Response {
        let uri = request.uri().to_string();
        let method = request.method().clone();
        let headers = request.headers().clone();
        let bytes = axum::body::to_bytes(request.into_body(), 20 << 20)
            .await
            .unwrap();
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        state
            .calls
            .lock()
            .unwrap()
            .push((uri.clone(), body.clone()));
        if uri.ends_with("complete")
            && let Some(path) = state.must_exit.lock().unwrap().as_ref()
        {
            let pid = std::fs::read_to_string(path)
                .unwrap()
                .trim()
                .parse::<i32>()
                .unwrap();
            assert_eq!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
                Err(nix::errno::Errno::ESRCH),
                "completion preceded process exit"
            );
        }
        let blocker = state
            .blocked
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| uri.contains(key.as_str()))
            .map(|(_, n)| n.clone());
        if let Some(blocker) = blocker {
            blocker.notified().await;
        }
        let status = state
            .faults
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| uri.contains(key.as_str()))
            .map(|(_, status)| *status);
        if let Some(status) = status {
            return axum::http::StatusCode::from_u16(status)
                .unwrap()
                .into_response();
        }
        if uri.ends_with("claim") {
            assert_eq!(headers["x-daemon-features"], api::FEATURES);
            assert_eq!(headers["authorization"], "Bearer machine-secret");
            let run = uri.split('/').nth(4).unwrap();
            return axum::Json(
                state
                    .claim_override
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| claim(run)),
            )
            .into_response();
        }
        if uri == "/mcp" {
            if body["id"].is_null() {
                return axum::http::StatusCode::ACCEPTED.into_response();
            }
            let result = match helpers::text(&body["method"]) {
                "initialize" => {
                    json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1"}})
                }
                "tools/list" => {
                    json!({"tools":[{"name":"word","description":"Return the test word","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]})
                }
                "tools/call" => json!({"content":[{"type":"text","text":"RC4-test-heron"}]}),
                _ => json!({}),
            };
            return axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
                .into_response();
        }
        if uri.contains("/library/") {
            use crate::library::Remote;
            let url = url::Url::parse(&format!("http://test{uri}")).unwrap();
            let path = url
                .query_pairs()
                .find(|(k, _)| k == "path")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let route = url.path().rsplit('/').next().unwrap();
            match (method.as_str(), route) {
                ("GET", "stat") => {
                    return axum::Json(json!({"entry":state.library.stat(&path).await.unwrap()}))
                        .into_response();
                }
                ("GET", "list") => {
                    return axum::Json(json!({"entries":state.library.list(&path).await.unwrap()}))
                        .into_response();
                }
                ("GET", "file") => {
                    return match state.library.read(&path).await.unwrap() {
                        Some((bytes, etag)) => ([("X-Library-Etag", etag)], bytes).into_response(),
                        None => axum::http::StatusCode::NOT_FOUND.into_response(),
                    };
                }
                ("PUT", "file") => {
                    return match state
                        .library
                        .write(
                            &path,
                            bytes.to_vec(),
                            headers
                                .get("X-Library-If-Etag")
                                .and_then(|h| h.to_str().ok()),
                        )
                        .await
                        .unwrap()
                    {
                        Some(etag) => axum::Json(json!({"etag":etag})).into_response(),
                        None => axum::http::StatusCode::CONFLICT.into_response(),
                    };
                }
                ("DELETE", "file") => {
                    state.library.remove(&path).await.unwrap();
                    return axum::Json(json!({})).into_response();
                }
                _ => return axum::Json(json!({})).into_response(),
            }
        }
        if uri.starts_with("/files/") {
            return axum::http::StatusCode::NOT_FOUND.into_response();
        }
        if uri.ends_with("heartbeat") && state.conflict.load(std::sync::atomic::Ordering::SeqCst) {
            return (axum::http::StatusCode::CONFLICT, axum::Json(json!({}))).into_response();
        }
        if uri.ends_with("needs-approval") {
            return axum::Json(json!({"required":true})).into_response();
        }
        if uri.ends_with("requests") {
            if let Some(outcome) = state.outcome.lock().unwrap().clone() {
                return axum::Json(json!({"requestId":"q", "outcome":outcome})).into_response();
            }
            return axum::Json(json!({"requestId":"q","status":"pending"})).into_response();
        }
        if uri.contains("requests/q") {
            assert!(uri.ends_with("?wait=25"));
            return axum::Json(json!({"status":"answered","outcome":{"status":"answered","answer":{"decision":"allow_once"}}})).into_response();
        }
        if uri.ends_with("skills") {
            assert_eq!(headers["authorization"], "Bearer run-secret");
            return axum::Json(json!({"files":[]})).into_response();
        }
        axum::Json(json!({})).into_response()
    }
    let state = Server::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    async fn connect(
        State(state): State<Server>,
        upgrade: axum::extract::ws::WebSocketUpgrade,
    ) -> axum::response::Response {
        upgrade.on_upgrade(move |mut socket| async move {
            let Some(Ok(axum::extract::ws::Message::Text(hello))) = socket.recv().await else {
                return;
            };
            let hello: Value = serde_json::from_str(&hello).unwrap();
            state
                .calls
                .lock()
                .unwrap()
                .push(("socket:hello".into(), hello));
            for frame in [
                json!({"type":"hello_ack","machineId":"m","serverTime":"2026-11-05T00:00:00Z"}),
                json!({"type":"offer","agentId":"A","runId":"golden"}),
            ] {
                socket
                    .send(axum::extract::ws::Message::Text(frame.to_string().into()))
                    .await
                    .unwrap();
            }
            while socket.recv().await.is_some() {}
        })
    }
    let app = Router::new()
        .route("/api/machines/connect", axum::routing::get(connect))
        .route("/{*path}", any(handle))
        .with_state(state.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, state, task)
}
fn claim(run: &str) -> Value {
    let input = match run {
        "hold" | "fail" | "controls" | "many" | "cancel-control" => run,
        _ => "go",
    };
    let mut result = json!({"run":{"id":run,"agentId":if run=="other"{"B"}else{"A"},"workspaceId":"WS","sessionId":"s","inputText":input},"agent":{"id":"A","slug":"ada","model":"fake","name":"Ada","runtimeConfig":{}},"session":{"id":"s","runtimeRef":null,"runtimeMachineId":null},"runToken":"run-secret","inputFileIds":[],"instructions":"Be useful","mcpServers":{},"toolRules":["bash"],"currentApprovals":true});
    if run == "subagent" {
        result["run"]["subagentLevel"] = json!(1);
    }
    result
}
fn fake(temp: &std::path::Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let bun = std::process::Command::new("which")
        .arg("bun")
        .output()
        .unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/tool-run/sdk-messages.json");
    let file = temp.join("claude");
    // The wrapper passes the replay file before the driver's flags.
    std::fs::write(
        &file,
        format!(
            "#!/bin/sh\nexec env -u PWD '{}' '{}' '{}' '{}' \"$@\"\n",
            String::from_utf8_lossy(&bun.stdout).trim(),
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/runs/fake-claude.ts")
                .display(),
            fixture.display(),
            temp.join("expected.json").display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
    file.display().to_string()
}
fn host(url: &str, temp: &std::path::Path) -> Host {
    let mut config = Config::new(
        "machine".into(),
        "test".into(),
        url.into(),
        vec![wire::MachineRole::AgentHost],
        false,
        RunAs::Current,
    );
    config.claude_binary = Some(fake(temp));
    Host {
        root: temp.join("work"),
        config,
        credential: "machine-secret".into(),
        user: None,
        state: Arc::new(Mutex::new(State::default())),
        idle: Arc::new(Notify::new()),
    }
}
async fn wait_calls(server: &Server, suffix: &str, count: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if server
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(p, _)| p.ends_with(suffix))
                .count()
                >= count
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn fake_claude_replay_matches_events_and_complete_over_http() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "golden".into());
    wait_calls(&server, "complete", 1).await;
    let calls = server.calls.lock().unwrap();
    let events = calls
        .iter()
        .filter(|(p, _)| p.ends_with("events"))
        .flat_map(|(_, b)| b["events"].as_array().unwrap().clone())
        .collect::<Vec<_>>();
    let expected: Vec<Vec<Value>> =
        serde_json::from_str(include_str!("../../testdata/tool-run/events.json")).unwrap();
    assert_eq!(events, expected.into_iter().flatten().collect::<Vec<_>>());
    let expected: Vec<Value> =
        serde_json::from_str(include_str!("../../testdata/tool-run/complete.json")).unwrap();
    assert_eq!(
        calls
            .iter()
            .find(|(p, _)| p.ends_with("complete"))
            .unwrap()
            .1,
        expected[0]
    );
    task.abort();
}
#[tokio::test]
async fn queue_cancel_deduplicate_parallel_agents_and_failed_completion() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "hold".into());
    host.offer("A".into(), "hold".into());
    host.offer("A".into(), "drop".into());
    host.offer("A".into(), "fail".into());
    host.cancel("drop");
    host.offer("B".into(), "other".into());
    wait_calls(&server, "complete", 1).await;
    assert!(
        !server
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _)| p.contains("/fail/"))
    );
    host.cancel("hold");
    wait_calls(&server, "complete", 3).await;
    let calls = server.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(p, _)| p == "/api/machines/runs/hold/claim")
            .count(),
        1
    );
    assert!(!calls.iter().any(|(p, _)| p.contains("/drop/")));
    assert_eq!(
        calls
            .iter()
            .find(|(p, _)| p == "/api/machines/runs/hold/complete")
            .unwrap()
            .1,
        json!({"status":"aborted"})
    );
    assert_eq!(
        calls
            .iter()
            .find(|(p, _)| p == "/api/machines/runs/fail/complete")
            .unwrap()
            .1["stop"]["kind"],
        "turn_limit"
    );
    task.abort();
}
#[tokio::test]
async fn control_protocol_and_live_approvals_long_poll() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "controls".into());
    wait_calls(&server, "complete", 1).await;
    let calls = server.calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .any(|(p, b)| p.ends_with("needs-approval") && b == &json!({"toolKey":"bash"}))
    );
    assert!(calls.iter().any(|(p, _)| p.ends_with("requests/q?wait=25")));
    assert_eq!(calls.last().unwrap().1["status"], "done");
    task.abort();
}
#[tokio::test]
async fn replacement_cancels_claimed_runs_and_clears_queue() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "hold".into());
    host.offer("A".into(), "drop".into());
    wait_calls(&server, "claim", 1).await;
    host.abort_all(false).await;
    assert_eq!(
        server.calls.lock().unwrap().last().unwrap().1["status"],
        "aborted"
    );
    assert!(host.state.lock().unwrap().known.is_empty());
    host.offer("A".into(), "golden".into());
    wait_calls(&server, "complete", 2).await;
    task.abort();
}

#[test]
fn typescript_helper_parity() {
    use crate::approvals::*;
    let fixture: Value = serde_json::from_str(include_str!("parity.json")).unwrap();
    for case in fixture["keys"].as_array().unwrap() {
        let servers = case["servers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| helpers::text(s).into())
            .collect::<Vec<_>>();
        assert_eq!(
            tool_key(helpers::text(&case["name"]), &servers),
            case["expected"]
        );
    }
    for case in fixture["summaries"].as_array().unwrap() {
        assert_eq!(
            approval_summary(helpers::text(&case["name"]), &case["input"]),
            case["expected"]
        );
    }
    for case in fixture["outcomes"].as_array().unwrap() {
        assert_eq!(
            json!(outcome_text(helpers::text(&case["kind"]), &case["outcome"]).unwrap()),
            case["expected"]
        );
    }
    assert_eq!(
        question_answers(
            &fixture["questions"]["input"],
            &fixture["questions"]["answer"]
        ),
        fixture["questions"]["expected"]
    );
    for case in fixture["turns"].as_array().unwrap() {
        assert_eq!(
            json!(helpers::max_turns(&json!({"maxTurns":case["value"]}))),
            case["expected"]
        );
    }
    assert_eq!(helpers::task_folder("ada", "r"), fixture["taskFolder"]);
    for case in fixture["stops"].as_array().unwrap() {
        assert_eq!(helpers::stop_message(&case["stop"]), case["expected"]);
    }
    let masker = Masker::new(&fixture["masker"]["secrets"]);
    assert_eq!(
        masker.mask(helpers::text(&fixture["masker"]["source"])),
        fixture["masker"]["expected"]
    );
    for case in fixture["prompts"].as_array().unwrap() {
        assert_eq!(
            helpers::workspace_instructions(
                "/work",
                case["library"].is_object().then_some(&case["library"]),
                case["live"] == true,
                "ada",
                "r"
            ),
            case["expected"]
        );
    }
    let env = helpers::agent_env(
        [
            ("HOME", "/home/test"),
            ("CLAUDECODE", "1"),
            ("XDG_API_KEY", "secret"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("CLAUDE_CONFIG_DIR", "/config"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into())),
    );
    assert_eq!(
        env,
        vec![
            ("HOME".into(), "/home/test".into()),
            ("CLAUDE_CONFIG_DIR".into(), "/config".into())
        ]
    );
    assert!(crate::claude::version_ok("2.1.300 (Claude Code)"));
    assert!(!crate::claude::version_ok("2.1.299"));
    assert!(!crate::claude::version_ok("not a version"));
}

#[derive(Clone, Default)]
struct MemoryRemote {
    files: Arc<Mutex<std::collections::BTreeMap<String, (Vec<u8>, String)>>>,
    version: Arc<std::sync::atomic::AtomicUsize>,
}
impl MemoryRemote {
    fn put(&self, path: &str, bytes: &str) {
        let etag = format!(
            "e{}",
            self.version
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1
        );
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), (bytes.as_bytes().to_vec(), etag));
    }
    fn entry(&self, path: &str) -> Option<crate::library::Entry> {
        let files = self.files.lock().unwrap();
        if let Some((bytes, etag)) = files.get(path) {
            Some(crate::library::Entry {
                path: path.into(),
                kind: "file".into(),
                size: bytes.len() as u64,
                etag: Some(etag.clone()),
            })
        } else if files.keys().any(|p| p.starts_with(&format!("{path}/"))) {
            Some(crate::library::Entry {
                path: path.into(),
                kind: "dir".into(),
                size: 0,
                etag: None,
            })
        } else {
            None
        }
    }
}
#[async_trait]
impl crate::library::Remote for MemoryRemote {
    async fn stat(&self, path: &str) -> api::Result<Option<crate::library::Entry>> {
        Ok(self.entry(path))
    }
    async fn list(&self, path: &str) -> api::Result<Vec<crate::library::Entry>> {
        let children = self
            .files
            .lock()
            .unwrap()
            .keys()
            .filter_map(|p| {
                p.strip_prefix(&format!("{path}/"))
                    .map(|s| format!("{path}/{}", s.split('/').next().unwrap()))
            })
            .collect::<std::collections::BTreeSet<_>>();
        Ok(children
            .into_iter()
            .filter_map(|p| self.entry(&p))
            .collect())
    }
    async fn read(&self, path: &str) -> api::Result<Option<(Vec<u8>, String)>> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }
    async fn write(
        &self,
        path: &str,
        bytes: Vec<u8>,
        etag: Option<&str>,
    ) -> api::Result<Option<String>> {
        if let Some(etag) = etag
            && self.entry(path).and_then(|e| e.etag).as_deref() != Some(etag)
        {
            return Ok(None);
        }
        let etag = format!(
            "e{}",
            self.version
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1
        );
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), (bytes, etag.clone()));
        Ok(Some(etag))
    }
    async fn remove(&self, path: &str) -> api::Result<()> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }
    async fn conflict(&self, _: &str, _: &str) -> api::Result<()> {
        Ok(())
    }
}
#[tokio::test]
async fn typescript_library_sync_parity_conflicts_and_read_modes() {
    let fixture: Value = serde_json::from_str(include_str!("parity.json")).unwrap();
    let expected = &fixture["sync"];
    let temp = tempfile::tempdir().unwrap();
    let disk = crate::files::Disk::new(temp.path().into(), None);
    let remote = MemoryRemote::default();
    let roots =
        json!([{"path":"agents/ada","mode":"write"},{"path":"agents/ada/read","mode":"read"}]);
    let mut sync = crate::library::Sync::new(remote.clone(), disk.clone(), roots, "r".into()).await;
    remote.put("agents/ada/note", "initial");
    remote.put("agents/ada/read/file", "truth");
    assert_eq!(sync.sync_in(None).await.unwrap(), expected["initial"]);
    disk.write("library/agents/ada/note", b"local")
        .await
        .unwrap();
    disk.write("library/agents/ada/read/file", b"refused")
        .await
        .unwrap();
    remote.put("agents/ada/note", "remote");
    assert_eq!(sync.sync_in(None).await.unwrap(), expected["pull"]);
    assert_eq!(sync.sync_out().await.unwrap(), expected["push"]);
    for (path, bytes) in expected["local"].as_object().unwrap() {
        assert_eq!(
            String::from_utf8(disk.read(&format!("library/{path}")).await.unwrap()).unwrap(),
            *bytes
        );
    }
    let actual = remote
        .files
        .lock()
        .unwrap()
        .iter()
        .map(|(p, (b, _))| (p.clone(), json!(String::from_utf8(b.clone()).unwrap())))
        .collect::<serde_json::Map<_, _>>();
    assert_eq!(Value::Object(actual), expected["remote"]);
}
#[tokio::test]
async fn library_targeted_pulls_deletes_and_unsent_edits() {
    let temp = tempfile::tempdir().unwrap();
    let disk = crate::files::Disk::new(temp.path().into(), None);
    let remote = MemoryRemote::default();
    let roots = json!([{"path":"a","mode":"write"}]);
    let mut sync = crate::library::Sync::new(remote.clone(), disk.clone(), roots, "r".into()).await;
    remote.put("a/x", "one");
    remote.put("a/y", "two");
    sync.sync_in(None).await.unwrap();
    remote.put("a/x", "new");
    remote.put("a/y", "changed");
    assert_eq!(
        sync.sync_in(Some(&["a/x".into(), "outside".into()]))
            .await
            .unwrap()["pulled"],
        json!(["a/x"])
    );
    assert_eq!(disk.read("library/a/y").await.unwrap(), b"two");
    disk.remove("library/a/x", false).await.unwrap();
    let out = sync.sync_out().await.unwrap();
    assert_eq!(out["deleted"], json!(["a/x"]));
    disk.write("library/a/y", b"unsent").await.unwrap();
    remote.files.lock().unwrap().remove("a/y");
    assert_eq!(sync.sync_in(None).await.unwrap()["kept"], json!(["a/y"]));
    assert_eq!(disk.read("library/a/y").await.unwrap(), b"unsent");
}

#[tokio::test]
async fn api_masking_transient_errors_aborted_409_and_batch_limits() {
    use axum::{Router, extract::Request, response::IntoResponse, routing::any};
    let calls = Arc::new(Mutex::new(vec![]));
    let captured = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/{*path}",
        any(move |req: Request| {
            let calls = captured.clone();
            async move {
                let uri = req.uri().to_string();
                let bytes = axum::body::to_bytes(req.into_body(), 1 << 20)
                    .await
                    .unwrap();
                calls
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&bytes).to_string());
                let status = if uri.ends_with("complete") { 409 } else { 503 };
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    axum::Json(json!({"error":"machine-secret run-secret"})),
                )
                    .into_response()
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let masker =
        Masker::new(&json!({"machine_credential":"machine-secret","run_token":"run-secret"}));
    let api = RunApi::new(
        Http::new(&url, "machine-secret", masker, CancellationToken::new(), 30),
        "r",
    );
    let error = api
        .call(
            "events",
            Some(&json!({"events":[{"payload":{"text":"machine-secret run-secret"}}]})),
        )
        .await
        .unwrap_err();
    assert!(error.transient());
    assert!(!error.message.contains("machine-secret"));
    assert!(!calls.lock().unwrap()[0].contains("run-secret"));
    api.call("complete", Some(&json!({"status":"aborted"})))
        .await
        .unwrap();
    assert_eq!(
        api.call("complete", Some(&json!({"status":"done"})))
            .await
            .unwrap_err()
            .status,
        409
    );
    task.abort();
}

#[tokio::test]
async fn control_cancel_request_fails_closed_and_run_continues() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "cancel-control".into());
    wait_calls(&server, "complete", 1).await;
    assert_eq!(
        server.calls.lock().unwrap().last().unwrap().1["status"],
        "done"
    );
    task.abort();
}
#[tokio::test]
async fn lease_heartbeat_409_aborts_and_reaps_process() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    server
        .conflict
        .store(true, std::sync::atomic::Ordering::SeqCst);
    host.offer("A".into(), "hold".into());
    wait_calls(&server, "skills", 1).await;
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(21)).await;
    tokio::time::resume();
    wait_calls(&server, "complete", 1).await;
    assert_eq!(
        server.calls.lock().unwrap().last().unwrap().1,
        json!({"status":"aborted"})
    );
    host.abort_all(true).await;
    task.abort();
}
#[tokio::test]
async fn approval_gate_invalid_questions_aborts_and_unknown_keys() {
    let (url, _, task) = server().await;
    let api = RunApi::new(
        Http::new(
            &url,
            "machine-secret",
            Masker::default(),
            CancellationToken::new(),
            30,
        ),
        "r",
    );
    let gate = crate::approvals::Gate::new(api, &json!({"toolRules":["bash"],"mcpServers":{}}));
    let invalid=gate.hook(&json!({"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"x","tool_input":{"questions":[]}}),CancellationToken::new()).await;
    assert_eq!(invalid["hookSpecificOutput"]["permissionDecision"], "deny");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let cancelled=gate.hook(&json!({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"x","tool_input":{}}),cancel).await;
    assert_eq!(
        cancelled["hookSpecificOutput"]["permissionDecisionReason"],
        "The run is ending, so the call did not run."
    );
    assert_eq!(
        gate.hook(
            &json!({"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{}}),
            CancellationToken::new()
        )
        .await,
        json!({})
    );
    task.abort();
}
#[test]
fn file_names_and_safe_skill_paths() {
    use crate::files::{filename, safe_path};
    for (header, expected) in [
        (
            "attachment; filename*=UTF-8''..%2Fhello%20world.txt",
            "hello world.txt",
        ),
        ("attachment; filename=../name.txt", "name.txt"),
        ("attachment; filename=..", "file"),
        ("attachment; filename*=UTF-8''%XX; filename=plain", "plain"),
        ("attachment; filename=\"a\\b.txt\"", "b.txt"),
    ] {
        assert_eq!(filename(header), expected);
    }
    for path in ["../x", "/x", "a//b", "a/./b", "a\\b", "a/\n"] {
        assert!(!safe_path(path));
    }
    assert!(safe_path("skill/scripts/run.ts"));
}

#[tokio::test]
async fn library_changed_pulls_and_watcher_pushes_over_library_api() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    let mut offered = claim("hold");
    offered["library"] = json!({"paths":["agents/ada"],"roots":[{"path":"agents/ada","mode":"write"}],"conflicts":[]});
    *server.claim_override.lock().unwrap() = Some(offered);
    server.library.put("agents/ada/note", "initial");
    host.offer("A".into(), "hold".into());
    let file = temp.path().join("work/WS/A/work/library/agents/ada/note");
    async fn file_is(file: &std::path::Path, expected: &[u8]) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if tokio::fs::read(file).await.is_ok_and(|b| b == expected) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    file_is(&file, b"initial").await;
    server.library.put("agents/ada/note", "changed");
    host.state.lock().unwrap().active["A"]
        .changes
        .send(vec!["agents/ada/note".into(), "outside".into()])
        .unwrap();
    file_is(&file, b"changed").await;
    tokio::fs::write(&file, b"agent edit").await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if server
                .library
                .files
                .lock()
                .unwrap()
                .get("agents/ada/note")
                .is_some_and(|(b, _)| b == b"agent edit")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    host.cancel("hold");
    wait_calls(&server, "complete", 1).await;
    task.abort();
}

#[tokio::test]
async fn real_claude_one_tool_conformance_opt_in_only() {
    if std::env::var("AGENTUM_CLAUDE_E2E").as_deref() != Ok("1") {
        eprintln!("Skipped real Claude: AGENTUM_CLAUDE_E2E is not 1");
        return;
    }
    let binary = std::env::var("AGENTUM_CLAUDE_BINARY").unwrap_or_else(|_| "claude".into());
    if !crate::privilege::on_path(&binary) && !std::path::Path::new(&binary).is_file() {
        eprintln!("Skipped real Claude: binary missing");
        return;
    }
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let mut host = host(&url, temp.path());
    host.config.claude_binary = Some(binary);
    let mut offered = claim("real");
    offered["run"]["inputText"] = json!(
        "Call mcp__test__word exactly once, then reply with its returned word. Do not call any other tool."
    );
    offered["agent"]["model"] = json!("haiku");
    offered["mcpServers"] = json!({"test":{"type":"http","url":format!("{url}/mcp"),"headers":{}}});
    *server.claim_override.lock().unwrap() = Some(offered);
    host.offer("A".into(), "real".into());
    tokio::time::timeout(std::time::Duration::from_secs(180), async {
        loop {
            if server
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _)| p.ends_with("complete"))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    let calls = server.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .find(|(p, _)| p.ends_with("complete"))
            .unwrap()
            .1["status"],
        "done"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(p, b)| p == "/mcp" && b["method"] == "tools/call")
            .count(),
        1
    );
    assert!(
        calls
            .iter()
            .filter(|(p, _)| p.ends_with("events"))
            .flat_map(|(_, b)| b["events"].as_array().unwrap())
            .any(|e| e["type"] == "tool.result"
                && e["payload"]["output"]
                    .as_str()
                    .is_some_and(|s| s.contains("RC4-test-heron")))
    );
    task.abort();
}

#[tokio::test]
async fn files_and_skills_use_run_bearer_preserve_bytes_and_stage_writes() {
    use axum::{Router, extract::Request, response::IntoResponse, routing::any};
    let requests = Arc::new(Mutex::new(vec![]));
    let captured = requests.clone();
    let bad = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let refuse = bad.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app=Router::new().route("/{*path}",any(move |req:Request|{let captured=captured.clone();let bad=refuse.clone();async move{
        assert_eq!(req.headers()["authorization"],"Bearer run-secret");let uri=req.uri().to_string();let content_type=req.headers().get("content-type").and_then(|h|h.to_str().ok()).unwrap_or("").to_owned();let bytes=axum::body::to_bytes(req.into_body(),20<<20).await.unwrap();captured.lock().unwrap().push((uri.clone(),content_type,bytes.to_vec()));
        if uri=="/files/fail" {return axum::http::StatusCode::NOT_FOUND.into_response()}
        if uri.starts_with("/files/"){return ([("content-disposition","attachment; filename*=UTF-8''..%2Fdata.bin")],vec![0u8,255,1]).into_response()}
        if uri=="/api/files"{return axum::Json(json!({"id":"uploaded"})).into_response()}
        if uri.ends_with("skills"){return axum::Json(if bad.load(std::sync::atomic::Ordering::SeqCst){json!({"files":[{"path":"good/SKILL.md","size":2},{"path":"../escape","size":2}]})}else{json!({"files":[{"path":"good/SKILL.md","size":2},{"path":"good/code.bin","size":3}]})}).into_response()}
        if uri.contains("skills/file"){return vec![0u8,255].into_response()}
        axum::http::StatusCode::NOT_FOUND.into_response()
    }}));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let http = Http::new(
        &url,
        "run-secret",
        Masker::default(),
        CancellationToken::new(),
        120,
    );
    let (name, bytes) = crate::files::download(&http, "id /?").await.unwrap();
    assert_eq!(name, "data.bin");
    assert_eq!(bytes, vec![0, 255, 1]);
    assert_eq!(
        crate::files::upload(&http, "bytes.bin", bytes)
            .await
            .unwrap(),
        "uploaded"
    );
    let temp = tempfile::tempdir().unwrap();
    let disk = crate::files::Disk::new(temp.path().into(), None);
    assert_eq!(crate::files::skills(&http, "r", &disk).await.unwrap(), 2);
    assert_eq!(
        disk.read(".claude/skills/good/SKILL.md").await.unwrap(),
        vec![0, 255]
    );
    bad.store(true, std::sync::atomic::Ordering::SeqCst);
    let before = requests.lock().unwrap().len();
    assert!(crate::files::skills(&http, "r", &disk).await.is_err());
    assert_eq!(requests.lock().unwrap().len(), before + 1);
    let inbox_temp = tempfile::tempdir().unwrap();
    let inbox = crate::files::Disk::new(inbox_temp.path().into(), None);
    let paths = super::files::input_files(&http, &inbox, &["id1".into(), "id2".into()])
        .await
        .unwrap();
    assert_eq!(paths, vec!["inbox/data.bin", "inbox/id2-data.bin"]);
    assert!(super::files::message_with_files("task", &paths).contains("- inbox/id2-data.bin"));
    let failure_temp = tempfile::tempdir().unwrap();
    let failure_disk = crate::files::Disk::new(failure_temp.path().into(), None);
    assert!(
        super::files::input_files(&http, &failure_disk, &["ok".into(), "fail".into()])
            .await
            .is_err()
    );
    assert!(failure_disk.list("").await.unwrap().is_empty());
    let calls = requests.lock().unwrap();
    assert_eq!(calls[0].0, "/files/id%20%2F%3F");
    assert!(calls[1].1.starts_with("multipart/form-data; boundary="));
    assert!(calls[1].2.windows(3).any(|b| b == [0, 255, 1]));
    task.abort();
}

#[tokio::test]
async fn approval_outcomes_questions_always_allow_and_terminal_failures() {
    use axum::{Router, extract::Request, response::IntoResponse, routing::any};
    for (answer, expected) in [
        (
            json!({"status":"answered","answer":{"decision":"allow_once"}}),
            "allow",
        ),
        (
            json!({"status":"answered","answer":{"decision":"always_allow"}}),
            "allow",
        ),
        (
            json!({"status":"answered","answer":{"decision":"deny","note":"Stop"}}),
            "deny",
        ),
        (json!({"status":"expired"}), "deny"),
        (json!({"status":"cancelled"}), "deny"),
        (json!({"status":"answered","answer":{"wrong":true}}), "deny"),
    ] {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let outcome = answer.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/{*path}",
            any(move |request: Request| {
                let count = count.clone();
                let outcome = outcome.clone();
                async move {
                    let bytes = axum::body::to_bytes(request.into_body(), 20 << 20)
                        .await
                        .unwrap();
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(body["kind"], "approval");
                    assert!(
                        body["display"]["input"]
                            .as_str()
                            .is_some_and(|s| s.ends_with("… [truncated]"))
                    );
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    axum::Json(
                        json!({"requestId":"q","status":outcome["status"],"outcome":outcome}),
                    )
                    .into_response()
                }
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let api = RunApi::new(
            Http::new(
                &url,
                "machine-secret",
                Masker::default(),
                CancellationToken::new(),
                30,
            ),
            "r",
        );
        let gate = crate::approvals::Gate::new(api, &json!({"toolRules":["bash"],"mcpServers":{}}));
        let input = json!({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t","tool_input":{"command":"a".repeat(10_000)}});
        assert_eq!(
            gate.hook(&input, CancellationToken::new()).await["hookSpecificOutput"]["permissionDecision"],
            expected
        );
        if answer["answer"]["decision"] == "always_allow" {
            assert_eq!(gate.hook(&input, CancellationToken::new()).await, json!({}));
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
        task.abort();
    }
}

#[tokio::test]
async fn questions_filter_answers_and_fail_closed_on_bad_http() {
    use axum::{Router, extract::Request, response::IntoResponse, routing::any};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app=Router::new().route("/{*path}",any(|req:Request|async move {
        let bytes=axum::body::to_bytes(req.into_body(),20<<20).await.unwrap();let body:Value=serde_json::from_slice(&bytes).unwrap();
        if body["kind"]=="question" {assert_eq!(body["display"],json!({"questions":[{"question":"Pick?","header":"Choice","multiSelect":true,"choices":["a","b"]}]}));axum::Json(json!({"requestId":"q","status":"answered","outcome":{"status":"answered","answer":{"answers":{"Pick?":"a, b, free text","Not asked":"drop"}}}})).into_response()}
        else {(axum::http::StatusCode::FORBIDDEN,"refused").into_response()}
    }));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let api = RunApi::new(
        Http::new(
            &url,
            "machine-secret",
            Masker::default(),
            CancellationToken::new(),
            30,
        ),
        "r",
    );
    let gate = crate::approvals::Gate::new(api, &json!({"toolRules":["bash"],"mcpServers":{}}));
    let input = json!({"questions":[{"question":"Pick?","header":"Choice","multiSelect":true,"options":[{"label":"a"},{"label":"b"},{"label":""}]}]});
    let result=gate.hook(&json!({"hook_event_name":"PreToolUse","tool_name":"ask_user","tool_use_id":"t","tool_input":input}),CancellationToken::new()).await;
    assert_eq!(
        result["hookSpecificOutput"]["updatedInput"]["answers"],
        json!({"Pick?":"a, b, free text"})
    );
    let denied=gate.hook(&json!({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t","tool_input":{}}),CancellationToken::new()).await;
    assert_eq!(denied["hookSpecificOutput"]["permissionDecision"], "deny");
    task.abort();
}

#[tokio::test]
async fn event_batches_cap_at_100_and_keep_sequence_across_batches() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "many".into());
    wait_calls(&server, "complete", 1).await;
    let calls = server.calls.lock().unwrap();
    let batches = calls
        .iter()
        .filter(|(p, _)| p.ends_with("events"))
        .map(|(_, b)| b["events"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert!(batches.len() >= 3);
    assert!(batches.iter().all(|b| b.len() <= 100));
    let events = batches.into_iter().flatten().collect::<Vec<_>>();
    assert_eq!(events.len(), 205);
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event["seq"], index + 1);
    }
    task.abort();
}

#[tokio::test]
async fn library_new_local_files_read_only_ties_size_caps_and_delete_races() {
    let temp = tempfile::tempdir().unwrap();
    let disk = crate::files::Disk::new(temp.path().into(), None);
    let remote = MemoryRemote::default();
    let roots = json!([{"path":"a","mode":"write"},{"path":"a/read","mode":"write"},{"path":"a/read","mode":"read"}]);
    assert_eq!(crate::library::mode("a/read/f", &roots), Some("read"));
    let mut sync = crate::library::Sync::new(remote.clone(), disk.clone(), roots, "r".into()).await;
    remote.put("a/keep", "base");
    remote.put("a/remove", "base");
    sync.sync_in(None).await.unwrap();
    disk.remove("library/a/keep", false).await.unwrap();
    disk.remove("library/a/remove", false).await.unwrap();
    remote.put("a/keep", "changed");
    disk.write("library/a/new", b"new").await.unwrap();
    disk.write("library/a/read/refused", b"read edit")
        .await
        .unwrap();
    disk.write(
        "library/a/big",
        &vec![0; crate::library::MAX_FILE_BYTES as usize + 1],
    )
    .await
    .unwrap();
    let out = sync.sync_out().await.unwrap();
    assert_eq!(out["deleteSkipped"], json!(["a/keep"]));
    assert_eq!(out["deleted"], json!(["a/remove"]));
    assert_eq!(out["written"], json!(["a/new"]));
    assert_eq!(out["refused"], json!(["a/read/refused"]));
    assert_eq!(out["skipped"], json!(["a/big"]));
    assert_eq!(
        remote.files.lock().unwrap().get("a/keep").unwrap().0,
        b"changed"
    );
}

#[test]
fn prerequisites_probe_only_fake_binary_and_check_only_version() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let mut config = Config::new(
        "m".into(),
        "test".into(),
        "http://localhost".into(),
        vec![wire::MachineRole::AgentHost],
        false,
        RunAs::Current,
    );
    config.claude_binary = Some(temp.path().join("missing").display().to_string());
    assert_eq!(
        crate::claude::prerequisites(&config, None, "test")
            .unwrap_err()
            .code,
        5
    );
    let file = temp.path().join("probe");
    config.claude_binary = Some(file.display().to_string());
    for (version, _logged, expected) in [
        ("2.1.299", true, "claude update"),
        ("2.1.300", false, "ok"),
        ("2.1.310", true, "ok"),
    ] {
        std::fs::write(&file,format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version} (Claude Code)'; else exit 42; fi\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = crate::claude::prerequisites(&config, None, "test");
        if expected == "ok" {
            assert_eq!(result.unwrap(), version);
        } else {
            let error = result.unwrap_err();
            assert!(error.message.contains(expected), "{version}: {error}");
        }
    }
}

#[tokio::test]
async fn relay_offer_reaches_role_executor_and_hello_advertises_cli_features() {
    let (url, server, server_task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    let role: Arc<dyn Role> = Arc::new(AgentHost {
        instance: "test".into(),
        paths: Paths::new(temp.path().join("config"), temp.path().join("state"), false),
        state_file: temp.path().join("connection.json"),
        host,
        load_error: None,
        claude_version: Mutex::new("2.1.310".into()),
    });
    let stop = CancellationToken::new();
    let cancel = stop.clone();
    let relay = tokio::spawn(async move {
        crate::relay::run(
            role,
            &url,
            "machine-secret",
            cancel,
            crate::relay::Timing::default(),
        )
        .await
    });
    wait_calls(&server, "complete", 1).await;
    stop.cancel();
    relay.await.unwrap().unwrap();
    let calls = server.calls.lock().unwrap();
    let hello = &calls.iter().find(|(p, _)| p == "socket:hello").unwrap().1;
    assert_eq!(hello["capabilities"]["agentSdk"], "claude-cli@2.1.310");
    assert_eq!(
        hello["features"],
        json!([
            "library-sync",
            "requests",
            "library-live",
            "current-approvals",
            "parallel-subagents"
        ])
    );
    server_task.abort();
}
#[test]
fn sudo_claude_command_uses_instance_user_and_cwd_and_only_environment_names() {
    let command = crate::privilege::agent::claude_command(
        "/usr/local/bin/claude",
        Some("agentum-office"),
        Some(std::path::Path::new("/var/lib/agentum/office/agent/work")),
        &["API_KEY".into(), "CLAUDE_CODE_ENTRYPOINT".into()],
    );
    assert_eq!(command.get_program(), "sudo");
    assert_eq!(command.get_current_dir(), Some(std::path::Path::new("/")));
    assert_eq!(
        command
            .get_args()
            .map(|s| s.to_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "-n",
            "-u",
            "agentum-office",
            "-H",
            "--preserve-env=API_KEY,CLAUDE_CODE_ENTRYPOINT",
            "-D",
            "/var/lib/agentum/office/agent/work",
            "/usr/local/bin/claude"
        ]
    );
}

#[path = "review_tests.rs"]
mod review;

#[tokio::test]
async fn subagent_runs_while_parent_is_live_in_its_own_directory() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    host.offer("A".into(), "hold".into());
    wait_calls(&server, "claim", 1).await;
    host.offer_subagent("A".into(), "subagent".into());
    wait_calls(&server, "complete", 1).await;
    assert!(host.state.lock().unwrap().active.contains_key("A"));
    assert!(temp.path().join("work/WS/A/subagents/s/work/pid").exists());
    assert!(
        server
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _)| p == "/api/machines/runs/subagent/complete")
    );
    host.abort_all(false).await;
    task.abort();
}
