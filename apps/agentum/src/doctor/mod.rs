use crate::{
    instance::{Config, Paths},
    privilege::Problem,
};
use serde::Serialize;
mod claude;
mod computer;
mod instance;
mod network;
mod service;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Warning,
    Problem,
}
#[derive(Serialize)]
pub struct Check {
    pub name: &'static str,
    pub level: Level,
    pub message: String,
}
pub struct Context<'a> {
    pub paths: &'a Paths,
    pub name: &'a str,
    pub config: Option<&'a Config>,
}
impl Context<'_> {
    pub fn problem(&self, name: &'static str, problem: Problem) -> Check {
        let user = self
            .config
            .map(|c| c.run_as.user(self.name))
            .unwrap_or_else(|| "user".into());
        Check {
            name,
            level: Level::Problem,
            message: problem
                .explain_at(&user, self.name, &self.paths.config(self.name))
                .to_string(),
        }
    }
}
pub fn ok(name: &'static str, message: &str) -> Check {
    Check {
        name,
        level: Level::Ok,
        message: message.into(),
    }
}
pub fn skipped(name: &'static str, reason: &str) -> Check {
    Check {
        name,
        level: Level::Warning,
        message: format!("Skipped: {reason}"),
    }
}
// One file per area lets RC.3/4/5 add their checks without editing another role.
pub async fn run(ctx: &Context<'_>) -> Vec<Check> {
    let mut checks = instance::checks(ctx);
    checks.extend(service::checks(ctx).await);
    checks.extend(claude::checks(ctx));
    checks.extend(computer::checks(ctx));
    checks.extend(network::checks(ctx).await);
    checks
}
