use super::*;
use crate::{
    claude::{self, Driver},
    files::Disk,
};
use std::{os::unix::fs::PermissionsExt, time::Duration};

#[tokio::test]
async fn symlinked_ancestor_and_state_root_allow_work_but_not_child_links() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("real")).unwrap();
    std::os::unix::fs::symlink(temp.path().join("real"), temp.path().join("home")).unwrap();
    let disk = Disk::new(temp.path().join("home/state/work"), None);
    disk.write("notes/file", b"yes").await.unwrap();
    assert_eq!(disk.read("notes/file").await.unwrap(), b"yes");
    std::os::unix::fs::symlink(temp.path(), disk.root.join("link")).unwrap();
    assert!(disk.read("link/no").await.is_err());
}

fn script(temp: &std::path::Path, source: &str) -> String {
    let path = temp.join("fake");
    std::fs::write(&path, format!("#!/bin/sh\n{source}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path.display().to_string()
}

#[test]
fn test_build_refuses_path_lookup_for_claude() {
    assert!(claude::probe("claude", None, &["--version"]).is_err());
}

#[tokio::test]
async fn result_closes_input_drains_output_and_waits_for_exit() {
    let temp = tempfile::tempdir().unwrap();
    let binary = script(
        temp.path(),
        r#"
read init
printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"initialize"}}'
read mcp
printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"mcp"}}'
read user
printf '%s\n' '{"type":"result","subtype":"success","session_id":"s","result":"ok"}'
# stdin must close before the final output. Keep stdout larger than its pipe buffer.
cat >/dev/null
sleep 0.25
i=0
while [ "$i" -lt 1000 ]; do
 printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"after result"}]}}'
 i=$((i+1))
done
# EOF can precede exit: the clean-exit grace still applies.
exec 1>&-
sleep 0.25
touch exited
"#,
    );
    let disk = Disk::new(temp.path().into(), None);
    let c = claim("r");
    let (events, mut receive) = mpsc::channel(16);
    let drain = tokio::spawn(async move {
        let mut count = 0;
        while receive.recv().await.is_some() {
            count += 1;
        }
        count
    });
    let body = claude::drive(Driver {
        binary: &binary,
        disk: &disk,
        claim: &c,
        machine: "machine",
        prompt: "prompt".into(),
        message: "go".into(),
        gate: None,
        cancel: CancellationToken::new(),
        events,
    })
    .await
    .unwrap();
    assert_eq!(body["status"], "done");
    assert!(temp.path().join("exited").exists());
    assert_eq!(drain.await.unwrap(), 1000);
}

#[tokio::test]
async fn spawn_failure_and_missing_input_name_the_failure() {
    for missing_file in [false, true] {
        let (url, server, task) = server().await;
        let temp = tempfile::tempdir().unwrap();
        let mut host = host(&url, temp.path());
        let mut c = claim("r");
        if missing_file {
            c["inputFileIds"] = json!(["missing-file-id"]);
        } else {
            host.config.claude_binary = Some(temp.path().join("absent").display().to_string());
        }
        *server.claim_override.lock().unwrap() = Some(c);
        host.offer("A".into(), "r".into());
        wait_calls(&server, "complete", 1).await;
        let calls = server.calls.lock().unwrap();
        let body = &calls
            .iter()
            .find(|(p, _)| p.ends_with("complete"))
            .unwrap()
            .1;
        assert_eq!(body["status"], "failed");
        assert!(helpers::text(&body["error"]).contains(if missing_file {
            "missing-file-id"
        } else {
            "Cannot start claude"
        }));
        assert!(body.get("stop").is_none());
        task.abort();
    }
}

#[tokio::test]
async fn replacement_returns_before_run_teardown() {
    let (url, _, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    let cancel = CancellationToken::new();
    let (changes, _) = mpsc::unbounded_channel();
    host.state.lock().unwrap().active.insert(
        "A".into(),
        Slot {
            run: "r".into(),
            cancel: cancel.clone(),
            changes,
        },
    );
    let role = AgentHost {
        instance: "test".into(),
        paths: crate::instance::Paths::new(
            temp.path().join("config"),
            temp.path().join("state"),
            false,
        ),
        state_file: temp.path().join("connection"),
        host,
        load_error: None,
        claude_version: Mutex::new("fake".into()),
    };
    tokio::time::timeout(
        Duration::from_millis(100),
        role.shutdown(Shutdown::Replaced),
    )
    .await
    .unwrap();
    assert!(cancel.is_cancelled());
    task.abort();
}

fn expected(temp: &std::path::Path, value: &Value) {
    std::fs::write(temp.join("expected.json"), value.to_string()).unwrap();
}
fn complete(server: &Server) -> Value {
    server
        .calls
        .lock()
        .unwrap()
        .iter()
        .find(|(p, _)| p.ends_with("complete"))
        .unwrap()
        .1
        .clone()
}
async fn wait_file(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn assert_reaped(path: &std::path::Path) {
    let pid = std::fs::read_to_string(path)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
        Err(nix::errno::Errno::ESRCH)
    );
}

#[tokio::test]
async fn completion_is_once_after_exit_and_timers_stop() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    expected(temp.path(), &json!({"mode":"completion-delay"}));
    *server.must_exit.lock().unwrap() = Some(host.root.join("WS/A/work/pid"));
    host.offer("A".into(), "golden".into());
    wait_calls(&server, "complete", 1).await;
    assert_reaped(&host.root.join("WS/A/work/pid"));
    let count = server.calls.lock().unwrap().len();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(601)).await;
    tokio::time::resume();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(server.calls.lock().unwrap().len(), count);
    assert_eq!(
        server
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p.ends_with("complete"))
            .count(),
        1
    );
    task.abort();
}

#[tokio::test]
async fn argv_env_cwd_budget_turns_resume_and_secrets_match_daemon() {
    for same in [None, Some(true), Some(false)] {
        let (url, server, task) = server().await;
        let temp = tempfile::tempdir().unwrap();
        let host = host(&url, temp.path());
        let cwd = host.root.join("WS/A/work");
        let mut c = claim("r");
        let configured = same.is_some();
        if configured {
            c["agent"]["runtimeConfig"] = json!({"maxTurns":12,"maxBudgetUsd":1.25});
        }
        if let Some(same) = same {
            c["session"] = json!({"runtimeMachineId":if same {"machine"} else {"elsewhere"},"runtimeRef":"resume-me"});
        }
        let secrets = json!({"API_KEY":"agent-key-unique", "XDG_SECRET":"agent-secret-unique", "PASSWORD":"agent-password-unique"});
        c["env"] = secrets.clone();
        let mut argv = vec![
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--thinking",
            "adaptive",
            "--thinking-display",
            "summarized",
            "--max-turns",
            if configured { "12" } else { "100" },
            "--model",
            "fake",
            "--setting-sources=project",
            "--strict-mcp-config",
            "--permission-mode",
            "bypassPermissions",
            "--allow-dangerously-skip-permissions",
            "--permission-prompt-tool",
            "stdio",
        ];
        if configured {
            argv.extend(["--max-budget-usd", "1.25"]);
        }
        if same == Some(true) {
            argv.extend(["--resume", "resume-me"]);
        }
        let mut env = helpers::agent_env(std::env::vars())
            .into_iter()
            .map(|(k, v)| (k, json!(v)))
            .collect::<serde_json::Map<String, Value>>();
        env.insert("CLAUDE_CODE_ENTRYPOINT".into(), json!("sdk-ts"));
        for (k, v) in secrets.as_object().unwrap() {
            env.insert(k.clone(), v.clone());
        }
        expected(
            temp.path(),
            &json!({"argv":argv,"env":env,"cwd":cwd,"mode":"secrets","secrets":secrets}),
        );
        *server.claim_override.lock().unwrap() = Some(c);
        host.offer("A".into(), "r".into());
        wait_calls(&server, "complete", 1).await;
        assert_eq!(complete(&server)["status"], "done", "{}", complete(&server));
        let calls = server.calls.lock().unwrap();
        let serialized = serde_json::to_string(&*calls).unwrap();
        for (name, secret) in secrets.as_object().unwrap() {
            assert!(!serialized.contains(secret.as_str().unwrap()));
            assert!(serialized.contains(&format!("[secret:{name}]")));
        }
        task.abort();
    }
}

#[tokio::test]
async fn mcp_warning_elicitation_error_session_and_masked_stderr() {
    for mode in ["mcp-error", "elicitation", "plain-error", "stderr"] {
        let (url, server, task) = server().await;
        let temp = tempfile::tempdir().unwrap();
        let host = host(&url, temp.path());
        expected(
            temp.path(),
            &json!({"mode":mode,"mcpError": mode == "mcp-error"}),
        );
        host.offer("A".into(), "golden".into());
        wait_calls(&server, "complete", 1).await;
        let body = complete(&server);
        assert!(body.get("stop").is_none());
        match mode {
            "plain-error" => {
                assert_eq!(body["status"], "failed");
                assert_eq!(body["runtimeRef"], "kept");
                assert_eq!(body["error"], "plain error");
            }
            "stderr" => {
                assert_eq!(body["status"], "failed");
                assert!(helpers::text(&body["error"]).contains("[secret:run_token]"));
                assert!(!body.to_string().contains("run-secret"));
            }
            _ => assert_eq!(body["status"], "done", "{body}"),
        }
        task.abort();
    }
}

#[tokio::test]
async fn abort_during_mcp_handover_reaps_and_completes() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    expected(temp.path(), &json!({"holdMcp":true}));
    host.offer("A".into(), "golden".into());
    let pid = host.root.join("WS/A/work/pid");
    wait_file(&host.root.join("WS/A/work/mcp-wait")).await;
    host.cancel("golden");
    wait_calls(&server, "complete", 1).await;
    assert_eq!(complete(&server), json!({"status":"aborted"}));
    assert_reaped(&pid);
    task.abort();
}

#[tokio::test]
async fn no_rules_skips_hook_empty_rules_still_asks_and_waiting_gate_keeps_timers() {
    for mode in ["no-rules", "question", "waiting"] {
        let (url, server, task) = server().await;
        let temp = tempfile::tempdir().unwrap();
        let host = host(&url, temp.path());
        let mut c = claim("r");
        c["currentApprovals"] = json!(false);
        c["toolRules"] = if mode == "waiting" {
            json!(["bash"])
        } else {
            json!([])
        };
        if mode == "no-rules" {
            c.as_object_mut().unwrap().remove("toolRules");
        }
        if mode == "question" {
            *server.outcome.lock().unwrap() =
                Some(json!({"status":"answered","answer":{"answers":{"Pick?":"yes"}}}));
        }
        if mode == "waiting" {
            server
                .blocked
                .lock()
                .unwrap()
                .insert("requests/q".into(), Arc::new(Notify::new()));
        }
        *server.claim_override.lock().unwrap() = Some(c);
        expected(temp.path(), &json!({"mode":mode}));
        host.offer("A".into(), "r".into());
        if mode == "waiting" {
            wait_calls(&server, "requests/q?wait=25", 1).await;
            wait_calls(&server, "events", 1).await;
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(21)).await;
            tokio::time::resume();
            wait_calls(&server, "heartbeat", 1).await;
            host.cancel("r");
        }
        wait_calls(&server, "complete", 1).await;
        if mode == "waiting" {
            assert_eq!(
                complete(&server)["status"],
                "aborted",
                "mode={mode}: {}",
                complete(&server)
            );
            let verdict = std::fs::read_to_string(host.root.join("WS/A/work/verdict")).unwrap();
            assert!(verdict.contains("deny"));
        } else {
            assert_eq!(complete(&server)["status"], "done", "{}", complete(&server));
        }
        if mode == "no-rules" {
            assert!(
                !server
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(p, _)| p.contains("requests"))
            );
        }
        task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn version_probe_times_out_without_stalling_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let binary = script(temp.path(), "exec sleep 60");
    let started = std::time::Instant::now();
    let probe = tokio::spawn(async move { claude::probe(&binary, None, &["--version"]) });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        probe.await.unwrap().unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
    assert!(started.elapsed() >= Duration::from_secs(5));
    assert!(started.elapsed() < Duration::from_secs(7));
}

#[tokio::test]
async fn abort_escalates_to_kill_and_reaps_whole_group() {
    let temp = tempfile::tempdir().unwrap();
    let binary = script(
        temp.path(),
        "trap '' TERM\necho $$ > pid\nsleep 60 &\necho $! > descendant\nwait",
    );
    let disk = Disk::new(temp.path().into(), None);
    let c = claim("r");
    let (events, _receive) = mpsc::channel(16);
    let cancel = CancellationToken::new();
    let end = cancel.clone();
    let root = temp.path().to_owned();
    let killer = tokio::spawn(async move {
        wait_file(&root.join("descendant")).await;
        end.cancel();
        std::time::Instant::now()
    });
    let body = claude::drive(Driver {
        binary: &binary,
        disk: &disk,
        claim: &c,
        machine: "machine",
        prompt: "prompt".into(),
        message: "go".into(),
        gate: None,
        cancel,
        events,
    })
    .await
    .unwrap();
    assert_eq!(body["status"], "aborted");
    let elapsed = killer.await.unwrap().elapsed();
    assert!(elapsed >= Duration::from_secs(5));
    assert!(elapsed < Duration::from_secs(7));
    assert_reaped(&temp.path().join("pid"));
    let descendant = std::fs::read_to_string(temp.path().join("descendant")).unwrap();
    // An adopted zombie has exited too; this host's PID 1 may reap it later.
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", descendant.trim())) {
        assert_eq!(stat.split_whitespace().nth(2), Some("Z"));
    }
}

#[tokio::test]
async fn approval_preview_counts_utf16_and_does_not_trust_error_prefixes() {
    let (url, server, task) = server().await;
    *server.outcome.lock().unwrap() =
        Some(json!({"status":"answered","answer":{"decision":"deny","note":"Stop now"}}));
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
    let gate = crate::approvals::Gate::new(api, &json!({"toolRules":["bash"]}));
    let result = gate.hook(&json!({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"😀".repeat(3000)}}), CancellationToken::new()).await;
    assert_eq!(
        result["hookSpecificOutput"]["permissionDecisionReason"],
        "A person denied this call. Stop now"
    );
    let calls = server.calls.lock().unwrap();
    let display = &calls
        .iter()
        .find(|(p, _)| p.ends_with("requests"))
        .unwrap()
        .1["display"]["input"];
    let preview = helpers::text(display)
        .strip_suffix("… [truncated]")
        .unwrap();
    assert_eq!(preview.encode_utf16().count(), 1300);
    drop(calls);
    // A transport error that starts with a policy-looking phrase is never a verdict.
    server.faults.lock().unwrap().insert("requests".into(), 403);
    let denied = gate
        .hook(
            &json!({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{}}),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(
        denied["hookSpecificOutput"]["permissionDecisionReason"],
        "The platform could not take this request, so the call did not run."
    );
    task.abort();
}

#[tokio::test]
async fn library_abort_checkpoint_failure_and_late_announcements() {
    for mode in ["aborted", "checkpoint", "failed-in", "late"] {
        let (url, server, task) = server().await;
        let temp = tempfile::tempdir().unwrap();
        let host = host(&url, temp.path());
        let mut c = claim("hold");
        c["library"] = json!({"roots":[{"path":"agents/ada","mode":"write"}]});
        if mode == "failed-in" {
            server
                .faults
                .lock()
                .unwrap()
                .insert("/library/".into(), 503);
        }
        *server.claim_override.lock().unwrap() = Some(c);
        host.offer("A".into(), "hold".into());
        let pid = host.root.join("WS/A/work/pid");
        wait_file(&pid).await;
        wait_file(&host.root.join("WS/A/work/ready")).await;
        let library = host.root.join("WS/A/work/library/agents/ada");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::write(library.join("note"), "local").unwrap();
        if mode == "checkpoint" {
            assert!(
                !server
                    .library
                    .files
                    .lock()
                    .unwrap()
                    .contains_key("agents/ada/note")
            );
            // Advance the checkpoint before the watcher debounce can fire.
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(301)).await;
            tokio::time::resume();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !server
                    .library
                    .files
                    .lock()
                    .unwrap()
                    .contains_key("agents/ada/note")
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        host.cancel("hold");
        wait_calls(&server, "complete", 1).await;
        assert_eq!(
            complete(&server)["status"],
            "aborted",
            "mode={mode}: {}",
            complete(&server)
        );
        if mode == "aborted" || mode == "failed-in" {
            assert!(
                !server
                    .library
                    .files
                    .lock()
                    .unwrap()
                    .contains_key("agents/ada/note")
            );
        }
        if mode == "late" {
            let count = server.calls.lock().unwrap().len();
            for slot in host.state.lock().unwrap().active.values() {
                let _ = slot.changes.send(vec!["agents/ada".into()]);
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(server.calls.lock().unwrap().len(), count);
        }
        assert_reaped(&pid);
        task.abort();
    }
}

#[tokio::test]
async fn library_unreachable_is_warning_and_failed_sync_in_never_syncs_out() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    let mut c = claim("r");
    c["library"] = json!({"roots":[{"path":"agents/ada","mode":"write"}]});
    server
        .faults
        .lock()
        .unwrap()
        .insert("/library/".into(), 503);
    // Capture the executor's diagnostic as well as proving the run continues.
    #[derive(Clone)]
    struct Log(Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Log {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let log = Log(Arc::default());
    let writer = log.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
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
    let (_send, changes) = mpsc::unbounded_channel();
    use tracing::instrument::WithSubscriber;
    executor::execute(&host, &c, api, CancellationToken::new(), changes)
        .with_subscriber(subscriber)
        .await;
    let diagnostic = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(diagnostic.contains("WARN"));
    assert!(diagnostic.contains("Library did not sync; run continues"));
    assert_eq!(complete(&server)["status"], "done");
    assert_eq!(
        server
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p.contains("/library/"))
            .count(),
        1
    );
    task.abort();
}

#[tokio::test]
async fn driver_reads_while_library_pull_is_blocked() {
    let (url, server, task) = server().await;
    let temp = tempfile::tempdir().unwrap();
    let host = host(&url, temp.path());
    let mut c = claim("hold");
    c["library"] = json!({"roots":[{"path":"agents/ada","mode":"write"}]});
    *server.claim_override.lock().unwrap() = Some(c);
    expected(temp.path(), &json!({"mode":"delayed-result"}));
    host.offer("A".into(), "hold".into());
    let pid = host.root.join("WS/A/work/pid");
    wait_file(&pid).await;
    let blocker = Arc::new(Notify::new());
    server
        .blocked
        .lock()
        .unwrap()
        .insert("/library/".into(), blocker.clone());
    for slot in host.state.lock().unwrap().active.values() {
        slot.changes.send(vec!["agents/ada".into()]).unwrap();
    }
    wait_calls(&server, "stat?path=agents%2Fada", 2).await;
    // Fake Claude waits for this file, emits enough events to fill the pipe,
    // then records that stdin closed at result. Library is still awaiting HTTP.
    std::fs::write(host.root.join("WS/A/work/release"), "go").unwrap();
    wait_file(&host.root.join("WS/A/work/input-closed")).await;
    blocker.notify_one();
    server.blocked.lock().unwrap().clear();
    wait_calls(&server, "complete", 1).await;
    assert_eq!(complete(&server)["status"], "done");
    task.abort();
}
