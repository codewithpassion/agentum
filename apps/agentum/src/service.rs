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
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::{Mode, fchmod, mkdirat},
    unistd::{Gid, Uid, fchown},
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
fn require_root(system: bool, root: bool, user: &str, name: &str, action: &str) -> Result<()> {
    if system && !root {
        let mut explanation = Problem::SystemRoot.explain(user, name);
        explanation.fix = format!("sudo agentum service {action} --instance {name} --system");
        // --system is an install flag; other commands discover the scope.
        if action != "install" {
            explanation.fix = format!("sudo agentum service {action} --instance {name}");
        }
        return Err(Error::new(5, explanation.to_string()));
    }
    Ok(())
}
fn user_home(home: Option<&str>) -> Result<String> {
    home.filter(|home| !home.is_empty()).map(str::to_owned).ok_or_else(|| Error::new(5, "HOME is unset or empty; a user service needs its login home for the unit and Claude settings. Fix: log in as the service user and export HOME to that user's absolute home directory."))
}
fn binary_error(binary: &Path) -> Error {
    Error::new(
        5,
        format!(
            "The system agentum binary and every directory above it must be root-owned, not writable by other users, and executable/traversable by the target users. Fix: as root, install -o root -g root -m 0755 {} /usr/local/bin/agentum; then run /usr/local/bin/agentum service install --system.",
            shell_path(binary)
        ),
    )
}
fn check_system_binary(binary: &Path) -> Result<()> {
    for path in binary.ancestors() {
        let meta = fs::symlink_metadata(path).map_err(|_| binary_error(binary))?;
        if meta.uid() != 0
            || meta.mode() & 0o022 != 0
            || meta.mode() & 0o111 != 0o111
            || (path == binary && !meta.is_file())
            || (path != binary && !meta.is_dir())
        {
            return Err(binary_error(binary));
        }
    }
    Ok(())
}
fn check_binary_access(runner: &mut impl Runner, binary: &Path, user: &str) -> Result<()> {
    if !output(
        runner,
        "runuser",
        &[
            "-u",
            user,
            "--",
            "/usr/bin/test",
            "-x",
            &binary.display().to_string(),
        ],
    )
    .success
    {
        return Err(binary_error(binary));
    }
    Ok(())
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
    let explanation = if system {
        Problem::SystemManager
    } else {
        Problem::UserBus
    }
    .explain(user, name);
    command(
        runner,
        "systemctl",
        &all,
        &explanation.meaning,
        &explanation.fix,
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
            &Problem::Systemd.explain(user, name).fix,
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
        &Problem::Linger.explain(user, name).fix,
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
    if config.system && (name.ends_with("-svc") || name.len() > 20) {
        return Err(Error::new(
            5,
            "System instance names must be at most 20 characters and must not end in -svc: generated account names must fit Linux limits and cannot collide with service accounts. Fix: enrol with another name.",
        ));
    }
    Ok(mode.clone())
}
// Freeze `current` under sudo to the invoking account, rather than resolving
// it later as the service account. It then uses the named-user system unit.
fn installed_mode(mode: RunAs, system: bool, sudo_user: Option<&str>) -> Result<RunAs> {
    if let Some(user) = sudo_user {
        let parsed = user.parse::<RunAs>().map_err(|_| Error::new(5, "Invalid SUDO_USER: use an existing user name, as for --run-as. Fix: invoke agentum through sudo from a valid login account."))?;
        if !matches!(parsed, RunAs::User(_)) {
            return Err(Error::new(
                5,
                "Invalid SUDO_USER: expected a literal login user name. Fix: invoke agentum through sudo from a valid login account.",
            ));
        }
        if system && mode == RunAs::Current {
            return Ok(parsed);
        }
    }
    Ok(mode)
}
fn check_root_agents(uid: u32, allow: bool) -> Result<()> {
    if uid == 0 && !allow {
        return Err(Error::new(
            5,
            "Refusing root as the run-as user. Fix: choose an unprivileged --run-as user, or explicitly opt in with --allow-root-agents.",
        ));
    }
    Ok(())
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
        unit.push_str("UMask=0077\n");
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
    unit.push_str(&format!("Environment={}\nEnvironment={}\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=2 3 4 5\n\n[Install]\nWantedBy={}\n",
        unit_quote(&format!("HOME={home}")),
        unit_quote(&format!("PATH={home}/.local/bin:{home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")),
        if paths.system { "multi-user.target" } else { "default.target" }));
    unit
}
struct Account {
    uid: u32,
    gid: u32,
    home: String,
    shell: String,
}
fn account(runner: &mut impl Runner, user: &str) -> Option<Account> {
    let out = output(runner, "getent", &["passwd", user]);
    if !out.success {
        return None;
    }
    let fields: Vec<_> = out.stdout.trim().split(':').collect();
    Some(Account {
        uid: fields.get(2)?.parse().ok()?,
        gid: fields.get(3)?.parse().ok()?,
        home: fields.get(5)?.to_string(),
        shell: fields.get(6)?.to_string(),
    })
}
fn create_user(runner: &mut impl Runner, user: &str, home: &Path, shell: &str) -> Result<()> {
    if let Some(existing) = account(runner, user) {
        if Path::new(&existing.home) != home || existing.shell != shell {
            return Err(Error::new(
                5,
                format!(
                    "Refusing to reuse account {user}: home or shell differs from the per-instance account. Fix: choose another instance name; inspect the existing account with getent passwd {user}."
                ),
            ));
        }
    } else {
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
            "The per-instance account is required before the service can start.",
            "Install the distribution's user management package and resolve account/group conflicts reported by getent passwd and getent group before retrying.",
        )?;
    }
    Ok(())
}
fn unsafe_path(path: &Path) -> Error {
    Error::new(
        5,
        format!(
            "Refusing unsafe path {}: symlink, unexpected owner or mode, hard link, or inaccessible entry. Fix: stop this instance, remove planted links and restore the expected root/service/agent ownership before reinstalling; do not chown a symlink target.",
            path.display()
        ),
    )
}
// Every child is opened relative to a pinned parent; never follow a symlink,
// including between validation and fchown/fchmod. Existing files may not be
// hard linked into a different ownership domain.
fn secure_child(
    parent: &fs::File,
    name: &Path,
    directory: bool,
    owners: &[u32],
    create: bool,
) -> Result<fs::File> {
    let flags = OFlag::O_NOFOLLOW
        | OFlag::O_CLOEXEC
        | if directory {
            OFlag::O_DIRECTORY | OFlag::O_RDONLY
        } else {
            OFlag::O_NONBLOCK | OFlag::O_RDWR
        };
    let fd = match openat(parent, name, flags, Mode::empty()) {
        Ok(fd) => fd,
        Err(nix::errno::Errno::ENOENT) if directory && create => {
            match mkdirat(parent, name, Mode::from_bits_truncate(0o700)) {
                Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                Err(_) => return Err(unsafe_path(name)),
            }
            openat(parent, name, flags, Mode::empty()).map_err(|_| unsafe_path(name))?
        }
        Err(_) => return Err(unsafe_path(name)),
    };
    let file = fs::File::from(fd);
    let meta = file.metadata().map_err(|_| unsafe_path(name))?;
    if !owners.contains(&meta.uid())
        || (if directory {
            !meta.is_dir()
        } else {
            !meta.is_file() || meta.nlink() != 1
        })
    {
        return Err(unsafe_path(name));
    }
    Ok(file)
}
fn system_parent(path: &Path) -> Result<fs::File> {
    let mut parent = fs::File::open("/").map_err(|_| unsafe_path(path))?;
    for part in path.components() {
        match part {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                parent = secure_child(&parent, Path::new(name), true, &[0], false)?;
                if parent.metadata().map_err(|_| unsafe_path(path))?.mode() & 0o022 != 0 {
                    return Err(unsafe_path(path));
                }
            }
            _ => return Err(unsafe_path(path)),
        }
    }
    Ok(parent)
}
fn set_owner(file: &fs::File, uid: u32, gid: Option<u32>, mode: u32) -> Result<()> {
    fchown(file, Some(Uid::from_raw(uid)), gid.map(Gid::from_raw))
        .and_then(|_| fchmod(file, Mode::from_bits_truncate(mode)))
        .map_err(|_| Error::new(5, "Cannot set ownership or mode on the opened instance entry. Fix: use a local filesystem supporting Unix ownership and modes, stop the service, and restore root/service ownership before retrying."))
}
fn transfer_state(directory: &fs::File, uid: u32, gid: u32, skip: Option<&str>) -> Result<()> {
    use std::os::fd::AsRawFd;
    // read_dir enumerates the pinned directory, while openat validates each
    // entry. A rename or symlink swap cannot redirect an ownership operation.
    let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
    for entry in fs::read_dir(&path).map_err(|_| unsafe_path(&path))? {
        let entry = entry.map_err(|_| unsafe_path(&path))?;
        let name = entry.file_name();
        if skip.is_some_and(|skip| name == skip) {
            continue;
        }
        let directory_entry = entry
            .file_type()
            .map_err(|_| unsafe_path(&entry.path()))?
            .is_dir();
        let child = secure_child(
            directory,
            Path::new(&name),
            directory_entry,
            &[0, uid],
            false,
        )?;
        if directory_entry {
            transfer_state(&child, uid, gid, None)?;
        }
        let mode = child
            .metadata()
            .map_err(|_| unsafe_path(&entry.path()))?
            .mode()
            & 0o777;
        set_owner(&child, uid, Some(gid), mode)?;
    }
    Ok(())
}
fn sudoers(name: &str, claude: &str, binary: &Path) -> Result<String> {
    let safe_path = |path: &str| {
        path.starts_with('/')
            && path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    };
    if !safe_path(claude) || !binary.to_str().is_some_and(safe_path) {
        return Err(Error::new(
            5,
            "Cannot safely put this binary path in sudoers. Fix: install agentum at /usr/local/bin/agentum and Claude at /usr/local/bin/claude and use --claude /usr/local/bin/claude",
        ));
    }
    let service = format!("agentum-{name}-svc");
    let agent = format!("agentum-{name}");
    let worker = privilege::computer::worker_rule(&service, &agent, binary);
    Ok(format!(
        "# Piped stream-json must not require or allocate a terminal.\nDefaults:{service} !requiretty, !use_pty\n{service} ALL=({agent}) CWD=* NOPASSWD: SETENV: {claude}, NOSETENV: /bin/kill, /bin/mkdir, /bin/rm, /usr/bin/dd, /usr/bin/head, /usr/bin/realpath, /usr/bin/stat, /usr/bin/find\n{worker}\n"
    ))
}
fn prepare_directories(
    config_parent: &fs::File,
    state_parent: &fs::File,
    name: &str,
    config: &Config,
    service: &Account,
    agent_account: Option<&Account>,
) -> Result<()> {
    let config_dir = secure_child(
        config_parent,
        Path::new(name),
        true,
        &[0, service.uid],
        true,
    )?;
    let state_dir = secure_child(state_parent, Path::new(name), true, &[0, service.uid], true)?;
    for filename in ["config.json", "credential"] {
        let mut file = secure_child(
            &config_dir,
            Path::new(filename),
            false,
            &[0, service.uid],
            false,
        )?;
        if filename == "config.json" {
            // Config is written through the checked descriptor, never through
            // a service-owned pathname that could have been swapped.
            file.set_len(0).map_err(|_| unsafe_path(Path::new(name)))?;
            serde_json::to_writer_pretty(&mut file, config)
                .map_err(|_| unsafe_path(Path::new(name)))?;
        }
        set_owner(&file, service.uid, Some(service.gid), 0o600)?;
    }
    transfer_state(
        &state_dir,
        service.uid,
        service.gid,
        (config.run_as == RunAs::AgentUser).then_some("agent"),
    )?;
    set_owner(&config_dir, service.uid, Some(service.gid), 0o700)?;
    if config.run_as == RunAs::AgentUser {
        let agent_account = agent_account.ok_or_else(|| Error::new(5, "Missing agent account"))?;
        let agent_dir = secure_child(
            &state_dir,
            Path::new("agent"),
            true,
            &[0, agent_account.uid],
            true,
        )?;
        let work = secure_child(
            &agent_dir,
            Path::new("work"),
            true,
            &[0, agent_account.uid],
            true,
        )?;
        set_owner(&work, agent_account.uid, Some(agent_account.gid), 0o700)?;
        set_owner(
            &agent_dir,
            agent_account.uid,
            Some(agent_account.gid),
            0o700,
        )?;
        set_owner(&state_dir, service.uid, Some(agent_account.gid), 0o710)?;
    } else {
        set_owner(&state_dir, service.uid, Some(service.gid), 0o700)?;
    }
    Ok(())
}
fn install_sudoers(
    runner: &mut impl Runner,
    name: &str,
    claude: &str,
    binary: &Path,
) -> Result<()> {
    let rule = sudoers(name, claude, binary)?;
    let staged = tempfile::NamedTempFile::new()
        .map_err(|_| instance::access_error(Path::new("/etc/sudoers.d")))?;
    fs::write(staged.path(), rule).map_err(|_| instance::access_error(staged.path()))?;
    let staged_path = staged.path().display().to_string();
    command(
        runner,
        "visudo",
        &["-cf", &staged_path],
        "The sudoers rule was rejected and has not been installed.",
        "install sudo (including visudo), or use --claude /usr/local/bin/claude with a sudo version supporting CWD and SETENV; inspect the reported syntax error.",
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
        "Restore root ownership and mode 0755 on /etc/sudoers.d, and ensure its filesystem is writable before reinstalling the rule.",
    )?;
    Ok(())
}
fn setup_system(
    runner: &mut impl Runner,
    paths: &Paths,
    name: &str,
    config: &Config,
    binary: &Path,
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
    let service = account(runner, &user).ok_or_else(|| Error::new(5, "Cannot resolve the service account. Fix: check getent passwd and the system account database."))?;
    let config_parent = system_parent(&paths.config_root)?;
    let state_parent = system_parent(&paths.state_root)?;
    let agent_account = if config.run_as == RunAs::AgentUser {
        let agent = config.run_as.user(name);
        create_user(runner, &agent, &paths.agent_home(name), "/bin/bash")?;
        Some(account(runner, &agent).ok_or_else(|| Error::new(5, "Cannot resolve agent account. Fix: check getent passwd and the system account database."))?)
    } else {
        None
    };
    prepare_directories(
        &config_parent,
        &state_parent,
        name,
        config,
        &service,
        agent_account.as_ref(),
    )?;
    if config.run_as == RunAs::AgentUser {
        let agent = config.run_as.user(name);
        let claude = config
            .claude_binary
            .as_deref()
            .unwrap_or("/usr/local/bin/claude");
        install_sudoers(runner, name, claude, binary)?;
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
                privilege::agent::private_claude(&user, name, claude)
                    .with_fix(&private_claude_fix_for_user(runner, name))
                    .to_string(),
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
    instance::validate_name(name)?;
    let dir = paths.config(name);
    // Explain planted links before reading config through one (which could
    // otherwise report a misleading JSON or access error).
    for path in [&dir, &dir.join("config.json"), &dir.join("credential")] {
        let meta = fs::symlink_metadata(path).map_err(|_| unsafe_path(path))?;
        if meta.file_type().is_symlink() {
            return Err(unsafe_path(path));
        }
    }
    let bytes = fs::read(dir.join("config.json")).map_err(|_| instance::access_error(&dir))?;
    let config: Config = serde_json::from_slice(&bytes).map_err(|_| {
        Error::new(
            5,
            "Cannot read config. Fix: restore config.json or enrol again",
        )
    })?;
    let owner = account(runner, &service_user(&config, name)).map(|account| account.uid);
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
            return Err(unsafe_path(&path));
        }
    }
    Ok(config)
}
/// Administrative read accepts root or the configured service owner, with private modes.
pub fn read_config(paths: &Paths, name: &str, action: &str) -> Result<Config> {
    load_config(&mut Commands, paths, name, nix::unistd::geteuid().is_root()).map_err(|error| {
        if paths.system {
            Error::new(error.code, format!("Cannot read private system instance {name}. Why: {} Fix: sudo agentum {action} --instance {name}", error.message.split("Fix:").next().unwrap_or("check ownership and modes")))
        } else { error }
    })
}
pub fn enrollment_locations(mode: &RunAs, name: &str) -> Vec<Paths> {
    let user = mode.user(name);
    enrollment_locations_for(&mut Commands, &user)
}
fn enrollment_locations_for(runner: &mut impl Runner, user: &str) -> Vec<Paths> {
    account(runner, user)
        .map(|account| {
            vec![Paths::new(
                PathBuf::from(&account.home).join(".config/agentum"),
                PathBuf::from(account.home).join(".local/state/agentum"),
                false,
            )]
        })
        .unwrap_or_default()
}
fn private_claude_fix_for_user(runner: &mut impl Runner, name: &str) -> String {
    let source = std::env::var("SUDO_USER")
        .ok()
        .filter(|user| !user.is_empty() && user != "root")
        .and_then(|user| resolve_for_user(runner, "claude", Some(&user)));
    private_claude_fix(name, source.as_deref())
}
fn private_claude_fix(name: &str, source: Option<&Path>) -> String {
    let install = format!(
        "sudo agentum service install --instance {name} --system --run-as agent-user --claude /usr/local/bin/claude"
    );
    match source.and_then(|path| fs::canonicalize(path).ok()) {
        Some(path) => format!(
            "sudo install -m 0755 {} /usr/local/bin/claude; {install}",
            shell_path(&path)
        ),
        None => format!(
            "Install Claude Code system-wide (for example at /usr/local/bin/claude), then run: {install}"
        ),
    }
}
fn explain_choice(config: &Config, name: &str) -> String {
    let user = if config.system && config.run_as == RunAs::Current {
        service_user(config, name)
    } else {
        config.run_as.user(name)
    };
    if config.run_as == RunAs::AgentUser {
        format!(
            "Agents and computer commands will run as {user}, with a separate home and work tree. {}",
            privilege::computer::tty_help(&format!("agentum-{name}-svc"))
        )
    } else if !config.roles.contains(&crate::wire::MachineRole::AgentHost) {
        format!(
            "Computer commands will run as {user}. They can read and change anything {user} can, including ~/.ssh and the machine credential. Use --run-as agent-user on a system service to keep them apart."
        )
    } else {
        format!(
            "Agents will run as {user}. They can read and change anything {user} can, including ~/.ssh. Computer commands can read the machine credential, which also opens the agent_host role and /mcp. Use --run-as agent-user on a system service to keep them apart."
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
fn resolve_for_user(runner: &mut impl Runner, binary: &str, user: Option<&str>) -> Option<PathBuf> {
    if let Some(user) = user {
        let script = format!(
            "PATH=\"$HOME/.local/bin:$PATH\"; command -v {}",
            shell_path(Path::new(binary))
        );
        let out = output(runner, "runuser", &["--login", user, "--command", &script]);
        let path = PathBuf::from(out.stdout.trim());
        if out.success && path.is_absolute() {
            resolve_binary(path.to_str()?)
        } else {
            None
        }
    } else {
        resolve_binary(binary).or_else(|| {
            if binary.contains('/') {
                return None;
            }
            let home = std::env::var_os("HOME")?;
            resolve_binary(
                PathBuf::from(home)
                    .join(".local/bin")
                    .join(binary)
                    .to_str()?,
            )
        })
    }
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
        .and_then(|path| {
            if path.is_absolute() {
                Some(path)
            } else {
                std::env::current_dir().ok().map(|cwd| cwd.join(path))
            }
        })
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
    installed_mode(
        RunAs::Current,
        false,
        std::env::var("SUDO_USER").ok().as_deref(),
    )?;
    let user = RunAs::Current.user(name);
    if paths.system && !root {
        return Err(problem(Problem::SystemRoot, &user, name));
    }
    let mut config = load_config(runner, paths, name, root)?;
    config.run_as = installed_mode(
        validate_install(&config, args, root, &user, name)?,
        paths.system,
        std::env::var("SUDO_USER").ok().as_deref(),
    )?;
    let run_uid = if paths.system {
        if let RunAs::User(ref user) = config.run_as {
            Some(
                account(runner, user)
                    .ok_or_else(|| {
                        Error::new(
                            5,
                            "Named run-as user is missing. Fix: choose an existing --run-as user.",
                        )
                    })?
                    .uid,
            )
        } else {
            None
        }
    } else {
        Some(nix::unistd::geteuid().as_raw())
    };
    if let Some(uid) = run_uid {
        check_root_agents(uid, args.allow_root_agents)?;
    }
    if paths.system != config.system {
        return Err(Error::new(
            5,
            "Stored scope differs from its config path. Fix: enrol again with the intended scope.",
        ));
    }
    let binary = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| Error::new(5, "Cannot locate agentum. Fix: reinstall the binary"))?;
    if paths.system {
        check_system_binary(&binary)?;
    }
    let user_home_value = std::env::var("HOME").ok();
    if !paths.system {
        user_home(user_home_value.as_deref())?;
    }
    ensure_manager(runner, paths.system, root, &user, name)?;
    config.computer.apply(&args.computer);
    if let Some(claude) = &args.claude {
        config.claude_binary = Some(claude.clone());
    }
    if config.roles.contains(&crate::wire::MachineRole::AgentHost) {
        let binary = config.claude_binary.as_deref().unwrap_or("claude");
        let target = paths.system.then(|| config.run_as.user(name));
        if let Some(path) = resolve_for_user(runner, binary, target.as_deref()) {
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
    let home = if paths.system {
        if matches!(config.run_as, RunAs::User(_)) {
            account(runner, &service_user(&config, name))
                .ok_or_else(|| Error::new(5, "Named user is missing. Fix: getent passwd <user>"))?
                .home
        } else {
            paths.state(name).display().to_string()
        }
    } else {
        user_home(user_home_value.as_deref())?
    };
    let unit = render_unit(paths, name, &config, &binary, &home);
    if paths.system {
        // Existing named users can be checked before account/filesystem changes.
        // Generated accounts use the world-executable path checked above.
        if matches!(config.run_as, RunAs::User(_)) {
            check_binary_access(runner, &binary, &service_user(&config, name))?;
        }
        setup_system(runner, paths, name, &config, &binary)?;
    } else {
        atomic_write(
            &paths.config(name).join("config.json"),
            &serde_json::to_vec_pretty(&config)
                .map_err(|_| Error::new(1, "Cannot encode config"))?,
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
pub fn installed(paths: &Paths, name: &str) -> Result<bool> {
    paths
        .unit(name)
        .try_exists()
        .map_err(|error| Error::new(5, format!("Cannot check unit file for {name}: {error}")))
}

pub fn run(name: Option<&str>, action: ServiceCommand) -> Result<()> {
    let (paths, name) = instance::select(&instance::locations(), name).map_err(|mut error| {
        if matches!(action, ServiceCommand::Installed) && error.code == 1 {
            error.code = 5;
        }
        error
    })?;
    if matches!(action, ServiceCommand::Installed) {
        return if installed(&paths, &name)? {
            Ok(())
        } else {
            Err(Error::new(1, "Service is not installed"))
        };
    }
    let mut runner = Commands;
    if let ServiceCommand::Install(args) = action {
        return install(&mut runner, &paths, &name, &args);
    }
    let user = RunAs::Current.user(&name);
    let root = nix::unistd::geteuid().is_root();
    let mutating = matches!(action, ServiceCommand::Uninstall | ServiceCommand::Restart);
    if mutating {
        require_root(
            paths.system,
            root,
            &user,
            &name,
            if matches!(action, ServiceCommand::Uninstall) {
                "uninstall"
            } else {
                "restart"
            },
        )?;
    }
    if !matches!(action, ServiceCommand::Uninstall) {
        ensure_manager(&mut runner, paths.system, root || !mutating, &user, &name)?;
    }
    let unit = format!("agentum-{name}.service");
    match action {
        ServiceCommand::Uninstall => {
            let sudoers = PathBuf::from(format!("/etc/sudoers.d/agentum-{name}"));
            let had_sudoers = paths.system && sudoers.exists();
            uninstall(
                &mut runner,
                paths.system,
                &name,
                &user,
                &paths.unit(&name),
                &sudoers,
            )?;
            println!(
                "Removed {unit}{}.",
                if had_sudoers {
                    " and its sudoers rule"
                } else {
                    ""
                }
            );
            match load_config(&mut runner, &paths, &name, root) {
                Ok(config) => {
                    let lingering = !paths.system && {
                        let linger = output(
                            &mut runner,
                            "loginctl",
                            &["show-user", &user, "-p", "Linger", "--value"],
                        );
                        linger.success && linger.stdout.trim() == "yes"
                    };
                    print!(
                        "{}",
                        uninstall_help(&paths, &name, &config, &user, lingering)
                    );
                }
                Err(error) => println!(
                    "Enrolment, state, accounts and lingering were kept. Cannot show removal steps without the saved config: {error}"
                ),
            }
        }
        ServiceCommand::Restart => {
            manager(&mut runner, paths.system, &["restart", &unit], &user, &name)?
        }
        ServiceCommand::Status | ServiceCommand::Logs { .. } => {
            query(&mut runner, paths.system, &name, &action)?
        }
        ServiceCommand::Install(_) | ServiceCommand::Installed => unreachable!(),
    }
    Ok(())
}

fn uninstall_help(
    paths: &Paths,
    name: &str,
    config: &Config,
    user: &str,
    lingering: bool,
) -> String {
    let sudo = if config.system { "sudo " } else { "" };
    let scope = if config.system { "system" } else { "user" };
    // Match setup_system: named users are never created by this instance.
    let mut users = vec![];
    if config.system && !matches!(config.run_as, RunAs::User(_)) {
        users.push(service_user(config, name));
        if config.run_as == RunAs::AgentUser {
            users.push(config.run_as.user(name));
        }
    }
    users.retain(|created| created != user);
    let mut text = format!(
        "Kept, so you can install the service again with: {sudo}agentum service install --instance {name} --{scope} --run-as {}\n  enrolment  {}\n  state      {} (removing it deletes the agents' working files)\n",
        config.run_as,
        paths.config(name).display(),
        paths.state(name).display(),
    );
    if !users.is_empty() {
        text.push_str(&format!("  users      {}\n", users.join(", ")));
    }
    text.push_str(&format!(
        "To remove this instance for good:\n  1. Revoke {:?} on the Machines page ({}/settings/machines).\n  2. {sudo}rm -r {} {}\n",
        config.machine_name,
        config.server.trim_end_matches('/'),
        shell_path(&paths.config(name)),
        shell_path(&paths.state(name)),
    ));
    if !users.is_empty() {
        // Delete the agent account before its service account.
        users.reverse();
        let commands: Vec<_> = users
            .iter()
            .map(|user| format!("sudo userdel {user}"))
            .collect();
        text.push_str(&format!("  3. {}\n", commands.join(" && ")));
    }
    if !config.system && lingering {
        text.push_str(&format!(
            "  3. loginctl disable-linger {user} # if nothing else of yours needs to keep running after logout\n"
        ));
    }
    text
}

fn uninstall(
    runner: &mut impl Runner,
    system: bool,
    name: &str,
    user: &str,
    unit_path: &Path,
    rule: &Path,
) -> Result<()> {
    let unit = format!("agentum-{name}.service");
    let mut args = vec![];
    if !system {
        args.push("--user");
    }
    args.extend(["show", &unit, "--property=LoadState", "--value"]);
    let state = output(runner, "systemctl", &args);
    let disabled = if state.stdout.trim() == "not-found" {
        Ok(())
    } else {
        let mut args = vec![];
        if !system {
            args.push("--user");
        }
        args.extend(["disable", "--now", &unit]);
        let result = output(runner, "systemctl", &args);
        if result.success
            || result.stderr.contains("does not exist")
            || result.stderr.contains("not loaded")
        {
            Ok(())
        } else {
            Err(Error::new(
                5,
                format!(
                    "Cannot disable {unit}: {}. Fix: inspect systemctl {}status {unit} and resolve the systemd error before retrying uninstall.",
                    result.stderr.trim(),
                    if system { "" } else { "--user " }
                ),
            ))
        }
    };
    // A manager failure must never leave the privilege grant behind.
    for path in system
        .then_some(rule)
        .into_iter()
        .chain(std::iter::once(unit_path))
    {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(instance::access_error(path)),
        }
    }
    disabled?;
    manager(runner, system, &["daemon-reload"], user, name)
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
        failure_message: Option<String>,
        load_state: Option<String>,
    }
    impl Runner for Fake {
        fn output(&mut self, program: &str, args: &[String]) -> std::io::Result<Output> {
            let mut call = vec![program.to_owned()];
            call.extend_from_slice(args);
            let line = call.join(" ");
            self.calls.push(call);
            Ok(Output {
                stderr: self.failure_message.clone().unwrap_or_else(|| {
                    if line.contains("disable") {
                        "Unit does not exist".into()
                    } else {
                        String::new()
                    }
                }),
                success: !(program == "getent" && self.missing_accounts)
                    && self.fail.as_ref().is_none_or(|s| !line.contains(s)),
                stdout: if program == "getent" {
                    format!(
                        "dom:x:{}:1000::/home/dom:/bin/bash\n",
                        nix::unistd::geteuid()
                    )
                } else if line.contains("--property=LoadState") {
                    self.load_state.clone().unwrap_or_else(|| "loaded".into())
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
    #[test]
    fn uninstall_help_for_user_instance_uses_real_paths_and_linger_state() {
        let paths = Paths::new("/home/dom/my config".into(), "/data/state".into(), false);
        let mut config = config(false, RunAs::Current);
        config.machine_name = "Dom's office".into();
        config.server = "https://staging.agentumbot.io/".into();
        let expected = concat!(
            "Kept, so you can install the service again with: agentum service install --instance office --user --run-as current\n",
            "  enrolment  /home/dom/my config/office\n",
            "  state      /data/state/office (removing it deletes the agents' working files)\n",
            "To remove this instance for good:\n",
            "  1. Revoke \"Dom's office\" on the Machines page (https://staging.agentumbot.io/settings/machines).\n",
            "  2. rm -r '/home/dom/my config/office' '/data/state/office'\n",
        );
        assert_eq!(
            uninstall_help(&paths, "office", &config, "dom", false),
            expected
        );
        assert_eq!(
            uninstall_help(&paths, "office", &config, "dom", true),
            format!(
                "{expected}  3. loginctl disable-linger dom # if nothing else of yours needs to keep running after logout\n"
            )
        );
    }
    #[test]
    fn uninstall_help_for_system_agent_user_lists_only_instance_accounts() {
        let paths = Paths::new("/etc/agentum".into(), "/var/lib/agentum".into(), true);
        let mut config = config(true, RunAs::AgentUser);
        config.server = "https://staging.agentumbot.io".into();
        assert_eq!(
            uninstall_help(&paths, "office", &config, "dom", true),
            concat!(
                "Kept, so you can install the service again with: sudo agentum service install --instance office --system --run-as agent-user\n",
                "  enrolment  /etc/agentum/office\n",
                "  state      /var/lib/agentum/office (removing it deletes the agents' working files)\n",
                "  users      agentum-office-svc, agentum-office\n",
                "To remove this instance for good:\n",
                "  1. Revoke \"office\" on the Machines page (https://staging.agentumbot.io/settings/machines).\n",
                "  2. sudo rm -r '/etc/agentum/office' '/var/lib/agentum/office'\n",
                "  3. sudo userdel agentum-office && sudo userdel agentum-office-svc\n",
            )
        );
    }
    #[test]
    fn uninstall_help_for_system_named_user_keeps_the_named_account() {
        let paths = Paths::new("/etc/agentum".into(), "/var/lib/agentum".into(), true);
        let mut config = config(true, RunAs::User("dom".into()));
        config.server = "https://agentumbot.io".into();
        assert_eq!(
            uninstall_help(&paths, "office", &config, "dom", true),
            concat!(
                "Kept, so you can install the service again with: sudo agentum service install --instance office --system --run-as dom\n",
                "  enrolment  /etc/agentum/office\n",
                "  state      /var/lib/agentum/office (removing it deletes the agents' working files)\n",
                "To remove this instance for good:\n",
                "  1. Revoke \"office\" on the Machines page (https://agentumbot.io/settings/machines).\n",
                "  2. sudo rm -r '/etc/agentum/office' '/var/lib/agentum/office'\n",
            )
        );
        config.run_as = RunAs::User("agentum-office-svc".into());
        assert!(!uninstall_help(&paths, "office", &config, "dom", false).contains("userdel"));
    }
    #[test]
    fn uninstall_help_for_system_current_lists_the_service_account_but_never_current_user() {
        let paths = Paths::new("/etc/agentum".into(), "/var/lib/agentum".into(), true);
        let config = config(true, RunAs::Current);
        let help = uninstall_help(&paths, "office", &config, "dom", false);
        assert!(help.contains("--system --run-as current\n"));
        assert!(help.contains("  users      agentum-office-svc\n"));
        assert!(help.ends_with("  3. sudo userdel agentum-office-svc\n"));
        assert!(
            !uninstall_help(&paths, "office", &config, "agentum-office-svc", false)
                .contains("userdel")
        );
    }
    #[test]
    fn enrollment_checks_the_target_users_home() {
        let locations = enrollment_locations_for(&mut Fake::default(), "dom");
        assert_eq!(
            locations[0].config_root,
            Path::new("/home/dom/.config/agentum")
        );
    }
    #[test]
    fn claude_lookup_uses_the_target_login_environment() {
        struct LoginPath(PathBuf);
        impl Runner for LoginPath {
            fn output(&mut self, program: &str, args: &[String]) -> std::io::Result<Output> {
                assert_eq!(program, "runuser");
                assert_eq!(&args[..3], ["--login", "dom", "--command"]);
                assert!(args[3].contains("$HOME/.local/bin:$PATH"));
                assert!(args[3].contains("command -v 'claude'"));
                Ok(Output {
                    success: true,
                    stdout: self.0.display().to_string(),
                    stderr: String::new(),
                })
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("claude");
        fs::write(&binary, "fake executable, never run").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            resolve_for_user(&mut LoginPath(binary.clone()), "claude", Some("dom")),
            Some(binary)
        );
    }
    #[test]
    fn system_read_fixes_never_change_ownership() {
        let paths = Paths::new(
            "/nonexistent/agentum".into(),
            "/nonexistent/state".into(),
            true,
        );
        for action in ["status", "doctor"] {
            let error = read_config(&paths, "office", action).unwrap_err();
            assert!(
                error
                    .message
                    .contains(&format!("sudo agentum {action} --instance office"))
            );
            assert!(!error.message.contains("chown"));
        }
    }
    fn args() -> InstallArgs {
        InstallArgs {
            user: false,
            system: false,
            run_as: None,
            claude: None,
            yes: true,
            allow_root_agents: false,
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
            assert!(unit.contains("RestartPreventExitStatus=2 3 4 5"));
            assert_eq!(unit.contains("UMask=0077"), system);
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
                .contains("Problem: Reload the systemd service definitions")
        );
        assert!(error.message.contains("Fix:"));
    }
    #[test]
    fn sudoers_allows_runtime_commands_and_refuses_other_workers() {
        use crate::privilege::{agent::claude_command, computer::worker_command};
        let binary = Path::new("/usr/local/bin/agentum");
        let rule = sudoers("office", "/usr/local/bin/claude", binary).unwrap();
        assert!(rule.contains("Defaults:agentum-office-svc !requiretty, !use_pty"));
        assert!(!rule.contains("/bin/sh"));
        // Parse the rendered command lists, including sticky tags. No sudo runs.
        let allowed = |command: &std::process::Command| {
            assert_eq!(command.get_program(), "sudo");
            let args = command
                .get_args()
                .map(|a| a.to_str().unwrap())
                .collect::<Vec<_>>();
            let mut i = 0;
            let mut user = "";
            let mut cwd = false;
            let mut env = false;
            while i < args.len() {
                match args[i] {
                    "-u" => {
                        user = args[i + 1];
                        i += 2;
                    }
                    "-D" => {
                        cwd = true;
                        i += 2;
                    }
                    "-n" | "-k" | "-H" | "-l" | "--" => i += 1,
                    a if a.starts_with("--preserve-env=") => {
                        env = true;
                        i += 1;
                    }
                    _ => break,
                }
            }
            rule.lines().any(|line| {
                let Some((head, commands)) = line.split_once(" NOPASSWD: ") else {
                    return false;
                };
                if !head.starts_with(&format!("agentum-office-svc ALL=({user})"))
                    || (cwd && !head.contains("CWD=*"))
                {
                    return false;
                }
                let mut setenv = false;
                commands.split(", ").any(|entry| {
                    let entry = if let Some(e) = entry.strip_prefix("SETENV: ") {
                        setenv = true;
                        e
                    } else if let Some(e) = entry.strip_prefix("NOSETENV: ") {
                        setenv = false;
                        e
                    } else {
                        entry
                    };
                    let words = entry.split_whitespace().collect::<Vec<_>>();
                    !words.is_empty()
                        && i < args.len()
                        && words[0] == args[i]
                        && (!env || setenv)
                        && (words.len() == 1 || words[1..] == args[i + 1..])
                })
            })
        };
        for preserve in [
            vec!["CLAUDE_CODE_ENTRYPOINT".into()],
            vec!["API_KEY".into(), "CLAUDE_CODE_ENTRYPOINT".into()],
        ] {
            let mut command = claude_command(
                "/usr/local/bin/claude",
                Some("agentum-office"),
                Some(Path::new("/work")),
                &preserve,
            );
            command.args(["--input-format", "stream-json"]);
            assert!(allowed(&command));
        }
        for probe in [vec!["--version"], vec!["auth", "status", "--json"]] {
            let mut command =
                claude_command("/usr/local/bin/claude", Some("agentum-office"), None, &[]);
            command.args(probe);
            assert!(allowed(&command));
        }
        for executable in [
            "/bin/mkdir",
            "/bin/rm",
            "/usr/bin/dd",
            "/usr/bin/head",
            "/usr/bin/realpath",
            "/usr/bin/stat",
            "/usr/bin/find",
        ] {
            assert!(allowed(&crate::privilege::agent::disk_process(
                "agentum-office",
                executable,
                &["test".into()]
            )));
        }
        for signal in ["-TERM", "-KILL"] {
            assert!(allowed(&crate::privilege::agent::signal_command(
                "agentum-office",
                123,
                signal
            )));
            assert!(!allowed(&crate::privilege::agent::signal_command(
                "agentum-other",
                123,
                signal
            )));
        }
        assert!(allowed(&worker_command("agentum-office", binary)));
        let mut extra = worker_command("agentum-office", binary);
        extra.arg("--allow-root");
        assert!(!allowed(&extra));
        assert!(!allowed(&worker_command("agentum-other", binary)));
        assert!(sudoers("office", "/home/dom/a,b", binary).is_err());
        assert!(sudoers("office", "/usr/bin/claude", Path::new("/bad path/agentum")).is_err());
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
    fn config_reload_explains_planted_symlinks_before_reading_them() {
        use std::os::unix::fs::symlink;
        for filename in ["config.json", "credential"] {
            let temp = tempfile::tempdir().unwrap();
            let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
            paths
                .save("office", &config(true, RunAs::Current), "secret")
                .unwrap();
            let file = paths.config("office").join(filename);
            let target = temp.path().join("target");
            fs::rename(&file, &target).unwrap();
            symlink(&target, &file).unwrap();
            let error = load_config(&mut Fake::default(), &paths, "office", true).unwrap_err();
            assert!(error.message.contains("symlink"), "{}", error.message);
        }
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
    fn ownership_walk_refuses_planted_symlinks_and_unexpected_owners() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let uid = nix::unistd::geteuid().as_raw();
        let root = fs::File::open(temp.path()).unwrap();
        fs::write(temp.path().join("victim"), "unchanged").unwrap();
        symlink("victim", temp.path().join("credential")).unwrap();
        symlink("/etc/sudoers.d", temp.path().join("agent")).unwrap();
        for (name, directory) in [("credential", false), ("agent", true)] {
            let error = secure_child(&root, Path::new(name), directory, &[uid], false).unwrap_err();
            assert!(error.message.contains("symlink"));
        }
        fs::hard_link(temp.path().join("victim"), temp.path().join("hardlink")).unwrap();
        assert!(secure_child(&root, Path::new("hardlink"), false, &[uid], false).is_err());
        fs::remove_file(temp.path().join("hardlink")).unwrap();
        fs::create_dir(temp.path().join("state")).unwrap();
        assert!(
            secure_child(&root, Path::new("state"), true, &[uid + 1], false)
                .unwrap_err()
                .message
                .contains("unexpected owner")
        );
        let state = secure_child(&root, Path::new("state"), true, &[uid], false).unwrap();
        symlink("../victim", temp.path().join("state/entry")).unwrap();
        assert!(
            transfer_state(&state, uid, uid, None)
                .unwrap_err()
                .message
                .contains("symlink")
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("victim")).unwrap(),
            "unchanged"
        );
    }
    #[test]
    fn claude_resolution_preserves_the_update_symlink() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("claude-v1");
        fs::write(&target, "fake").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        let link = temp.path().join("claude");
        symlink(&target, &link).unwrap();
        assert_eq!(resolve_binary(link.to_str().unwrap()).unwrap(), link);
    }
    #[test]
    fn system_names_and_existing_accounts_are_checked() {
        for name in ["office-svc", "abcdefghijklmnopqrstu"] {
            assert!(
                validate_install(&config(true, RunAs::Current), &args(), true, "dom", name)
                    .unwrap_err()
                    .message
                    .contains("account")
            );
        }
        let mut fake = Fake::default();
        let error =
            create_user(&mut fake, "dom", Path::new("/wrong"), "/usr/sbin/nologin").unwrap_err();
        assert!(error.message.contains("home or shell"));
    }
    #[test]
    fn binary_is_checked_before_any_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("agentum");
        fs::write(&binary, "fake").unwrap();
        let error = check_system_binary(&binary).unwrap_err();
        assert!(error.message.contains("/usr/local/bin"));
        let mut fake = Fake::default();
        assert!(check_binary_access(&mut fake, Path::new("/usr/bin/true"), "dom").is_ok());
        fake.fail = Some("runuser".into());
        assert!(
            check_binary_access(&mut fake, Path::new("/usr/bin/true"), "dom")
                .unwrap_err()
                .message
                .contains("/usr/local/bin")
        );
    }
    #[test]
    fn status_accepts_installed_inactive_units_but_rejects_missing_units() {
        struct Status(i32);
        impl Runner for Status {
            fn output(&mut self, _: &str, _: &[String]) -> std::io::Result<Output> {
                panic!("status should use interact");
            }
            fn interact(&mut self, program: &str, args: &[String]) -> std::io::Result<i32> {
                assert_eq!(program, "systemctl");
                assert!(args.ends_with(&[
                    "status".into(),
                    "agentum-office.service".into(),
                    "--no-pager".into(),
                ]));
                Ok(self.0)
            }
        }
        for system in [false, true] {
            for (code, installed) in [(0, true), (3, true), (4, false), (1, false)] {
                assert_eq!(
                    query(&mut Status(code), system, "office", &ServiceCommand::Status).is_ok(),
                    installed
                );
            }
        }
    }
    #[test]
    fn system_manager_and_subcommand_fixes_are_specific() {
        let mut fake = Fake {
            fail: Some("restart".into()),
            failure_message: Some("Unit agentum-office.service not found.\n".into()),
            ..Fake::default()
        };
        let error = manager(
            &mut fake,
            true,
            &["restart", "agentum-office.service"],
            "dom",
            "office",
        )
        .unwrap_err();
        assert!(
            error
                .message
                .starts_with("Problem: Restart agentum-office.service\n")
        );
        assert!(
            error
                .message
                .contains("Why: Unit agentum-office.service not found. ")
        );
        assert!(!error.message.contains("not found.."));
        assert!(!error.message.contains("XDG_RUNTIME_DIR"));
        for action in ["uninstall", "restart"] {
            let error = require_root(true, false, "dom", "office", action).unwrap_err();
            assert!(
                error
                    .message
                    .contains(&format!("sudo agentum service {action}"))
            );
        }
    }
    #[test]
    fn uninstall_twice_removes_rules_even_when_the_unit_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let unit = temp.path().join("unit");
        let rule = temp.path().join("rule");
        fs::write(&unit, "unit").unwrap();
        fs::write(&rule, "rule").unwrap();
        let mut fake = Fake {
            fail: Some("disable".into()),
            ..Fake::default()
        };
        for _ in 0..2 {
            uninstall(&mut fake, true, "office", "dom", &unit, &rule).unwrap();
            assert!(!unit.exists());
            assert!(!rule.exists());
        }
    }
    #[test]
    fn uninstall_skips_unloaded_units_and_removes_rules_after_manager_failure() {
        let temp = tempfile::tempdir().unwrap();
        let rule = temp.path().join("rule");
        let unit = temp.path().join("unit");
        let mut fake = Fake {
            load_state: Some("not-found".into()),
            ..Fake::default()
        };
        fs::write(&rule, "rule").unwrap();
        uninstall(&mut fake, true, "office", "dom", &unit, &rule).unwrap();
        assert!(
            !fake
                .calls
                .iter()
                .any(|call| call.iter().any(|arg| arg == "disable"))
        );
        let mut fake = Fake {
            fail: Some("disable".into()),
            failure_message: Some("access denied".into()),
            ..Fake::default()
        };
        fs::write(&rule, "rule").unwrap();
        assert!(uninstall(&mut fake, true, "office", "dom", &unit, &rule).is_err());
        assert!(!rule.exists());
    }
    #[test]
    fn warning_and_home_explanation_match_the_mode() {
        assert!(
            !explain_choice(&config(true, RunAs::AgentUser), "office")
                .contains("can read the machine credential")
        );
        for mode in [RunAs::Current, RunAs::User("dom".into())] {
            let mut config = config(true, mode);
            config.roles.push(crate::wire::MachineRole::AgentHost);
            let warning = explain_choice(&config, "office");
            assert!(warning.contains("can read the machine credential"));
            assert!(warning.contains("also opens the agent_host role and /mcp"));
        }
        assert!(user_home(None).unwrap_err().message.contains("HOME"));
        assert!(user_home(Some("")).is_err());
    }
    #[test]
    fn computer_only_warning_does_not_claim_agent_host_access() {
        let mut config = config(false, RunAs::Current);
        config.roles = vec![crate::wire::MachineRole::Computer];
        let warning = explain_choice(&config, "office");
        assert!(warning.contains("Computer commands will run as"));
        assert!(warning.contains("can read and change anything"));
        assert!(!warning.contains("agent_host"));
        assert!(!warning.contains("/mcp"));
    }

    #[test]
    fn private_claude_fix_copies_the_resolved_binary_before_installing() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("claude-v1");
        fs::write(&binary, "fake").unwrap();
        let link = temp.path().join("claude");
        std::os::unix::fs::symlink(&binary, &link).unwrap();
        let fix = private_claude_fix("office", Some(&link));
        assert!(fix.starts_with(&format!(
            "sudo install -m 0755 {} /usr/local/bin/claude",
            shell_path(&binary)
        )));
        assert!(fix.ends_with("--claude /usr/local/bin/claude"));
        assert!(private_claude_fix("office", None).starts_with("Install Claude Code system-wide"));
    }

    #[test]
    fn root_agents_opt_in_is_an_install_flag() {
        use clap::Parser;
        assert!(
            crate::cli::Cli::try_parse_from([
                "agentum",
                "service",
                "install",
                "--allow-root-agents"
            ])
            .is_ok()
        );
    }
    #[test]
    fn sudo_user_is_validated_and_root_requires_explicit_opt_in() {
        for user in ["-root", "bad user", "root\n", "current", "agent-user", ""] {
            assert!(installed_mode(RunAs::Current, true, Some(user)).is_err());
        }
        assert!(
            check_root_agents(0, false)
                .unwrap_err()
                .message
                .contains("--allow-root-agents")
        );
        assert!(check_root_agents(0, true).is_ok());
        assert!(check_root_agents(1000, false).is_ok());
    }
    #[test]
    fn descriptor_setup_keeps_private_modes_and_skips_agent_contents() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
        let c = config(true, RunAs::AgentUser);
        paths.save("office", &c, "secret").unwrap();
        fs::create_dir_all(paths.state("office").join("agent")).unwrap();
        symlink(
            "/etc/shadow",
            paths.state("office").join("agent").join("untouched"),
        )
        .unwrap();
        let service = Account {
            uid: nix::unistd::geteuid().as_raw(),
            gid: nix::unistd::getegid().as_raw(),
            home: String::new(),
            shell: String::new(),
        };
        let config_parent = fs::File::open(&paths.config_root).unwrap();
        let state_parent = fs::File::open(&paths.state_root).unwrap();
        prepare_directories(
            &config_parent,
            &state_parent,
            "office",
            &c,
            &service,
            Some(&service),
        )
        .unwrap();
        for (path, mode) in [
            (paths.config("office"), 0o700),
            (paths.config("office").join("credential"), 0o600),
            (paths.config("office").join("config.json"), 0o600),
            (paths.state("office"), 0o710),
            (paths.state("office").join("agent"), 0o700),
            (paths.state("office").join("agent").join("work"), 0o700),
        ] {
            let meta = fs::metadata(&path).unwrap();
            assert_eq!(meta.uid(), service.uid);
            assert_eq!(meta.mode() & 0o777, mode, "{}", path.display());
        }
        assert_eq!(
            fs::read_link(paths.state("office").join("agent").join("untouched")).unwrap(),
            Path::new("/etc/shadow")
        );
    }
    #[test]
    fn ownership_useradd_and_visudo_failures_have_distinct_fixes() {
        let mut fake = Fake {
            fail: Some("useradd".into()),
            missing_accounts: true,
            ..Fake::default()
        };
        let error = create_user(
            &mut fake,
            "agentum-office",
            Path::new("/home/agent"),
            "/bin/bash",
        )
        .unwrap_err();
        assert!(error.message.contains("user management package"));
        let mut fake = Fake {
            fail: Some("visudo".into()),
            ..Fake::default()
        };
        let error = install_sudoers(
            &mut fake,
            "office",
            "/usr/local/bin/claude",
            Path::new("/usr/local/bin/agentum"),
        )
        .unwrap_err();
        assert!(error.message.contains("install sudo"));
        assert!(!fake.calls.iter().any(|call| call[0] == "install"));
        // An unprivileged test cannot chown to uid 0. Exercise the syscall
        // failure through an opened temporary file, without external commands.
        if !nix::unistd::geteuid().is_root() {
            let file = tempfile::tempfile().unwrap();
            let error = set_owner(&file, 0, None, 0o600).unwrap_err();
            assert!(
                error
                    .message
                    .contains("filesystem supporting Unix ownership")
            );
        }
    }
    #[test]
    fn current_under_sudo_is_persisted_as_the_invoking_user() {
        assert_eq!(
            installed_mode(RunAs::Current, true, Some("dom")).unwrap(),
            RunAs::User("dom".into())
        );
        assert_eq!(
            installed_mode(RunAs::Current, true, None).unwrap(),
            RunAs::Current
        );
        assert_eq!(
            installed_mode(RunAs::AgentUser, true, Some("dom")).unwrap(),
            RunAs::AgentUser
        );
        assert_eq!(
            installed_mode(RunAs::Current, false, Some("dom")).unwrap(),
            RunAs::Current
        );
    }
}
