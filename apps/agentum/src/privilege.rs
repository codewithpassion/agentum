//! Each area owns its explanations and tests; add new problems in that area's file.
use std::fmt;
pub mod agent;
pub mod common;
pub mod computer;
pub mod service;
#[derive(Clone, Copy, Debug)]
pub struct Problem(fn(&str, &str) -> Explanation);
impl Problem {
    pub fn explain(self, user: &str, instance: &str) -> Explanation {
        (self.0)(user, instance)
    }
    pub fn explain_at(
        self,
        user: &str,
        instance: &str,
        config_dir: &std::path::Path,
    ) -> Explanation {
        let mut explanation = self.explain(user, instance);
        let quoted = format!(
            "'{}'",
            config_dir.display().to_string().replace('\'', "'\"'\"'")
        );
        explanation.fix = explanation
            .fix
            .replace(&format!("~/.config/agentum/{instance}"), &quoted);
        explanation
    }
}
#[derive(Debug)]
pub struct Explanation {
    pub tried: String,
    pub reason: String,
    pub meaning: String,
    pub fix: String,
}
impl Explanation {
    pub fn with_fix(mut self, fix: &str) -> Self {
        self.fix = fix.into();
        self
    }
}
impl fmt::Display for Explanation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Problem: {}\nWhy: {}. {}\nFix: {}",
            self.tried, self.reason, self.meaning, self.fix
        )
    }
}
// getent also works in static musl builds whose libc cannot see LDAP/SSSD users.
pub fn user_exists(name: &str) -> bool {
    std::process::Command::new("getent")
        .args(["passwd", name])
        .output()
        .is_ok_and(|output| output.status.success())
}
pub fn on_path(binary: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).any(|path| {
        std::fs::metadata(path.join(binary))
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}
