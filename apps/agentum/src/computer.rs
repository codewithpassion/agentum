//! Computer protocol v1: machine-local policy, bounded execution and transfers.
mod audit;
pub mod files;
mod policy;
mod runner;
mod worker;
use crate::{
    Error, Result,
    instance::{Config, Paths},
    privilege::on_path,
    relay::{Reply, Role, Shutdown, SocketRole},
    wire::{self, ComputerCapabilities, ComputerHello},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
pub use worker::entry as worker_entry;
#[derive(Debug)]
pub struct Fault {
    pub code: &'static str,
    pub message: String,
}
pub(crate) type OpResult<T> = std::result::Result<T, Fault>;
impl Fault {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn decode(error: impl std::fmt::Display) -> Self {
        Self::new("bad_request", error.to_string())
    }
}
impl From<std::io::Error> for Fault {
    fn from(e: std::io::Error) -> Self {
        Self::new(
            if e.kind() == std::io::ErrorKind::NotFound {
                "not_found"
            } else {
                "op_failed"
            },
            e.to_string(),
        )
    }
}
pub fn hello(
    hostname: &str,
    os: &str,
    arch: &str,
    version: &str,
    user: &str,
    workdir: &str,
    capabilities: ComputerCapabilities,
) -> ComputerHello {
    ComputerHello {
        r#type: "hello".into(),
        protocol_version: 1,
        hostname: hostname.into(),
        os: os.into(),
        arch: arch.into(),
        version: version.into(),
        run_as_user: user.into(),
        workdir: workdir.into(),
        capabilities,
    }
}
struct Engine {
    audit_sink: Option<tokio::sync::mpsc::UnboundedSender<Value>>,
    policy: policy::Policy,
    state: PathBuf,
    audit: Mutex<Option<audit::Log>>,
    transfers: files::Transfers,
    running: Mutex<HashMap<String, CancellationToken>>,
    pids: Mutex<HashMap<String, u32>>,
    slots: Semaphore,
    process_gate: Mutex<()>,
    handlers: Arc<Semaphore>,
    desktop: Option<Arc<crate::desktop::Desktop>>,
}
impl Engine {
    fn new(
        config: crate::instance::ComputerConfig,
        state: PathBuf,
        config_dir: PathBuf,
        work: PathBuf,
        desktop: Option<Arc<crate::desktop::Desktop>>,
    ) -> OpResult<Self> {
        Self::prepare(config, state, config_dir, work, desktop, None)
    }
    fn prepare(
        mut config: crate::instance::ComputerConfig,
        state: PathBuf,
        config_dir: PathBuf,
        work: PathBuf,
        desktop: Option<Arc<crate::desktop::Desktop>>,
        audit_sink: Option<tokio::sync::mpsc::UnboundedSender<Value>>,
    ) -> OpResult<Self> {
        if config.max_concurrent == 0 {
            config.max_concurrent = 4;
        }
        if config.max_queue == 0 {
            config.max_queue = 32;
        }
        if config.max_exec_seconds == 0 {
            config.max_exec_seconds = 1800;
        }
        if config.max_file_bytes == 0 {
            config.max_file_bytes = 256 << 20;
        }
        let slots = Semaphore::new(config.max_concurrent);
        let policy = policy::Policy::new(config, state.clone(), config_dir, work)?;
        ensure_directory(&policy.work)?;
        crate::instance::private_dir(&state.join("running"))
            .map_err(|e| Fault::new("op_failed", e.to_string()))?;
        let audit = Mutex::new(if audit_sink.is_none() {
            Some(audit::Log::new(
                &state,
                policy.config.audit_max_bytes,
                policy.config.audit_keep,
            )?)
        } else {
            None
        });
        runner::sweep(&state);
        Ok(Self {
            audit_sink,
            policy,
            state,
            audit,
            transfers: Default::default(),
            running: Default::default(),
            pids: Default::default(),
            slots,
            process_gate: Mutex::new(()),
            handlers: Arc::new(Semaphore::new(64)),
            desktop,
        })
    }
    fn reserve(&self, id: &str) -> OpResult<()> {
        let mut running = self.running.lock().unwrap();
        if running.contains_key(id) {
            return Err(Fault::new(
                "duplicate_id",
                "a command with this request id is already running",
            ));
        }
        if running.len()
            >= self.policy.config.max_concurrent.max(1) + self.policy.config.max_queue.max(1)
        {
            return Err(Fault::new(
                "queue_full",
                "too many commands are already queued",
            ));
        }
        running.insert(id.into(), CancellationToken::new());
        Ok(())
    }
    fn cancel(&self, id: &str) -> bool {
        if let Some(token) = self.running.lock().unwrap().get(id) {
            token.cancel();
            true
        } else {
            false
        }
    }
    fn record(&self, entry: Value) {
        if let Some(sink) = &self.audit_sink {
            let _ = sink.send(json!({"audit":entry}));
            return;
        }
        if let Some(log) = self.audit.lock().unwrap().as_mut()
            && let Err(error) = log.record(entry)
        {
            tracing::warn!(%error,"Cannot write computer audit log");
        }
    }
    async fn dispatch(&self, frame: Value) -> OpResult<Value> {
        let op = frame["op"].as_str().unwrap_or("");
        let id = frame["id"].as_str().unwrap_or("");
        let mut entry = json!({"op":op,"request_id":id});
        let cwd = frame["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(std::path::Path::new)
            .unwrap_or(&self.policy.work);
        if op == "exec"
            && let Ok(cwd) = policy::resolve(cwd)
        {
            entry["cwd"] = json!(cwd);
        }
        if let Some(path) = frame["path"].as_str()
            && let Ok(path) = policy::resolve(std::path::Path::new(path))
        {
            entry["path"] = json!(path);
        }
        if let Some(command) = frame.get("command") {
            entry["command"] = command.clone();
        }
        let mut result = match op {
            "exec" => {
                let token = self
                    .running
                    .lock()
                    .unwrap()
                    .get(id)
                    .cloned()
                    .unwrap_or_default();
                let result = runner::exec(self, id, frame.clone(), token).await;
                self.running.lock().unwrap().remove(id);
                result
            }
            "cancel" => match frame["target_id"].as_str() {
                Some(target) => Ok(json!({"cancelled":self.cancel(target)})),
                None => Err(Fault::new("bad_request", "target_id must be a string")),
            },
            "file_put" => self.transfers.put(frame.clone(), &self.policy).await,
            "file_get" => files::get(frame.clone(), &self.policy),
            op if op.starts_with("desktop_") => {
                crate::desktop::dispatch(
                    self.desktop.as_deref(),
                    &frame,
                    self.policy.config.read_only,
                )
                .await
            }
            _ => Err(Fault::new(
                "unknown_op",
                "this computer does not implement the requested op",
            )),
        };
        entry["outcome"] = json!(match &result {
            Ok(r) if op == "exec" && r["_started"] == false => "error",
            Ok(_) => "ok",
            Err(e) if ["denied", "read_only"].contains(&e.code) => "denied",
            Err(_) => "error",
        });
        if let Some(actions) = frame["actions"].as_array().filter(|a| a.len() <= 64) {
            entry["actions"] = json!(
                actions
                    .iter()
                    .filter_map(|a| a["type"].as_str())
                    .collect::<Vec<_>>()
            );
        }
        if op == "cancel" {
            entry["command"] = json!(format!(
                "cancel {}",
                frame["target_id"].as_str().unwrap_or("")
            ));
        }
        match &result {
            Ok(r) => {
                if let Some(data) = r["data_b64"].as_str() {
                    entry["bytes"] = json!(data.len());
                }
                if let Some(text) = r["text"].as_str() {
                    entry["bytes"] = json!(text.len());
                }
                if op == "desktop_clipboard_set" {
                    entry["bytes"] = json!(frame["text"].as_str().map_or(0, str::len));
                }
                for (src, dst) in [
                    ("exit_code", "exit_code"),
                    ("bytes_total", "bytes"),
                    ("bytes_written", "bytes"),
                    ("truncated", "truncated"),
                    ("duration_ms", "duration_ms"),
                ] {
                    if let Some(v) = r.get(src) {
                        entry[dst] = v.clone();
                    }
                }
            }
            Err(e) => entry["error"] = json!(e.message),
        }
        self.record(entry);
        if let Ok(value) = &mut result
            && let Some(object) = value.as_object_mut()
        {
            object.remove("_started");
        }
        result
    }
    fn stop(&self) {
        let _gate = self.process_gate.lock().unwrap();
        for token in self.running.lock().unwrap().values() {
            token.cancel();
        }
        for pid in self.pids.lock().unwrap().values() {
            runner::kill(*pid);
        }
        self.transfers.abandon();
    }
}
struct Computer {
    paths: Paths,
    name: String,
    config: Config,
    state_file: PathBuf,
    config_dir: PathBuf,
    agent_home: PathBuf,
    workdir: PathBuf,
    engine: OnceLock<Arc<Engine>>,
    capabilities: OnceLock<ComputerCapabilities>,
    worker: OnceLock<worker::Worker>,
}
pub fn role(paths: &Paths, name: &str, config: &Config) -> Arc<dyn Role> {
    Arc::new(Computer {
        paths: paths.clone(),
        name: name.into(),
        config: config.clone(),
        state_file: paths.state(name).join("connection-computer.json"),
        config_dir: paths.config(name),
        agent_home: paths.agent_home(name),
        workdir: config
            .computer
            .workdir
            .clone()
            .unwrap_or_else(|| paths.work_root(name, &config.run_as)),
        engine: OnceLock::new(),
        capabilities: OnceLock::new(),
        worker: OnceLock::new(),
    })
}
#[async_trait]
impl Role for Computer {
    fn kind(&self) -> SocketRole {
        SocketRole::Computer
    }
    fn state_file(&self) -> Option<&std::path::Path> {
        Some(&self.state_file)
    }
    fn prerequisites(&self) -> Result<()> {
        if self.config.run_as != crate::instance::RunAs::AgentUser {
            crate::privilege::computer::check_root(
                nix::unistd::geteuid().as_raw(),
                self.config.computer.allow_root,
                &self.name,
            )?;
        }
        if self.config.run_as == crate::instance::RunAs::AgentUser {
            let worker = worker::Worker::start(self)?;
            let capabilities = worker.capabilities();
            let _ = self.capabilities.set(capabilities);
            let _ = self.worker.set(worker);
            return Ok(());
        }
        let state = self.state_file.parent().unwrap();
        let mut reason = None;
        let desktop = if self.config.computer.desktop {
            match crate::desktop::Desktop::launch(
                state,
                self.config.computer.desktop_display.unwrap_or(90),
            ) {
                Ok(d) => Some(Arc::new(d)),
                Err(e) => {
                    reason = Some(e.message.chars().take(256).collect());
                    tracing::warn!(reason=?reason,"Desktop unavailable");
                    None
                }
            }
        } else {
            None
        };
        let _ = self
            .capabilities
            .set(detect_capabilities(desktop.is_some(), reason));
        let engine=Engine::new(self.config.computer.clone(),state.into(),self.config_dir.clone(),self.workdir.clone(),desktop).map_err(|e|Error::new(5,format!("Prepare computer role: {}. Check ownership and permissions of {} and the --workdir setting.",e.message,state.display())))?;
        let _ = self.engine.set(Arc::new(engine));
        Ok(())
    }
    fn machine_name(&self) -> &str {
        &self.config.machine_name
    }
    async fn problems(&self) -> Option<Value> {
        Some(
            crate::doctor::problems(&crate::doctor::Context {
                paths: &self.paths,
                name: &self.name,
                config: Some(&self.config),
            })
            .await,
        )
    }
    fn hello(&self) -> Value {
        let capabilities = self
            .capabilities
            .get()
            .map(|c| ComputerCapabilities {
                python3: c.python3,
                git: c.git,
                skills: c.skills,
                desktop: c.desktop,
                desktop_unavailable_reason: c.desktop_unavailable_reason.clone(),
            })
            .unwrap_or(ComputerCapabilities {
                python3: false,
                git: false,
                skills: false,
                desktop: false,
                desktop_unavailable_reason: None,
            });
        let capabilities = self.worker.get().map_or(capabilities, |w| w.capabilities());
        serde_json::to_value(hello(
            &wire::hostname(),
            wire::os(),
            wire::arch(),
            &format!("agentum-rs@{}", crate::VERSION),
            &self.config.run_as.user(&self.name),
            &self
                .engine
                .get()
                .map(|e| e.policy.work.clone())
                .unwrap_or_else(|| {
                    self.worker
                        .get()
                        .map(|w| w.workdir())
                        .unwrap_or(self.workdir.clone())
                })
                .to_string_lossy(),
            capabilities,
        ))
        .expect("encode hello")
    }
    fn on_frame(&self, frame: Value, reply: Reply) -> Result<()> {
        if let Some(worker) = self.worker.get() {
            return worker.frame(frame, reply);
        }
        let Some(engine) = self.engine.get().cloned() else {
            return Err(Error::new(5, "computer role was not prepared"));
        };
        let id = frame["id"].as_str().unwrap_or("").to_owned();
        let exec = frame["op"] == "exec";
        let refusal = if id.is_empty() {
            Some(Fault::new(
                "bad_request",
                "a nonempty request id is required",
            ))
        } else if exec {
            engine.reserve(&id).err()
        } else {
            None
        };
        let permit = engine.handlers.clone().try_acquire_owned();
        let refusal = refusal.or_else(|| {
            permit.as_ref().err().map(|_| {
                if exec {
                    engine.running.lock().unwrap().remove(&id);
                }
                Fault::new("queue_full", "too many in-flight handlers")
            })
        });
        tokio::spawn(async move {
            let _permit = permit.ok();
            let result = match refusal {
                Some(e) => {
                    engine.record(json!({"op":frame["op"],"request_id":id,"outcome":"error","error":e.message}));
                    Err(e)
                }
                None => engine.dispatch(frame).await,
            };
            let response = encode_reply(&id, result);
            if let Err(error) = reply.send(response).await {
                engine.record(
                    json!({"request_id":id,"outcome":"reply_dropped","error":error.to_string()}),
                );
            }
        });
        Ok(())
    }
    async fn shutdown(&self, reason: Shutdown) {
        if let Some(worker) = self.worker.get() {
            worker.shutdown(reason);
        }
        if let Some(engine) = self.engine.get() {
            engine.transfers.abandon();
            if matches!(reason, Shutdown::Stopped | Shutdown::Revoked) {
                engine.stop();
                if let Some(desktop) = &engine.desktop {
                    desktop.stop();
                }
            }
        }
    }
}
#[cfg(test)]
mod tests;

pub(crate) fn kill_group(pid: u32) {
    runner::kill(pid);
}

pub(crate) fn ensure_directory(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

fn detect_capabilities(desktop: bool, reason: Option<String>) -> ComputerCapabilities {
    let python3 = on_path("python3");
    let git = on_path("git");
    let skills = python3
        && git
        && std::process::Command::new("timeout")
            .args(["10", "python3", "-c", "import pydantic"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    ComputerCapabilities {
        python3,
        git,
        skills,
        desktop,
        desktop_unavailable_reason: reason,
    }
}

fn encode_reply(id: &str, result: OpResult<Value>) -> Value {
    let reply = match result {
        Ok(result) => json!({"id":id,"result":result}),
        Err(e) => json!({"id":id,"error":{"code":e.code,"message":e.message}}),
    };
    bound_reply(reply)
}
fn bound_reply(reply: Value) -> Value {
    if serde_json::to_vec(&reply).map_or(true, |bytes| bytes.len() > 8 << 20) {
        json!({"id":reply["id"],"error":{"code":"frame_too_large","message":"reply exceeds the 8 MiB frame limit"}})
    } else {
        reply
    }
}
