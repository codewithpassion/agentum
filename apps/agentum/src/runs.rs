//! RC.4 owns agent_host frame handling. The transport owns socket lifecycle.
pub mod files;
use crate::{
    Result,
    instance::{Config, Paths},
    relay::{Reply, Role, Shutdown, SocketRole},
    wire,
};
use async_trait::async_trait;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
struct AgentHost {
    state_file: PathBuf,
    _work_root: PathBuf,
}
pub fn role(paths: &Paths, name: &str, config: &Config) -> Arc<dyn Role> {
    Arc::new(AgentHost {
        state_file: paths.state(name).join("connection-agent_host.json"),
        _work_root: paths.work_root(name, &config.run_as),
    })
}
#[async_trait]
impl Role for AgentHost {
    fn kind(&self) -> SocketRole {
        SocketRole::AgentHost
    }
    fn state_file(&self) -> Option<&std::path::Path> {
        Some(&self.state_file)
    }
    fn hello(&self) -> Value {
        serde_json::to_value(wire::daemon_hello(crate::VERSION, "not-built-yet"))
            .expect("encode hello")
    }
    fn on_frame(&self, frame: Value, _: Reply) -> Result<()> {
        tracing::info!(
            role = "agent_host",
            frame_type = frame["type"].as_str().unwrap_or("unknown"),
            "Frame handler: not built yet"
        );
        Ok(())
    }
    async fn shutdown(&self, reason: Shutdown) {
        tracing::info!(role = "agent_host", ?reason, "Role shutdown");
    }
}
