use crate::{
    Error, Result,
    cli::EnrollArgs,
    instance::{Config, Paths, RunAs, enrollment_lock},
    privilege::Problem,
    wire::{self, EnrollRequest, EnrollResponse},
};
use serde::Serialize;
use url::Url;

pub fn server_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw.trim())
        .map_err(|_| Error::new(2, "Invalid server URL. Use --url https://<server>"))?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::new(
            2,
            "Use an http(s) server URL without a username or password",
        ));
    }
    let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if matches!(url.scheme(), "http" | "ws") && !loopback {
        return Err(Error::new(
            2,
            Problem::Plaintext.explain("user", "instance").to_string(),
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url)
}
pub fn endpoint(raw: &str, path: &str, websocket: bool) -> Result<Url> {
    let mut url = server_url(raw)?;
    let secure = matches!(url.scheme(), "https" | "wss");
    url.set_scheme(match (websocket, secure) {
        (true, true) => "wss",
        (true, false) => "ws",
        (false, true) => "https",
        (false, false) => "http",
    })
    .map_err(|_| Error::new(2, "Invalid server scheme"))?;
    let path = format!("{}{path}", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}
pub fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| Error::new(5, Problem::Tls.explain("user", "instance").to_string()))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub instance: String,
    pub machine_id: String,
    pub roles: Vec<wire::MachineRole>,
}

pub async fn enroll(
    paths: &Paths,
    args: &EnrollArgs,
    code: &str,
    version: &str,
) -> Result<Enrolled> {
    if !args.system && args.run_as != RunAs::Current {
        return Err(Error::new(
            2,
            "--run-as requires --system for a named user or agent-user",
        ));
    }
    if args.system && !nix::unistd::geteuid().is_root() {
        return Err(Error::new(
            5,
            Problem::SystemRoot.explain("user", "instance").to_string(),
        ));
    }
    let code = code.trim();
    if code.len() > 200 || !(code.starts_with("ag_enr_") || code.starts_with("hm_enr_")) {
        return Err(Error::new(
            2,
            "An enrolment code is required; use --code-stdin with a new code from the Machines page",
        ));
    }
    let url = server_url(&args.url)?;
    let _lock = enrollment_lock(paths)?;
    crate::instance::private_dir(&paths.state_root)?;
    if let Some(name) = args.name.as_deref() {
        paths.reserve(Some(name), "")?;
    }
    let request = EnrollRequest {
        code: code.into(),
        roles: None,
        single_user: args.run_as.single_user(),
        arch: wire::arch().into(),
        os: wire::os().into(),
        hostname: wire::hostname(),
        client_version: version.into(),
    };
    let mut response = http_client()?
        .post(endpoint(url.as_str(), "/api/machines/enroll", false)?)
        .header("Accept", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            Error::new(
                1,
                if e.is_connect() {
                    Problem::Unreachable
                } else {
                    Problem::Tls
                }
                .explain("user", "instance")
                .to_string(),
            )
        })?;
    if response.status().is_redirection() {
        return Err(Error::new(
            1,
            Problem::Redirect.explain("user", "instance").to_string(),
        ));
    }
    if !response.status().is_success() {
        // Never echo an untrusted response body: it may contain the code or credential.
        return Err(Error::new(
            1,
            format!(
                "Enrolment refused (HTTP {}). Codes are single use; get a new code from the Machines page and check that its roles match.",
                response.status().as_u16()
            ),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        Error::new(
            1,
            "Could not read enrolment response; check the server connection",
        )
    })? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Error::new(
                1,
                "Enrolment response exceeds 1 MiB; check the server URL",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let answer: EnrollResponse = serde_json::from_slice(&bytes).map_err(|_| {
        Error::new(
            1,
            "Invalid enrolment answer; the server must support the RC.1 contract",
        )
    })?;
    if answer.machine_id.is_empty()
        || answer.roles.is_empty()
        || !(answer.credential.starts_with("ag_mach_") || answer.credential.starts_with("hm_mach_"))
    {
        return Err(Error::new(
            1,
            "Invalid machine identity in enrolment answer; check the server version",
        ));
    }
    let name = paths.reserve(args.name.as_deref(), &answer.machine_name)?;
    let mut config = Config::new(
        answer.machine_id.clone(),
        answer.machine_name,
        url.as_str().trim_end_matches('/').into(),
        answer.roles.clone(),
        args.system,
        args.run_as.clone(),
    );
    config.claude_binary = args.claude.clone();
    paths.save(&name, &config, &answer.credential)?;
    Ok(Enrolled {
        instance: name,
        machine_id: answer.machine_id,
        roles: answer.roles,
    })
}
