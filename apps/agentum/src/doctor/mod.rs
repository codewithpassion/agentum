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
impl std::fmt::Display for Check {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?}: {}: {}",
            self.level,
            self.name,
            self.message
                .strip_prefix("Problem: ")
                .unwrap_or(&self.message)
        )
    }
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
    checks.extend(instance::connections(ctx));
    checks.extend(service::checks(ctx).await);
    checks.extend(claude::checks(ctx));
    checks.extend(computer::checks(ctx));
    checks.extend(network::checks(ctx).await);
    checks
}

/// The failed checks a running role sends in its hello. The server check is left out,
/// because the role is already connected to it. Each message carries its own fix.
pub async fn problems(ctx: &Context<'_>) -> serde_json::Value {
    let mut checks = instance::checks(ctx);
    checks.extend(instance::connections(ctx));
    checks.extend(service::checks(ctx).await);
    checks.extend(claude::checks(ctx));
    checks.extend(computer::checks(ctx));
    checks
        .into_iter()
        .filter(|check| matches!(check.level, Level::Problem))
        .take(20)
        .map(|check| {
            serde_json::json!({
                "name": check.name,
                "message": truncate(check.message.strip_prefix("Problem: ").unwrap_or(&check.message), 2000),
            })
        })
        .collect()
}
/// The server counts UTF-16 units against 2000, and a char is at most two of them.
fn truncate(text: &str, max_units: usize) -> String {
    text.chars().take(max_units / 2).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failing_checks_render_one_problem_with_their_own_fix() {
        let check = Check {
            name: "claude login",
            level: Level::Problem,
            message: Problem::ClaudeLogin.explain("dom", "office").to_string(),
        };
        assert_eq!(
            check.to_string(),
            "Problem: claude login: Check claude login\nWhy: the run-as user is not logged in. Agents need that user's Claude login and settings.\nFix: sudo -iu dom claude auth login"
        );
    }
}
