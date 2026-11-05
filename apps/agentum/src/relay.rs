//! Shared transport. Role handlers reserve work synchronously, then may retain Reply
//! while work continues across reconnects. Each Reply belongs to exactly one socket.
use crate::{Error, Result, enroll::endpoint, privilege::Problem};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SocketRole {
    AgentHost,
    Computer,
}
impl SocketRole {
    pub fn path(self) -> &'static str {
        match self {
            Self::AgentHost => "/api/machines/connect",
            Self::Computer => "/api/machines/computer",
        }
    }
    pub fn resets(self, elapsed: Duration, acknowledged_for: Option<Duration>) -> bool {
        match self {
            Self::AgentHost => acknowledged_for.is_some_and(|d| d >= Duration::from_secs(30)),
            Self::Computer => elapsed >= Duration::from_secs(60),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shutdown {
    Disconnected,
    Replaced,
    Revoked,
    Stopped,
}
#[async_trait]
pub trait Role: Send + Sync + 'static {
    fn kind(&self) -> SocketRole;
    /// Check only this role's local prerequisites before opening either socket.
    fn prerequisites(&self) -> Result<()> {
        Ok(())
    }
    fn hello(&self) -> Value;
    /// Reserve ids on the read loop before dispatching work, so a cancel cannot overtake exec.
    fn on_frame(&self, frame: Value, reply: Reply) -> Result<()>;
    /// AgentHost aborts runs on replacement; Computer keeps commands alive until Stopped/Revoked.
    async fn shutdown(&self, reason: Shutdown);
}
#[derive(Clone, Debug)]
pub struct Reply {
    pub generation: u64,
    sender: mpsc::Sender<Value>,
}
impl Reply {
    pub fn send(&self, frame: Value) -> Result<()> {
        if serde_json::to_vec(&frame).map_or(true, |bytes| bytes.len() > 8 << 20) {
            return Err(Error::new(1, "Reply exceeds the 8 MiB frame limit"));
        }
        self.sender.try_send(frame).map_err(|_| {
            Error::new(
                1,
                "Reply dropped: its socket closed or its reply queue is full",
            )
        })
    }
}
#[derive(Clone, Debug)]
pub struct Timing {
    pub heartbeat: Duration,
    pub read_deadline: Duration,
    pub ack_timeout: Duration,
    pub stable_after: Duration,
    pub dial_timeout: Duration,
    pub write_timeout: Duration,
    pub retry_scale: f64,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(20),
            read_deadline: Duration::from_secs(25),
            ack_timeout: Duration::from_secs(40),
            stable_after: Duration::from_secs(30),
            dial_timeout: Duration::from_secs(20),
            write_timeout: Duration::from_secs(30),
            retry_scale: 1.0,
        }
    }
}
impl Timing {
    pub fn for_role(role: SocketRole) -> Self {
        match role {
            SocketRole::AgentHost => Self::default(),
            SocketRole::Computer => Self {
                heartbeat: Duration::from_secs(10),
                stable_after: Duration::from_secs(60),
                ..Self::default()
            },
        }
    }
}
pub fn retry_delay(role: SocketRole, step: u32, slow: bool, jitter: f64) -> Duration {
    let jitter = jitter.clamp(0.0, 1.0);
    let ceiling = (1000_u64.saturating_mul(1_u64 << step.min(6))).min(60000) as f64;
    let millis = match role {
        SocketRole::AgentHost => (ceiling * (0.8 + jitter * 0.4)).min(60000.0),
        SocketRole::Computer if slow => 300000.0 + jitter * 150000.0,
        SocketRole::Computer => ceiling * (0.5 + jitter * 0.5),
    };
    Duration::from_millis(millis as u64)
}
struct End {
    code: u16,
    acknowledged: Option<Instant>,
    connected: Option<Instant>,
}
static GENERATION: AtomicU64 = AtomicU64::new(1);

pub async fn run(
    role: Arc<dyn Role>,
    server: &str,
    credential: &str,
    stop: CancellationToken,
    timing: Timing,
) -> Result<()> {
    let url = endpoint(server, role.kind().path(), true)?;
    let mut step = 0_u32;
    loop {
        if stop.is_cancelled() {
            role.shutdown(Shutdown::Stopped).await;
            return Ok(());
        }
        let end = session(&role, url.as_str(), credential, &stop, &timing).await;
        let reason = match end.code {
            4401 => Shutdown::Revoked,
            1012 if role.kind() == SocketRole::AgentHost => Shutdown::Replaced,
            4409 if role.kind() == SocketRole::Computer => Shutdown::Replaced,
            _ if stop.is_cancelled() => Shutdown::Stopped,
            _ => Shutdown::Disconnected,
        };
        role.shutdown(reason).await;
        if end.code == 4401 {
            stop.cancel();
            return Err(Error::new(
                3,
                Problem::Revoked.explain("user", "instance").to_string(),
            ));
        }
        if stop.is_cancelled() {
            return Ok(());
        }
        let stable = match role.kind() {
            SocketRole::AgentHost => end.acknowledged,
            SocketRole::Computer => end.connected,
        };
        if stable.is_some_and(|at| at.elapsed() >= timing.stable_after) {
            step = 0;
        }
        let slow = matches!(end.code, 401 | 4400 | 4409);
        let delay =
            retry_delay(role.kind(), step, slow, rand::random()).mul_f64(timing.retry_scale);
        tracing::warn!(role = ?role.kind(), close_code = end.code, retry_ms = delay.as_millis() as u64, "Socket disconnected; reconnecting");
        step = step.saturating_add(1);
        tokio::select! { _ = stop.cancelled() => { role.shutdown(Shutdown::Stopped).await; return Ok(()); }, _ = tokio::time::sleep(delay) => {} }
    }
}
async fn session(
    role: &Arc<dyn Role>,
    url: &str,
    credential: &str,
    stop: &CancellationToken,
    timing: &Timing,
) -> End {
    let mut end = End {
        code: 0,
        acknowledged: None,
        connected: None,
    };
    let Ok(mut request) = url.into_client_request() else {
        return end;
    };
    let Ok(header) = format!("Bearer {credential}").parse() else {
        return end;
    };
    request.headers_mut().insert("Authorization", header);
    let config = WebSocketConfig::default()
        .max_message_size(Some(8 << 20))
        .max_frame_size(Some(8 << 20));
    let dial = tokio::select! { _ = stop.cancelled() => return end, result = timeout(timing.dial_timeout, connect_async_with_config(request, Some(config), false)) => result };
    let mut socket = match dial {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
            end.code = response.status().as_u16();
            return end;
        }
        _ => return end,
    };
    let connected = Instant::now();
    end.connected = Some(connected);
    let (sender, mut replies) = mpsc::channel::<Value>(64);
    let reply = Reply {
        generation: GENERATION.fetch_add(1, Ordering::Relaxed),
        sender,
    };
    let hello = Message::text(role.hello().to_string());
    if !matches!(
        timeout(timing.write_timeout, socket.send(hello)).await,
        Ok(Ok(()))
    ) {
        return end;
    }
    let mut beats = tokio::time::interval_at(Instant::now() + timing.heartbeat, timing.heartbeat);
    beats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_read = Instant::now();
    let mut missed = 0;
    loop {
        let deadline = match role.kind() {
            SocketRole::AgentHost if end.acknowledged.is_none() => connected + timing.ack_timeout,
            SocketRole::Computer => last_read + timing.read_deadline,
            _ => Instant::now() + Duration::from_secs(86400),
        };
        let outgoing = tokio::select! {
            _ = stop.cancelled() => { let _ = timeout(timing.write_timeout, socket.close(None)).await; break; }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = timeout(timing.write_timeout, socket.close(Some(CloseFrame { code: CloseCode::Policy, reason: "heartbeat or hello timeout".into() }))).await;
                break;
            }
            _ = beats.tick() => {
                if role.kind() == SocketRole::Computer {
                    if missed >= 2 { let _ = timeout(timing.write_timeout, socket.close(Some(CloseFrame { code: CloseCode::Policy, reason: "no heartbeat answer".into() }))).await; break; }
                    missed += 1;
                    Some(Message::text("ping"))
                } else { Some(Message::text(json!({"type":"ping", "at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}).to_string())) }
            }
            frame = replies.recv() => frame.map(|v| Message::text(v.to_string())),
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Close(close))) => { end.code = close.map_or(1000, |c| c.code.into()); break; }
                    Some(Ok(Message::Text(text))) => {
                        last_read = Instant::now();
                        if role.kind() == SocketRole::Computer && text == "pong" { missed = 0; None }
                        else if role.kind() == SocketRole::Computer && text == "ping" { Some(Message::text("pong")) }
                        else {
                            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                if value["type"] == "hello_ack" && role.kind() == SocketRole::AgentHost && end.acknowledged.is_none() { end.acknowledged = Some(Instant::now()); }
                                if let Err(error) = role.on_frame(value, reply.clone()) { tracing::warn!(code = error.code, "Role refused incoming frame"); }
                            }
                            None
                        }
                    }
                    Some(Ok(Message::Ping(data))) => Some(Message::Pong(data)),
                    Some(Ok(_)) => None,
                    _ => break,
                }
            }
        };
        if let Some(frame) = outgoing
            && !matches!(
                timeout(timing.write_timeout, socket.send(frame)).await,
                Ok(Ok(()))
            )
        {
            break;
        }
        if role.kind() == SocketRole::Computer && missed >= 2 {
            let _ = timeout(
                timing.write_timeout,
                socket.close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: "no heartbeat answer".into(),
                })),
            )
            .await;
            break;
        }
    }
    end
}
/// Both sockets share cancellation. Revocation cancels its sibling before returning exit 3.
pub async fn run_roles(
    roles: Vec<Arc<dyn Role>>,
    server: String,
    credential: String,
    stop: CancellationToken,
) -> Result<()> {
    let roles: Vec<_> = roles.into_iter().filter(|role| {
        if let Err(error) = role.prerequisites() {
            tracing::warn!(role = ?role.kind(), reason = %error, "Role disabled: missing prerequisite");
            false
        } else { true }
    }).collect();
    if roles.is_empty() {
        return Err(Error::new(5, "No role can start; run agentum doctor"));
    }
    let mut tasks = tokio::task::JoinSet::new();
    for role in roles {
        let (server, credential, stop) = (server.clone(), credential.clone(), stop.clone());
        tasks.spawn(async move {
            let timing = Timing::for_role(role.kind());
            run(role, &server, &credential, stop, timing).await
        });
    }
    let mut failure = None;
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Err(error)) => {
                if failure.as_ref().is_none_or(|e: &Error| e.code != 3) {
                    failure = Some(error);
                }
                stop.cancel();
            }
            Err(_) => {
                if failure.is_none() {
                    failure = Some(Error::new(1, "Socket task failed"));
                }
                stop.cancel();
            }
            _ => {}
        }
    }
    failure.map_or(Ok(()), Err)
}
