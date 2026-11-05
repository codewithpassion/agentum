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
            "sudo agentum service install --instance {instance} --system --run-as agent-user --claude /usr/local/bin/claude"
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
