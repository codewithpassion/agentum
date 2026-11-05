use agentum::{
    Result,
    relay::{self, Reply, Role, Shutdown, SocketRole, Timing},
};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::{
    accept_async,
    tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;

struct TestRole {
    kind: SocketRole,
    state_file: Option<std::path::PathBuf>,
    stopped: Arc<Mutex<Vec<Shutdown>>>,
    replies: Arc<Mutex<Vec<Reply>>>,
}
#[async_trait]
impl Role for TestRole {
    fn kind(&self) -> SocketRole {
        self.kind
    }
    fn state_file(&self) -> Option<&std::path::Path> {
        self.state_file.as_deref()
    }
    fn hello(&self) -> Value {
        json!({"type":"hello", "role":format!("{:?}", self.kind)})
    }
    fn on_frame(&self, _: Value, reply: Reply) -> Result<()> {
        self.replies.lock().unwrap().push(reply);
        Ok(())
    }
    async fn shutdown(&self, reason: Shutdown) {
        self.stopped.lock().unwrap().push(reason);
    }
}
fn timing() -> Timing {
    Timing {
        heartbeat: Duration::from_millis(30),
        read_deadline: Duration::from_millis(120),
        ack_timeout: Duration::from_millis(100),
        stable_after: Duration::from_secs(30),
        retry_scale: 0.0001,
        ..Timing::default()
    }
}

#[tokio::test]
async fn both_roles_send_hello_heartbeat_and_exit_three_on_revocation() {
    for kind in [SocketRole::AgentHost, SocketRole::Computer] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                tcp,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), kind.path());
                    assert!(request.uri().query().is_none());
                    assert_eq!(request.headers()["authorization"], "Bearer hm_mach_test");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let first = ws.next().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(first.to_text().unwrap()).unwrap()["type"],
                "hello"
            );
            if kind == SocketRole::AgentHost {
                ws.send(Message::text(r#"{"type":"hello_ack"}"#))
                    .await
                    .unwrap();
            }
            let start = tokio::time::Instant::now();
            let beat = ws.next().await.unwrap().unwrap();
            assert!(start.elapsed() >= Duration::from_millis(20));
            if kind == SocketRole::Computer {
                assert_eq!(beat.to_text().unwrap(), "ping");
            } else {
                let ping: Value = serde_json::from_str(beat.to_text().unwrap()).unwrap();
                assert_eq!(ping["type"], "ping");
                assert!(ping["at"].as_str().unwrap().ends_with('Z'));
            }
            ws.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Library(4401),
                reason: "revoked".into(),
            })))
            .await
            .unwrap();
        });
        let role = Arc::new(TestRole {
            kind,
            state_file: None,
            stopped: Arc::default(),
            replies: Arc::default(),
        });
        let error = relay::run(
            role,
            &url,
            "hm_mach_test",
            CancellationToken::new(),
            timing(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 3);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn replacement_is_role_local_and_old_replies_never_reach_new_socket() {
    for (kind, code) in [(SocketRole::AgentHost, 1012), (SocketRole::Computer, 4409)] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let replies: Arc<Mutex<Vec<Reply>>> = Arc::default();
        let stopped: Arc<Mutex<Vec<Shutdown>>> = Arc::default();
        let (ready, ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(tcp).await.unwrap();
            ws.next().await.unwrap().unwrap();
            ws.send(Message::text(r#"{"type":"request","id":"one"}"#))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            let disconnected = tokio::time::Instant::now();
            ws.send(Message::Close(Some(CloseFrame {
                code: code.into(),
                reason: "replaced".into(),
            })))
            .await
            .unwrap();
            let (tcp, _) = listener.accept().await.unwrap();
            if kind == SocketRole::Computer {
                assert!(disconnected.elapsed() >= Duration::from_millis(25));
            }
            let mut next = accept_async(tcp).await.unwrap();
            next.next().await.unwrap().unwrap();
            ready.send(()).unwrap();
            // A stale reply must not appear before the new socket's heartbeat.
            let frame = next.next().await.unwrap().unwrap();
            assert!(!frame.to_text().unwrap().contains("stale"));
        });
        let cancel = CancellationToken::new();
        let role = Arc::new(TestRole {
            kind,
            state_file: None,
            stopped: stopped.clone(),
            replies: replies.clone(),
        });
        let client = tokio::spawn({
            let cancel = cancel.clone();
            async move { relay::run(role, &url, "hm_mach_test", cancel, timing()).await }
        });
        ready_rx.await.unwrap();
        let old = replies.lock().unwrap()[0].clone();
        assert!(old.send(json!({"stale":true})).await.is_err());
        assert!(stopped.lock().unwrap().contains(&Shutdown::Replaced));
        server.await.unwrap();
        cancel.cancel();
        client.await.unwrap().unwrap();
    }
}

#[test]
fn backoff_preserves_both_roles_windows_and_stability() {
    for step in [0, 1, 4, 100] {
        let ceiling = (2_f64.powi(step.min(6)) * 1000.0).min(60000.0);
        let host =
            relay::retry_delay(SocketRole::AgentHost, step as u32, false, 0.0).as_millis() as f64;
        assert_eq!(host, (ceiling * 0.8).max(1000.0));
        let computer =
            relay::retry_delay(SocketRole::Computer, step as u32, false, 0.0).as_millis() as f64;
        assert_eq!(computer, ceiling / 2.0);
    }
    assert_eq!(
        relay::retry_delay(SocketRole::Computer, 0, true, 0.0),
        Duration::from_secs(300)
    );
    assert_eq!(
        relay::retry_delay(SocketRole::Computer, 0, true, 0.99),
        Duration::from_millis(448500)
    );
}

#[tokio::test]
async fn revoked_role_stops_its_sibling() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stopped_a = Arc::default();
    let stopped_b: Arc<Mutex<Vec<Shutdown>>> = Arc::default();
    let server = tokio::spawn(async move {
        let (one, _) = listener.accept().await.unwrap();
        let mut one = accept_async(one).await.unwrap();
        one.next().await.unwrap().unwrap();
        let (two, _) = listener.accept().await.unwrap();
        let mut two = accept_async(two).await.unwrap();
        two.next().await.unwrap().unwrap();
        one.send(Message::Close(Some(CloseFrame {
            code: 4401.into(),
            reason: "revoked".into(),
        })))
        .await
        .unwrap();
        // The other socket must close too without receiving a server revocation.
        let _ = tokio::time::timeout(Duration::from_secs(1), two.next())
            .await
            .unwrap();
    });
    let roles: Vec<Arc<dyn Role>> = vec![
        Arc::new(TestRole {
            kind: SocketRole::AgentHost,
            state_file: None,
            stopped: stopped_a,
            replies: Arc::default(),
        }),
        Arc::new(TestRole {
            kind: SocketRole::Computer,
            state_file: None,
            stopped: stopped_b.clone(),
            replies: Arc::default(),
        }),
    ];
    let error = relay::run_roles(roles, url, "ag_mach_test".into(), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, 3);
    server.await.unwrap();
    assert!(!stopped_b.lock().unwrap().is_empty());
}

#[tokio::test]
async fn computer_closes_after_two_unanswered_pings() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let cancel = CancellationToken::new();
    let server = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            socket.next().await.unwrap().unwrap();
            for _ in 0..2 {
                assert_eq!(
                    socket.next().await.unwrap().unwrap().to_text().unwrap(),
                    "ping"
                );
            }
            let Message::Close(Some(frame)) = socket.next().await.unwrap().unwrap() else {
                panic!("expected heartbeat timeout close")
            };
            assert_eq!(u16::from(frame.code), 1008);
            cancel.cancel();
        }
    });
    let role = Arc::new(TestRole {
        kind: SocketRole::Computer,
        state_file: None,
        stopped: Arc::default(),
        replies: Arc::default(),
    });
    relay::run(role, &url, "ag_mach_test", cancel, timing())
        .await
        .unwrap();
    server.await.unwrap();
}

struct MissingPrerequisite;
#[async_trait]
impl Role for MissingPrerequisite {
    fn kind(&self) -> SocketRole {
        SocketRole::AgentHost
    }
    fn prerequisites(&self) -> Result<()> {
        Err(agentum::Error::new(
            5,
            "Claude missing; install it with the doctor fix",
        ))
    }
    fn hello(&self) -> Value {
        panic!("disabled role must never dial")
    }
    fn on_frame(&self, _: Value, _: Reply) -> Result<()> {
        panic!("disabled role")
    }
    async fn shutdown(&self, _: Shutdown) {}
}
#[tokio::test]
async fn missing_prerequisite_disables_only_its_role() {
    let error = relay::run_roles(
        vec![Arc::new(MissingPrerequisite)],
        "http://127.0.0.1:1".into(),
        "hm_mach_test".into(),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, 5);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Close(Some(CloseFrame {
                code: 4401.into(),
                reason: "revoked".into(),
            })))
            .await
            .unwrap();
    });
    let healthy = Arc::new(TestRole {
        kind: SocketRole::Computer,
        state_file: None,
        stopped: Arc::default(),
        replies: Arc::default(),
    });
    let error = relay::run_roles(
        vec![Arc::new(MissingPrerequisite), healthy],
        url,
        "hm_mach_test".into(),
        CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, 3);
    server.await.unwrap();
}

#[tokio::test]
async fn hello_ack_has_40_seconds_and_computer_read_has_25_seconds() {
    for (kind, deadline) in [(SocketRole::AgentHost, 40), (SocketRole::Computer, 25)] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (ready, received) = tokio::sync::oneshot::channel();
        let cancel = CancellationToken::new();
        let server = tokio::spawn({
            let cancel = cancel.clone();
            async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(tcp).await.unwrap();
                socket.next().await.unwrap().unwrap();
                ready.send(()).unwrap();
                loop {
                    let frame = socket.next().await.unwrap().unwrap();
                    if let Message::Close(Some(close)) = frame {
                        assert_eq!(u16::from(close.code), 1008);
                        cancel.cancel();
                        break;
                    }
                }
            }
        });
        let role = Arc::new(TestRole {
            kind,
            state_file: None,
            stopped: Arc::default(),
            replies: Arc::default(),
        });
        let client = tokio::spawn({
            let cancel = cancel.clone();
            async move {
                let mut timing = Timing::for_role(kind);
                // Isolate the computer's read deadline from its two-missed-ping limit.
                if kind == SocketRole::Computer {
                    timing.heartbeat = Duration::from_secs(3600);
                }
                relay::run(role, &url, "ag_mach_test", cancel, timing).await
            }
        });
        received.await.unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(deadline - 1)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(!server.is_finished(), "closed before {deadline} s");
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::time::resume();
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        client.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn loops_reset_their_own_backoff_and_persist_state() {
    for kind in [SocketRole::AgentHost, SocketRole::Computer] {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("connection.json");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        let server = tokio::spawn({
            let cancel = cancel.clone();
            let state = state.clone();
            async move {
                let expected = if kind == SocketRole::Computer {
                    [1, 2, 2, 0, 1]
                } else {
                    [0, 1, 0, 0, 1]
                };
                for phase in 0..=5 {
                    let (tcp, _) = listener.accept().await.unwrap();
                    if phase > 0 {
                        let value: Value =
                            serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
                        assert_eq!(value["status"], "reconnecting");
                        assert_eq!(
                            value["retry_step"],
                            expected[phase - 1],
                            "{kind:?} phase {phase}"
                        );
                        assert!(value["next_attempt"].as_str().is_some());
                    }
                    let mut socket = accept_async(tcp).await.unwrap();
                    socket.next().await.unwrap().unwrap();
                    if kind == SocketRole::AgentHost {
                        socket
                            .send(Message::text(r#"{"type":"hello_ack"}"#))
                            .await
                            .unwrap();
                    }
                    // Wait for connected state, also ensuring ack processing precedes the stable period.
                    tokio::time::timeout(Duration::from_secs(1), async {
                        loop {
                            let value: Value =
                                serde_json::from_slice(&std::fs::read(&state).unwrap_or_default())
                                    .unwrap_or_default();
                            if value["status"] == "connected" {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .unwrap();
                    if phase == 5 {
                        cancel.cancel();
                        break;
                    }
                    if phase == 2 || phase == 3 {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                    socket
                        .send(Message::Close(Some(CloseFrame {
                            code: if phase == 2 {
                                if kind == SocketRole::Computer {
                                    4409.into()
                                } else {
                                    1012.into()
                                }
                            } else {
                                1000.into()
                            },
                            reason: "retry test".into(),
                        })))
                        .await
                        .unwrap();
                }
            }
        });
        let role = Arc::new(TestRole {
            kind,
            state_file: Some(state.clone()),
            stopped: Arc::default(),
            replies: Arc::default(),
        });
        let mut timing = Timing::for_role(kind);
        timing.stable_after = Duration::from_millis(50);
        timing.retry_scale = 0.01;
        relay::run(role, &url, "ag_mach_test", cancel, timing)
            .await
            .unwrap();
        server.await.unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(state).unwrap()).unwrap();
        assert_eq!(value["status"], "stopped");
        assert_eq!(value["reason"], "stopped by signal");
    }
}

#[tokio::test]
async fn production_constructors_send_strict_hellos_and_log_frames() {
    use agentum::{
        instance::{Config, Paths, RunAs},
        wire::MachineRole,
    };
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut config = Config::new(
        "machine".into(),
        "office".into(),
        url.clone(),
        vec![MachineRole::AgentHost, MachineRole::Computer],
        false,
        RunAs::Current,
    );
    config.computer.allow_root = true;
    paths.save("office", &config, "ag_mach_test").unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let server = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        for _ in 0..2 {
            let (tcp, _) = listener.accept().await.unwrap();
            let barrier = barrier.clone();
            handlers.spawn(async move {
                let mut socket = accept_async(tcp).await.unwrap();
                let frame = socket.next().await.unwrap().unwrap();
                let hello: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                assert_eq!(hello["type"], "hello");
                if hello.get("protocol_version").is_some() {
                    assert_eq!(hello.as_object().unwrap().len(), 9);
                } else {
                    assert_eq!(hello.as_object().unwrap().len(), 5);
                    socket
                        .send(Message::text(r#"{"type":"hello_ack"}"#))
                        .await
                        .unwrap();
                }
                socket
                    .send(Message::text(r#"{"type":"future_frame"}"#))
                    .await
                    .unwrap();
                barrier.wait().await;
                socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 4401.into(),
                        reason: "revoked".into(),
                    })))
                    .await
                    .unwrap();
            });
        }
        while let Some(result) = handlers.join_next().await {
            result.unwrap();
        }
    });
    let roles = vec![
        agentum::runs::role(&paths, "office", &config),
        agentum::computer::role(&paths, "office", &config),
    ];
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        relay::run_roles(roles, url, "ag_mach_test".into(), CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, 3);
    server.await.unwrap();
    for role in ["agent_host", "computer"] {
        let value: Value = serde_json::from_slice(
            &std::fs::read(
                paths
                    .state("office")
                    .join(format!("connection-{role}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["status"], "stopped");
    }
}
