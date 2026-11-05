//! Human-readable explanations shared by checks and privileged operations.
use std::fmt;
#[derive(Clone, Copy, Debug)]
pub enum Problem {
    Systemd,
    UserBus,
    Linger,
    SystemRoot,
    PrivateClaude,
    ClaudeMissing,
    ClaudeOld,
    ClaudeLogin,
    Desktop,
    ConfigOwner,
    ConfigMode,
    Unreachable,
    Tls,
    Plaintext,
    Redirect,
    Revoked,
    Root,
}
impl Problem {
    pub const ALL: [Self; 17] = [
        Self::Systemd,
        Self::UserBus,
        Self::Linger,
        Self::SystemRoot,
        Self::PrivateClaude,
        Self::ClaudeMissing,
        Self::ClaudeOld,
        Self::ClaudeLogin,
        Self::Desktop,
        Self::ConfigOwner,
        Self::ConfigMode,
        Self::Unreachable,
        Self::Tls,
        Self::Plaintext,
        Self::Redirect,
        Self::Revoked,
        Self::Root,
    ];
    pub fn explain(self, user: &str, instance: &str) -> Explanation {
        let (tried, reason, meaning, fix) = match self {
            Self::Systemd => ("Find systemd", "systemd is not running", "Service management needs a systemd host; foreground mode works without it.", "agentum run".into()),
            Self::UserBus => ("Contact systemctl --user", "no user session bus is reachable under sudo, su or cron", "The service manager cannot be contacted without the user's runtime directory and bus.", format!("loginctl enable-linger {user}; export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus")),
            Self::Linger => ("Check user lingering", "lingering is off", "Your user service stops after logout and will not start at boot.", format!("loginctl enable-linger {user}")),
            Self::SystemRoot => ("Set up a system service or agent-user", "root permission is required", "Creating users and writing /etc needs root.", format!("sudo agentum service install --instance {instance} --system --run-as agent-user")),
            Self::PrivateClaude => ("Run claude as the agent user", "the binary is not executable by the agent user", "A binary in a private home cannot be used. Install it system-wide, then install the service again.", format!("sudo agentum service install --instance {instance} --system --run-as agent-user --claude /usr/local/bin/claude")),
            Self::ClaudeMissing => ("Find claude", "claude is missing from PATH", "The agent_host role needs Claude CLI 2.1.300 or newer.", "curl -fsSL https://claude.ai/install.sh | bash".into()),
            Self::ClaudeOld => ("Check claude version", "claude is older than 2.1.300", "The stream-json control protocol requires a newer CLI.", "claude update".into()),
            Self::ClaudeLogin => ("Check claude login", "the run-as user is not logged in", "Agents need that user's Claude login and settings.", format!("sudo -iu {user} claude auth login")),
            Self::Desktop => ("Find desktop programs", "one or more desktop packages are missing", "Desktop operations need Xvfb, openbox, xdotool, xclip and Chromium.", "sudo apt install xvfb openbox xdotool xclip chromium; # Fedora: sudo dnf install xorg-x11-server-Xvfb openbox xdotool xclip chromium".into()),
            Self::ConfigOwner => ("Read instance config", "the directory belongs to another user", "Another user could control this machine's credential.", format!("sudo chown -R {user} ~/.config/agentum/{instance}")),
            Self::ConfigMode => ("Check private file modes", "config permissions are loose", "The credential must be readable only by the service user.", format!("chmod 700 ~/.config/agentum/{instance}; chmod 600 ~/.config/agentum/{instance}/config.json ~/.config/agentum/{instance}/credential")),
            Self::Unreachable => ("Contact the server", "the server is unreachable", "Network errors retry; they do not invalidate your enrolment.", "agentum doctor --instance <name> # check the stored URL, DNS and network".into()),
            Self::Tls => ("Establish TLS", "the TLS handshake or certificate validation failed", "The client uses the system's native CA roots. Install the corporate root CA if needed.", "sudo update-ca-certificates # Fedora: sudo update-ca-trust".into()),
            Self::Plaintext => ("Validate the server URL", "plain http:// is allowed only on loopback", "The enrolment code, credential and commands would cross the network in the clear.", "agentum enroll --url https://<server> --code-stdin".into()),
            Self::Redirect => ("Contact the enrolment endpoint", "the server returned a redirect", "Following it could send the code to another server. Use the final HTTPS origin directly.", "agentum enroll --url https://<final-server> --code-stdin".into()),
            Self::Revoked => ("Authenticate the machine", "the server rejected the credential", "This machine was revoked or its credential replaced. Enrol it again with a new code from the Machines page.", "agentum enroll --url https://<server> --code-stdin".into()),
            Self::Root => ("Start computer commands", "running as root requires --allow-root", "Use an unprivileged user or explicitly accept root access.", format!("agentum run --instance {instance} --allow-root")),
        };
        Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    }
}
#[derive(Debug)]
pub struct Explanation {
    pub tried: String,
    pub reason: String,
    pub meaning: String,
    pub fix: String,
}
impl fmt::Display for Explanation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {}. {} Fix: {}",
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
