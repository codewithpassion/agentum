use crate::{Error, Result, cli::ComputerArgs, wire::MachineRole};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunAs {
    #[default]
    Current,
    AgentUser,
    User(String),
}
impl std::fmt::Display for RunAs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Current => "current",
            Self::AgentUser => "agent-user",
            Self::User(user) => user,
        })
    }
}
impl FromStr for RunAs {
    type Err = String;
    fn from_str(value: &str) -> std::result::Result<Self, String> {
        match value {
            "current" => Ok(Self::Current),
            "agent-user" => Ok(Self::AgentUser),
            value
                if !value.is_empty()
                    && value.len() <= 32
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    && !value.starts_with('-') =>
            {
                Ok(Self::User(value.into()))
            }
            _ => Err("use current, agent-user or an existing user name".into()),
        }
    }
}
impl RunAs {
    pub fn single_user(&self) -> bool {
        *self != Self::AgentUser
    }
    pub fn user(&self, instance: &str) -> String {
        match self {
            Self::Current => {
                if nix::unistd::geteuid().is_root()
                    && let Ok(user) = std::env::var("SUDO_USER")
                    && !user.is_empty()
                {
                    return user;
                }
                let uid = nix::unistd::getuid();
                nix::unistd::User::from_uid(uid)
                    .ok()
                    .flatten()
                    .map(|u| u.name)
                    .or_else(|| {
                        std::process::Command::new("getent")
                            .args(["passwd", &uid.to_string()])
                            .output()
                            .ok()
                            .filter(|o| o.status.success())
                            .and_then(|o| String::from_utf8(o.stdout).ok())
                            .and_then(|s| s.split(':').next().map(str::to_owned))
                    })
                    .unwrap_or_else(|| uid.to_string())
            }
            Self::AgentUser => format!("agentum-{instance}"),
            Self::User(name) => name.clone(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct ComputerConfig {
    pub workdir: Option<PathBuf>,
    pub allow_root: bool,
    pub read_only: bool,
    pub workdir_only: bool,
    pub max_concurrent: usize,
    pub max_queue: usize,
    pub max_exec_seconds: u64,
    pub max_file_bytes: u64,
    pub audit_max_bytes: u64,
    pub audit_keep: i32,
    pub desktop: bool,
    pub desktop_display: Option<u16>,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub allow_env: Vec<String>,
}
impl Default for ComputerConfig {
    fn default() -> Self {
        Self {
            workdir: None,
            allow_root: false,
            read_only: false,
            workdir_only: false,
            max_concurrent: 4,
            max_queue: 32,
            max_exec_seconds: 1800,
            max_file_bytes: 256 << 20,
            audit_max_bytes: 8 << 20,
            audit_keep: 3,
            desktop: false,
            desktop_display: None,
            allow: vec![],
            deny: vec![],
            allow_env: vec![],
        }
    }
}
impl ComputerConfig {
    pub fn apply(&mut self, args: &ComputerArgs) {
        macro_rules! options { ($($key:ident),*) => { $(if let Some(value) = &args.$key { self.$key = value.clone(); })* }; }
        options!(
            max_concurrent,
            max_queue,
            max_exec_seconds,
            max_file_bytes,
            audit_max_bytes,
            audit_keep
        );
        if args.workdir.is_some() {
            self.workdir = args.workdir.clone();
        }
        if args.desktop_display.is_some() {
            self.desktop_display = args.desktop_display;
        }
        for (stored, yes, no) in [
            (&mut self.allow_root, args.allow_root, args.no_allow_root),
            (&mut self.read_only, args.read_only, args.no_read_only),
            (
                &mut self.workdir_only,
                args.workdir_only,
                args.no_workdir_only,
            ),
            (&mut self.desktop, args.desktop, args.no_desktop),
        ] {
            if yes || no {
                *stored = yes;
            }
        }
        for (stored, given, clear) in [
            (&mut self.allow, &args.allow, args.clear_allow),
            (&mut self.deny, &args.deny, args.clear_deny),
            (&mut self.allow_env, &args.allow_env, args.clear_allow_env),
        ] {
            if clear {
                stored.clear();
            }
            if !given.is_empty() {
                stored.clone_from(given);
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Config {
    pub machine_id: String,
    pub machine_name: String,
    pub server: String,
    pub roles: Vec<MachineRole>,
    pub system: bool,
    pub single_user: bool,
    pub run_as: RunAs,
    #[serde(default)]
    pub claude_binary: Option<String>,
    #[serde(default)]
    pub computer: ComputerConfig,
}
impl Config {
    pub fn new(
        machine_id: String,
        machine_name: String,
        server: String,
        roles: Vec<MachineRole>,
        system: bool,
        run_as: RunAs,
    ) -> Self {
        Self {
            machine_id,
            machine_name,
            server,
            roles,
            system,
            single_user: run_as.single_user(),
            run_as,
            claude_binary: None,
            computer: ComputerConfig::default(),
        }
    }
}
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.to_ascii_lowercase().bytes() {
        if out.len() == 40 {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch as char);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "machine".into()
    } else {
        out.into()
    }
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 40 || slug(name) != name {
        return Err(Error::new(
            2,
            "instance names use a-z, 0-9 and hyphens, at most 40 characters, with no leading/trailing hyphen",
        ));
    }
    Ok(())
}
#[derive(Clone)]
pub struct Paths {
    pub config_root: PathBuf,
    pub state_root: PathBuf,
    pub system: bool,
}
impl Paths {
    pub fn new(config_root: PathBuf, state_root: PathBuf, system: bool) -> Self {
        Self {
            config_root,
            state_root,
            system,
        }
    }
    pub fn discover(system: bool) -> Self {
        if system {
            return Self::new("/etc/agentum".into(), "/var/lib/agentum".into(), true);
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let config = std::env::var_os("AGENTUM_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"))
                    .join("agentum")
            });
        let state = std::env::var_os("AGENTUM_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("XDG_STATE_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/state"))
                    .join("agentum")
            });
        Self::new(config, state, false)
    }
    pub fn prepare_config_root(&self) -> Result<()> {
        namespace_dir(&self.config_root, self.system)
    }
    pub fn prepare_state_root(&self) -> Result<()> {
        namespace_dir(&self.state_root, self.system)
    }
    pub fn config(&self, name: &str) -> PathBuf {
        self.config_root.join(name)
    }
    pub fn state(&self, name: &str) -> PathBuf {
        self.state_root.join(name)
    }
    /// Agent-user's home is created 0700 and owned by agentum-<instance> by RC.3.
    pub fn agent_home(&self, name: &str) -> PathBuf {
        PathBuf::from("/var/lib/agentum").join(name).join("agent")
    }
    /// Shared by service installation and both roles; never derive a work root elsewhere.
    pub fn work_root(&self, name: &str, run_as: &RunAs) -> PathBuf {
        match run_as {
            RunAs::AgentUser => self.agent_home(name).join("work"),
            _ => self.state(name).join("work"),
        }
    }
    pub fn agent_work(
        &self,
        name: &str,
        run_as: &RunAs,
        workspace: &str,
        agent: &str,
    ) -> Result<PathBuf> {
        validate_name(name)?;
        for part in [workspace, agent] {
            if part.is_empty()
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err(Error::new(
                    2,
                    "workspace and agent ids may only hold letters, digits, _ and -",
                ));
            }
        }
        Ok(self
            .work_root(name, run_as)
            .join(workspace)
            .join(agent)
            .join("work"))
    }
    pub fn unit(&self, name: &str) -> PathBuf {
        if self.system {
            PathBuf::from("/etc/systemd/system").join(format!("agentum-{name}.service"))
        } else {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".config/systemd/user")
                .join(format!("agentum-{name}.service"))
        }
    }
    pub fn names(&self) -> Result<Vec<String>> {
        let entries = match fs::read_dir(&self.config_root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(_) => return Err(access_error(&self.config_root)),
        };
        let mut names = vec![];
        for entry in entries {
            let entry = entry.map_err(|_| access_error(&self.config_root))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if validate_name(&name).is_ok() && entry.file_type().is_ok_and(|t| t.is_dir()) {
                match entry.path().join("config.json").try_exists() {
                    Ok(true) => names.push(name),
                    // The private instance directory may belong to a system service user.
                    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => names.push(name),
                    Ok(false) => {}
                    Err(_) => return Err(access_error(&entry.path())),
                }
            }
        }
        names.sort();
        Ok(names)
    }
    pub fn select(&self, name: Option<&str>) -> Result<String> {
        if let Some(name) = name {
            validate_name(name)?;
            if self.config(name).join("config.json").exists() {
                return Ok(name.into());
            }
            return Err(Error::new(
                4,
                format!("{name} is not enrolled. Run agentum enroll --url <server> --code-stdin"),
            ));
        }
        let names = self.names()?;
        match names.as_slice() {
            [name] => Ok(name.clone()),
            [] => Err(Error::new(
                4,
                "Not enrolled. Run agentum enroll --url <server> --code-stdin",
            )),
            _ => Err(Error::new(
                2,
                format!("Choose --instance <name> from: {}", names.join(", ")),
            )),
        }
    }
    pub fn reserve(&self, explicit: Option<&str>, server_name: &str) -> Result<String> {
        if let Some(name) = explicit {
            validate_name(name)?;
            if self.config(name).exists() {
                return Err(Error::new(
                    2,
                    format!("instance {name} already exists; choose another --name"),
                ));
            }
            return Ok(name.into());
        }
        let base = slug(server_name);
        for n in 1.. {
            let suffix = if n == 1 {
                String::new()
            } else {
                format!("-{n}")
            };
            let name = format!(
                "{}{}",
                base[..base.len().min(40 - suffix.len())].trim_end_matches('-'),
                suffix
            );
            if !self.config(&name).exists() {
                return Ok(name);
            }
        }
        unreachable!()
    }
    pub fn save(&self, name: &str, config: &Config, credential: &str) -> Result<()> {
        validate_name(name)?;
        self.prepare_config_root()?;
        let dir = self.config(name);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|_| {
                Error::new(
                    2,
                    format!(
                        "instance {name} already exists or cannot be created; choose another --name"
                    ),
                )
            })?;
        // Once issued, keep the credential even if writing the config/state subsequently fails.
        atomic_write(
            &dir.join("credential"),
            format!("{credential}\n").as_bytes(),
        )?;
        let bytes = serde_json::to_vec_pretty(config)
            .map_err(|_| Error::new(1, "cannot encode instance config"))?;
        atomic_write(&dir.join("config.json"), &bytes)?;
        self.prepare_state_root()?;
        private_dir(&self.state(name))?;
        Ok(())
    }
    pub fn load(&self, name: &str) -> Result<(Config, String)> {
        validate_name(name)?;
        let dir = self.config(name);
        check_private(&dir, 0o700)?;
        for file in ["config.json", "credential"] {
            check_private(&dir.join(file), 0o600)?;
        }
        let bytes = fs::read(dir.join("config.json")).map_err(|_| access_error(&dir))?;
        let config = serde_json::from_slice(&bytes).map_err(|_| {
            Error::new(
                1,
                format!("cannot read config for {name}; restore config.json or enrol again"),
            )
        })?;
        let credential =
            fs::read_to_string(dir.join("credential")).map_err(|_| access_error(&dir))?;
        Ok((config, credential.trim().into()))
    }
}
pub fn access_error(path: &Path) -> Error {
    let directory = if path
        .file_name()
        .is_some_and(|name| name == "credential" || name == "config.json")
    {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    let quoted = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\"'\"'"));
    Error::new(
        5,
        format!(
            "Cannot access private instance files at {}. Another user or loose modes can expose the credential. Fix: sudo chown -R $(id -un) {}; chmod 700 {}; chmod 600 {} {}",
            path.display(),
            quoted(directory),
            quoted(directory),
            quoted(&directory.join("config.json")),
            quoted(&directory.join("credential"))
        ),
    )
}
pub fn check_private(path: &Path, mode: u32) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| access_error(path))?;
    if metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.permissions().mode() & 0o777 != mode
    {
        return Err(access_error(path));
    }
    Ok(())
}
pub fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|_| access_error(path))?;
    }
    check_private(path, 0o700)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| access_error(path))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .tempfile_in(parent)
        .map_err(|_| access_error(path))?;
    tmp.as_file_mut()
        .write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|_| access_error(path))?;
    tmp.persist(path).map_err(|_| access_error(path))?;
    Ok(())
}
// Keep service ownership when root replaces credentials/config atomically.
pub fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|_| access_error(path))?;
    let parent = path.parent().ok_or_else(|| access_error(path))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|_| access_error(path))?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|_| access_error(path))?;
    if nix::unistd::geteuid().is_root() {
        nix::unistd::fchown(
            tmp.as_file(),
            Some(nix::unistd::Uid::from_raw(meta.uid())),
            Some(nix::unistd::Gid::from_raw(meta.gid())),
        )
        .map_err(|_| access_error(path))?;
    }
    tmp.persist(path).map_err(|_| access_error(path))?;
    Ok(())
}
// Cross-process lock acquired before exchanging a single-use code. Crashes release it.
pub fn enrollment_lock(paths: &Paths) -> Result<std::fs::File> {
    paths.prepare_config_root()?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(paths.config_root.join(".enroll.lock"))
        .map_err(|_| access_error(&paths.config_root))?;
    file.try_lock().map_err(|_| {
        Error::new(
            1,
            "Another enrolment is in progress; retry when it finishes",
        )
    })?;
    Ok(file)
}

/// All callers use both scopes, including explicit-name collision checks before enrolment.
pub fn locations() -> Vec<Paths> {
    vec![Paths::discover(false), Paths::discover(true)]
}
pub fn select(locations: &[Paths], name: Option<&str>) -> Result<(Paths, String)> {
    if let Some(name) = name {
        validate_name(name)?;
    }
    let mut found = vec![];
    for paths in locations {
        match paths.names() {
            Ok(names) => {
                for candidate in names {
                    if name.is_none_or(|n| n == candidate) {
                        found.push((paths.clone(), candidate));
                    }
                }
            }
            Err(error) if paths.system && error.code == 5 => {}
            Err(error) => return Err(error),
        }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(Error::new(
            4,
            "Not enrolled. Run agentum enroll --url <server> --code-stdin",
        )),
        _ => Err(Error::new(
            2,
            format!(
                "Choose --instance <name> from: {}",
                found
                    .iter()
                    .map(|(p, n)| format!("{n} ({})", if p.system { "system" } else { "user" }))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}
pub fn reserve(locations: &[Paths], explicit: Option<&str>, server_name: &str) -> Result<String> {
    reserve_enrollment(locations, explicit, server_name, false)
}
pub fn validate_system_name(name: &str) -> Result<()> {
    validate_name(name)?;
    if name.len() > 20 || name.ends_with("-svc") {
        return Err(Error::new(
            2,
            "System instance names must be at most 20 characters and must not end in -svc; choose another --name",
        ));
    }
    Ok(())
}
pub fn reserve_enrollment(
    locations: &[Paths],
    explicit: Option<&str>,
    server_name: &str,
    system: bool,
) -> Result<String> {
    if let Some(name) = explicit {
        if system {
            validate_system_name(name)?;
        } else {
            validate_name(name)?;
        }
    }
    let limit = if system { 20 } else { 40 };
    let base = explicit
        .map(str::to_owned)
        .unwrap_or_else(|| slug(server_name));
    let base = if system {
        base[..base.len().min(limit)]
            .trim_end_matches('-')
            .trim_end_matches("-svc")
            .to_owned()
    } else {
        base
    };
    for n in 1.. {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let name = format!(
            "{}{}",
            base[..base.len().min(limit - suffix.len())].trim_end_matches('-'),
            suffix
        );
        let mut occupied = false;
        for paths in locations {
            match fs::symlink_metadata(paths.config(&name)) {
                Ok(_) => occupied = true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(access_error(&paths.config_root)),
            }
        }
        if !occupied {
            return Ok(name);
        }
        if explicit.is_some() {
            return Err(Error::new(
                2,
                format!("instance {name} already exists; choose another --name"),
            ));
        }
    }
    unreachable!()
}
pub fn free_display(locations: &[Paths], tmp: &Path) -> Result<u16> {
    let mut displays = vec![];
    for paths in locations {
        match paths.names() {
            Ok(names) => {
                for name in names {
                    if let Ok((c, _)) = paths.load(&name) {
                        displays.extend(c.computer.desktop_display);
                    }
                }
            }
            Err(e) if paths.system && e.code == 5 => {}
            Err(e) => return Err(e),
        }
    }
    (90..=u16::MAX)
        .find(|n| {
            !displays.contains(n)
                && !tmp.join(format!(".X{n}-lock")).exists()
                && !tmp.join(format!(".X11-unix/X{n}")).exists()
        })
        .ok_or_else(|| Error::new(5, "No desktop display is free; stop an unused X server"))
}

// The system namespace must be traversable by per-instance service users.
// Only the namespace is public; config/state instance directories remain 0700.
fn namespace_dir(path: &Path, system: bool) -> Result<()> {
    if !system {
        return private_dir(path);
    }
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o755)
            .create(path)
            .map_err(|_| access_error(path))?;
    }
    check_private(path, 0o755)
}
