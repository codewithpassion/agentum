use super::{Engine, Fault, OpResult};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;
#[derive(Default)]
pub struct Output {
    head: Vec<u8>,
    tail: Vec<u8>,
    total: usize,
}
impl Output {
    pub fn push(&mut self, data: &[u8]) {
        const CAP: usize = ((1 << 19) - 64) / 2;
        self.total += data.len();
        let take = (CAP - self.head.len()).min(data.len());
        self.head.extend_from_slice(&data[..take]);
        let rest = &data[take..];
        if rest.len() >= CAP {
            self.tail.clear();
            self.tail.extend_from_slice(&rest[rest.len() - CAP..]);
        } else {
            self.tail.extend_from_slice(rest);
            if self.tail.len() > CAP {
                self.tail.drain(..self.tail.len() - CAP);
            }
        }
    }
    pub fn snapshot(&self) -> (String, usize, bool) {
        let truncated = self.total > self.head.len() + self.tail.len();
        if !truncated {
            let mut all = self.head.clone();
            all.extend_from_slice(&self.tail);
            return (
                String::from_utf8_lossy(&all).into_owned(),
                self.total,
                false,
            );
        }
        let mut head = self.head.as_slice();
        let mut tail = self.tail.as_slice();
        for _ in 0..3 {
            if (1..=head.len().min(4)).any(|n| {
                std::str::from_utf8(&head[head.len() - n..]).is_ok_and(|s| s.chars().count() == 1)
            }) {
                break;
            }
            head = &head[..head.len().saturating_sub(1)];
        }
        for _ in 0..3 {
            if (1..=tail.len().min(4))
                .any(|n| std::str::from_utf8(&tail[..n]).is_ok_and(|s| s.chars().count() == 1))
            {
                break;
            }
            tail = &tail[1.min(tail.len())..];
        }
        (
            format!(
                "{}\n[... {} bytes dropped ...]\n{}",
                String::from_utf8_lossy(head),
                self.total - head.len() - tail.len(),
                String::from_utf8_lossy(tail)
            ),
            self.total,
            true,
        )
    }
}
async fn drain(mut stream: impl tokio::io::AsyncRead + Unpin, output: Arc<Mutex<Output>>) {
    let mut data = [0; 16384];
    loop {
        match stream.read(&mut data).await {
            Ok(0) | Err(_) => break,
            Ok(n) => output.lock().unwrap().push(&data[..n]),
        }
    }
}
pub fn kill(pid: u32) {
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGKILL,
    );
}
pub fn start_time(pid: u32) -> Option<u64> {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()?
        .rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}
pub fn sweep(state: &std::path::Path) {
    let Ok(entries) = fs::read_dir(state.join("running")) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(raw) = fs::read(&path)
            && let Ok(record) = serde_json::from_slice::<Value>(&raw)
            && let Some(pid) = record["pgid"]
                .as_u64()
                .filter(|p| *p > 1 && *p <= i32::MAX as u64)
            && let Some(tick) = record["start_time"].as_u64().filter(|t| *t > 0)
            && start_time(pid as u32) == Some(tick)
        {
            kill(pid as u32);
        }
        let _ = fs::remove_file(path);
    }
}
pub async fn exec(
    engine: &Engine,
    id: &str,
    frame: Value,
    token: CancellationToken,
) -> OpResult<Value> {
    #[derive(Deserialize)]
    struct Exec {
        command: String,
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        timeout_ms: i64,
    }
    let request: Exec = serde_json::from_value(frame).map_err(Fault::decode)?;
    engine.policy.exec(&request.command)?;
    let refused: Vec<_> = request
        .env
        .keys()
        .filter(|n| !engine.policy.env_allowed(n))
        .cloned()
        .collect();
    if !refused.is_empty() {
        return Err(Fault::new(
            "denied",
            format!(
                "environment variables refused: {}; use --allow-env",
                refused.join(", ")
            ),
        ));
    }
    let cwd = engine.policy.cwd(request.cwd.as_deref())?;
    let start = Instant::now();
    let cancelled = |message: &str| json!({"_started":false,"exit_code":137,"stdout":"","stderr":message,"bytes_total":0,"truncated":false,"duration_ms":start.elapsed().as_millis() as u64});
    let _permit = tokio::select! {biased;_=token.cancelled()=>return Ok(cancelled("cancelled before the command started")),p=engine.slots.acquire()=>p.map_err(|_|Fault::new("op_failed","computer is stopping"))?};
    if token.is_cancelled() {
        return Ok(cancelled("cancelled while queued"));
    }
    let mut command = Command::new("/bin/sh");
    command.args(["-c", &request.command]);
    command
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (name, fallback) in [
        ("PATH", "/usr/local/bin:/usr/bin:/bin"),
        ("HOME", "/tmp"),
        ("LANG", "C.UTF-8"),
        ("TERM", "dumb"),
    ] {
        command.env(
            name,
            if name == "TERM" {
                fallback.into()
            } else {
                std::env::var(name)
                    .ok()
                    .filter(|v| !v.is_empty())
                    .unwrap_or(fallback.into())
            },
        );
    }
    if let Some(desktop) = &engine.desktop {
        for (k, v) in desktop.environment() {
            command.env(k, v);
        }
    }
    for (k, v) in request.env {
        if !k.is_empty() && !k.contains(['=', '\0']) && !v.contains('\0') {
            command.env(k, v);
        }
    }
    // Each command is its own session, including its descendants.
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setsid().map_err(std::io::Error::from)?;
            Ok(())
        });
    }
    let (mut child, pid, record) = {
        let _gate = engine.process_gate.lock().unwrap();
        if token.is_cancelled() {
            return Ok(cancelled("cancelled before the command started"));
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                return Ok(
                    json!({"_started":false,"exit_code":127,"stdout":"","stderr":e.to_string(),"bytes_total":0,"truncated":false,"duration_ms":start.elapsed().as_millis() as u64}),
                );
            }
        };
        let pid = child.id().unwrap();
        let record = engine.state.join("running").join(format!("{pid}.json"));
        if let Err(error)=crate::instance::atomic_write(&record,json!({"pgid":pid,"request_id":id,"command":request.command.chars().take(4096).collect::<String>(),"started_at":chrono::Utc::now().to_rfc3339(),"start_time":start_time(pid)}).to_string().as_bytes()){tracing::warn!(%error,"Cannot record command process group");}
        engine.pids.lock().unwrap().insert(id.into(), pid);
        (child, pid, record)
    };
    let stdout = Arc::new(Mutex::new(Output::default()));
    let stderr = Arc::new(Mutex::new(Output::default()));
    let mut out_task = tokio::spawn(drain(child.stdout.take().unwrap(), stdout.clone()));
    let mut err_task = tokio::spawn(drain(child.stderr.take().unwrap(), stderr.clone()));
    let duration = Duration::from_millis(if request.timeout_ms <= 0 {
        30000
    } else {
        request.timeout_ms as u64
    })
    .min(Duration::from_secs(
        engine.policy.config.max_exec_seconds.max(1),
    ));
    let (status, timed_out) = tokio::select! {s=child.wait()=>(s,false),_=token.cancelled()=>{kill(pid);(child.wait().await,false)},_=tokio::time::sleep(duration)=>{kill(pid);(child.wait().await,true)}};
    // An escaped descendant may still hold a pipe. Never wait for it indefinitely.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = tokio::join!(&mut out_task, &mut err_task);
    })
    .await;
    out_task.abort();
    err_task.abort();
    engine.pids.lock().unwrap().remove(id);
    let _ = fs::remove_file(record);
    let (out, out_total, out_cut) = stdout.lock().unwrap().snapshot();
    let (err, err_total, err_cut) = stderr.lock().unwrap().snapshot();
    let exit = if timed_out {
        124
    } else {
        status
            .map(|s| s.code().unwrap_or(128 + s.signal().unwrap_or(9)))
            .unwrap_or(1)
    };
    Ok(
        json!({"_started":true,"exit_code":exit,"stdout":out,"stderr":err,"bytes_total":out_total+err_total,"truncated":out_cut||err_cut,"duration_ms":start.elapsed().as_millis() as u64}),
    )
}
