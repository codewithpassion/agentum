//! Claude CLI stream-json/control protocol, following SDK 0.2.119.
use crate::{
    approvals::{Gate, HOOK_TIMEOUT_SECONDS},
    files::Disk,
    runs::{
        api::{Failure, Result},
        helpers::{Masker, agent_env, max_turns, stop_message, text},
    },
};
use serde_json::{Value, json};
use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, mpsc},
};
use tokio_util::sync::CancellationToken;

pub fn normalize(message: &Value) -> Vec<Value> {
    let mut events = vec![];
    let Some(blocks) = message["message"]["content"].as_array() else {
        return events;
    };
    for block in blocks {
        let event = match (text(&message["type"]), text(&block["type"])) {
            ("assistant", "text") if block["text"] != "" => {
                Some(json!({"type":"message.assistant","payload":{"text":block["text"]}}))
            }
            ("assistant", "thinking") if block["thinking"] != "" => {
                Some(json!({"type":"message.reasoning","payload":{"text":block["thinking"]}}))
            }
            ("assistant", "tool_use") => Some(
                json!({"type":"tool.call","payload":{"name":block["name"],"toolUseId":block["id"],"input":if block["input"].is_object(){block["input"].clone()}else{json!({})}}}),
            ),
            ("user", "tool_result") => {
                let output = if let Some(s) = block["content"].as_str() {
                    s.to_owned()
                } else {
                    block["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|item| {
                            if item["type"] == "text" {
                                text(&item["text"]).into()
                            } else {
                                format!("[{}]", text(&item["type"]))
                            }
                        })
                        .collect::<Vec<String>>()
                        .join("\n")
                };
                Some(
                    json!({"type":"tool.result","payload":{"toolUseId":block["tool_use_id"],"ok":block["is_error"]!=true,"output":output}}),
                )
            }
            _ => None,
        };
        if let Some(event) = event {
            events.push(event);
        }
    }
    events
}
pub fn completion(
    result: Option<&Value>,
    failure: Option<&str>,
    session: Option<&str>,
    turns: u64,
) -> Value {
    let Some(result) = result else {
        let mut body = json!({"status":"failed","error":failure.unwrap_or("Claude Code ended without a result")});
        if let Some(session) = session {
            body["runtimeRef"] = json!(session);
        }
        return body;
    };
    let mut usage = json!({});
    for (key, value) in [
        ("costUsd", &result["total_cost_usd"]),
        ("inputTokens", &result["usage"]["input_tokens"]),
        ("outputTokens", &result["usage"]["output_tokens"]),
    ] {
        if value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
            usage[key] = value.clone();
        }
    }
    let mut body = json!({"runtimeRef":result["session_id"],"usage":usage});
    match text(&result["subtype"]) {
        "success" => {
            body["status"] = json!("done");
            body["text"] = result["result"].clone();
        }
        "error_max_turns" => {
            body["status"] = json!("failed");
            body["error"] = json!(stop_message(&json!({"kind":"turn_limit","limit":turns})));
            body["stop"] = json!({"kind":"turn_limit","limit":turns});
        }
        subtype => {
            body["status"] = json!("failed");
            body["error"] = json!(
                result["errors"]
                    .as_array()
                    .filter(|e| !e.is_empty())
                    .map(|e| e.iter().map(text).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_else(|| subtype.into())
            );
        }
    }
    body
}
pub fn version_ok(version: &str) -> bool {
    let re = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").unwrap();
    re.captures(version)
        .and_then(|c| {
            Some((
                c[1].parse::<u64>().ok()?,
                c[2].parse::<u64>().ok()?,
                c[3].parse::<u64>().ok()?,
            ))
        })
        .is_some_and(|v| v >= (2, 1, 300))
}
/// Build non-conversation probes. Tests never invoke this on a real binary.
pub fn probe(
    binary: &str,
    user: Option<&str>,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    test_binary_guard(binary)?;
    let mut command = crate::privilege::agent::claude_command(binary, user, None, &[]);
    command
        .args(args)
        .env_clear()
        .envs(agent_env(std::env::vars()));
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    // The Role prerequisite API is synchronous. Release a Tokio worker while the
    // bounded probe runs; doctor also calls this outside a runtime.
    let mut run = move || {
        let mut child = command.spawn()?;
        drop(child.stdin.take());
        // Drain both pipes concurrently: a noisy or stuck version command must
        // still obey the deadline, including descendants holding a pipe open.
        let read = |mut pipe: Box<dyn std::io::Read + Send>| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                pipe.read_to_end(&mut bytes).map(|_| bytes)
            })
        };
        let stdout = read(Box::new(child.stdout.take().unwrap()));
        let stderr = read(Box::new(child.stderr.take().unwrap()));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait()?
                && stdout.is_finished()
                && stderr.is_finished()
            {
                return Ok(std::process::Output {
                    status,
                    stdout: stdout
                        .join()
                        .map_err(|_| std::io::Error::other("Version output reader failed"))??,
                    stderr: stderr
                        .join()
                        .map_err(|_| std::io::Error::other("Version error reader failed"))??,
                });
            }
            if std::time::Instant::now() >= deadline {
                signal_group(child.id(), nix::sys::signal::Signal::SIGKILL);
                let _ = child.wait();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Claude version probe timed out",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    if tokio::runtime::Handle::try_current()
        .is_ok_and(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
    {
        tokio::task::block_in_place(run)
    } else {
        run()
    }
}
// Cargo integration tests link the normal library, so cfg(test) alone is not
// enough. Never resolve an implicit Claude through PATH from a test executable.
fn test_binary_guard(binary: &str) -> std::io::Result<()> {
    let testing = cfg!(test)
        || std::env::current_exe()
            .ok()
            .is_some_and(|p| p.parent().is_some_and(|p| p.ends_with("deps")));
    if testing && !std::path::Path::new(binary).is_absolute() {
        return Err(std::io::Error::other(
            "Tests require an explicit fake Claude binary",
        ));
    }
    Ok(())
}
fn signal_group(id: u32, signal: nix::sys::signal::Signal) {
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(id as i32), signal);
}
fn group_alive(result: std::result::Result<(), nix::errno::Errno>) -> bool {
    !matches!(result, Err(nix::errno::Errno::ESRCH))
}
async fn signal_as_user(group: u32, signal: nix::sys::signal::Signal, user: Option<&str>) {
    signal_group(group, signal);
    if let Some(user) = user {
        let command = crate::privilege::agent::signal_command(
            user,
            group,
            if signal == nix::sys::signal::Signal::SIGTERM {
                "-TERM"
            } else {
                "-KILL"
            },
        );
        let mut command = Command::from(command);
        command.kill_on_drop(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), command.output()).await;
    }
}
async fn terminate(child: &mut Child, group: u32, user: Option<&str>) {
    signal_as_user(group, nix::sys::signal::Signal::SIGTERM, user).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let alive = group_alive(nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(group as i32),
            None,
        ));
        let _ = child.try_wait();
        if !alive {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            signal_as_user(group, nix::sys::signal::Signal::SIGKILL, user).await;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}
async fn write_frame(
    stdin: &Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    frame: &Value,
) -> Result<()> {
    let mut guard = stdin.lock().await;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| Failure::local("Claude input is closed"))?;
    stdin.write_all(format!("{frame}\n").as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
}
pub struct Driver<'a> {
    pub binary: &'a str,
    pub disk: &'a Disk,
    pub claim: &'a Value,
    pub machine: &'a str,
    pub prompt: String,
    pub message: String,
    pub gate: Option<Arc<Gate>>,
    pub cancel: CancellationToken,
    pub events: mpsc::Sender<Value>,
}
pub async fn drive(options: Driver<'_>) -> Result<Value> {
    let Driver {
        binary,
        disk,
        claim,
        machine,
        prompt,
        message,
        gate,
        cancel,
        events,
    } = options;
    test_binary_guard(binary)?;
    let mut preserve = vec!["CLAUDE_CODE_ENTRYPOINT".to_owned()];
    preserve.extend(
        claim["env"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.keys().cloned()),
    );
    let mut command = Command::from(crate::privilege::agent::claude_command(
        binary,
        disk.user.as_deref(),
        Some(&disk.root),
        &preserve,
    ));
    command
        .args([
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
        ])
        .arg(max_turns(&claim["agent"]["runtimeConfig"]).to_string())
        .args([
            "--model",
            text(&claim["agent"]["model"]),
            "--setting-sources=project",
            "--strict-mcp-config",
            "--permission-mode",
            "bypassPermissions",
            "--allow-dangerously-skip-permissions",
        ]);
    if gate.is_some() {
        command.args(["--permission-prompt-tool", "stdio"]);
    }
    if let Some(budget) = claim["agent"]["runtimeConfig"]["maxBudgetUsd"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
    {
        command.arg("--max-budget-usd").arg(budget.to_string());
    }
    if claim["session"]["runtimeMachineId"] == machine
        && let Some(session) = claim["session"]["runtimeRef"].as_str()
    {
        command.args(["--resume", session]);
    }
    command
        .env_clear()
        .envs(agent_env(std::env::vars()))
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");
    for (name, value) in claim["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            command.env(name, value);
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn().map_err(|_| {
        Failure::local(
            "Cannot start claude as the run-as user. Run agentum doctor to repair its access.",
        )
    })?;
    let group = child.id().unwrap();
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let stderr = child.stderr.take().unwrap();
    let stderr_tail = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut stderr = stderr;
        let mut tail = String::new();
        let mut buf = [0; 1024];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            tail.push_str(&String::from_utf8_lossy(&buf[..n]));
            tail = tail
                .chars()
                .rev()
                .take(500)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
        tail
    });
    let controls = CancellationToken::new();
    let mut callbacks: HashMap<String, CancellationToken> = HashMap::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut result = None;
    let mut session = None;
    let mut failure = None;
    let mut exit_deadline = None;
    let mut secrets = claim["env"].as_object().cloned().unwrap_or_default();
    secrets.insert("run_token".into(), claim["runToken"].clone());
    let masker = Masker::new(&Value::Object(secrets));
    let conversation = async {
        let mut initialize = json!({"subtype":"initialize","appendSystemPrompt":prompt});
        if gate.is_some() {
            initialize["hooks"] = json!({"PreToolUse":[{"hookCallbackIds":["hook_0"],"timeout":HOOK_TIMEOUT_SECONDS}]});
        }
        write_frame(
            &stdin,
            &json!({"type":"control_request","request_id":"initialize","request":initialize}),
        )
        .await?;
        let handshake_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut initialized = false;
        let mut ready = false;
        loop {
            let line = tokio::select! {
                _ = cancel.cancelled()=>break,
                _ = tokio::time::sleep_until(handshake_deadline), if !ready => return Err(Failure::local("Claude control handshake timed out")),
                _ = tokio::time::sleep_until(exit_deadline.unwrap_or(handshake_deadline)), if exit_deadline.is_some() => break,
                line=lines.next_line()=>line?
            };
            let Some(line) = line else { break };
            let frame: Value = serde_json::from_str(&line)
                .map_err(|_| Failure::local("Claude wrote invalid stream-json"))?;
            match text(&frame["type"]) {
                "control_response" => {
                    if frame["response"]["subtype"] == "error"
                        && frame["response"]["request_id"] != "mcp"
                    {
                        return Err(Failure::local("Claude rejected a control request"));
                    }
                    match text(&frame["response"]["request_id"]) {
                        "initialize" if !initialized => {
                            initialized = true;
                            write_frame(&stdin,&json!({"type":"control_request","request_id":"mcp","request":{"subtype":"mcp_set_servers","servers":claim["mcpServers"]}})).await?;
                        }
                        "mcp" if initialized && !ready => {
                            if frame["response"]["subtype"] == "error" {
                                tracing::warn!(error = %masker.mask(text(&frame["response"]["error"])), "Claude MCP handover failed; run continues");
                            } else {
                                tracing::info!(added = %masker.deep(&frame["response"]["response"]["added"]), errors = %masker.deep(&frame["response"]["response"]["errors"]), "Claude MCP servers");
                            }
                            ready = true;
                            write_frame(&stdin,&json!({"type":"user","message":{"role":"user","content":message},"parent_tool_use_id":null})).await?;
                        }
                        _ => {}
                    }
                }
                "control_cancel_request" => {
                    if let Some(token) = callbacks.remove(text(&frame["request_id"])) {
                        token.cancel();
                    }
                }
                "control_request" => {
                    let id = text(&frame["request_id"]).to_owned();
                    let request = frame["request"].clone();
                    let stdin = stdin.clone();
                    let gate = gate.clone();
                    let token = controls.child_token();
                    callbacks.insert(id.clone(), token.clone());
                    tasks.spawn(async move {
                        let response=match text(&request["subtype"]) {
                            "can_use_tool" if gate.is_some()=>json!({"subtype":"success","request_id":id,"response":{"behavior":"allow","updatedInput":request["input"],"toolUseID":request["tool_use_id"]}}),
                            "hook_callback" if request["callback_id"]=="hook_0" && gate.is_some()=>{let hook=gate.unwrap().hook(&request["input"],token.clone()).await;json!({"subtype":"success","request_id":id,"response":hook})},
                            "elicitation"=>json!({"subtype":"success","request_id":id,"response":{"action":"decline"}}),
                            _=>{tracing::warn!(subtype = %request["subtype"], "Unsupported Claude control request");json!({"subtype":"error","request_id":id,"error":"Unsupported control request"})}
                        };
                        let _=write_frame(&stdin,&json!({"type":"control_response","response":response})).await;token.cancel();
                    });
                }
                "result" => {
                    result = Some(frame);
                    stdin.lock().await.take();
                    exit_deadline
                        .get_or_insert(tokio::time::Instant::now() + Duration::from_secs(5));
                }
                _ => {
                    if frame["type"] == "system" && frame["subtype"] == "init" {
                        session = frame["session_id"].as_str().map(str::to_owned);
                    }
                    for event in normalize(&frame) {
                        let _ = events.send(event).await;
                    }
                }
            }
            while let Some(_result) = tasks.try_join_next() {}
            callbacks.retain(|_, token| !token.is_cancelled());
        }
        Ok(())
    };
    if let Err(e) = tokio::select! {_ = cancel.cancelled()=>Ok(()),result=conversation=>result} {
        failure = Some(e.message);
    }
    controls.cancel();
    if tokio::time::timeout(Duration::from_secs(1), async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
    // Close input, allow a clean exit, then enforce the daemon's TERM/KILL grace.
    stdin.lock().await.take();
    // Give final control replies a chance to be consumed after closing input.
    let grace = if cancel.is_cancelled() {
        Duration::from_millis(100)
    } else {
        exit_deadline
            .map(|at| at.saturating_duration_since(tokio::time::Instant::now()))
            .unwrap_or(Duration::from_millis(100))
    };
    let _ = tokio::time::timeout(grace, child.wait()).await;
    if child.try_wait()?.is_none() {
        terminate(&mut child, group, disk.user.as_deref()).await;
    } else {
        // Reap any descendants even when the direct child has already exited.
        signal_as_user(
            group,
            nix::sys::signal::Signal::SIGKILL,
            disk.user.as_deref(),
        )
        .await;
    }
    let mut stderr_tail = stderr_tail;
    let tail = match tokio::time::timeout(Duration::from_secs(5), &mut stderr_tail).await {
        Ok(result) => result.unwrap_or_default(),
        Err(_) => {
            stderr_tail.abort();
            String::new()
        }
    };
    if result.is_none() && !tail.trim().is_empty() {
        failure = Some(format!(
            "{}: {}",
            failure
                .as_deref()
                .unwrap_or("Claude Code ended without a result"),
            tail.trim()
        ));
    }
    Ok(if cancel.is_cancelled() {
        json!({"status":"aborted"})
    } else {
        completion(
            result.as_ref(),
            failure.as_deref(),
            session.as_deref(),
            max_turns(&claim["agent"]["runtimeConfig"]),
        )
    })
}
pub fn prerequisites(
    config: &crate::instance::Config,
    user: Option<&str>,
    instance: &str,
) -> crate::Result<String> {
    let binary = config.claude_binary.as_deref().unwrap_or("claude");
    let explain = |p: crate::privilege::Problem| {
        crate::Error::new(
            5,
            p.explain(&config.run_as.user(instance), instance)
                .to_string(),
        )
    };
    let version = probe(binary, user, &["--version"])
        .map_err(|_| explain(crate::privilege::Problem::ClaudeMissing))?;
    if !version.status.success() {
        return Err(if user.is_some() {
            crate::Error::new(
                5,
                crate::privilege::agent::private_claude(
                    &config.run_as.user(instance),
                    instance,
                    binary,
                )
                .to_string(),
            )
        } else {
            explain(crate::privilege::Problem::ClaudeMissing)
        });
    }
    if !version_ok(&String::from_utf8_lossy(&version.stdout)) {
        return Err(explain(crate::privilege::Problem::ClaudeOld));
    }
    Ok(regex::Regex::new(r"\d+\.\d+\.\d+")
        .unwrap()
        .find(&String::from_utf8_lossy(&version.stdout))
        .unwrap()
        .as_str()
        .to_owned())
}

#[cfg(test)]
mod termination_review_tests {
    #[test]
    fn permission_denied_is_alive_and_only_esrch_is_dead() {
        use nix::errno::Errno;
        assert!(super::group_alive(Ok(())));
        assert!(super::group_alive(Err(Errno::EPERM)));
        assert!(!super::group_alive(Err(Errno::ESRCH)));
    }
    #[test]
    fn escalation_uses_the_per_instance_sudo_target() {
        let command = crate::privilege::agent::signal_command("agentum-office", 123, "-KILL");
        assert_eq!(command.get_program(), "sudo");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-n",
                "-u",
                "agentum-office",
                "--",
                "/bin/kill",
                "-KILL",
                "--",
                "-123"
            ]
        );
    }
}
