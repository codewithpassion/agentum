use agentum::{
    Error, Result,
    cli::{Cli, Command, EnrollArgs, LogFormat},
    doctor, enroll,
    instance::{Config, Paths, RunAs, atomic_write},
};
use clap::Parser;
use serde_json::{Value, json};
use std::io::Read;
use zeroize::Zeroizing;

fn main() {
    // Read and remove the code before creating threads. Rust 2024 requires env
    // mutation to be unsafe because concurrent libc environment reads can race.
    let environment_code = std::env::var("AGENTUM_ENROLL_CODE")
        .ok()
        .map(Zeroizing::new);
    // SAFETY: this process is still single threaded; the runtime has not started.
    unsafe {
        std::env::remove_var("AGENTUM_ENROLL_CODE");
    }
    let cli = Cli::parse();
    match cli.log_format {
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
            tracing::error!(exit_code = error.code, message = %error, "Command failed");
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
            .take(201)
            .read_to_string(&mut value)
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
    vec![Paths::discover(false), Paths::discover(true)]
}
fn select(name: Option<&str>) -> Result<(Paths, String)> {
    let mut found = vec![];
    for paths in locations() {
        match paths.names() {
            Ok(names) => {
                for candidate in names {
                    if name.is_none_or(|n| n == candidate) {
                        found.push((paths.clone(), candidate));
                    }
                }
            }
            Err(error) if paths.system && error.code == 5 => {}
            Err(error) => return Err(error),
        }
    }
    if found.len() == 1 {
        return Ok(found.remove(0));
    }
    if found.is_empty() {
        return Err(Error::new(
            4,
            "Not enrolled. Run agentum enroll --url <server> --code-stdin",
        ));
    }
    Err(Error::new(
        2,
        format!(
            "Choose --instance <name> from: {}",
            found
                .iter()
                .map(|(paths, name)| format!(
                    "{name} ({})",
                    if paths.system { "system" } else { "user" }
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}
async fn service_state(paths: &Paths, name: &str) -> String {
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
    let (config, _) = paths.load(name)?;
    Ok(
        json!({"instance":name, "machineId":config.machine_id, "machineName":config.machine_name, "roles":config.roles, "server":config.server, "run_as":config.run_as, "singleUser":config.single_user, "config":paths.config(name), "state":paths.state(name), "service":service_state(paths,name).await, "connection":"unknown", "version":agentum::VERSION}),
    )
}
async fn execute(cli: Cli, environment_code: Option<&str>) -> Result<()> {
    match cli.command {
        Command::Version => println!("{}", agentum::VERSION),
        Command::Enroll(mut args) => {
            args.name = args.name.or(cli.instance);
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
                    "Enrolled as {}. Start with: agentum run --instance {}",
                    answer.instance, answer.instance
                );
            }
        }
        Command::List { json: as_json } => {
            let mut instances = vec![];
            for paths in locations() {
                match paths.names() {
                    Ok(names) => {
                        for name in names {
                            instances.push(status(&paths, &name).await?);
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
            let (paths, name) = match select(cli.instance.as_deref()) {
                Ok(instance) => instance,
                Err(error) if error.code == 4 => (
                    Paths::discover(false),
                    cli.instance.unwrap_or_else(|| "default".into()),
                ),
                Err(error) => return Err(error),
            };
            let config = paths.load(&name).ok().map(|(config, _)| config);
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
                    5,
                    "Doctor found a missing permission or prerequisite; apply the fixes above",
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
                    let enroll_args = EnrollArgs {
                        url: args
                            .url
                            .clone()
                            .ok_or_else(|| Error::new(2, "First-start enrolment needs --url"))?,
                        name: args.name.clone().or(cli.instance.clone()),
                        system: false,
                        run_as: RunAs::Current,
                        code: None,
                        legacy_code: None,
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
            let (mut config, _) = paths.load(&name)?;
            config.computer.apply(&args.computer);
            if config.computer.desktop && config.computer.desktop_display.is_none() {
                config.computer.desktop_display = Some(free_display(&paths)?);
            }
            save_config(&paths, &name, &config)?;
            return Err(Error::new(
                1,
                "agent_host and computer run handlers: not built yet",
            ));
        }
        Command::Service { .. } | Command::InstallService(_) => {
            return Err(Error::new(1, "service: not built yet"));
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
        item["connection"].as_str().unwrap_or_default(),
        item["machineId"].as_str().unwrap_or_default(),
        item["server"].as_str().unwrap_or_default()
    );
}
fn save_config(paths: &Paths, name: &str, config: &Config) -> Result<()> {
    atomic_write(
        &paths.config(name).join("config.json"),
        &serde_json::to_vec_pretty(config).map_err(|_| Error::new(1, "Cannot encode config"))?,
    )
}
fn free_display(paths: &Paths) -> Result<u16> {
    let displays: Vec<u16> = paths
        .names()?
        .into_iter()
        .filter_map(|name| {
            paths
                .load(&name)
                .ok()
                .and_then(|(c, _)| c.computer.desktop_display)
        })
        .collect();
    (90..=u16::MAX)
        .find(|display| {
            !displays.contains(display)
                && !std::path::Path::new(&format!("/tmp/.X{display}-lock")).exists()
                && !std::path::Path::new(&format!("/tmp/.X11-unix/X{display}")).exists()
        })
        .ok_or_else(|| Error::new(5, "No desktop display is free; stop an unused X server"))
}
