use super::*;
use crate::wire::MachineRole;
pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    if !ctx
        .config
        .is_some_and(|c| c.roles.contains(&MachineRole::AgentHost))
    {
        return vec![];
    }
    let binary = ctx
        .config
        .and_then(|c| c.claude_binary.as_deref())
        .unwrap_or("claude");
    if !(crate::privilege::on_path(binary) || std::path::Path::new(binary).is_file()) {
        return vec![ctx.problem("claude", Problem::ClaudeMissing)];
    }
    // Never launch Claude in RC.2, including --version or auth probes. RC.4 adds
    // opt-in driver checks; a normal test run must never consume Claude tokens.
    vec![Check { name: "claude", level: Level::Warning, message: "Claude binary found. Version >=2.1.300, run-as access and login checks: not built yet (RC.4)".into() }]
}
