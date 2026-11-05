use super::Problem;

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
            format!(
                "sudo agentum service install --instance {instance} --system --run-as agent-user"
            ),
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
        for p in [
            Problem::Systemd,
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
