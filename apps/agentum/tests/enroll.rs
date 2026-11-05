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
