//! RC.5 owns computer commands, policy, audit and desktop integration.
pub mod files;
use crate::{
    Error, Result,
    instance::{Config, Paths},
    privilege::{Problem, on_path},
    relay::{Reply, Role, Shutdown, SocketRole},
    wire::{self, ComputerCapabilities, ComputerHello},
};
use async_trait::async_trait;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
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
struct Computer {
    name: String,
    config: Config,
    state_file: PathBuf,
    workdir: PathBuf,
}
pub fn role(paths: &Paths, name: &str, config: &Config) -> Arc<dyn Role> {
    Arc::new(Computer {
        name: name.into(),
        config: config.clone(),
        state_file: paths.state(name).join("connection-computer.json"),
        workdir: config
            .computer
            .workdir
            .clone()
            .unwrap_or_else(|| paths.work_root(name, &config.run_as)),
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
        if nix::unistd::geteuid().is_root() && !self.config.computer.allow_root {
            return Err(Error::new(
                5,
                Problem::Root
                    .explain(&self.config.run_as.user(&self.name), &self.name)
                    .to_string(),
            ));
        }
        Ok(())
    }
    fn hello(&self) -> Value {
        serde_json::to_value(hello(
            &wire::hostname(),
            wire::os(),
            wire::arch(),
            crate::VERSION,
            &self.config.run_as.user(&self.name),
            &self.workdir.to_string_lossy(),
            ComputerCapabilities {
                python3: on_path("python3"),
                git: on_path("git"),
                skills: false,
                desktop: false,
                desktop_unavailable_reason: self
                    .config
                    .computer
                    .desktop
                    .then(|| "desktop: not built yet".into()),
            },
        ))
        .expect("encode hello")
    }
    fn on_frame(&self, frame: Value, _: Reply) -> Result<()> {
        tracing::info!(
            role = "computer",
            frame_type = frame["type"].as_str().unwrap_or("unknown"),
            "Frame handler: not built yet"
        );
        Ok(())
    }
    async fn shutdown(&self, reason: Shutdown) {
        tracing::info!(role = "computer", ?reason, "Role shutdown");
    }
}
