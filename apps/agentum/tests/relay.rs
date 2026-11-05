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
    stopped: Arc<Mutex<Vec<Shutdown>>>,
    replies: Arc<Mutex<Vec<Reply>>>,
}
#[async_trait]
impl Role for TestRole {
    fn kind(&self) -> SocketRole {
        self.kind
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
            stopped: stopped.clone(),
            replies: replies.clone(),
        });
        let client = tokio::spawn({
            let cancel = cancel.clone();
            async move { relay::run(role, &url, "hm_mach_test", cancel, timing()).await }
        });
        ready_rx.await.unwrap();
        let old = replies.lock().unwrap()[0].clone();
        assert!(old.send(json!({"stale":true})).is_err());
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
        assert_eq!(host, ceiling * 0.8);
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
    assert!(!SocketRole::AgentHost.resets(Duration::from_secs(59), None));
    assert!(SocketRole::AgentHost.resets(Duration::from_secs(40), Some(Duration::from_secs(31))));
    assert!(!SocketRole::Computer.resets(Duration::from_secs(59), None));
    assert!(SocketRole::Computer.resets(Duration::from_secs(60), None));
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
            stopped: stopped_a,
            replies: Arc::default(),
        }),
        Arc::new(TestRole {
            kind: SocketRole::Computer,
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
