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
                "Desktop programs found; RC.5 adds the sandbox check",
            ));
        } else {
            checks.push(ctx.problem("desktop packages", Problem::Desktop));
        }
    }
    if config.roles.contains(&crate::wire::MachineRole::Computer)
        && nix::unistd::geteuid().is_root()
        && !config.computer.allow_root
    {
        checks.push(ctx.problem("computer user", Problem::Root));
    }
    checks
}
