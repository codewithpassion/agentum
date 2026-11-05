use agentum::{
    Error, Result,
    cli::{Cli, Command, EnrollArgs, LogFormat},
    doctor, enroll,
    instance::{self, Config, Paths, RunAs, atomic_write},
};
use clap::Parser;
use serde_json::{Value, json};
use std::io::{BufRead, Read};
use zeroize::Zeroizing;

fn main() {
    if let Some(code) = agentum::computer::worker_entry() {
        std::process::exit(code);
    }
    // Read and remove the code before creating threads. Rust 2024 requires env
    // mutation to be unsafe because concurrent libc environment reads can race.
    let environment_code = std::env::var("AGENTUM_ENROLL_CODE")
        .ok()
        .map(Zeroizing::new);
    // SAFETY: this process is still single threaded; the runtime has not started.
    unsafe {
        std::env::remove_var("AGENTUM_ENROLL_CODE");
    }
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) if error.use_stderr() => {
            eprintln!("Problem: Invalid command or flags\nWhy: {error}\nFix: agentum --help");
            std::process::exit(2);
        }
        Err(error) => error.exit(),
    };
    let running = matches!(cli.command, Command::Run(_));
    match if running {
        cli.log_format
    } else {
        LogFormat::Text
    } {
        LogFormat::Json => {
            tracing_subscriber::fmt()
                .json()
                .with_writer(std::io::stderr)
                .with_ansi(false)
                .init();
        }
        LogFormat::Text => {
            tracing_subscriber::fmt()
                .with_writer(std::io::stderr)
                .with_ansi(false)
                .init();
        }
    }
    let runtime = tokio::runtime::Runtime::new().expect("create async runtime");
    let code = match runtime.block_on(execute(
        cli,
        environment_code.as_deref().map(|s| s.as_str()),
    )) {
        Ok(()) => 0,
        Err(error) => {
            if running {
                tracing::error!(exit_code = error.code, message = %error, "Command failed");
            } else if error.message.starts_with("Problem:") {
                eprintln!("{error}");
            } else {
                let (problem, fix) = error
                    .message
                    .split_once("Fix: ")
                    .or_else(|| error.message.split_once(". Run "))
                    .unwrap_or((
                        &error.message,
                        "Follow the command guidance above; use agentum --help for usage.",
                    ));
                let reason = if problem.trim() == "Not enrolled" {
                    "No instance is enrolled on this machine for this user."
                } else {
                    problem.trim()
                };
                eprintln!("Problem: {}\nWhy: {reason}\nFix: {fix}", problem.trim());
            }
            error.code
        }
    };
    std::process::exit(code.into());
}
fn code_input(
    code: Option<&str>,
    stdin: bool,
    environment: Option<&str>,
) -> Result<Zeroizing<String>> {
    if stdin {
        let mut value = Zeroizing::new(String::new());
        std::io::stdin()
            .lock()
            .take(201)
            .read_line(&mut value)
            .map_err(|_| {
                Error::new(
                    2,
                    "Cannot read --code-stdin; supply a code on standard input",
                )
            })?;
        if value.trim().is_empty() {
            return Err(Error::new(2, "--code-stdin carried no code"));
        }
        return Ok(value);
    }
    Ok(Zeroizing::new(
        code.or(environment).unwrap_or_default().into(),
    ))
}
fn locations() -> Vec<Paths> {
    instance::locations()
}
fn select(name: Option<&str>) -> Result<(Paths, String)> {
    instance::select(&locations(), name)
}
async fn service_state(paths: &Paths, name: &str) -> String {
    if !paths.unit(name).exists() {
        return "not installed".into();
    }
    let mut command = tokio::process::Command::new("systemctl");
    if !paths.system {
        command.arg("--user");
    }
    command
        .args(["is-active", &format!("agentum-{name}.service")])
        .kill_on_drop(true);
    match tokio::time::timeout(std::time::Duration::from_secs(3), command.output()).await {
        Ok(Ok(output)) => {
            let state = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if matches!(
                state.as_str(),
                "active" | "inactive" | "failed" | "activating" | "deactivating"
            ) {
                state
            } else {
                "unavailable".into()
            }
        }
        _ => "unavailable".into(),
    }
}
async fn status(paths: &Paths, name: &str) -> Result<Value> {
    let config = agentum::service::read_config(paths, name, "status")?;
    let mut connections = serde_json::Map::new();
    for role in &config.roles {
        let role = serde_json::to_value(role)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let state = std::fs::read(paths.state(name).join(format!("connection-{role}.json")))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({"status":"unknown"}));
        connections.insert(role, state);
    }
    Ok(
        json!({"instance":name, "machineId":config.machine_id, "machineName":config.machine_name, "roles":config.roles, "server":config.server, "run_as":config.run_as, "singleUser":config.single_user, "config":paths.config(name), "state":paths.state(name), "service":service_state(paths,name).await, "connection":connections, "version":agentum::VERSION}),
    )
}
async fn execute(cli: Cli, environment_code: Option<&str>) -> Result<()> {
    match cli.command {
        Command::Version => println!("{}", agentum::VERSION),
        Command::Enroll(mut args) => {
            args.name = args.name.or(cli.instance.clone());
            if args.replace {
                let (paths, name) = select(args.name.as_deref())?;
                let config = agentum::service::read_config(&paths, &name, "enroll")?;
                args.name = Some(name);
                args.system = config.system;
                args.run_as = config.run_as;
                if args.url.is_none() {
                    args.url = Some(config.server);
                }
            }
            let code = code_input(
                args.code.as_deref().or(args.legacy_code.as_deref()),
                args.code_stdin,
                environment_code,
            )?;
            args.code = None;
            args.legacy_code = None;
            let paths = Paths::discover(args.system);
            let answer = enroll::enroll(&paths, &args, &code, agentum::VERSION).await?;
            if args.json {
                println!("{}", serde_json::to_string(&answer).unwrap());
            } else {
                println!(
                    "Enrolled as {}. Start with: agentum run --instance {}\nOr install a service: agentum service install --instance {}{}",
                    answer.instance,
                    answer.instance,
                    answer.instance,
                    if args.system { " --system" } else { " --user" }
                );
            }
        }
        Command::List { json: as_json } => {
            let mut instances = vec![];
            for paths in locations() {
                match paths.names() {
                    Ok(names) => {
                        for name in names {
                            let item = match status(&paths, &name).await {
                                Ok(item) => item,
                                Err(error) if error.code == 5 => {
                                    json!({"instance":name, "roles":"unavailable", "service":service_state(&paths, &name).await, "connection":{}, "error":error.message})
                                }
                                Err(error) => return Err(error),
                            };
                            instances.push(item);
                        }
                    }
                    Err(error) if paths.system && error.code == 5 => {}
                    Err(error) => return Err(error),
                }
            }
            if as_json {
                println!("{}", json!(instances));
            } else if instances.is_empty() {
                println!("No enrolled instances. Run agentum enroll --url <server> --code-stdin");
            } else {
                for item in instances {
                    print_status(&item);
                }
            }
        }
        Command::Status { json: as_json } => {
            let (paths, name) = select(cli.instance.as_deref())?;
            let item = status(&paths, &name).await?;
            if as_json {
                println!("{item}");
            } else {
                print_status(&item);
            }
        }
        Command::Doctor => {
            let (paths, name, not_enrolled) = match select(cli.instance.as_deref()) {
                Ok((paths, name)) => (paths, name, false),
                Err(error) if error.code == 4 => (
                    Paths::discover(false),
                    cli.instance.unwrap_or_else(|| "default".into()),
                    true,
                ),
                Err(error) => return Err(error),
            };
            let config = agentum::service::read_config(&paths, &name, "doctor").ok();
            let checks = doctor::run(&doctor::Context {
                paths: &paths,
                name: &name,
                config: config.as_ref(),
            })
            .await;
            let failed = checks
                .iter()
                .any(|check| matches!(check.level, doctor::Level::Problem));
            for check in checks {
                println!("{:?}: {}: {}", check.level, check.name, check.message);
            }
            if failed {
                return Err(Error::new(
                    if not_enrolled { 4 } else { 5 },
                    if not_enrolled {
                        "Not enrolled. Fix: agentum enroll --url <server> --code-stdin"
                    } else {
                        "Doctor found a missing permission or prerequisite; apply the fixes above"
                    },
                ));
            }
        }
        Command::Run(args) => {
            let selected = select(cli.instance.as_deref());
            let (paths, name) = match selected {
                Ok(value) => value,
                Err(error)
                    if error.code == 4
                        && (args.code.is_some()
                            || args.code_stdin
                            || environment_code.is_some()) =>
                {
                    let code = code_input(args.code.as_deref(), args.code_stdin, environment_code)?;
                    let enroll_args =
                        EnrollArgs {
                            url: Some(args.url.clone().ok_or_else(|| {
                                Error::new(2, "First-start enrolment needs --url")
                            })?),
                            name: args.name.clone().or(cli.instance.clone()),
                            system: false,
                            run_as: RunAs::Current,
                            code: None,
                            legacy_code: None,
                            replace: false,
                            code_stdin: false,
                            claude: None,
                            json: false,
                        };
                    let paths = Paths::discover(false);
                    let answer =
                        enroll::enroll(&paths, &enroll_args, &code, agentum::VERSION).await?;
                    (paths, answer.instance)
                }
                Err(error) => return Err(error),
            };
            let (mut config, credential) = paths.load(&name)?;
            config.computer.apply(&args.computer);
            if config.computer.desktop && config.computer.desktop_display.is_none() {
                config.computer.desktop_display = Some(instance::free_display(
                    &locations(),
                    std::path::Path::new("/tmp"),
                )?);
            }
            if args.save {
                save_config(&paths, &name, &config)?;
            }
            let roles = config
                .roles
                .iter()
                .map(|role| match role {
                    agentum::wire::MachineRole::AgentHost => {
                        agentum::runs::role(&paths, &name, &config)
                    }
                    agentum::wire::MachineRole::Computer => {
                        agentum::computer::role(&paths, &name, &config)
                    }
                })
                .collect();
            let stop = tokio_util::sync::CancellationToken::new();
            let signal = tokio::spawn({
                let stop = stop.clone();
                async move {
                    let mut term =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                            .expect("register SIGTERM");
                    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
                    stop.cancel();
                }
            });
            let result = agentum::relay::run_roles(roles, config.server, credential, stop).await;
            signal.abort();
            return result;
        }
        Command::Service { command } => {
            return agentum::service::run(cli.instance.as_deref(), command);
        }
        Command::InstallService(args) => {
            return agentum::service::run(
                cli.instance.as_deref(),
                agentum::cli::ServiceCommand::Install(Box::new(args)),
            );
        }
    }
    Ok(())
}
fn print_status(item: &Value) {
    println!(
        "{}  roles={}  service={}  connection={}\n  machine={} server={}",
        item["instance"].as_str().unwrap_or_default(),
        item["roles"],
        item["service"].as_str().unwrap_or_default(),
        item["connection"],
        item["machineId"].as_str().unwrap_or_default(),
        item["server"].as_str().unwrap_or_default()
    );
    if let Some(error) = item["error"].as_str() {
        println!("  {error}");
    }
}
fn save_config(paths: &Paths, name: &str, config: &Config) -> Result<()> {
    atomic_write(
        &paths.config(name).join("config.json"),
        &serde_json::to_vec_pretty(config).map_err(|_| Error::new(1, "Cannot encode config"))?,
    )
}
