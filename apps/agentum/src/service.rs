//! Per-instance systemd services. All external commands pass through Runner.
use crate::{
    Error, Result,
    cli::{InstallArgs, ServiceCommand},
    instance::{self, Config, Paths, RunAs, atomic_write},
    privilege::{
        self, Problem,
        service::{Commands, Runner, command, output},
    },
};
use std::{
    fs,
    io::{IsTerminal, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

fn problem(problem: Problem, user: &str, name: &str) -> Error {
    Error::new(5, problem.explain(user, name).to_string())
}
fn manager(
    runner: &mut impl Runner,
    system: bool,
    args: &[&str],
    user: &str,
    name: &str,
) -> Result<()> {
    let mut all = vec![];
    if !system {
        all.push("--user");
    }
    all.extend_from_slice(args);
    command(
        runner,
        "systemctl",
        &all,
        &Problem::UserBus.explain(user, name).to_string(),
    )
}
fn ensure_manager(
    runner: &mut impl Runner,
    system: bool,
    root: bool,
    user: &str,
    name: &str,
) -> Result<()> {
    if system && !root {
        return Err(problem(Problem::SystemRoot, user, name));
    }
    if !output(runner, "systemctl", &["--version"]).success {
        return Err(problem(Problem::Systemd, user, name));
    }
    if system {
        command(
            runner,
            "systemctl",
            &["show-environment"],
            &Problem::Systemd.explain(user, name).to_string(),
        )
    } else if !output(runner, "systemctl", &["--user", "show-environment"]).success {
        Err(problem(Problem::UserBus, user, name))
    } else {
        Ok(())
    }
}
fn enable_linger(runner: &mut impl Runner, user: &str, name: &str) -> Result<()> {
    command(
        runner,
        "loginctl",
        &["enable-linger", user],
        &Problem::Linger.explain(user, name).to_string(),
    )
}
fn validate_install(
    config: &Config,
    args: &InstallArgs,
    root: bool,
    user: &str,
    name: &str,
) -> Result<RunAs> {
    let mode = args.run_as.as_ref().unwrap_or(&config.run_as);
    if mode.single_user() != config.single_user {
        return Err(Error::new(
            5,
            "The requested run-as contradicts the stored singleUser. Fix: enrol again with --run-as and a new code from the Machines page.",
        ));
    }
    if (args.system && !config.system) || (args.user && config.system) {
        return Err(Error::new(
            5,
            "The service scope differs from enrolment. Enrol again with --system or use the enrolled scope.",
        ));
    }
    if !config.system && (*mode == RunAs::AgentUser || mode.user(name) != user) {
        return Err(Error::new(
            5,
            format!(
                "A user service runs as {user}. For another user or agent-user, enrol with --system and install a system service."
            ),
        ));
    }
    if config.system && !root {
        return Err(problem(Problem::SystemRoot, user, name));
    }
    Ok(mode.clone())
}
// Freeze `current` under sudo to the invoking account, rather than resolving
// it later as the service account. It then uses the named-user system unit.
fn installed_mode(mode: RunAs, system: bool, sudo_user: Option<&str>) -> RunAs {
    if system
        && mode == RunAs::Current
        && let Some(user) = sudo_user.filter(|user| !user.is_empty())
    {
        return RunAs::User(user.into());
    }
    mode
}
fn service_user(config: &Config, name: &str) -> String {
    match &config.run_as {
        RunAs::User(user) => user.clone(),
        _ => format!("agentum-{name}-svc"),
    }
}
// systemd has its own quoting rules; never interpolate shell code in a unit.
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
fn render_unit(paths: &Paths, name: &str, config: &Config, binary: &Path, home: &str) -> String {
    let mut unit = format!(
        "[Unit]\nDescription=Agentum instance {name}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n"
    );
    if paths.system {
        if config.run_as == RunAs::AgentUser {
            unit.push_str(&format!("Group=agentum-{name}\n"));
        }
        let mode = if config.run_as == RunAs::AgentUser {
            "0710"
        } else {
            "0700"
        };
        unit.push_str(&format!("User={}\nConfigurationDirectory=agentum/{name}\nConfigurationDirectoryMode=0700\nStateDirectory=agentum/{name}\nStateDirectoryMode={mode}\n", service_user(config, name)));
    }
    unit.push_str(&format!(
        "ExecStart={} run --instance {name}\n",
        unit_quote(&binary.display().to_string().replace('$', "$$"))
    ));
    if !paths.system {
        unit.push_str(&format!(
            "Environment={}\nEnvironment={}\n",
            unit_quote(&format!(
                "AGENTUM_CONFIG_DIR={}",
                paths.config_root.display()
            )),
            unit_quote(&format!("AGENTUM_STATE_DIR={}", paths.state_root.display()))
        ));
    }
    unit.push_str(&format!("Environment={}\nEnvironment={}\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=3 4 5\n\n[Install]\nWantedBy={}\n",
        unit_quote(&format!("HOME={home}")),
        unit_quote(&format!("PATH={home}/.local/bin:{home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")),
        if paths.system { "multi-user.target" } else { "default.target" }));
    unit
}
fn account(runner: &mut impl Runner, user: &str) -> Option<(u32, String)> {
    let out = output(runner, "getent", &["passwd", user]);
    if !out.success {
        return None;
    }
    let fields: Vec<_> = out.stdout.trim().split(':').collect();
    Some((fields.get(2)?.parse().ok()?, fields.get(5)?.to_string()))
}
fn create_user(runner: &mut impl Runner, user: &str, home: &Path, shell: &str) -> Result<()> {
    if account(runner, user).is_none() {
        command(
            runner,
            "useradd",
            &[
                "--system",
                "--user-group",
                "--badname",
                "--no-create-home",
                "--home-dir",
                &home.display().to_string(),
                "--shell",
                shell,
                user,
            ],
            "The per-instance service/agent account is required before the service can start.",
        )?;
    }
    Ok(())
}
fn sudoers(name: &str, claude: &str) -> Result<String> {
    if !claude.starts_with('/')
        || !claude
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    {
        return Err(Error::new(
            5,
            "Cannot safely put this Claude path in sudoers. Fix: install Claude at /usr/local/bin/claude and use --claude /usr/local/bin/claude",
        ));
    }
    Ok(format!(
        "agentum-{name}-svc ALL=(agentum-{name}) CWD=* NOPASSWD: SETENV: {claude}, NOSETENV: /bin/mkdir, /bin/rm, /usr/bin/dd, /usr/bin/head, /usr/bin/realpath, /usr/bin/stat, /usr/bin/find, NOSETENV: /bin/sh\n"
    ))
}
fn setup_system(
    runner: &mut impl Runner,
    paths: &Paths,
    name: &str,
    config: &Config,
) -> Result<()> {
    let user = service_user(config, name);
    let home = paths.state(name);
    if matches!(config.run_as, RunAs::User(_)) {
        if account(runner, &user).is_none() {
            return Err(Error::new(
                5,
                format!(
                    "The named user {user} does not exist. Fix: getent passwd {user}; choose an existing --run-as user"
                ),
            ));
        }
    } else {
        create_user(runner, &user, &home, "/usr/sbin/nologin")?;
    }
    // ConfigurationDirectory does not chown existing enrolment files. Do not use
    // recursive chown: an agent's private home belongs to a different account.
    for directory in [paths.config(name), paths.state(name)] {
        command(
            runner,
            "install",
            &["-d", "-m", "0700", &directory.display().to_string()],
            "The instance directory must be private.",
        )?;
        command(
            runner,
            "chown",
            &[&user, &directory.display().to_string()],
            "The service must own its config and state (check_private requires the effective uid).",
        )?;
        command(
            runner,
            "chmod",
            &["0700", &directory.display().to_string()],
            "The instance directory must be private.",
        )?;
    }
    for file in ["config.json", "credential"] {
        let path = paths.config(name).join(file).display().to_string();
        command(
            runner,
            "chown",
            &[&user, &path],
            "The service must own both the config and credential before starting.",
        )?;
        command(
            runner,
            "chmod",
            &["0600", &path],
            "The credential and config must remain private.",
        )?;
    }
    // Foreground runs may already have written state as the enrolling user.
    // Transfer that state without taking ownership of the nested agent home.
    command(
        runner,
        "find",
        &[
            &paths.state(name).display().to_string(),
            "-path",
            &paths.agent_home(name).display().to_string(),
            "-prune",
            "-o",
            "-exec",
            "chown",
            "-h",
            &user,
            "{}",
            "+",
        ],
        "Existing instance state must also belong to the service user; the agent home keeps its separate owner.",
    )?;
    if config.run_as == RunAs::AgentUser {
        let agent = config.run_as.user(name);
        let home = paths.agent_home(name);
        create_user(runner, &agent, &home, "/bin/bash")?;
        for directory in [home, paths.work_root(name, &config.run_as)] {
            command(
                runner,
                "install",
                &["-d", "-m", "0700", &directory.display().to_string()],
                "The agent needs a private home and work tree.",
            )?;
            command(
                runner,
                "chown",
                &[&agent, &directory.display().to_string()],
                "The agent must own its home and work tree.",
            )?;
            command(
                runner,
                "chmod",
                &["0700", &directory.display().to_string()],
                "The agent home and work tree must stay private.",
            )?;
        }
        // The agent home is nested below the service's state directory.
        // Give only the agent group traverse access; no directory listing.
        // Group= in the unit matches this ownership so systemd does not
        // recursively chown the nested agent home when starting the service.
        command(
            runner,
            "chgrp",
            &[&agent, &paths.state(name).display().to_string()],
            "The agent must traverse the parent of its private home.",
        )?;
        command(
            runner,
            "chmod",
            &["0710", &paths.state(name).display().to_string()],
            "Only the service owner and agent group may traverse this state directory.",
        )?;
        let claude = config
            .claude_binary
            .as_deref()
            .unwrap_or("/usr/local/bin/claude");
        let rule = sudoers(name, claude)?;
        let staged = tempfile::NamedTempFile::new()
            .map_err(|_| instance::access_error(Path::new("/etc/sudoers.d")))?;
        fs::write(staged.path(), rule).map_err(|_| instance::access_error(staged.path()))?;
        let staged_path = staged.path().display().to_string();
        command(
            runner,
            "visudo",
            &["-cf", &staged_path],
            "The sudoers rule was rejected, so it has not been installed.",
        )?;
        command(
            runner,
            "install",
            &[
                "-m",
                "0440",
                "-o",
                "root",
                "-g",
                "root",
                &staged_path,
                &format!("/etc/sudoers.d/agentum-{name}"),
            ],
            "Only this instance's service user may sudo to its agent user.",
        )?;
        // Check access only. Never launch the real Claude CLI during installation.
        if config.roles.contains(&crate::wire::MachineRole::AgentHost)
            && !output(
                runner,
                "runuser",
                &["-u", &agent, "--", "/usr/bin/test", "-x", claude],
            )
            .success
        {
            return Err(Error::new(
                5,
                privilege::agent::private_claude(&user, name, claude).to_string(),
            ));
        }
    }
    Ok(())
}
// Root can refresh a service-owned instance without weakening runtime checks.
fn load_config(runner: &mut impl Runner, paths: &Paths, name: &str, root: bool) -> Result<Config> {
    if !paths.system || !root {
        return paths.load(name).map(|(config, _)| config);
    }
    let dir = paths.config(name);
    let bytes = fs::read(dir.join("config.json")).map_err(|_| instance::access_error(&dir))?;
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| {
        Error::new(
            5,
            "Cannot read config. Fix: restore config.json or enrol again",
        )
    })?;
    let owner = account(runner, &service_user(&config, name)).map(|(uid, _)| uid);
    for (path, mode) in [
        (dir.clone(), 0o700),
        (dir.join("config.json"), 0o600),
        (dir.join("credential"), 0o600),
    ] {
        let meta = fs::symlink_metadata(&path).map_err(|_| instance::access_error(&path))?;
        if meta.file_type().is_symlink()
            || meta.mode() & 0o777 != mode
            || (meta.uid() != 0 && Some(meta.uid()) != owner)
        {
            return Err(instance::access_error(&path));
        }
    }
    Ok(config)
}
fn explain_choice(config: &Config, name: &str) -> String {
    let user = if config.system && config.run_as == RunAs::Current {
        service_user(config, name)
    } else {
        config.run_as.user(name)
    };
    if config.run_as == RunAs::AgentUser {
        format!(
            "Agents and computer commands will run as {user}, with a separate home and work tree. Computer commands can read the machine credential, which also opens the agent_host role and /mcp."
        )
    } else {
        format!(
            "Agents will run as {user}. They can read and change anything {user} can, including ~/.ssh. Use --run-as agent-user on a system service to keep them apart."
        )
    }
}
fn confirm(message: &str, yes: bool) -> Result<()> {
    println!("{message}");
    if !yes && std::io::stdin().is_terminal() {
        print!("Continue? [y/N] ");
        std::io::stdout()
            .flush()
            .map_err(|_| Error::new(1, "Cannot write confirmation"))?;
        let mut answer = String::new();
        std::io::stdin()
            .read_line(&mut answer)
            .map_err(|_| Error::new(1, "Cannot read confirmation"))?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            return Err(Error::new(1, "Service installation cancelled"));
        }
    }
    Ok(())
}
fn resolve_binary(binary: &str) -> Option<PathBuf> {
    let candidates = if binary.contains('/') {
        vec![PathBuf::from(binary)]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|path| path.join(binary))
            .collect()
    };
    candidates
        .into_iter()
        .find(|path| {
            fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.mode() & 0o111 != 0)
        })
        .and_then(|path| fs::canonicalize(path).ok())
}
fn unit_error(paths: &Paths, name: &str) -> Error {
    Error::new(5, privilege::Explanation {
        tried: format!("Write or remove {}", paths.unit(name).display()),
        reason: "the unit directory or file is not writable".into(),
        meaning: "Service installation needs permission to manage this instance's unit.".into(),
        fix: if paths.system {
            format!("sudo agentum service install --system --instance {name}")
        } else {
            format!("mkdir -p {0}; chmod u+rwx {0}; agentum service install --user --instance {name}", shell_path(paths.unit(name).parent().unwrap()))
        },
    }.to_string())
}
fn shell_path(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\"'\"'"))
}
fn install(runner: &mut impl Runner, paths: &Paths, name: &str, args: &InstallArgs) -> Result<()> {
    let root = nix::unistd::geteuid().is_root();
    let user = RunAs::Current.user(name);
    if paths.system && !root {
        return Err(problem(Problem::SystemRoot, &user, name));
    }
    let mut config = load_config(runner, paths, name, root)?;
    config.run_as = installed_mode(
        validate_install(&config, args, root, &user, name)?,
        paths.system,
        std::env::var("SUDO_USER").ok().as_deref(),
    );
    if paths.system != config.system {
        return Err(Error::new(
            5,
            "Stored scope differs from its config path. Fix: enrol again with the intended scope.",
        ));
    }
    ensure_manager(runner, paths.system, root, &user, name)?;
    config.computer.apply(&args.computer);
    if let Some(claude) = &args.claude {
        config.claude_binary = Some(claude.clone());
    }
    if config.roles.contains(&crate::wire::MachineRole::AgentHost) {
        let binary = config.claude_binary.as_deref().unwrap_or("claude");
        if let Some(path) = resolve_binary(binary) {
            config.claude_binary = Some(path.display().to_string());
        } else {
            eprintln!(
                "{}",
                Problem::ClaudeMissing.explain(&config.run_as.user(name), name)
            );
        }
    }
    if config.computer.desktop && config.computer.desktop_display.is_none() {
        config.computer.desktop_display = Some(instance::free_display(
            &instance::locations(),
            Path::new("/tmp"),
        )?);
    }
    confirm(&explain_choice(&config, name), args.yes)?;
    if !paths.system {
        let linger = output(
            runner,
            "loginctl",
            &["show-user", &user, "-p", "Linger", "--value"],
        );
        if !linger.success || linger.stdout.trim() != "yes" {
            confirm(
                &format!("{} Enable lingering?", Problem::Linger.explain(&user, name)),
                args.yes,
            )?;
            enable_linger(runner, &user, name)?;
        }
    }
    let binary = std::env::current_exe()
        .map_err(|_| Error::new(5, "Cannot locate agentum. Fix: reinstall the binary"))?;
    let home = if paths.system {
        if matches!(config.run_as, RunAs::User(_)) {
            account(runner, &service_user(&config, name))
                .ok_or_else(|| Error::new(5, "Named user is missing. Fix: getent passwd <user>"))?
                .1
        } else {
            paths.state(name).display().to_string()
        }
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    let unit = render_unit(paths, name, &config, &binary, &home);
    atomic_write(
        &paths.config(name).join("config.json"),
        &serde_json::to_vec_pretty(&config).map_err(|_| Error::new(1, "Cannot encode config"))?,
    )?;
    if paths.system {
        setup_system(runner, paths, name, &config)?;
        command(
            runner,
            "runuser",
            &[
                "-u",
                &service_user(&config, name),
                "--",
                "/usr/bin/test",
                "-x",
                &binary.display().to_string(),
            ],
            "The service user cannot execute agentum from a private home. Install the binary system-wide and rerun sudo agentum service install --system.",
        )?;
    }
    let unit_path = paths.unit(name);
    fs::create_dir_all(unit_path.parent().unwrap()).map_err(|_| unit_error(paths, name))?;
    atomic_write(&unit_path, unit.as_bytes()).map_err(|_| unit_error(paths, name))?;
    fs::set_permissions(&unit_path, fs::Permissions::from_mode(0o644))
        .map_err(|_| unit_error(paths, name))?;
    manager(runner, paths.system, &["daemon-reload"], &user, name)?;
    manager(
        runner,
        paths.system,
        &["enable", &format!("agentum-{name}.service")],
        &user,
        name,
    )?;
    manager(
        runner,
        paths.system,
        &["restart", &format!("agentum-{name}.service")],
        &user,
        name,
    )?;
    println!(
        "Installed agentum-{name}.service. Check it with: agentum service status --instance {name}"
    );
    Ok(())
}
pub fn run(name: Option<&str>, action: ServiceCommand) -> Result<()> {
    let (paths, name) = instance::select(&instance::locations(), name)?;
    let mut runner = Commands;
    if let ServiceCommand::Install(args) = action {
        return install(&mut runner, &paths, &name, &args);
    }
    let user = RunAs::Current.user(&name);
    let root = nix::unistd::geteuid().is_root();
    let mutating = matches!(action, ServiceCommand::Uninstall | ServiceCommand::Restart);
    ensure_manager(&mut runner, paths.system, root || !mutating, &user, &name)?;
    let unit = format!("agentum-{name}.service");
    match action {
        ServiceCommand::Uninstall => {
            manager(
                &mut runner,
                paths.system,
                &["disable", "--now", &unit],
                &user,
                &name,
            )?;
            let path = paths.unit(&name);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(unit_error(&paths, &name)),
            }
            if paths.system {
                let rule = PathBuf::from(format!("/etc/sudoers.d/agentum-{name}"));
                match fs::remove_file(&rule) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(instance::access_error(&rule)),
                }
            }
            manager(&mut runner, paths.system, &["daemon-reload"], &user, &name)?;
            println!(
                "Removed {unit}. Enrolment, state, accounts and lingering were kept. Revoke the machine on the Machines page if it is retired."
            );
        }
        ServiceCommand::Restart => {
            manager(&mut runner, paths.system, &["restart", &unit], &user, &name)?
        }
        ServiceCommand::Status | ServiceCommand::Logs { .. } => {
            query(&mut runner, paths.system, &name, &action)?
        }
        ServiceCommand::Install(_) => unreachable!(),
    }
    Ok(())
}

fn query(
    runner: &mut impl Runner,
    system: bool,
    name: &str,
    action: &ServiceCommand,
) -> Result<()> {
    let unit = format!("agentum-{name}.service");
    let logs = matches!(action, ServiceCommand::Logs { .. });
    let program = if logs { "journalctl" } else { "systemctl" };
    let mut args = vec![];
    if !system {
        args.push("--user".to_owned());
    }
    if logs {
        args.extend(["-u".into(), unit, "--no-pager".into()]);
        if matches!(action, ServiceCommand::Logs { follow: true }) {
            args.push("-f".into());
        }
    } else {
        args.extend(["status".into(), unit, "--no-pager".into()]);
    }
    let result = runner.interact(program, &args);
    if matches!(result, Ok(0)) || (!logs && matches!(result, Ok(3))) {
        return Ok(());
    }
    Err(Error::new(
        5,
        privilege::Explanation {
            tried: format!("{program} {}", args.join(" ")),
            reason: "the service query failed or access to the manager/journal was denied".into(),
            meaning: "Status and logs need access to this instance's service manager and journal."
                .into(),
            fix: if system {
                format!(
                    "sudo agentum service {} --instance {name}",
                    if logs { "logs" } else { "status" }
                )
            } else {
                Problem::UserBus
                    .explain(&RunAs::Current.user(name), name)
                    .fix
            },
        }
        .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privilege::service::Output;
    use crate::{cli::ComputerArgs, instance::RunAs, wire::MachineRole};

    #[derive(Default)]
    struct Fake {
        calls: Vec<Vec<String>>,
        fail: Option<String>,
        missing_accounts: bool,
    }
    impl Runner for Fake {
        fn output(&mut self, program: &str, args: &[String]) -> std::io::Result<Output> {
            let mut call = vec![program.to_owned()];
            call.extend_from_slice(args);
            let line = call.join(" ");
            self.calls.push(call);
            Ok(Output {
                stderr: String::new(),
                success: !(program == "getent" && self.missing_accounts)
                    && self.fail.as_ref().is_none_or(|s| !line.contains(s)),
                stdout: if program == "getent" {
                    format!(
                        "dom:x:{}:1000::/home/dom:/bin/bash\n",
                        nix::unistd::geteuid()
                    )
                } else {
                    "yes\n".into()
                },
            })
        }
    }
    fn config(system: bool, run_as: RunAs) -> Config {
        Config::new(
            "m".into(),
            "office".into(),
            "http://127.0.0.1".into(),
            vec![MachineRole::Computer],
            system,
            run_as,
        )
    }
    fn args() -> InstallArgs {
        InstallArgs {
            user: false,
            system: false,
            run_as: None,
            claude: None,
            yes: true,
            refresh: false,
            computer: ComputerArgs::default(),
        }
    }
    #[test]
    fn units_match_goldens_for_every_mode() {
        let paths = Paths::new("/config".into(), "/state".into(), false);
        for (system, mode, golden) in [
            (
                false,
                RunAs::Current,
                include_str!("service/user-current.golden"),
            ),
            (
                false,
                RunAs::User("dom".into()),
                include_str!("service/user-named.golden"),
            ),
            (
                true,
                RunAs::Current,
                include_str!("service/system-current.golden"),
            ),
            (
                true,
                RunAs::User("dom".into()),
                include_str!("service/system-named.golden"),
            ),
            (
                true,
                RunAs::AgentUser,
                include_str!("service/system-agent.golden"),
            ),
        ] {
            let paths = Paths {
                system,
                ..paths.clone()
            };
            let unit = render_unit(
                &paths,
                "office",
                &config(system, mode),
                Path::new("/opt/agentum"),
                "/home/dom",
            );
            assert_eq!(
                paths.unit("office").file_name().unwrap(),
                "agentum-office.service"
            );
            assert_eq!(unit, golden);
            assert!(unit.contains("RestartPreventExitStatus=3 4 5"));
            assert!(unit.contains("--instance office"));
            for forbidden in ["NoNewPrivileges", "ProtectHome", "ProtectSystem"] {
                assert!(!unit.contains(forbidden));
            }
        }
    }
    #[test]
    fn rejects_incompatible_modes_before_commands() {
        let mut fake = Fake::default();
        let mut a = args();
        a.run_as = Some(RunAs::AgentUser);
        let error = validate_install(&config(false, RunAs::Current), &a, false, "dom", "office")
            .unwrap_err();
        assert!(error.message.contains("enrol again"));
        a.run_as = None;
        a.system = true;
        assert!(
            validate_install(&config(false, RunAs::Current), &a, false, "dom", "office")
                .unwrap_err()
                .message
                .contains("enrol")
        );
        assert!(
            ensure_manager(&mut fake, true, false, "dom", "office")
                .unwrap_err()
                .message
                .contains("sudo agentum service install")
        );
        assert!(fake.calls.is_empty());
    }
    #[test]
    fn permission_failures_explain_and_offer_exact_fixes() {
        for (failure, system, root, expected) in [
            ("systemctl --version", false, false, "foreground"),
            ("show-environment", false, false, "sudo, su or cron"),
            ("enable-linger", false, false, "loginctl enable-linger dom"),
        ] {
            let mut fake = Fake {
                fail: Some(failure.into()),
                ..Fake::default()
            };
            if failure == "enable-linger" {
                assert!(
                    enable_linger(&mut fake, "dom", "office")
                        .unwrap_err()
                        .message
                        .contains(expected)
                );
            } else {
                assert!(
                    ensure_manager(&mut fake, system, root, "dom", "office")
                        .unwrap_err()
                        .message
                        .contains(expected)
                );
            }
        }
        let mut fake = Fake {
            fail: Some("daemon-reload".into()),
            ..Fake::default()
        };
        let error = manager(&mut fake, false, &["daemon-reload"], "dom", "office").unwrap_err();
        assert!(
            error
                .message
                .contains("\'systemctl\' \'--user\' \'daemon-reload\'")
        );
        assert!(error.message.contains("Fix:"));
    }
    #[test]
    fn system_setup_transfers_private_files_before_start() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
        let c = config(true, RunAs::Current);
        paths.save("office", &c, "ag_mach_secret").unwrap();
        let mut fake = Fake::default();
        setup_system(&mut fake, &paths, "office", &c).unwrap();
        let calls: Vec<_> = fake.calls.iter().map(|c| c.join(" ")).collect();
        for path in [
            paths.config("office"),
            paths.config("office").join("config.json"),
            paths.config("office").join("credential"),
            paths.state("office"),
        ] {
            assert!(
                calls
                    .iter()
                    .any(|c| c.starts_with("chown ") && c.contains(&path.display().to_string())),
                "{}",
                path.display()
            );
        }
        assert!(
            calls
                .iter()
                .any(|c| c.contains("getent passwd agentum-office-svc"))
        );
        assert!(!calls.iter().any(|c| c.contains("systemctl")));
        assert!(calls.iter().any(|c| c.starts_with("find ")
            && c.contains("-prune -o -exec chown -h agentum-office-svc {} +")));
    }
    #[test]
    fn system_command_failures_are_actionable() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
        let mut c = config(true, RunAs::AgentUser);
        c.roles.push(MachineRole::AgentHost);
        paths.save("office", &c, "ag_mach_secret").unwrap();
        for failure in ["chown", "chmod", "install -d", "find", "visudo", "runuser"] {
            let mut fake = Fake {
                fail: Some(failure.into()),
                ..Fake::default()
            };
            let error = setup_system(&mut fake, &paths, "office", &c).unwrap_err();
            assert_eq!(error.code, 5);
            assert!(error.message.contains("Fix:"), "{}", error.message);
            if failure == "runuser" {
                assert!(error.message.contains("private home directory"));
            }
        }
        let mut fake = Fake {
            fail: Some("useradd".into()),
            missing_accounts: true,
            ..Fake::default()
        };
        assert!(
            create_user(
                &mut fake,
                "agentum-office",
                Path::new("/home/agent"),
                "/bin/bash"
            )
            .unwrap_err()
            .message
            .contains("useradd")
        );
    }
    #[test]
    fn sudoers_is_per_instance_and_includes_computer_shell() {
        let rule = sudoers("office", "/usr/local/bin/claude").unwrap();
        assert!(rule.contains("agentum-office-svc ALL=(agentum-office)"));
        assert!(rule.contains("NOSETENV: /bin/sh"));
        assert!(!rule.contains("(ALL)"));
        assert!(sudoers("office", "/home/dom/a,b").is_err());
    }
    #[test]
    fn system_config_reload_accepts_only_expected_owner() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
        paths
            .save("office", &config(true, RunAs::Current), "secret")
            .unwrap();
        let mut fake = Fake::default();
        assert!(load_config(&mut fake, &paths, "office", true).is_ok());
        fs::set_permissions(
            paths.config("office").join("credential"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(
            load_config(&mut fake, &paths, "office", true)
                .unwrap_err()
                .code,
            5
        );
    }
    #[test]
    fn queries_use_instance_scope_and_report_permission_failures() {
        let mut fake = Fake::default();
        query(
            &mut fake,
            false,
            "office",
            &ServiceCommand::Logs { follow: true },
        )
        .unwrap();
        assert_eq!(
            fake.calls[0],
            [
                "journalctl",
                "--user",
                "-u",
                "agentum-office.service",
                "--no-pager",
                "-f"
            ]
        );
        query(&mut fake, true, "office", &ServiceCommand::Status).unwrap();
        assert_eq!(
            fake.calls[1],
            [
                "systemctl",
                "status",
                "agentum-office.service",
                "--no-pager"
            ]
        );
        for (system, action, failure, fix) in [
            (
                false,
                ServiceCommand::Status,
                "systemctl",
                "XDG_RUNTIME_DIR",
            ),
            (
                true,
                ServiceCommand::Logs { follow: false },
                "journalctl",
                "sudo agentum service logs --instance office",
            ),
        ] {
            let mut fake = Fake {
                fail: Some(failure.into()),
                ..Fake::default()
            };
            let error = query(&mut fake, system, "office", &action).unwrap_err();
            assert_eq!(error.code, 5);
            assert!(error.message.contains(fix));
        }
    }
    #[test]
    fn agent_user_requires_system_scope_and_private_traversable_home() {
        let c = config(false, RunAs::AgentUser);
        assert!(
            validate_install(&c, &args(), false, "dom", "office")
                .unwrap_err()
                .message
                .contains("system service")
        );
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
        let c = config(true, RunAs::AgentUser);
        paths.save("office", &c, "secret").unwrap();
        let mut fake = Fake::default();
        setup_system(&mut fake, &paths, "office", &c).unwrap();
        assert!(fake.calls.iter().any(|call| call
            == &[
                "chgrp",
                "agentum-office",
                &paths.state("office").display().to_string()
            ]));
        assert!(fake.calls.iter().any(|call| call
            == &[
                "chmod",
                "0710",
                &paths.state("office").display().to_string()
            ]));
        assert!(
            !fake
                .calls
                .iter()
                .any(|call| call.first().is_some_and(|s| s == "runuser")),
            "Computer-only enrolment must not require Claude"
        );
        assert!(
            explain_choice(&c, "office").contains("which also opens the agent_host role and /mcp")
        );
    }
    #[test]
    fn unit_paths_are_quoted_and_write_errors_show_service_fixes() {
        let paths = Paths::new("/config/with space%$".into(), "/state".into(), false);
        let rendered = render_unit(
            &paths,
            "office",
            &config(false, RunAs::Current),
            Path::new("/opt/a %$/agentum"),
            "/home/dom",
        );
        assert!(rendered.contains("ExecStart=\"/opt/a %%$$/agentum\" run --instance office"));
        assert!(rendered.contains("AGENTUM_CONFIG_DIR=/config/with space%%$"));
        assert!(
            unit_error(&paths, "office")
                .message
                .contains("service install --user --instance office")
        );
        let system = Paths {
            system: true,
            ..paths
        };
        assert!(
            unit_error(&system, "office")
                .message
                .contains("sudo agentum service install --system --instance office")
        );
    }
    #[test]
    fn current_under_sudo_is_persisted_as_the_invoking_user() {
        assert_eq!(
            installed_mode(RunAs::Current, true, Some("dom")),
            RunAs::User("dom".into())
        );
        assert_eq!(installed_mode(RunAs::Current, true, None), RunAs::Current);
        assert_eq!(
            installed_mode(RunAs::AgentUser, true, Some("dom")),
            RunAs::AgentUser
        );
        assert_eq!(
            installed_mode(RunAs::Current, false, Some("dom")),
            RunAs::Current
        );
    }
}
