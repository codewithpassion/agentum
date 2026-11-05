use super::*;
pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let Some(config) = ctx.config else {
        return vec![];
    };
    let mut checks = vec![];
    if config.computer.desktop {
        if ["Xvfb", "openbox", "xdotool", "xclip", "chromium"]
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
        && let Ok(binary) = std::env::current_exe()
    {
        let user = config.run_as.user(ctx.name);
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
