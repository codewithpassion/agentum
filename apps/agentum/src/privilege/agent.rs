use super::Problem;

#[allow(non_upper_case_globals)]
impl Problem {
    pub const PrivateClaude: Self =
        Self(|user, instance| private_claude(user, instance, "<claude>"));
    pub const ClaudeMissing: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Find claude",
            "claude is missing from PATH",
            "The agent_host role needs Claude CLI 2.1.300 or newer.",
            "curl -fsSL https://claude.ai/install.sh | bash".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const ClaudeOld: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Check claude version",
            "claude is older than 2.1.300",
            "The stream-json control protocol requires a newer CLI.",
            "claude update".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const ClaudeLogin: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Check claude login",
            "the run-as user is not logged in",
            "Agents need that user's Claude login and settings.",
            format!("sudo -iu {user} claude auth login"),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
}

/// Preserve the daemon's diagnostic, substituting only the per-instance agent user.
pub fn private_claude(user: &str, instance: &str, claude: &str) -> super::Explanation {
    let agent_user = format!("agentum-{instance}");
    super::Explanation {
        tried: "Run claude as the agent user".into(),
        reason: "the binary is not executable by the agent user".into(),
        meaning: format!(
            "{user} could not run {claude} as {agent_user}. The binary must be executable by {agent_user}, so it cannot sit in a private home directory. Install it system-wide, then run install-service again with --claude <path>"
        ),
        fix: format!(
            "Install Claude Code system-wide (for example at /usr/local/bin/claude), then run: sudo agentum service install --instance {instance} --system --run-as agent-user --claude /usr/local/bin/claude"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_explanation_renders() {
        for p in [
            Problem::PrivateClaude,
            Problem::ClaudeMissing,
            Problem::ClaudeOld,
            Problem::ClaudeLogin,
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

/// Build Claude's command without ever placing an environment value in argv.
pub fn claude_command(
    binary: &str,
    user: Option<&str>,
    cwd: Option<&std::path::Path>,
    preserve: &[String],
) -> std::process::Command {
    let mut command = if let Some(user) = user {
        let mut command = std::process::Command::new("sudo");
        command.args(["-n", "-u", user, "-H"]);
        if !preserve.is_empty() {
            command.arg(format!("--preserve-env={}", preserve.join(",")));
        }
        if let Some(cwd) = cwd {
            command.arg("-D").arg(cwd);
        }
        command.arg(binary).current_dir("/");
        command
    } else {
        let mut command = std::process::Command::new(binary);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command
    };
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
}

pub async fn disk_command(
    user: &str,
    binary: &str,
    args: &[String],
    input: Option<&[u8]>,
) -> crate::runs::api::Result<Vec<u8>> {
    use crate::runs::api::Failure;
    use tokio::{io::AsyncWriteExt, process::Command};
    let mut command = Command::from(disk_process(user, binary, args));
    command.kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    if let Some(input) = input {
        stdin.write_all(input).await?;
    }
    drop(stdin);
    let result = child.wait_with_output().await?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        if stderr.contains("No such file or directory") || stderr.contains("Not a directory") {
            return Err(Failure {
                status: 404,
                message: "File missing".into(),
            });
        }
        return Err(Failure::local(format!(
            "Cannot run {binary} as the agent user. Run sudo agentum service install --instance {} --system --run-as agent-user again to repair its access.",
            user.strip_prefix("agentum-").unwrap_or("<instance>")
        )));
    }
    Ok(result.stdout)
}

/// Build the fixed work-file utilities for policy tests as well as execution.
pub(crate) fn disk_process(user: &str, binary: &str, args: &[String]) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut command = Command::new("sudo");
    command
        .args(["-n", "-u", user, binary])
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// This target-user kill is allowed by the same per-instance sudoers drop-in as Claude.
pub(crate) fn signal_command(user: &str, group: u32, signal: &str) -> std::process::Command {
    let mut command = std::process::Command::new("sudo");
    command.args([
        "-n",
        "-u",
        user,
        "--",
        "/bin/kill",
        signal,
        "--",
        &format!("-{group}"),
    ]);
    command
}
