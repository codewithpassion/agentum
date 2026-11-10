//! RC.4 owns agent_host execution. The transport owns socket lifecycle.
pub mod api;
mod executor;
pub mod files;
pub mod helpers;
use crate::{
    Error, Result,
    instance::{Config, Paths, RunAs},
    relay::{Reply, Role, Shutdown, SocketRole},
    wire,
};
use api::{Http, RunApi};
use async_trait::async_trait;
use helpers::{Masker, text};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

struct Slot {
    run: String,
    cancel: CancellationToken,
    changes: mpsc::UnboundedSender<Vec<String>>,
}
#[derive(Default)]
struct State {
    known: HashSet<String>,
    queues: HashMap<String, VecDeque<String>>,
    active: HashMap<String, Slot>,
    stopped: bool,
}
#[derive(Clone)]
struct Host {
    root: PathBuf,
    config: Config,
    credential: String,
    user: Option<String>,
    state: Arc<Mutex<State>>,
    idle: Arc<Notify>,
}
struct AgentHost {
    instance: String,
    paths: Paths,
    state_file: PathBuf,
    host: Host,
    load_error: Option<String>,
    claude_version: Mutex<String>,
}
pub fn role(paths: &Paths, name: &str, config: &Config) -> Arc<dyn Role> {
    let loaded = paths.load(name);
    let load_error = loaded.as_ref().err().map(ToString::to_string);
    let credential = loaded.map(|(_, credential)| credential).unwrap_or_default();
    Arc::new(AgentHost {
        instance: name.into(),
        paths: paths.clone(),
        state_file: paths.state(name).join("connection-agent_host.json"),
        host: Host {
            root: paths.work_root(name, &config.run_as),
            config: config.clone(),
            credential,
            user: if config.run_as == RunAs::AgentUser {
                Some(config.run_as.user(name))
            } else {
                None
            },
            state: Arc::new(Mutex::new(State::default())),
            idle: Arc::new(Notify::new()),
        },
        load_error,
        claude_version: Mutex::new("unknown".into()),
    })
}
impl Host {
    fn offer(&self, agent: String, run: String) {
        self.offer_slot(agent.clone(), run, agent);
    }
    fn offer_subagent(&self, agent: String, run: String) {
        // A subagent has its own session. Ordinary runs keep the per-agent FIFO.
        self.offer_slot(agent, run.clone(), format!("subagent:{run}"));
    }
    fn offer_slot(&self, agent: String, run: String, slot: String) {
        let mut state = self.state.lock().unwrap();
        if state.stopped || !state.known.insert(run.clone()) {
            return;
        }
        state.queues.entry(slot.clone()).or_default().push_back(run);
        drop(state);
        self.pump(agent, slot);
    }
    fn pump(&self, agent: String, slot: String) {
        let mut state = self.state.lock().unwrap();
        if state.active.contains_key(&slot) {
            return;
        }
        let Some(run) = state.queues.get_mut(&slot).and_then(VecDeque::pop_front) else {
            state.queues.remove(&slot);
            return;
        };
        let cancel = CancellationToken::new();
        let (changes, receiver) = mpsc::unbounded_channel();
        state.active.insert(
            slot.clone(),
            Slot {
                run: run.clone(),
                cancel: cancel.clone(),
                changes,
            },
        );
        drop(state);
        let host = self.clone();
        tokio::spawn(async move {
            let initial = Masker::new(&json!({"machine_credential":host.credential}));
            // Claim remains in flight through a cancel, so a claimed run can be completed as aborted.
            let mut api = RunApi::new(
                Http::new(
                    &host.config.server,
                    &host.credential,
                    initial,
                    CancellationToken::new(),
                    30,
                ),
                &run,
            );
            match api.call("claim", None).await {
                Ok(claim) => {
                    if claim["run"]["id"] != run
                        || claim["run"]["agentId"] != agent
                        || !executor::valid_claim(&claim)
                    {
                        tracing::warn!("Claim does not match the offer or protocol");
                    } else {
                        let mut secrets = claim["env"].as_object().cloned().unwrap_or_default();
                        secrets.insert("machine_credential".into(), json!(host.credential));
                        secrets.insert("run_token".into(), claim["runToken"].clone());
                        api.http.masker = Masker::new(&Value::Object(secrets));
                        executor::execute(&host, &claim, api, cancel, receiver).await;
                    }
                }
                Err(error) => tracing::warn!(status = error.status, "Could not claim run"),
            }
            let mut state = host.state.lock().unwrap();
            state.active.remove(&slot);
            state.known.remove(&run);
            drop(state);
            host.idle.notify_waiters();
            host.pump(agent, slot);
        });
    }
    fn cancel(&self, run: &str) {
        let mut state = self.state.lock().unwrap();
        for queue in state.queues.values_mut() {
            queue.retain(|id| id != run);
        }
        for slot in state.active.values() {
            if slot.run == run {
                slot.cancel.cancel();
            }
        }
        if !state.active.values().any(|slot| slot.run == run) {
            state.known.remove(run);
        }
    }
    fn cancel_all(&self, stop: bool) {
        let mut state = self.state.lock().unwrap();
        state.stopped |= stop;
        state.queues.clear();
        let active = state
            .active
            .values()
            .map(|s| s.run.clone())
            .collect::<HashSet<_>>();
        state.known.retain(|r| active.contains(r));
        for slot in state.active.values() {
            slot.cancel.cancel();
        }
    }
    async fn abort_all(&self, stop: bool) {
        self.cancel_all(stop);
        loop {
            let notified = self.idle.notified();
            if self.state.lock().unwrap().active.is_empty() {
                break;
            }
            notified.await;
        }
        self.state.lock().unwrap().known.clear();
    }
}
#[async_trait]
impl Role for AgentHost {
    fn kind(&self) -> SocketRole {
        SocketRole::AgentHost
    }
    fn state_file(&self) -> Option<&std::path::Path> {
        Some(&self.state_file)
    }
    fn prerequisites(&self) -> Result<()> {
        if let Some(error) = &self.load_error {
            return Err(Error::new(5, error));
        }
        let version = crate::claude::prerequisites(
            &self.host.config,
            self.host.user.as_deref(),
            &self.instance,
        )?;
        *self.claude_version.lock().unwrap() = version;
        Ok(())
    }
    fn machine_name(&self) -> &str {
        &self.host.config.machine_name
    }
    async fn problems(&self) -> Option<Value> {
        Some(
            crate::doctor::problems(&crate::doctor::Context {
                paths: &self.paths,
                name: &self.instance,
                config: Some(&self.host.config),
            })
            .await,
        )
    }
    fn hello(&self) -> Value {
        serde_json::to_value(wire::daemon_hello(
            crate::VERSION,
            &self.claude_version.lock().unwrap(),
        ))
        .expect("encode hello")
    }
    fn on_frame(&self, frame: Value, _: Reply) -> Result<()> {
        match text(&frame["type"]) {
            "offer" => {
                if let (Some(agent), Some(run)) =
                    (frame["agentId"].as_str(), frame["runId"].as_str())
                {
                    if frame["subagent"] == true {
                        self.host.offer_subagent(agent.into(), run.into());
                    } else {
                        self.host.offer(agent.into(), run.into());
                    }
                }
            }
            "cancel" => self.host.cancel(text(&frame["runId"])),
            "library_changed" => {
                let paths = frame["paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect::<Vec<_>>();
                for slot in self.host.state.lock().unwrap().active.values() {
                    let _ = slot.changes.send(paths.clone());
                }
            }
            _ => {}
        }
        Ok(())
    }
    async fn shutdown(&self, reason: Shutdown) {
        if reason == Shutdown::Replaced {
            self.host.cancel_all(false);
        } else if reason != Shutdown::Disconnected {
            self.host
                .abort_all(matches!(reason, Shutdown::Stopped | Shutdown::Revoked))
                .await;
        }
    }
}
#[cfg(test)]
mod tests;
