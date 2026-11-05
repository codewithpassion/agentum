use super::*;
use crate::{claude, wire::MachineRole};

pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let Some(config) = ctx
        .config
        .filter(|c| c.roles.contains(&MachineRole::AgentHost))
    else {
        return vec![];
    };
    let user = if config.run_as == crate::instance::RunAs::AgentUser {
        Some(config.run_as.user(ctx.name))
    } else {
        None
    };
    match claude::prerequisites(config, user.as_deref(), ctx.name) {
        Ok(_) => vec![ok(
            "claude",
            "Claude CLI >=2.1.300 is executable and logged in for the run-as user",
        )],
        Err(e) => vec![Check {
            name: "claude",
            level: Level::Problem,
            message: e.message,
        }],
    }
}
