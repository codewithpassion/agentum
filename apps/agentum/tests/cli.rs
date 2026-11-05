use std::process::Command;

fn command(temp: &tempfile::TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_agentum"));
    command
        .env("AGENTUM_CONFIG_DIR", temp.path().join("config"))
        .env("AGENTUM_STATE_DIR", temp.path().join("state"))
        .env_remove("AGENTUM_ENROLL_CODE");
    command
}
#[test]
fn version_help_usage_and_service_exit_codes() {
    let temp = tempfile::tempdir().unwrap();
    for flag in ["version", "--version", "-v"] {
        let output = command(&temp).arg(flag).output().unwrap();
        assert!(output.status.success());
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains(agentum::VERSION)
        );
    }
    for args in [
        vec!["run", "--help"],
        vec!["service", "restart", "--help"],
        vec!["help", "enroll"],
    ] {
        let output = command(&temp).args(args).output().unwrap();
        assert!(output.status.success());
        assert!(
            String::from_utf8(output.stdout)
                .unwrap()
                .contains("Example:")
        );
    }
    assert_eq!(
        command(&temp)
            .args(["run", "--nonsense"])
            .output()
            .unwrap()
            .status
            .code(),
        Some(2)
    );
    let output = command(&temp)
        .args(["service", "install", "--system"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.starts_with("Problem: "));
    assert!(error.contains("Not enrolled"));
    assert!(error.contains("Why:"));
    assert!(error.contains("Fix:"));
}

#[test]
fn modes_and_symlinks_cannot_expose_credentials() {
    use agentum::{
        instance::{Config, Paths, RunAs},
        wire::MachineRole,
    };
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    let config = Config::new(
        "machine".into(),
        "test".into(),
        "https://example.com".into(),
        vec![MachineRole::Computer],
        false,
        RunAs::Current,
    );
    paths.save("test", &config, "ag_mach_secret").unwrap();
    fs::set_permissions(
        paths.config("test").join("credential"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(paths.load("test").unwrap_err().code, 5);
    fs::remove_file(paths.config("test").join("credential")).unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, "ag_mach_secret").unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(outside, paths.config("test").join("credential")).unwrap();
    assert_eq!(paths.load("test").unwrap_err().code, 5);
}

#[test]
fn run_as_and_computer_settings_are_a_stable_config_contract() {
    use agentum::{
        cli::{Cli, Command},
        instance::{Config, RunAs},
        wire::MachineRole,
    };
    use clap::Parser;
    for (run_as, single) in [
        (RunAs::Current, true),
        (RunAs::User("dom".into()), true),
        (RunAs::AgentUser, false),
    ] {
        let config = Config::new(
            "m".into(),
            "office".into(),
            "https://example.com".into(),
            vec![MachineRole::Computer],
            true,
            run_as,
        );
        assert_eq!(config.single_user, single);
        let json = serde_json::to_value(config).unwrap();
        let decoded: Config = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.single_user, single);
        assert_eq!(decoded.computer.max_file_bytes, 256 << 20);
    }
    let cli = Cli::try_parse_from([
        "agentum",
        "run",
        "--desktop",
        "--workdir",
        "/work",
        "--read-only",
        "--allow-env",
        "LANG",
        "--max-file-bytes",
        "42",
        "--audit-keep",
        "-1",
    ])
    .unwrap();
    let Command::Run(args) = cli.command else {
        panic!()
    };
    let mut settings = agentum::instance::ComputerConfig::default();
    settings.apply(&args.computer);
    assert_eq!(settings.max_file_bytes, 42);
    assert_eq!(settings.audit_keep, -1);
    assert!(settings.desktop && settings.read_only);
    assert_eq!(settings.allow_env, ["LANG"]);
    let json = serde_json::to_value(&settings).unwrap();
    assert_eq!(json["workdir"], "/work");
}

#[test]
fn doctor_without_enrolment_reports_every_area_without_launching_claude() {
    let temp = tempfile::tempdir().unwrap();
    let output = command(&temp)
        .args(["doctor", "--instance", "rc-integration-uninstalled"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    let text = String::from_utf8(output.stdout).unwrap();
    for area in [
        "instance:",
        "systemd:",
        "service:",
        "claude:",
        "computer:",
        "server:",
    ] {
        assert!(text.contains(area), "missing {area}: {text}");
    }
    assert!(text.contains("enroll"));
    assert!(!text.contains("enable-linger user"));
}

#[test]
fn doctor_without_enrollment_and_malformed_code() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        command(&temp).arg("doctor").output().unwrap().status.code(),
        Some(4)
    );
    let output = command(&temp)
        .args(["enroll", "--url", "http://127.0.0.1:1", "--code", "bad"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("malformed"));
}

#[test]
fn all_help_entries_have_descriptions_and_examples() {
    use clap::CommandFactory;
    fn check(mut command: clap::Command) {
        for arg in command.get_arguments() {
            assert!(
                arg.get_help().is_some(),
                "{}: {}",
                command.get_name(),
                arg.get_id()
            );
        }
        assert!(command.render_help().to_string().contains("Example:"));
        for sub in command.get_subcommands() {
            if sub.get_name() != "help" {
                assert!(sub.get_about().is_some(), "{}", sub.get_name());
                check(sub.clone());
            }
        }
    }
    check(agentum::cli::Cli::command());
}

#[test]
fn rendered_problems_always_explain_the_specific_failure() {
    let temp = tempfile::tempdir().unwrap();
    for args in [
        vec!["status"],
        vec!["service", "restart"],
        vec!["enroll", "--url", "http://127.0.0.1:1", "--code", "bad"],
        vec!["run", "--nonsense"],
    ] {
        let output = command(&temp).args(&args).output().unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains("Why:"), "{error}");
        assert!(
            !error.contains("The command could not complete."),
            "{error}"
        );
        if args == ["status"] {
            assert!(
                error.contains("Why: No instance is enrolled on this machine for this user."),
                "{error}"
            );
        }
    }
}
