use super::*;
use crate::{claude, wire::MachineRole};

pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let Some(config) = ctx
        .config
        .filter(|c| c.roles.contains(&MachineRole::AgentHost))
    else {
        return vec![skipped("claude", "no enrolled agent_host role to check")];
    };
    let target = if config.system && config.run_as == crate::instance::RunAs::Current {
        format!("agentum-{}-svc", ctx.name)
    } else {
        config.run_as.user(ctx.name)
    };
    let caller = nix::unistd::User::from_uid(nix::unistd::geteuid())
        .ok()
        .flatten()
        .map(|u| u.name);
    let user = (caller.as_deref() != Some(&target)).then_some(target);
    match claude::prerequisites(config, user.as_deref(), ctx.name) {
        Ok(_) => {
            let mut checks = vec![ok(
                "claude",
                "Claude CLI >=2.1.300 is executable for the run-as user",
            )];
            let login = claude::probe(
                config.claude_binary.as_deref().unwrap_or("claude"),
                user.as_deref(),
                &["auth", "status", "--json"],
            );
            if login.is_ok_and(|out| {
                out.status.success()
                    && serde_json::from_slice::<serde_json::Value>(&out.stdout)
                        .is_ok_and(|value| value["loggedIn"] == true)
            }) {
                checks.push(ok("claude login", "The run-as user is logged in to Claude"));
            } else {
                checks.push(ctx.problem("claude login", Problem::ClaudeLogin));
            }
            checks
        }
        Err(e) => vec![Check {
            name: "claude",
            level: Level::Problem,
            message: e.message,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instance::{Config, Paths, RunAs};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn doctor_checks_login_for_the_run_as_user_with_a_fake_cli() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("fake-claude");
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
        let mut config = Config::new(
            "m".into(),
            "office".into(),
            "https://example.com".into(),
            vec![MachineRole::AgentHost],
            false,
            RunAs::Current,
        );
        config.claude_binary = Some(binary.display().to_string());
        for logged_in in [false, true] {
            std::fs::write(&binary, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.300 (Fake Claude)'; elif [ \"$1 $2 $3\" = 'auth status --json' ]; then echo '{{\"loggedIn\":{logged_in}}}'; else exit 42; fi\n")).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = checks(&Context {
                paths: &paths,
                name: "office",
                config: Some(&config),
            });
            let login = result
                .iter()
                .find(|c| c.name == "claude login")
                .expect("login check missing");
            if logged_in {
                assert!(matches!(login.level, Level::Ok));
            } else {
                assert!(matches!(login.level, Level::Problem));
                assert!(login.message.contains("claude auth login"));
            }
        }
    }
}
