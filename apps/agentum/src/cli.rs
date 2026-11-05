use crate::instance::RunAs;
use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "agentum", version = crate::VERSION, disable_version_flag = true, about = "Connect a machine to Agentum", after_help = "Example: agentum enroll --url https://agentumbot.io --code-stdin")]
pub struct Cli {
    #[arg(short = 'v', long = "version", action = clap::ArgAction::Version)]
    pub version: (),
    #[arg(long, global = true)]
    pub instance: Option<String>,
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
    Enroll(EnrollArgs),
    #[command(after_help = "Example: agentum run --instance office")]
    Run(RunArgs),
    #[command(after_help = "Example: agentum service install --user")]
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    #[command(after_help = "Example: agentum install-service --user")]
    InstallService(InstallArgs),
    #[command(after_help = "Example: agentum status --json")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(after_help = "Example: agentum list --json")]
    List {
        #[arg(long)]
        json: bool,
    },
    #[command(after_help = "Example: agentum doctor --instance office")]
    Doctor,
    #[command(after_help = "Example: agentum version")]
    Version,
}
#[derive(Debug, Args)]
pub struct EnrollArgs {
    #[arg(value_name = "CODE", conflicts_with = "code")]
    pub legacy_code: Option<String>,
    #[arg(long)]
    pub code: Option<String>,
    #[arg(long, alias = "server")]
    pub url: String,
    #[arg(long)]
    pub code_stdin: bool,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub system: bool,
    #[arg(long, default_value = "current")]
    pub run_as: RunAs,
    #[arg(long)]
    pub claude: Option<String>,
    #[arg(long)]
    pub json: bool,
}
#[derive(Debug, Args)]
pub struct RunArgs {
    #[arg(long)]
    pub url: Option<String>,
    #[arg(long)]
    pub code: Option<String>,
    #[arg(long)]
    pub code_stdin: bool,
    #[arg(long)]
    pub name: Option<String>,
    #[command(flatten)]
    pub computer: ComputerArgs,
}
#[derive(Debug, Args)]
pub struct InstallArgs {
    #[arg(long, conflicts_with = "system")]
    pub user: bool,
    #[arg(long)]
    pub system: bool,
    #[arg(long)]
    pub run_as: Option<RunAs>,
    #[arg(long)]
    pub claude: Option<String>,
    #[arg(long)]
    pub yes: bool,
    #[arg(long)]
    pub refresh: bool,
    #[command(flatten)]
    pub computer: ComputerArgs,
}
#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    #[command(after_help = "Example: agentum service install --system --run-as agent-user --yes")]
    Install(Box<InstallArgs>),
    #[command(after_help = "Example: agentum service uninstall --instance office")]
    Uninstall,
    #[command(after_help = "Example: agentum service status --instance office")]
    Status,
    #[command(after_help = "Example: agentum service logs --instance office -f")]
    Logs {
        #[arg(short = 'f', long)]
        follow: bool,
    },
    #[command(after_help = "Example: agentum service restart --instance office")]
    Restart,
}
// Options stay optional so a run override never resets a persisted policy to a default.
#[derive(Debug, Default, Args)]
pub struct ComputerArgs {
    #[arg(long)]
    pub workdir: Option<std::path::PathBuf>,
    #[arg(long)]
    pub allow_root: bool,
    #[arg(long)]
    pub read_only: bool,
    #[arg(long)]
    pub workdir_only: bool,
    #[arg(long)]
    pub max_concurrent: Option<usize>,
    #[arg(long)]
    pub max_queue: Option<usize>,
    #[arg(long)]
    pub max_exec_seconds: Option<u64>,
    #[arg(long)]
    pub max_file_bytes: Option<u64>,
    #[arg(long)]
    pub audit_max_bytes: Option<u64>,
    #[arg(long, allow_hyphen_values = true)]
    pub audit_keep: Option<i32>,
    #[arg(long)]
    pub desktop: bool,
    #[arg(long, value_parser = clap::value_parser!(u16).range(90..))]
    pub desktop_display: Option<u16>,
    #[arg(long, value_parser = nonempty)]
    pub allow: Vec<String>,
    #[arg(long, value_parser = nonempty)]
    pub deny: Vec<String>,
    #[arg(long, value_parser = nonempty)]
    pub allow_env: Vec<String>,
}
fn nonempty(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err("remove the empty flag value".into())
    } else {
        Ok(value.into())
    }
}
