use agentum::{
    cli::{Cli, Command},
    enroll,
    instance::Paths,
};
use axum::{Json, Router, extract::State, routing::post};
use clap::Parser;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn all_spellings_use_the_rc1_contract_and_keep_colliding_credentials() {
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let app = Router::new().route("/api/machines/enroll", post(|State(calls): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>| async move {
        calls.lock().unwrap().push(body);
        Json(json!({"credential":"ag_mach_test", "machineId":"machine-1", "machineName":"Office box", "roles":["agent_host","computer"], "future":true}))
    })).with_state(calls.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    for (index, flags) in [
        vec!["--code", "hm_enr_test", "--url", &url],
        vec!["hm_enr_test", "--server", &url],
        vec!["--url", &url, "--code", "ag_enr_test"],
    ]
    .into_iter()
    .enumerate()
    {
        let cli = Cli::try_parse_from(["agentum", "enroll"].into_iter().chain(flags)).unwrap();
        let Command::Enroll(args) = cli.command else {
            panic!()
        };
        let result = enroll::enroll(
            &paths,
            &args,
            args.code
                .as_deref()
                .or(args.legacy_code.as_deref())
                .unwrap(),
            "0.1.0",
        )
        .await
        .unwrap();
        assert_eq!(
            result.instance,
            if index == 0 {
                "office-box".into()
            } else {
                format!("office-box-{}", index + 1)
            }
        );
    }
    let calls_before = calls.lock().unwrap().len();
    let cli = Cli::try_parse_from([
        "agentum",
        "enroll",
        "--code",
        "hm_enr_test",
        "--url",
        &url,
        "--name",
        "office-box",
    ])
    .unwrap();
    let Command::Enroll(args) = cli.command else {
        panic!()
    };
    assert!(
        enroll::enroll(&paths, &args, "hm_enr_test", "0.1.0")
            .await
            .is_err()
    );
    assert_eq!(calls.lock().unwrap().len(), calls_before);
    for body in calls.lock().unwrap().iter() {
        assert_eq!(body.as_object().unwrap().len(), 6);
        assert_eq!(body["singleUser"], true);
        assert_eq!(body["os"], "linux");
        assert!(matches!(body["arch"].as_str().unwrap(), "amd64" | "arm64"));
        assert!(body.get("roles").is_none());
    }
    server.abort();
}

#[test]
fn server_urls_refuse_remote_plaintext_and_strip_secrets() {
    for url in [
        "http://example.com",
        "https://user:password@example.com",
        "file:///etc/passwd",
    ] {
        assert!(enroll::server_url(url).is_err());
    }
    assert_eq!(
        enroll::server_url("http://127.0.0.1:123/?secret=x#x")
            .unwrap()
            .as_str(),
        "http://127.0.0.1:123/"
    );
}

#[tokio::test]
async fn redirects_are_never_followed_and_errors_never_echo_the_code() {
    use axum::{http::StatusCode, response::Redirect, routing::get};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let redirected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = redirected.clone();
    let app = Router::new()
        .route(
            "/api/machines/enroll",
            post(|| async { Redirect::temporary("/leak") }),
        )
        .route(
            "/leak",
            get(move || async move {
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
                StatusCode::OK
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    let cli = Cli::try_parse_from([
        "agentum",
        "enroll",
        "--url",
        &url,
        "--code",
        "ag_enr_secret",
    ])
    .unwrap();
    let Command::Enroll(args) = cli.command else {
        panic!()
    };
    let error = enroll::enroll(&paths, &args, "ag_enr_secret", "0.1.0")
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("redirect"));
    assert!(!error.to_string().contains("ag_enr_secret"));
    assert!(!redirected.load(std::sync::atomic::Ordering::SeqCst));
    server.abort();
}

#[tokio::test]
async fn issued_credential_survives_a_state_write_failure() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    agentum::instance::private_dir(&paths.state_root).unwrap();
    std::fs::write(paths.state("office"), "blocks directory creation").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/api/machines/enroll", post(|| async { Json(json!({"credential":"ag_mach_recover", "machineId":"machine", "machineName":"office", "roles":["computer"]})) }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let cli = Cli::try_parse_from(["agentum", "enroll", "--url", &url]).unwrap();
    let Command::Enroll(args) = cli.command else {
        panic!()
    };
    let error = enroll::enroll(&paths, &args, "ag_enr_test", "0.1.0")
        .await
        .err()
        .unwrap();
    let recovered = std::fs::read_dir(paths.config("office"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("recovered-credential-")
        })
        .unwrap();
    assert!(error.to_string().contains(recovered.to_str().unwrap()));
    assert!(!error.to_string().contains("ag_mach_recover"));
    assert_eq!(
        std::fs::read_to_string(&recovered).unwrap(),
        "ag_mach_recover\n"
    );
    agentum::instance::check_private(&recovered, 0o600).unwrap();
    server.abort();
}

#[tokio::test]
async fn system_enrollment_uses_system_paths_and_agent_user_contract() {
    use agentum::instance::RunAs;
    let system = Paths::discover(true);
    assert_eq!(
        system.config("office"),
        std::path::Path::new("/etc/agentum/office")
    );
    assert_eq!(
        system.state("office"),
        std::path::Path::new("/var/lib/agentum/office")
    );
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("etc"), temp.path().join("var"), true);
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let app = Router::new().route("/api/machines/enroll", post(|State(calls): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>| async move {
        calls.lock().unwrap().push(body);
        Json(json!({"credential":"ag_mach_test", "machineId":"machine", "machineName":"system-test", "roles":["agent_host","computer"]}))
    })).with_state(calls.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let cli = Cli::try_parse_from([
        "agentum",
        "enroll",
        "--url",
        &url,
        "--system",
        "--run-as",
        "agent-user",
    ])
    .unwrap();
    let Command::Enroll(args) = cli.command else {
        panic!()
    };
    let answer = enroll::enroll(&paths, &args, "ag_enr_test", "0.1.0").await;
    if nix::unistd::geteuid().is_root() {
        let name = answer.unwrap().instance;
        let (config, _) = paths.load(&name).unwrap();
        assert!(config.system);
        assert_eq!(config.run_as, RunAs::AgentUser);
        assert_eq!(calls.lock().unwrap()[0]["singleUser"], false);
    } else {
        assert_eq!(answer.err().unwrap().code, 5);
        assert!(calls.lock().unwrap().is_empty());
    }
    server.abort();
}

#[tokio::test]
async fn stdin_environment_first_start_and_runtime_overrides() {
    use axum::{
        extract::ws::{CloseFrame, Message, WebSocketUpgrade},
        routing::get,
    };
    use tokio::io::AsyncWriteExt;
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = calls.clone();
    let app = Router::new()
        .route("/api/machines/enroll", post(move |Json(body): Json<Value>| { let observed = observed.clone(); async move {
            observed.lock().unwrap().push(body);
            Json(json!({"credential":"ag_mach_test", "machineId":"machine", "machineName":"cli-test", "roles":["computer"]}))
        }}))
        .route("/api/machines/computer", get(|ws: WebSocketUpgrade| async move { ws.on_upgrade(|mut socket| async move {
            let hello = socket.recv().await.unwrap().unwrap();
            let Message::Text(hello) = hello else { panic!() };
            let hello: Value = serde_json::from_str(&hello).unwrap();
            assert_eq!(hello["type"], "hello");
            assert_eq!(hello["run_as_user"], agentum::instance::RunAs::Current.user("cli-test"));
            socket.send(Message::Close(Some(CloseFrame { code: 4401, reason: "revoked".into() }))).await.unwrap();
        }) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for mode in ["stdin", "environment", "run"] {
        let temp = tempfile::tempdir().unwrap();
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_agentum"));
        command
            .env("AGENTUM_CONFIG_DIR", temp.path().join("config"))
            .env("AGENTUM_STATE_DIR", temp.path().join("state"))
            .env("USER", "wrong-user")
            .env_remove("SUDO_USER")
            .env_remove("AGENTUM_ENROLL_CODE")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        command.args([if mode == "run" { "run" } else { "enroll" }, "--url", &url]);
        if mode == "stdin" {
            command
                .arg("--code-stdin")
                .stdin(std::process::Stdio::piped());
        }
        if mode == "environment" {
            command.env("AGENTUM_ENROLL_CODE", "ag_enr_environment");
        }
        if mode == "run" {
            command.args([
                "--instance",
                "cli-test",
                "--code",
                "ag_enr_run",
                "--allow-root",
                "--read-only",
            ]);
        }
        let mut child = command.spawn().unwrap();
        // Keep stdin open: --code-stdin must return after the first line without waiting for EOF.
        let mut stdin = child.stdin.take();
        if let Some(stdin) = &mut stdin {
            stdin
                .write_all(b"ag_enr_stdin\nignored second line\n")
                .await
                .unwrap();
        }
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            output.status.code(),
            Some(if mode == "run" { 3 } else { 0 }),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
        assert!(!paths.load("cli-test").unwrap().0.computer.read_only);
        if mode == "run" {
            for save in [false, true] {
                let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_agentum"));
                command
                    .env("AGENTUM_CONFIG_DIR", &paths.config_root)
                    .env("AGENTUM_STATE_DIR", &paths.state_root)
                    .args([
                        "run",
                        "--instance",
                        "cli-test",
                        "--allow-root",
                        "--read-only",
                    ]);
                if save {
                    command.arg("--save");
                }
                let output = command.output().await.unwrap();
                assert_eq!(output.status.code(), Some(3));
                assert_eq!(paths.load("cli-test").unwrap().0.computer.read_only, save);
            }
            for args in [vec!["status", "--json"], vec!["list", "--json"]] {
                let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_agentum"))
                    .env("AGENTUM_CONFIG_DIR", &paths.config_root)
                    .env("AGENTUM_STATE_DIR", &paths.state_root)
                    .args(args)
                    .args(["--instance", "cli-test"])
                    .output()
                    .await
                    .unwrap();
                assert!(output.status.success());
                let value: Value = serde_json::from_slice(&output.stdout).unwrap();
                let status = if value.is_array() { &value[0] } else { &value };
                assert_eq!(status["service"], "not installed");
                assert_eq!(status["connection"]["computer"]["status"], "stopped");
                assert!(
                    status["connection"]["computer"]["reason"]
                        .as_str()
                        .unwrap()
                        .contains("revoked")
                );
            }
        }
        drop(stdin);
    }
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|v| v["code"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["ag_enr_stdin", "ag_enr_environment", "ag_enr_run"]
    );
    server.abort();
}

#[tokio::test]
async fn enrollment_401_is_a_runtime_failure_without_leaking_response() {
    let app = Router::new().route(
        "/api/machines/enroll",
        post(|| async { (axum::http::StatusCode::UNAUTHORIZED, "ag_enr_secret") }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_agentum"))
        .env("AGENTUM_CONFIG_DIR", temp.path().join("config"))
        .env("AGENTUM_STATE_DIR", temp.path().join("state"))
        .args(["enroll", "--url", &url, "--code", "ag_enr_secret"])
        .output()
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let message = String::from_utf8(output.stderr).unwrap();
    assert!(message.contains("401"));
    assert!(!message.contains("ag_enr_secret"));
    server.abort();
}

#[tokio::test]
async fn replacement_preserves_settings_and_name() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    let mut config = agentum::instance::Config::new(
        "old".into(),
        "office".into(),
        "http://127.0.0.1".into(),
        vec![agentum::wire::MachineRole::Computer],
        false,
        agentum::instance::RunAs::Current,
    );
    config.computer.read_only = true;
    paths.save("office", &config, "ag_mach_old").unwrap();
    std::fs::create_dir_all(paths.state("office")).unwrap();
    for role in ["agent_host", "computer"] {
        std::fs::write(
            paths
                .state("office")
                .join(format!("connection-{role}.json")),
            r#"{"status":"stopped","reason":"credential rejected"}"#,
        )
        .unwrap();
    }
    std::fs::write(paths.state("office").join("audit.json"), "keep").unwrap();
    let app = Router::new().route("/api/machines/enroll", post(|| async { Json(json!({"credential":"ag_mach_new", "machineId":"new", "machineName":"renamed", "roles":["computer"]})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let cli = Cli::try_parse_from([
        "agentum",
        "enroll",
        "--name",
        "office",
        "--replace",
        "--url",
        &url,
    ])
    .unwrap();
    let Command::Enroll(args) = cli.command else {
        panic!()
    };
    let answer = enroll::enroll(&paths, &args, "ag_enr_test", "test")
        .await
        .unwrap();
    assert_eq!(answer.instance, "office");
    let (config, credential) = paths.load("office").unwrap();
    assert!(config.computer.read_only);
    assert_eq!(config.machine_id, "new");
    assert_eq!(credential, "ag_mach_new");
    for role in ["agent_host", "computer"] {
        assert!(
            !paths
                .state("office")
                .join(format!("connection-{role}.json"))
                .exists()
        );
    }
    assert_eq!(
        std::fs::read_to_string(paths.state("office").join("audit.json")).unwrap(),
        "keep"
    );
    use std::os::unix::fs::MetadataExt;
    let before = std::fs::metadata(paths.config("office").join("credential")).unwrap();
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_agentum"))
        .env("AGENTUM_CONFIG_DIR", &paths.config_root)
        .env("AGENTUM_STATE_DIR", &paths.state_root)
        .env_remove("AGENTUM_ENROLL_CODE")
        .args([
            "enroll",
            "--instance",
            "office",
            "--replace",
            "--code",
            "ag_enr_next",
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("agentum run --instance office"));
    assert!(text.contains("agentum service install --instance office"));
    let after = std::fs::metadata(paths.config("office").join("credential")).unwrap();
    assert_eq!(
        (after.uid(), after.gid(), after.mode()),
        (before.uid(), before.gid(), before.mode())
    );
    assert!(paths.load("office").unwrap().0.computer.read_only);
    let unit = temp
        .path()
        .join(".config/systemd/user/agentum-office.service");
    std::fs::create_dir_all(unit.parent().unwrap()).unwrap();
    std::fs::write(unit, "fake installed unit").unwrap();
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_agentum"))
        .env("HOME", temp.path())
        .env("AGENTUM_CONFIG_DIR", &paths.config_root)
        .env("AGENTUM_STATE_DIR", &paths.state_root)
        .env_remove("AGENTUM_ENROLL_CODE")
        .args([
            "enroll",
            "--instance",
            "office",
            "--replace",
            "--code",
            "ag_enr_next",
        ])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("Restart it with: agentum service restart --instance office"));
    assert!(!text.contains("Start with:"));
    assert!(!text.contains("install a service"));
    server.abort();
}

#[test]
fn system_names_fit_accounts_and_remain_unique() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
    for name in ["abcdefghijklmnopqrstu", "office-svc"] {
        assert!(
            agentum::instance::reserve_enrollment(&[paths.clone()], Some(name), "", true).is_err()
        );
    }
    for server in ["a very long server supplied machine name", "office-svc"] {
        let name =
            agentum::instance::reserve_enrollment(&[paths.clone()], None, server, true).unwrap();
        assert!(name.len() <= 20 && !name.ends_with("-svc"));
        std::fs::create_dir_all(paths.config(&name)).unwrap();
        let next =
            agentum::instance::reserve_enrollment(&[paths.clone()], None, server, true).unwrap();
        assert_ne!(name, next);
        assert!(next.len() <= 20 && !next.ends_with("-svc"));
    }
}

#[tokio::test]
async fn invalid_system_names_are_refused_before_any_exchange() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), true);
    for name in ["abcdefghijklmnopqrstu", "office-svc"] {
        let cli = Cli::try_parse_from([
            "agentum",
            "enroll",
            "--system",
            "--name",
            name,
            "--url",
            "http://127.0.0.1:1",
        ])
        .unwrap();
        let Command::Enroll(args) = cli.command else {
            panic!()
        };
        let error = enroll::enroll(&paths, &args, "ag_enr_test", "test")
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, 2);
        assert!(error.message.contains("System instance names"));
        assert!(!paths.config_root.exists());
    }
}

#[tokio::test]
async fn pre_enrollment_network_fix_uses_the_real_command_and_name() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let cli =
        Cli::try_parse_from(["agentum", "enroll", "--url", &url, "--name", "office"]).unwrap();
    let Command::Enroll(args) = cli.command else {
        panic!()
    };
    let error = enroll::enroll(&paths, &args, "ag_enr_secret", "test")
        .await
        .err()
        .unwrap();
    assert!(
        error
            .message
            .contains(&format!("agentum enroll --instance office --url {url}"))
    );
    assert!(!error.message.contains("agentum doctor"));
    assert!(!error.message.contains("ag_enr_secret"));
}

#[test]
fn installer_json_keys_are_stable() {
    let value = serde_json::to_value(agentum::enroll::Enrolled {
        instance: "office".into(),
        machine_id: "m".into(),
        roles: vec![agentum::wire::MachineRole::Computer],
        run_as: "agent-user".into(),
    })
    .unwrap();
    assert_eq!(
        value,
        json!({"instance":"office", "machineId":"m", "roles":["computer"], "runAs":"agent-user"})
    );
}
