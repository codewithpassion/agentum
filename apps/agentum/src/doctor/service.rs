use super::*;
async fn succeeds(args: &[&str]) -> bool {
    matches!(tokio::time::timeout(std::time::Duration::from_secs(5), tokio::process::Command::new(args[0]).args(&args[1..]).kill_on_drop(true).output()).await, Ok(Ok(output)) if output.status.success())
}
pub async fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let mut checks = vec![];
    if !std::path::Path::new("/run/systemd/system").exists() {
        checks.push(ctx.problem("systemd", Problem::Systemd));
    } else {
        checks.push(ok("systemd", "systemd is running"));
    }
    if !ctx.paths.system {
        if succeeds(&["systemctl", "--user", "show-environment"]).await {
            checks.push(ok("user bus", "User manager is reachable"));
        } else {
            checks.push(ctx.problem("user bus", Problem::UserBus));
        }
        let user = ctx
            .config
            .map(|c| c.run_as.user(ctx.name))
            .unwrap_or_else(|| crate::instance::RunAs::Current.user(ctx.name));
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
        let unit = format!("agentum-{}.service", ctx.name);
        let mut args = vec!["systemctl"];
        if !ctx.paths.system {
            args.push("--user");
        }
        args.extend(["is-active", &unit]);
        if succeeds(&args).await {
            checks.push(ok("service", "Instance unit is active"));
        } else {
            checks.push(Check {
                name: "service", level: Level::Warning,
                message: format!("Instance unit is inactive. Inspect with: agentum service status --instance {}; agentum service logs --instance {}", ctx.name, ctx.name),
            });
        }
    } else {
        checks.push(Check {
            name: "service",
            level: Level::Warning,
            message: if ctx.config.is_some() {
                format!("No instance service installed. Install with: agentum service install --instance {}", ctx.name)
            } else {
                "No instance service installed. Enrol an instance before installing its service.".into()
            },
        });
    }
    checks
}
