use super::*;
pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let Some(config) = ctx.config else {
        return vec![skipped("computer", "no enrolled computer role to check")];
    };
    if !config.roles.contains(&crate::wire::MachineRole::Computer) {
        return vec![skipped("computer", "this instance has no computer role")];
    }
    let mut checks = vec![ok("computer", "Computer policy and limits loaded")];
    if config.computer.desktop {
        if crate::desktop::required_binaries(!config.computer.allow_apps.is_empty())
            .iter()
            .all(|name| crate::privilege::on_path(name))
        {
            checks.push(ok(
                "desktop packages",
                "Desktop programs found; startup also checks the private X display and Chromium sandbox",
            ));
        } else {
            checks.push(ctx.problem("desktop packages", Problem::Desktop));
        }
    }
    if config.roles.contains(&crate::wire::MachineRole::Computer)
        && nix::unistd::geteuid().is_root()
        && config.run_as != crate::instance::RunAs::AgentUser
        && !config.computer.allow_root
    {
        checks.push(ctx.problem("computer user", Problem::Root));
    }
    if config.roles.contains(&crate::wire::MachineRole::Computer)
        && config.run_as == crate::instance::RunAs::AgentUser
        && let Ok(binary) = std::env::current_exe().and_then(std::fs::canonicalize)
    {
        let user = config.run_as.user(ctx.name);
        checks.push(Check {
            name: "computer sudo terminal",
            level: Level::Warning,
            message: crate::privilege::computer::tty_help(&format!("{user}-svc")),
        });
        if std::process::Command::new("sudo")
            .args(["-k", "-n", "-l", "-u", &user, "--"])
            .arg(&binary)
            .arg("--computer-worker")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            checks.push(ok(
                "computer run-as",
                "The fixed computer worker is permitted as the agent user",
            ));
        } else {
            checks.push(Check {
                name: "computer run-as",
                level: Level::Problem,
                message: crate::privilege::computer::worker_fix(&user, &binary),
            });
        }
    }
    checks
}
