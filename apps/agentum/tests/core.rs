use agentum::{
    cli::Cli,
    instance::{Config, Paths, RunAs, slug},
    privilege::Problem,
    wire,
};
use clap::Parser;
use serde_json::Value;
use std::{fs, path::Path};

#[test]
fn every_wire_fixture_round_trips() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for folder in [
        "packages/protocol/fixtures",
        "apps/computer/testdata/protocol",
        "apps/computer/testdata/enroll",
        "apps/daemon/fixtures/tool-run",
    ] {
        for file in fs::read_dir(root.join(folder)).unwrap() {
            let path = file.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                let filename = path.file_name().unwrap().to_str().unwrap();
                if folder == "packages/protocol/fixtures" {
                    match filename {
                        "enroll-request.json" => round_trip::<wire::LegacyEnrollRequest>(&value),
                        "enroll-response.json" => round_trip::<wire::LegacyEnrollResponse>(&value),
                        "enroll-request-roles.json" => round_trip::<wire::EnrollRequest>(&value),
                        "enroll-response-roles.json" => round_trip::<wire::EnrollResponse>(&value),
                        "hello.json" => round_trip::<wire::DaemonHello>(&value),
                        "ping.json" => round_trip::<wire::Ping>(&value),
                        "hello-ack.json"
                        | "offer.json"
                        | "cancel.json"
                        | "library-changed.json" => round_trip::<wire::RelayFrame>(&value),
                        "events-request.json" => round_trip::<wire::EventsRequest>(&value),
                        "events-response.json" => round_trip::<wire::EventsResponse>(&value),
                        "claim-response.json" => round_trip::<wire::ClaimResponse>(&value),
                        name if name.starts_with("complete-request-") => {
                            round_trip::<wire::CompleteRequest>(&value)
                        }
                        "complete-response.json" | "heartbeat-response.json" => {
                            round_trip::<wire::Empty>(&value)
                        }
                        _ => panic!("add a typed fixture check for {filename}"),
                    }
                } else if folder == "apps/computer/testdata/protocol" {
                    if filename.starts_with("client_to_server_hello") {
                        round_trip::<wire::ComputerHello>(&value);
                    } else if filename.starts_with("client_to_server_reply") {
                        round_trip::<wire::ComputerReply>(&value);
                    } else if filename.starts_with("server_to_client") {
                        round_trip::<wire::ComputerRequest>(&value);
                    } else {
                        round_trip::<wire::ErrorCodes>(&value);
                    }
                } else if folder == "apps/computer/testdata/enroll" {
                    if filename == "request.json" {
                        round_trip::<wire::ComputerEnrollRequest>(&value);
                    } else {
                        round_trip::<wire::LegacyEnrollResponse>(&value);
                    }
                } else {
                    round_trip::<wire::Document>(&value);
                }
            }
        }
    }
    let request: wire::EnrollRequest = serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/enroll-request-roles.json"
    ))
    .unwrap();
    assert_eq!(request.roles.unwrap().len(), 2);
    let response: wire::EnrollResponse = serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/enroll-response-roles.json"
    ))
    .unwrap();
    assert_eq!(response.roles.len(), 2);
}

#[test]
fn slugs_instances_and_private_files() {
    assert_eq!(slug(" Office BOX! "), "office-box");
    assert_eq!(slug("✨"), "machine");
    assert_eq!(slug(&"x".repeat(100)).len(), 40);
    let tmp = tempfile::tempdir().unwrap();
    let paths = Paths::new(tmp.path().join("config"), tmp.path().join("state"), false);
    assert_eq!(paths.select(None).unwrap_err().code, 4);
    let config = Config::new(
        "machine-1".into(),
        "Office".into(),
        "https://example.com".into(),
        vec![wire::MachineRole::Computer],
        false,
        RunAs::Current,
    );
    paths.save("office", &config, "hm_mach_test").unwrap();
    assert_eq!(paths.select(None).unwrap(), "office");
    assert!(paths.reserve(Some("office"), "ignored").is_err());
    assert_eq!(paths.reserve(None, "Office").unwrap(), "office-2");
    paths.save("office-2", &config, "ag_mach_test").unwrap();
    let error = paths.select(None).unwrap_err();
    assert_eq!(error.code, 2);
    assert!(error.to_string().contains("office-2"));
    assert_eq!(paths.load("office").unwrap().1, "hm_mach_test");
    assert!(
        !fs::read_to_string(paths.config("office").join("config.json"))
            .unwrap()
            .contains("hm_mach")
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(paths.config("office"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    for file in ["config.json", "credential"] {
        assert_eq!(
            fs::metadata(paths.config("office").join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert!(paths.save("office", &config, "hm_mach_new").is_err());
    assert_eq!(paths.load("office").unwrap().1, "hm_mach_test");
}

#[test]
fn every_privilege_explanation_renders() {
    for problem in [
        Problem::PrivateClaude,
        Problem::ClaudeMissing,
        Problem::ClaudeOld,
        Problem::ClaudeLogin,
        Problem::ConfigOwner,
        Problem::ConfigMode,
        Problem::Unreachable,
        Problem::Tls,
        Problem::Plaintext,
        Problem::Redirect,
        Problem::Revoked,
        Problem::Desktop,
        Problem::Root,
        Problem::Systemd,
        Problem::SystemManager,
        Problem::UserBus,
        Problem::Linger,
        Problem::SystemRoot,
    ] {
        let explanation = problem.explain("dom", "office");
        assert!(!explanation.reason.trim().is_empty());
        let rendered = explanation.to_string();
        assert!(rendered.contains("Why:"), "{rendered}");
        assert!(
            !rendered.contains("The command could not complete."),
            "{rendered}"
        );
    }
    assert!(
        Problem::UserBus
            .explain("dom", "office")
            .to_string()
            .contains("sudo, su or cron")
    );
}

#[test]
fn cli_accepts_all_commands_and_old_enrol_spellings() {
    for args in [
        vec![
            "enroll",
            "--code",
            "hm_enr_test",
            "--url",
            "https://example.com",
            "--system",
            "--run-as",
            "agent-user",
        ],
        vec![
            "enroll",
            "hm_enr_test",
            "--server",
            "https://example.com",
            "--claude",
            "/bin/claude",
        ],
        vec![
            "run",
            "--instance",
            "office",
            "--read-only",
            "--allow",
            "ls",
            "--deny",
            "rm",
            "--allow-env",
            "LANG",
            "--max-concurrent",
            "2",
            "--desktop-display",
            "92",
        ],
        vec![
            "service",
            "install",
            "--system",
            "--run-as",
            "dom",
            "--desktop",
            "--yes",
        ],
        vec!["install-service", "--yes"],
        vec!["service", "logs", "-f"],
        vec!["service", "restart"],
        vec!["service", "uninstall"],
        vec!["service", "status"],
        vec!["status", "--json"],
        vec!["list", "--json"],
        vec!["doctor"],
        vec!["version"],
    ] {
        Cli::try_parse_from(std::iter::once("agentum").chain(args)).unwrap();
    }
    assert!(Cli::try_parse_from(["agentum", "enroll", "--code", "hm_enr_test"]).is_err());
    assert!(Cli::try_parse_from(["agentum", "run", "--unknown"]).is_err());
    assert!(Cli::try_parse_from(["agentum", "install-service", "--refresh"]).is_err());
    for args in [
        vec!["--help"],
        vec!["enroll", "--help"],
        vec!["service", "install", "--help"],
    ] {
        let error = Cli::try_parse_from(std::iter::once("agentum").chain(args)).unwrap_err();
        assert_eq!(error.exit_code(), 0);
        assert!(error.to_string().contains("Example:"));
    }
}

fn round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(value: &Value) {
    let decoded: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), *value);
}

#[test]
fn reads_ignore_unknown_fields_and_sends_have_exact_hello_keys() {
    let mut hello: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/hello.json"
    ))
    .unwrap();
    hello["future"] = serde_json::json!(true);
    let parsed: wire::DaemonHello = serde_json::from_value(hello).unwrap();
    assert!(
        serde_json::to_value(parsed)
            .unwrap()
            .get("future")
            .is_none()
    );
    let hello = serde_json::to_value(wire::daemon_hello("0.1.0", "2.1.300")).unwrap();
    assert_eq!(hello.as_object().unwrap().len(), 5);
    assert_eq!(hello["capabilities"]["agentSdk"], "claude-cli@2.1.300");
    assert!(
        hello["features"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("parallel-subagents"))
    );
    let mut request: Value = serde_json::from_str(include_str!(
        "../../../apps/computer/testdata/protocol/server_to_client_exec_null_cwd.json"
    ))
    .unwrap();
    request["future"] = serde_json::json!(true);
    assert!(matches!(
        serde_json::from_value::<wire::ComputerRequest>(request).unwrap(),
        wire::ComputerRequest::Exec { cwd: None, .. }
    ));
}
