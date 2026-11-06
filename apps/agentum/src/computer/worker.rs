//! Run the whole computer backend as the configured user. No credentials cross stdin.
use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
#[derive(serde::Serialize, serde::Deserialize)]
struct Init {
    config: crate::instance::ComputerConfig,
    state: PathBuf,
    config_dir: PathBuf,
    work: PathBuf,
    home: PathBuf,
}
struct Pending {
    id: Value,
    reply: Reply,
}
struct Session {
    generation: u64,
    input: std::sync::mpsc::SyncSender<Value>,
    child: Child,
}
struct State {
    session: Option<Session>,
    pending: HashMap<u64, Pending>,
    ready: Value,
    unavailable: Option<String>,
}
pub struct Worker {
    state: Arc<Mutex<State>>,
    serial: AtomicU64,
    stop: CancellationToken,
}
impl Worker {
    pub fn start(paths: &Computer) -> Result<Self> {
        let binary = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|e| Error::new(5, e.to_string()))?;
        let user = paths.config.run_as.user(&paths.name);
        let command = crate::privilege::computer::worker_command(&user, &binary);
        let init = Init {
            config: paths.config.computer.clone(),
            state: paths.state_file.parent().unwrap().to_owned(),
            config_dir: paths.config_dir.clone(),
            work: paths.workdir.clone(),
            home: paths.agent_home.clone(),
        };
        Self::start_with(command, init, std::time::Duration::from_secs(1)).map_err(|e| {
            Error::new(
                5,
                format!(
                    "Cannot run computer commands as {user}: {}. {}",
                    e.message,
                    crate::privilege::computer::worker_fix(&user, &binary)
                ),
            )
        })
    }
    fn start_with(
        mut command: std::process::Command,
        init: Init,
        backoff: std::time::Duration,
    ) -> Result<Self> {
        let audit = Arc::new(Mutex::new(
            audit::Log::new(
                &init.state,
                init.config.audit_max_bytes,
                init.config.audit_keep,
            )
            .map_err(|e| Error::new(5, e.to_string()))?,
        ));
        let state = Arc::new(Mutex::new(State {
            session: None,
            pending: HashMap::new(),
            ready: Value::Null,
            unavailable: None,
        }));
        let stop = CancellationToken::new();
        let runtime = tokio::runtime::Handle::current();
        let (death_tx, death_rx) = std::sync::mpsc::channel();
        let launch_state = state.clone();
        let launch_runtime = runtime.clone();
        let mut generation = 0;
        let mut launch = move |command: &mut std::process::Command| -> Result<(Session, Value)> {
            generation += 1;
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| Error::new(5, e.to_string()))?;
            let mut stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            if let Err(e) = writeln!(stdin, "{}", serde_json::to_string(&init).unwrap()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(5, e.to_string()));
            }
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            thread_reader(
                stdout,
                ready_tx,
                launch_state.clone(),
                launch_runtime.clone(),
                audit.clone(),
                death_tx.clone(),
                generation,
            );
            let ready = ready_rx
                .recv_timeout(std::time::Duration::from_secs(70))
                .ok();
            let failure = ready
                .as_ref()
                .and_then(|v| v["error"].as_str())
                .unwrap_or("computer worker failed its handshake")
                .to_owned();
            let Some(ready) = ready.filter(|v| {
                serde_json::from_value::<ComputerCapabilities>(v["ready"]["capabilities"].clone())
                    .is_ok()
                    && v["ready"]["workdir"].is_string()
                    && v.get("error").is_none()
            }) else {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(5, failure));
            };
            let (sender, receiver) = std::sync::mpsc::sync_channel::<Value>(64);
            let deaths = death_tx.clone();
            std::thread::spawn(move || {
                for frame in receiver {
                    if writeln!(stdin, "{frame}").is_err() {
                        let _ = deaths.send(generation);
                        break;
                    }
                }
            });
            Ok((
                Session {
                    generation,
                    input: sender,
                    child,
                },
                ready["ready"].clone(),
            ))
        };
        let (session, ready) = launch(&mut command)?;
        {
            let mut s = state.lock().unwrap();
            s.session = Some(session);
            s.ready = ready;
        }
        let supervisor_state = state.clone();
        let supervisor_stop = stop.clone();
        // The closure owns only immutable launch data, so retries never copy credentials.
        std::thread::spawn(move || {
            let state = supervisor_state;
            let stop = supervisor_stop;
            let mut failures = 0u32;
            let mut started = std::time::Instant::now();
            loop {
                if stop.is_cancelled() {
                    break;
                }
                let Ok(dead) = death_rx.recv_timeout(std::time::Duration::from_millis(100)) else {
                    continue;
                };
                if state
                    .lock()
                    .unwrap()
                    .session
                    .as_ref()
                    .is_none_or(|s| s.generation != dead)
                {
                    continue;
                }
                if started.elapsed() > std::time::Duration::from_secs(60) {
                    failures = 0;
                }
                let mut failure = "computer worker pipe closed".to_owned();
                let pending = {
                    let mut s = state.lock().unwrap();
                    if let Some(mut session) = s.session.take() {
                        if let Ok(Some(status)) = session.child.try_wait() {
                            failure = format!("computer worker exited with {status}");
                        }
                        let _ = session.child.kill();
                        let _ = session.child.wait();
                    }
                    s.pending.drain().map(|(_, p)| p).collect::<Vec<_>>()
                };
                for pending in pending {
                    runtime.spawn(async move {
                        let _ = pending.reply.send(json!({"id":pending.id,"error":{"code":"op_failed","message":"computer worker exited"}})).await;
                    });
                }
                loop {
                    failures += 1;
                    if failures > 5 {
                        let reason =
                            format!("computer worker unavailable (5 retries exhausted): {failure}");
                        state.lock().unwrap().unavailable = Some(reason.clone());
                        tracing::error!(reason, "Computer role unavailable");
                        return;
                    }
                    tracing::warn!(failures, "Computer worker exited; restarting with backoff");
                    let delay = backoff * (1 << (failures - 1));
                    let deadline = std::time::Instant::now() + delay;
                    while std::time::Instant::now() < deadline {
                        if stop.is_cancelled() {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10).min(delay));
                    }
                    // Discard duplicate reader/writer notifications for the old session.
                    while death_rx.try_recv().is_ok() {}
                    match launch(&mut command) {
                        Ok((mut session, ready)) => {
                            if stop.is_cancelled() {
                                let _ = session.child.kill();
                                let _ = session.child.wait();
                                return;
                            }
                            let mut s = state.lock().unwrap();
                            s.session = Some(session);
                            s.ready = ready;
                            started = std::time::Instant::now();
                            break;
                        }
                        Err(error) => {
                            failure = error.message;
                            tracing::warn!(message=%failure, "Cannot restart computer worker")
                        }
                    }
                }
            }
        });
        Ok(Self {
            state,
            serial: AtomicU64::new(0),
            stop,
        })
    }
    pub fn capabilities(&self) -> ComputerCapabilities {
        let s = self.state.lock().unwrap();
        if s.session.is_none() {
            ComputerCapabilities {
                python3: false,
                git: false,
                skills: false,
                desktop: false,
                desktop_unavailable_reason: Some(
                    s.unavailable
                        .clone()
                        .unwrap_or_else(|| "computer worker is restarting".into())
                        .chars()
                        .take(256)
                        .collect(),
                ),
            }
        } else {
            serde_json::from_value(s.ready["capabilities"].clone()).expect("worker capabilities")
        }
    }
    pub fn workdir(&self) -> PathBuf {
        PathBuf::from(
            self.state.lock().unwrap().ready["workdir"]
                .as_str()
                .unwrap_or(""),
        )
    }
    pub fn frame(&self, frame: Value, reply: Reply) -> Result<()> {
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        let id = frame["id"].clone();
        let mut state = self.state.lock().unwrap();
        let fault = if state.pending.len() >= 64 {
            Some(Fault::new("queue_full", "too many computer handlers"))
        } else if state.session.as_ref().is_none_or(|s| {
            s.input
                .try_send(json!({"serial":serial,"frame":frame}))
                .is_err()
        }) {
            Some(Fault::new("op_failed", "computer worker is unavailable"))
        } else {
            None
        };
        if let Some(fault) = fault {
            tokio::spawn(async move {
                let _ = reply
                    .send(encode_reply(id.as_str().unwrap_or(""), Err(fault)))
                    .await;
            });
        } else {
            state.pending.insert(serial, Pending { id, reply });
        }
        Ok(())
    }
    pub fn shutdown(&self, reason: Shutdown) {
        let mut state = self.state.lock().unwrap();
        if let Some(session) = state.session.as_mut() {
            let _ = session
                .input
                .try_send(json!({"shutdown":matches!(reason,Shutdown::Stopped|Shutdown::Revoked)}));
        }
        if matches!(reason, Shutdown::Stopped | Shutdown::Revoked) {
            self.stop.cancel();
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(mut session) = self.state.lock().unwrap().session.take() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}
fn thread_reader(
    stdout: std::process::ChildStdout,
    ready: std::sync::mpsc::Sender<Value>,
    state: Arc<Mutex<State>>,
    runtime: tokio::runtime::Handle,
    audit: Arc<Mutex<audit::Log>>,
    death: std::sync::mpsc::Sender<u64>,
    generation: u64,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("ready").is_some() {
                let _ = ready.send(value);
                continue;
            }
            if let Some(entry) = value.get("audit") {
                let _ = audit.lock().unwrap().record(entry.clone());
                continue;
            }
            if let Some(serial) = value["serial"].as_u64()
                && let Some(pending) = state.lock().unwrap().pending.remove(&serial)
            {
                let audit = audit.clone();
                runtime.spawn(async move {
                    if let Err(error) = pending.reply.send(bound_reply(value["reply"].clone())).await {
                        let _ = audit.lock().unwrap().record(json!({"request_id":pending.id,"outcome":"reply_dropped","error":error.to_string()}));
                    }
                });
            }
        }
        let _ = death.send(generation);
    });
}
fn prepare_worker(
    init: &Init,
    output: &tokio::sync::mpsc::UnboundedSender<Value>,
    uid: u32,
) -> OpResult<(Arc<Engine>, ComputerCapabilities)> {
    crate::privilege::computer::check_root(uid, false, "worker")
        .map_err(|e| Fault::new("op_failed", e.message))?;
    let cache = init.home.join("computer");
    let mut config = init.config.clone();
    config.allow_root = false;
    let mut reason = None;
    let desktop = if config.desktop {
        match crate::desktop::Desktop::launch(&cache, config.desktop_display.unwrap_or(90)) {
            Ok(d) => Some(Arc::new(d)),
            Err(e) => {
                reason = Some(e.message.chars().take(256).collect());
                None
            }
        }
    } else {
        None
    };
    let capabilities = detect_capabilities(desktop.is_some(), reason);
    let mut engine = Engine::prepare(
        config,
        cache,
        init.config_dir.clone(),
        init.work.clone(),
        desktop,
        Some(output.clone()),
    )?;
    engine.policy = policy::Policy::new(
        init.config.clone(),
        init.state.clone(),
        init.config_dir.clone(),
        init.work.clone(),
    )?;
    Ok::<_, Fault>((Arc::new(engine), capabilities))
}
/// Called before CLI parsing. Only runs when explicitly invoked as an internal worker.
pub fn entry() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("--computer-worker")) {
        return None;
    }
    let runtime = tokio::runtime::Runtime::new().expect("computer worker runtime");
    Some(runtime.block_on(serve()))
}
async fn serve() -> i32 {
    use tokio::io::AsyncBufReadExt;
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let Some(line) = input.next_line().await.ok().flatten() else {
        return 1;
    };
    let Ok(init) = serde_json::from_str::<Init>(&line) else {
        return 2;
    };
    let (output, mut frames) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut out = tokio::io::stdout();
        while let Some(v) = frames.recv().await {
            if out.write_all(format!("{v}\n").as_bytes()).await.is_err() {
                break;
            }
            let _ = out.flush().await;
        }
    });
    let setup = prepare_worker(&init, &output, nix::unistd::geteuid().as_raw());
    let (engine, capabilities) = match setup {
        Ok(e) => e,
        Err(e) => {
            let _ = output.send(json!({"ready":null,"error":e.message}));
            drop(output);
            let _ = writer.await;
            return 5;
        }
    };
    let _ =
        output.send(json!({"ready":{"capabilities":capabilities,"workdir":engine.policy.work}}));
    while let Ok(Some(line)) = input.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(stop) = value["shutdown"].as_bool() {
            engine.transfers.abandon();
            if stop {
                break;
            }
            continue;
        }
        let frame = value["frame"].clone();
        let id = frame["id"].as_str().unwrap_or("").to_owned();
        let exec = frame["op"] == "exec";
        let refusal = if id.is_empty() {
            Some(Fault::new("bad_request", "request id is required"))
        } else if exec {
            engine.reserve(&id).err()
        } else {
            None
        };
        let engine = engine.clone();
        let output = output.clone();
        tokio::spawn(async move {
            let result = match refusal {
                Some(e) => Err(e),
                None => engine.dispatch(frame).await,
            };
            let reply = encode_reply(&id, result);
            let _ = output.send(json!({"serial":value["serial"],"reply":reply}));
        });
    }
    engine.stop();
    if let Some(d) = &engine.desktop {
        d.stop();
    }
    writer.abort();
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_subprocess_child() {
        if std::env::var_os("RC5_WORKER_CHILD").is_some() {
            assert_eq!(
                tokio::runtime::Runtime::new().unwrap().block_on(serve()),
                if nix::unistd::geteuid().is_root() {
                    5
                } else {
                    0
                }
            );
        }
    }
    #[test]
    fn worker_stdio_exec_cancel_files_and_audit() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let work = state.join("agent/work");
        let init = Init {
            config: Default::default(),
            state: state.clone(),
            config_dir: dir.path().join("config"),
            work: work.clone(),
            home: state.join("agent"),
        };
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "computer::worker::tests::worker_subprocess_child",
                "--nocapture",
            ])
            .env("RC5_WORKER_CHILD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        writeln!(input, "{}", serde_json::to_string(&init).unwrap()).unwrap();
        fn next(output: &mut BufReader<std::process::ChildStdout>, key: &str) -> Value {
            loop {
                let mut line = String::new();
                assert!(
                    output.read_line(&mut line).unwrap() > 0,
                    "worker closed before {key}"
                );
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && v.get(key).is_some()
                {
                    return v;
                }
            }
        }
        let ready = next(&mut output, "ready");
        if nix::unistd::geteuid().is_root() {
            assert!(ready["error"].as_str().unwrap().contains("--allow-root"));
            drop(input);
            assert!(child.wait().unwrap().success());
            return;
        }
        assert_eq!(ready["ready"]["workdir"], json!(work));
        assert!(!state.join("agent/computer/audit.jsonl").exists());
        writeln!(
            input,
            "{}",
            json!({"serial":0,"frame":{"op":"exec","id":"long","command":"sleep 30"}})
        )
        .unwrap();
        writeln!(
            input,
            "{}",
            json!({"serial":1,"frame":{"op":"cancel","id":"cancel","target_id":"long"}})
        )
        .unwrap();
        let mut replies = vec![next(&mut output, "reply"), next(&mut output, "reply")];
        replies.sort_by_key(|r| r["serial"].as_u64().unwrap());
        assert_eq!(replies[0]["reply"]["result"]["exit_code"], 137);
        assert_eq!(replies[1]["reply"]["result"]["cancelled"], true);
        writeln!(input,"{}",json!({"serial":2,"frame":{"op":"file_put","id":"file","transfer_id":"t","path":work.join("file"),"seq":0,"data_b64":"b2s=","final":true}})).unwrap();
        let reply = next(&mut output, "reply");
        assert_eq!(reply["reply"]["result"]["bytes_written"], 2);
        assert_eq!(std::fs::read(work.join("file")).unwrap(), b"ok");
        writeln!(input, "{}", json!({"shutdown":true})).unwrap();
        drop(input);
        assert!(child.wait().unwrap().success());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::relay::{self, Timing};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        accept_async,
        tungstenite::{Message, protocol::CloseFrame},
    };

    struct TestRole(Worker);
    #[async_trait]
    impl Role for TestRole {
        fn kind(&self) -> SocketRole {
            SocketRole::Computer
        }
        fn hello(&self) -> Value {
            json!({"capabilities":self.0.capabilities()})
        }
        fn on_frame(&self, frame: Value, reply: Reply) -> Result<()> {
            self.0.frame(frame, reply)
        }
        async fn shutdown(&self, reason: Shutdown) {
            self.0.shutdown(reason);
        }
    }
    #[test]
    fn fake_worker_child() {
        let Some(counter) = std::env::var_os("RC5_FAKE_WORKER") else {
            return;
        };
        let count = std::fs::read_to_string(&counter)
            .unwrap_or_default()
            .parse::<u32>()
            .unwrap_or(0)
            + 1;
        std::fs::write(&counter, count.to_string()).unwrap();
        let mut lines = std::io::stdin().lock().lines();
        let init: Init = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        println!(
            "{}",
            json!({"ready":{"capabilities":{"python3":true,"git":true,"skills":true,"desktop":false,"desktop_unavailable_reason":null},"workdir":init.work}})
        );
        std::io::stdout().flush().unwrap();
        if count == 1 {
            // Keep all requests pending until the parent has hit the handler cap.
            for _ in 0..64 {
                lines.next().unwrap().unwrap();
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        } else if count == 2 {
            let frame: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            println!(
                "{}",
                json!({"serial":frame["serial"],"reply":{"id":frame["frame"]["id"],"result":{"text":"x".repeat(8 << 20)}}})
            );
            std::io::stdout().flush().unwrap();
        }
        // Exit bypasses the test harness's final output and closes the worker pipes.
        std::process::exit(0);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_death_fails_every_pending_request_restarts_and_eventually_disables_hello() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("starts");
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "computer::worker::recovery_tests::fake_worker_child",
                "--nocapture",
            ])
            .env("RC5_FAKE_WORKER", &counter);
        let init = Init {
            config: Default::default(),
            state: dir.path().join("state"),
            config_dir: dir.path().join("config"),
            work: dir.path().join("work"),
            home: dir.path().join("agent"),
        };
        let worker =
            Worker::start_with(command, init, std::time::Duration::from_millis(5)).unwrap();
        let role = Arc::new(TestRole(worker));
        assert!(role.0.capabilities().python3);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let observed = role.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            socket.next().await.unwrap().unwrap();
            for id in 0..65 {
                socket
                    .send(Message::text(
                        json!({"id":id.to_string(),"op":"exec","command":"true"}).to_string(),
                    ))
                    .await
                    .unwrap();
            }
            let mut failed = std::collections::HashSet::new();
            let mut refused = 0;
            for _ in 0..65 {
                let frame: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                match frame["error"]["code"].as_str().unwrap() {
                    "queue_full" => refused += 1,
                    "op_failed" => {
                        failed.insert(frame["id"].as_str().unwrap().to_owned());
                    }
                    code => panic!("unexpected code {code}"),
                }
            }
            assert_eq!(refused, 1);
            assert_eq!(failed.len(), 64);
            while observed.0.state.lock().unwrap().session.is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            socket
                .send(Message::text(
                    json!({"id":"oversize","op":"anything"}).to_string(),
                ))
                .await
                .unwrap();
            let frame: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(frame["id"], "oversize");
            assert_eq!(frame["error"]["code"], "frame_too_large");
            while observed.0.state.lock().unwrap().unavailable.is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            let hello = observed.hello();
            assert_eq!(hello["capabilities"]["python3"], false);
            assert_eq!(hello["capabilities"]["skills"], false);
            assert!(
                hello["capabilities"]["desktop_unavailable_reason"]
                    .as_str()
                    .unwrap()
                    .contains("5 retries exhausted")
            );
            socket
                .close(Some(CloseFrame {
                    code: 4401.into(),
                    reason: "done".into(),
                }))
                .await
                .unwrap();
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            relay::run(
                role,
                &url,
                "test",
                CancellationToken::new(),
                Timing::for_role(SocketRole::Computer),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().code, 3);
        server.await.unwrap();
        assert_eq!(std::fs::read_to_string(counter).unwrap(), "6");
    }
}

#[cfg(test)]
mod root_refusal_tests {
    use super::*;
    #[test]
    fn uid_zero_worker_refuses_even_with_allow_root_in_config() {
        let dir = tempfile::tempdir().unwrap();
        let init = Init {
            config: crate::instance::ComputerConfig {
                allow_root: true,
                ..Default::default()
            },
            state: dir.path().join("state"),
            config_dir: dir.path().join("config"),
            work: dir.path().join("work"),
            home: dir.path().join("agent"),
        };
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let Err(error) = prepare_worker(&init, &sink, 0) else {
            panic!("uid-zero worker was accepted");
        };
        assert!(error.message.contains("--allow-root"));
        assert!(!init.home.exists());
    }
}

#[cfg(test)]
mod unavailable_tests {
    use super::*;
    #[test]
    fn worker_unavailable_reason_fits_the_frozen_hello_schema() {
        let worker = Worker {
            state: Arc::new(Mutex::new(State {
                session: None,
                pending: HashMap::new(),
                ready: Value::Null,
                unavailable: Some("é".repeat(1000)),
            })),
            serial: AtomicU64::new(0),
            stop: CancellationToken::new(),
        };
        let capabilities = worker.capabilities();
        assert!(!capabilities.desktop);
        assert_eq!(
            capabilities
                .desktop_unavailable_reason
                .unwrap()
                .chars()
                .count(),
            256
        );
    }
}
