use super::{Explanation, Problem};
use crate::{Error, Result};

#[allow(non_upper_case_globals)]
impl Problem {
    pub const Systemd: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Find systemd",
            "systemd is not running",
            "Service management needs a systemd host; foreground mode works without it.",
            "agentum run".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const SystemManager: Self = Self(|_, instance| Explanation {
        tried: "Manage the system service".into(),
        reason: "the system manager rejected the operation".into(),
        meaning: "This system service needs a working systemd manager and valid unit.".into(),
        fix: format!(
            "systemctl status agentum-{instance}.service; journalctl -u agentum-{instance}.service --no-pager"
        ),
    });
    pub const UserBus: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Contact systemctl --user",
            "no user session bus is reachable under sudo, su or cron",
            "The service manager cannot be contacted without the user's runtime directory and bus.",
            format!(
                "loginctl enable-linger {user}; export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus"
            ),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Linger: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Check user lingering",
            "lingering is off",
            "Your user service stops after logout and will not start at boot.",
            format!("loginctl enable-linger {user}"),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const SystemRoot: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Set up a system service or agent-user",
            "root permission is required",
            "Creating users and writing /etc needs root.",
            format!("sudo agentum service install --instance {instance} --system"),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
}

#[derive(Default)]
pub(crate) struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}
pub(crate) trait Runner {
    fn output(&mut self, program: &str, args: &[String]) -> std::io::Result<Output>;
    fn interact(&mut self, program: &str, args: &[String]) -> std::io::Result<i32> {
        self.output(program, args)
            .map(|out| if out.success { 0 } else { 1 })
    }
}
pub(crate) struct Commands;
impl Runner for Commands {
    fn interact(&mut self, program: &str, args: &[String]) -> std::io::Result<i32> {
        std::process::Command::new(program)
            .args(args)
            .status()
            .map(|status| status.code().unwrap_or(1))
    }
    fn output(&mut self, program: &str, args: &[String]) -> std::io::Result<Output> {
        let out = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()?;
        Ok(Output {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}
pub(crate) fn output(runner: &mut impl Runner, program: &str, args: &[&str]) -> Output {
    runner
        .output(
            program,
            &args.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
        )
        .unwrap_or_default()
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
pub(crate) fn command(
    runner: &mut impl Runner,
    program: &str,
    args: &[&str],
    meaning: &str,
    fix: &str,
) -> Result<()> {
    let result = output(runner, program, args);
    if result.success {
        return Ok(());
    }
    let line = std::iter::once(program)
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let tried = if program == "systemctl" {
        let args = args.strip_prefix(&["--user"]).unwrap_or(args);
        match args {
            ["restart", unit] => format!("Restart {unit}"),
            ["enable", unit] => format!("Enable {unit}"),
            ["daemon-reload"] => "Reload the systemd service definitions".into(),
            _ => format!("Run systemctl {}", args.join(" ")),
        }
    } else {
        line
    };
    Err(Error::new(
        5,
        Explanation {
            tried,
            reason: if result.stderr.trim().is_empty() {
                "command failed or is unavailable".into()
            } else {
                result.stderr.trim().into()
            },
            meaning: meaning.into(),
            fix: fix.into(),
        }
        .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_explanation_renders() {
        for p in [
            Problem::Systemd,
            Problem::SystemManager,
            Problem::UserBus,
            Problem::Linger,
            Problem::SystemRoot,
        ] {
            let e = p.explain("dom", "office");
            assert!(
                !e.tried.is_empty()
                    && !e.reason.is_empty()
                    && !e.meaning.is_empty()
                    && !e.fix.is_empty()
            );
            assert!(e.to_string().contains(&e.fix));
        }
    }
}
