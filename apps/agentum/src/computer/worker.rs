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
pub struct Worker {
    input: Mutex<Option<std::sync::mpsc::SyncSender<Value>>>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    serial: AtomicU64,
    child: Mutex<Child>,
    pub capabilities: Value,
}
impl Worker {
    pub fn start(paths: &Computer) -> Result<Self> {
        let binary = std::env::current_exe().map_err(|e| Error::new(5, e.to_string()))?;
        let user = paths.config.run_as.user(&paths.name);
        // sudo executes a fixed binary and fixed worker argument; configuration is stdin.
        let mut child = std::process::Command::new("sudo")
            .args(["-k", "-n", "-H", "-u", &user, "--"])
            .arg(&binary)
            .arg("--computer-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| {
                Error::new(
                    5,
                    format!(
                        "Cannot start computer as {user}: {e}. {}",
                        crate::privilege::computer::worker_fix(&user, &binary)
                    ),
                )
            })?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let state = paths.state_file.parent().unwrap().to_owned();
        let home = paths.agent_home.clone();
        let init = Init {
            config: paths.config.computer.clone(),
            state: state.clone(),
            config_dir: paths.config_dir.clone(),
            work: paths.workdir.clone(),
            home,
        };
        writeln!(stdin, "{}", serde_json::to_string(&init).unwrap())
            .map_err(|e| Error::new(5, e.to_string()))?;
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Default::default();
        let replies = pending.clone();
        let runtime = tokio::runtime::Handle::current();
        let audit = Arc::new(Mutex::new(
            audit::Log::new(
                &state,
                paths.config.computer.audit_max_bytes,
                paths.config.computer.audit_keep,
            )
            .map_err(|e| Error::new(5, e.to_string()))?,
        ));
        thread_reader(stdout, ready_tx, replies, runtime, audit);
        let ready = ready_rx
            .recv_timeout(std::time::Duration::from_secs(70))
            .ok()
            .filter(|v| v.get("ready").is_some());
        let Some(ready) = ready else {
            let _ = child.kill();
            return Err(Error::new(
                5,
                format!(
                    "Cannot run computer commands as {user}. {}",
                    crate::privilege::computer::worker_fix(&user, &binary)
                ),
            ));
        };
        if let Some(message) = ready["error"].as_str() {
            let _ = child.kill();
            return Err(Error::new(5, message));
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Value>(64);
        std::thread::spawn(move || {
            for frame in receiver {
                if writeln!(stdin, "{frame}").is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            input: Mutex::new(Some(sender)),
            pending,
            serial: AtomicU64::new(0),
            child: Mutex::new(child),
            capabilities: ready["ready"].clone(),
        })
    }
    pub fn frame(&self, frame: Value, reply: Reply) -> Result<()> {
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        let mut pending = self.pending.lock().unwrap();
        let id = frame["id"].clone();
        if pending.len() >= 64 {
            tokio::spawn(async move {
                let _=reply.send(json!({"id":id,"error":{"code":"queue_full","message":"too many computer handlers"}})).await;
            });
            return Ok(());
        }
        pending.insert(serial, reply.clone());
        if self
            .input
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|s| s.try_send(json!({"serial":serial,"frame":frame})).is_err())
        {
            pending.remove(&serial);
            tokio::spawn(async move {
                let _=reply.send(json!({"id":id,"error":{"code":"op_failed","message":"computer worker is unavailable"}})).await;
            });
        }
        Ok(())
    }
    pub fn shutdown(&self, reason: Shutdown) {
        if let Some(sender) = self.input.lock().unwrap().as_ref() {
            let _ = sender
                .try_send(json!({"shutdown":matches!(reason,Shutdown::Stopped|Shutdown::Revoked)}));
        }
        if matches!(reason, Shutdown::Stopped | Shutdown::Revoked) {
            self.input.lock().unwrap().take();
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.input.lock().unwrap().take();
        let _ = self.child.lock().unwrap().try_wait();
    }
}
fn thread_reader(
    stdout: std::process::ChildStdout,
    ready: std::sync::mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    runtime: tokio::runtime::Handle,
    audit: Arc<Mutex<audit::Log>>,
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
                && let Some(reply) = pending.lock().unwrap().remove(&serial)
            {
                let audit = audit.clone();
                runtime.spawn(async move{if let Err(error)=reply.send(value["reply"].clone()).await{let _=audit.lock().unwrap().record(json!({"request_id":value["reply"]["id"],"outcome":"reply_dropped","error":error.to_string()}));}});
            }
        }
        pending.lock().unwrap().clear();
    });
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
    let setup = (|| {
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
        let mut engine = Engine::new(
            config,
            cache,
            init.config_dir.clone(),
            init.work.clone(),
            desktop,
        )?;
        engine.policy = policy::Policy::new(init.config, init.state, init.config_dir, init.work)?;
        engine.audit_sink = Some(output.clone());
        Ok::<_, Fault>((Arc::new(engine), capabilities))
    })();
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
            let reply = match result {
                Ok(r) => json!({"id":id,"result":r}),
                Err(e) => json!({"id":id,"error":{"code":e.code,"message":e.message}}),
            };
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
            assert_eq!(tokio::runtime::Runtime::new().unwrap().block_on(serve()), 0);
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
        assert_eq!(ready["ready"]["workdir"], json!(work));
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
