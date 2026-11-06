use crate::instance::RunAs;
use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "agentum", version = crate::VERSION, disable_version_flag = true, about = "Connect a machine to Agentum", after_help = "Example: agentum enroll --url https://agentumbot.io --code-stdin")]
pub struct Cli {
    /// Print the client version
    #[arg(short = 'v', long = "version", action = clap::ArgAction::Version)]
    pub version: (),
    /// Select an enrolled instance
    #[arg(long, global = true)]
    pub instance: Option<String>,
    /// Set run logging format
    #[arg(long, global = true, value_enum, default_value = "json")]
    pub log_format: LogFormat,
    #[command(subcommand)]
    pub command: Command,
}
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum LogFormat {
    Json,
    Text,
}
#[derive(Debug, Subcommand)]
pub enum Command {
    #[command(after_help = "Example: agentum enroll --url https://agentumbot.io --code-stdin")]
    /// Enrol a machine or replace its credential
    Enroll(EnrollArgs),
    #[command(after_help = "Example: agentum run --instance office")]
    /// Run the enrolled roles in the foreground
    Run(RunArgs),
    #[command(after_help = "Example: agentum service install --user")]
    /// Manage an instance service
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    #[command(after_help = "Example: agentum install-service --user")]
    /// Install an instance service (alias for service install)
    InstallService(InstallArgs),
    #[command(after_help = "Example: agentum status --json")]
    /// Show instance service and connection state
    Status {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    #[command(after_help = "Example: agentum list --json")]
    /// List enrolled instances
    List {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    #[command(after_help = "Example: agentum doctor --instance office")]
    /// Check instance permissions and prerequisites
    Doctor,
    #[command(after_help = "Example: agentum version")]
    /// Print the client version
    Version,
}
#[derive(Debug, Args)]
pub struct EnrollArgs {
    /// Enrolment code (alternative to --code or --code-stdin)
    #[arg(value_name = "CODE", conflicts_with = "code")]
    pub legacy_code: Option<String>,
    /// Replace an enrolled instance in place, preserving its service settings
    #[arg(long)]
    pub replace: bool,
    /// Use a one-time code from the Machines page
    #[arg(long)]
    pub code: Option<String>,
    /// Set the Agentum server URL (required for a new enrolment)
    #[arg(long, alias = "server", required_unless_present = "replace")]
    pub url: Option<String>,
    /// Read one enrolment code from standard input
    #[arg(long)]
    pub code_stdin: bool,
    /// Choose the instance name
    #[arg(long)]
    pub name: Option<String>,
    /// Use system service paths (requires root)
    #[arg(long)]
    pub system: bool,
    /// Choose current (invoking user), a user name (existing account), or agent-user (separate per-instance agent account)
    #[arg(long, default_value = "current")]
    pub run_as: RunAs,
    /// Use this Claude CLI executable
    #[arg(long)]
    pub claude: Option<String>,
    /// Print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}
#[derive(Debug, Args)]
pub struct RunArgs {
    /// Save computer overrides to the instance config
    #[arg(long)]
    pub save: bool,
    /// Set the Agentum server URL (required for a new enrolment)
    #[arg(long)]
    pub url: Option<String>,
    /// Use a one-time code from the Machines page
    #[arg(long)]
    pub code: Option<String>,
    /// Read one enrolment code from standard input
    #[arg(long)]
    pub code_stdin: bool,
    /// Choose the instance name
    #[arg(long)]
    pub name: Option<String>,
    #[command(flatten)]
    pub computer: ComputerArgs,
}
#[derive(Debug, Args)]
pub struct InstallArgs {
    /// Install a user service
    #[arg(long, conflicts_with = "system")]
    pub user: bool,
    /// Use system service paths (requires root)
    #[arg(long)]
    pub system: bool,
    /// Choose current (invoking user), a user name (existing account), or agent-user (separate per-instance agent account)
    #[arg(long)]
    pub run_as: Option<RunAs>,
    /// Use this Claude CLI executable
    #[arg(long)]
    pub claude: Option<String>,
    /// Accept the run-as choice without prompting
    #[arg(long)]
    pub yes: bool,
    /// Allow agents to run as root
    #[arg(long)]
    pub allow_root_agents: bool,
    #[command(flatten)]
    pub computer: ComputerArgs,
}
#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    #[command(after_help = "Example: agentum service install --system --run-as agent-user --yes")]
    /// Install and start the instance service
    Install(Box<InstallArgs>),
    #[command(after_help = "Example: agentum service uninstall --instance office")]
    /// Stop and remove the instance service
    Uninstall,
    #[command(after_help = "Example: agentum service status --instance office")]
    /// Show instance service and connection state
    Status,
    #[command(after_help = "Example: agentum service installed --instance office")]
    /// Quietly check for an installed unit file (exit 0 if present, 1 if absent)
    Installed,
    #[command(after_help = "Example: agentum service logs --instance office -f")]
    /// Read the instance service logs
    Logs {
        /// Follow new log entries
        #[arg(short = 'f', long)]
        follow: bool,
    },
    #[command(after_help = "Example: agentum service restart --instance office")]
    /// Restart the instance service
    Restart,
}
// Options stay optional so a run override never resets a persisted policy to a default.
#[derive(Debug, Default, Args)]
#[command(next_help_heading = "Computer options")]
pub struct ComputerArgs {
    /// Set the computer working directory
    #[arg(long)]
    pub workdir: Option<std::path::PathBuf>,
    /// Allow computer commands as root
    #[arg(long)]
    pub allow_root: bool,
    /// Refuse computer commands as root
    #[arg(long, conflicts_with = "allow_root")]
    pub no_allow_root: bool,
    /// Refuse computer execution and file writes
    #[arg(long)]
    pub read_only: bool,
    /// Allow computer execution and file writes
    #[arg(long, conflicts_with = "read_only")]
    pub no_read_only: bool,
    /// Confine computer file access to the working directory
    #[arg(long)]
    pub workdir_only: bool,
    /// Allow file access outside the working directory
    #[arg(long, conflicts_with = "workdir_only")]
    pub no_workdir_only: bool,
    /// Limit simultaneous computer commands
    #[arg(long)]
    pub max_concurrent: Option<usize>,
    /// Limit queued computer commands
    #[arg(long)]
    pub max_queue: Option<usize>,
    /// Limit command execution time in seconds
    #[arg(long)]
    pub max_exec_seconds: Option<u64>,
    /// Limit file transfer size in bytes
    #[arg(long)]
    pub max_file_bytes: Option<u64>,
    /// Rotate the audit log at this size in bytes
    #[arg(long)]
    pub audit_max_bytes: Option<u64>,
    /// Keep this many rotated audit logs
    #[arg(long, allow_hyphen_values = true)]
    pub audit_keep: Option<i32>,
    /// Enable the virtual desktop
    #[arg(long)]
    pub desktop: bool,
    /// Disable the virtual desktop
    #[arg(long, conflicts_with = "desktop")]
    pub no_desktop: bool,
    /// Use this X display number (90 or higher)
    #[arg(long, value_parser = clap::value_parser!(u16).range(90..))]
    pub desktop_display: Option<u16>,
    /// Allow commands matching this pattern (repeatable)
    #[arg(long, value_parser = nonempty)]
    pub allow: Vec<String>,
    /// Clear saved command allow patterns
    #[arg(long)]
    pub clear_allow: bool,
    /// Deny commands matching this pattern (repeatable)
    #[arg(long, value_parser = nonempty)]
    pub deny: Vec<String>,
    /// Clear saved command deny patterns
    #[arg(long)]
    pub clear_deny: bool,
    /// Allow this environment variable (repeatable)
    #[arg(long, value_parser = nonempty)]
    pub allow_env: Vec<String>,
    /// Clear saved environment allow entries
    #[arg(long)]
    pub clear_allow_env: bool,
}
fn nonempty(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err("remove the empty flag value".into())
    } else {
        Ok(value.into())
    }
}
