//! Both bearer scopes share timeouts and masking, but never credentials.
use super::helpers::{Masker, encode};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const FEATURES: &str = "library-sync,requests,library-live,current-approvals";
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Failure {
    pub status: u16,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Failure>;
impl Failure {
    pub fn local(message: impl Into<String>) -> Self {
        Self {
            status: 0,
            message: message.into(),
        }
    }
    pub fn transient(&self) -> bool {
        matches!(self.status, 0 | 408 | 429 | 500..=599)
    }
}
impl From<std::io::Error> for Failure {
    fn from(_: std::io::Error) -> Self {
        Self::local(
            "Work directory operation failed; check its ownership and permissions with agentum doctor",
        )
    }
}
#[derive(Clone)]
pub struct Http {
    pub server: String,
    token: String,
    client: Client,
    pub masker: Masker,
    pub cancel: CancellationToken,
}
impl Http {
    pub fn new(
        server: &str,
        token: &str,
        masker: Masker,
        cancel: CancellationToken,
        seconds: u64,
    ) -> Self {
        Self {
            server: server.trim_end_matches('/').into(),
            token: token.into(),
            masker,
            cancel,
            client: Client::builder()
                .timeout(Duration::from_secs(seconds))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
        }
    }
    pub fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.server))
            .bearer_auth(&self.token)
    }
    pub async fn send(&self, request: reqwest::RequestBuilder) -> Result<Response> {
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Failure::local("Run cancelled")),
            response = request.send() => {
                let response = response.map_err(|_|Failure::local("Request failed before an answer"))?;
                if response.status().is_success() { return Ok(response) }
                let status = response.status().as_u16();
                let body = self.read_json(response).await.unwrap_or(Value::Null);
                let detail = self.masker.mask(body["error"].as_str().unwrap_or(""));
                Err(Failure {status,message:format!("HTTP {status}: {}",detail.chars().take(200).collect::<String>())})
            }
        }
    }
    pub async fn read_json(&self, response: Response) -> Result<Value> {
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Failure::local("Run cancelled")),
            value = response.json() => value.map_err(|_|Failure {status:422,message:"Answer does not match the protocol".into()}),
        }
    }
    pub async fn bytes(&self, response: Response) -> Result<Vec<u8>> {
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Failure::local("Run cancelled")),
            value = response.bytes() => value.map(|b|b.to_vec()).map_err(|_|Failure::local("Answer body could not be read")),
        }
    }
    pub async fn json(&self, request: reqwest::RequestBuilder) -> Result<Value> {
        self.read_json(self.send(request).await?).await
    }
}
#[derive(Clone)]
pub struct RunApi {
    pub http: Http,
    pub base: String,
}
impl RunApi {
    pub fn new(http: Http, run: &str) -> Self {
        Self {
            http,
            base: format!("/api/machines/runs/{}", encode(run)),
        }
    }
    pub async fn call(&self, route: &str, body: Option<&Value>) -> Result<Value> {
        let mut request = self
            .http
            .request(Method::POST, &format!("{}/{route}", self.base));
        if route == "claim" {
            request = request.header("X-Daemon-Features", FEATURES);
        }
        if let Some(body) = body {
            request = request.json(&self.http.masker.deep(body));
        }
        let response = self.http.send(request).await;
        match response {
            Err(e)
                if route == "complete"
                    && body.is_some_and(|b| b["status"] == "aborted")
                    && e.status == 409 =>
            {
                Ok(json!({}))
            }
            Err(e) => Err(e),
            Ok(response) if matches!(route, "events" | "heartbeat" | "complete") => {
                let _ = response.bytes().await;
                Ok(json!({}))
            }
            Ok(response) => self.http.read_json(response).await,
        }
    }
    pub async fn wait(&self, id: &str) -> Result<Value> {
        self.http
            .json(self.http.request(
                Method::GET,
                &format!("{}/requests/{}?wait=25", self.base, encode(id)),
            ))
            .await
    }
    pub fn with_cancel(&self, cancel: CancellationToken) -> Self {
        let mut api = self.clone();
        api.http.cancel = cancel;
        api
    }
}
