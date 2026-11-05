use super::*;
async fn succeeds(args: &[&str]) -> bool {
    matches!(tokio::time::timeout(std::time::Duration::from_secs(5), tokio::process::Command::new(args[0]).args(&args[1..]).kill_on_drop(true).output()).await, Ok(Ok(output)) if output.status.success())
}
pub async fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let mut checks = vec![];
    if !std::path::Path::new("/run/systemd/system").exists() {
        checks.push(ctx.problem("systemd", Problem::Systemd));
        return checks;
    }
    checks.push(ok("systemd", "systemd is running"));
    if !ctx.paths.system {
        if succeeds(&["systemctl", "--user", "show-environment"]).await {
            checks.push(ok("user bus", "User manager is reachable"));
        } else {
            checks.push(ctx.problem("user bus", Problem::UserBus));
        }
        let user = ctx
            .config
            .map(|c| c.run_as.user(ctx.name))
            .unwrap_or_else(|| "user".into());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::process::Command::new("loginctl")
                .args(["show-user", &user, "-p", "Linger", "--value"])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        if matches!(result, Ok(Ok(out)) if out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "yes")
        {
            checks.push(ok("linger", "User services survive logout"));
        } else {
            checks.push(ctx.problem("linger", Problem::Linger));
        }
    }
    if ctx.paths.unit(ctx.name).exists() {
        checks.push(ok("service", "Instance unit exists"));
    } else {
        checks.push(Check {
            name: "service",
            level: Level::Warning,
            message: "No instance service installed. RC.3 service install: not built yet".into(),
        });
    }
    checks
}
