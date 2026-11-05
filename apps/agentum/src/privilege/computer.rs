use super::Problem;

#[allow(non_upper_case_globals)]
impl Problem {
    pub const Desktop: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = ("Find desktop programs", "one or more desktop packages are missing", "Desktop operations need Xvfb, openbox, xdotool, xclip and Chromium.", "sudo apt install xvfb openbox xdotool xclip chromium; # Fedora: sudo dnf install xorg-x11-server-Xvfb openbox xdotool xclip chromium".into());
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Root: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Start computer commands",
            "running as root requires --allow-root",
            "Use an unprivileged user or explicitly accept root access.",
            format!("agentum run --instance {instance} --allow-root"),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_explanation_renders() {
        for p in [Problem::Desktop, Problem::Root] {
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

/// RC.3 can use this exact, fixed-argument rule for the computer backend.
pub fn worker_rule(service_user: &str, agent_user: &str, binary: &std::path::Path) -> String {
    format!(
        "{service_user} ALL=({agent_user}) NOPASSWD: {} --computer-worker",
        binary.display()
    )
}
pub fn worker_fix(user: &str, binary: &std::path::Path) -> String {
    format!(
        "Install a sudoers rule with sudo visudo: {}",
        worker_rule(
            &crate::instance::RunAs::Current.user("instance"),
            user,
            binary
        )
    )
}

pub fn check_root(uid: u32, allow: bool, instance: &str) -> crate::Result<()> {
    if uid == 0 && !allow {
        return Err(crate::Error::new(
            5,
            Problem::Root.explain("root", instance).to_string(),
        ));
    }
    Ok(())
}
#[cfg(test)]
mod root_tests {
    #[test]
    fn root_refusal_requires_explicit_override() {
        let error = super::check_root(0, false, "box").unwrap_err();
        assert_eq!(error.code, 5);
        assert!(error.message.contains("--allow-root"));
        assert!(super::check_root(1000, false, "box").is_ok());
        assert!(super::check_root(0, true, "box").is_ok());
    }
}
