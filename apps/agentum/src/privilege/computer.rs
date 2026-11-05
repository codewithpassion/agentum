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
