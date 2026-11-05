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
            format!(
                "Plain http:// is allowed only on loopback; it exposes the enrolment code and credential. Fix: agentum enroll --url https://{} --code-stdin",
                url.host_str().unwrap_or_default()
            ),
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
        .map_err(|_| {
            Error::new(
                5,
                "Cannot initialise TLS. Fix: sudo update-ca-certificates # Fedora: sudo update-ca-trust",
            )
        })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub instance: String,
    pub machine_id: String,
    pub roles: Vec<wire::MachineRole>,
    pub run_as: String,
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
    let name_hint = args.name.as_deref().unwrap_or("default");
    if args.system
        && let Some(name) = args.name.as_deref()
    {
        crate::instance::validate_system_name(name)?;
    }
    if args.system && !nix::unistd::geteuid().is_root() {
        return Err(Error::new(
            5,
            format!(
                "System enrolment requires root. Fix: sudo agentum enroll --system{} --run-as {}{} --code-stdin",
                args.name
                    .as_ref()
                    .map(|n| format!(" --instance {n}"))
                    .unwrap_or_default(),
                args.run_as,
                args.url
                    .as_ref()
                    .map(|u| format!(" --url {u}"))
                    .unwrap_or_default()
            ),
        ));
    }
    let code = code.trim();
    if code.len() > 200
        || !code
            .strip_prefix("ag_enr_")
            .or_else(|| code.strip_prefix("hm_enr_"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
    {
        return Err(Error::new(
            2,
            if code.is_empty() {
                "An enrolment code is required; use --code-stdin with a new code from the Machines page"
            } else {
                "The enrolment code is malformed; use --code-stdin with a new code from the Machines page"
            },
        ));
    }
    let mut locations = crate::instance::locations();
    locations.retain(|p| p.system != paths.system);
    locations.push(paths.clone());
    if args.system {
        locations.extend(crate::service::enrollment_locations(
            &args.run_as,
            name_hint,
        ));
    }
    let existing = if args.replace {
        let name = args
            .name
            .as_deref()
            .ok_or_else(|| Error::new(2, "--replace requires --instance or --name"))?;
        Some(crate::service::read_config(paths, name, "enroll")?)
    } else {
        None
    };
    let raw_url = args
        .url
        .as_deref()
        .or_else(|| existing.as_ref().map(|c| c.server.as_str()))
        .ok_or_else(|| Error::new(2, "Enrolment requires --url"))?;
    let url = server_url(raw_url).map_err(|error| {
        Error::new(
            error.code,
            error.message.replace(
                "--code-stdin",
                &format!(
                    "{}--code-stdin",
                    args.name
                        .as_ref()
                        .map(|name| format!("--instance {name} "))
                        .unwrap_or_default()
                ),
            ),
        )
    })?;
    let _lock = enrollment_lock(paths)?;
    paths.prepare_state_root()?;
    if let Some(name) = args.name.as_deref() {
        if args.system {
            crate::instance::validate_system_name(name)?;
        }
        if !args.replace {
            crate::instance::reserve_enrollment(&locations, Some(name), "", args.system)?;
        }
    }
    let request = EnrollRequest {
        code: code.into(),
        roles: None,
        single_user: existing
            .as_ref()
            .map_or_else(|| args.run_as.single_user(), |c| c.single_user),
        arch: wire::arch().into(),
        os: wire::os().into(),
        hostname: wire::hostname(),
        client_version: version.into(),
    };
    let retry = format!(
        "{}agentum enroll{}{} --url {}{} --code-stdin",
        if args.system { "sudo " } else { "" },
        args.name
            .as_ref()
            .map(|name| format!(" --instance {name}"))
            .unwrap_or_default(),
        if args.replace { " --replace" } else { "" },
        url,
        if args.system {
            format!(" --system --run-as {}", args.run_as)
        } else {
            String::new()
        }
    );
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
                .explain("user", name_hint)
                .with_fix(&format!(
                    "{retry} # check DNS, TLS certificates and network"
                ))
                .to_string(),
            )
        })?;
    if response.status().is_redirection() {
        return Err(Error::new(
            1,
            Problem::Redirect
                .explain("user", name_hint)
                .with_fix(&format!("{retry} # set --url to the final HTTPS origin"))
                .to_string(),
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
    let mut recovery_dir = paths.config_root.clone();
    let saved = (|| {
        let name = if args.replace {
            name_hint.to_owned()
        } else {
            crate::instance::reserve_enrollment(
                &locations,
                args.name.as_deref(),
                &answer.machine_name,
                args.system,
            )?
        };
        recovery_dir = paths.config(&name);
        let mut config = Config::new(
            answer.machine_id.clone(),
            answer.machine_name.clone(),
            url.as_str().trim_end_matches('/').into(),
            answer.roles.clone(),
            args.system,
            args.run_as.clone(),
        );
        if let Some(old) = &existing {
            config.system = old.system;
            config.run_as = old.run_as.clone();
            config.single_user = old.single_user;
            config.computer = old.computer.clone();
            config.claude_binary = old.claude_binary.clone();
        }
        if args.claude.is_some() {
            config.claude_binary = args.claude.clone();
        }
        if args.replace {
            crate::instance::replace_file(
                &paths.config(&name).join("credential"),
                format!("{}\n", answer.credential).as_bytes(),
            )?;
            // Saved connection failures belong to the old credential.
            match std::fs::read_dir(paths.state(&name)) {
                Ok(entries) => {
                    for entry in entries {
                        let entry = entry
                            .map_err(|e| Error::new(5, format!("Read connection state: {e}")))?;
                        let filename = entry.file_name();
                        let filename = filename.to_string_lossy();
                        if filename.starts_with("connection-") && filename.ends_with(".json") {
                            std::fs::remove_file(entry.path()).map_err(|e| {
                                Error::new(5, format!("Clear connection state: {e}"))
                            })?;
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(Error::new(5, format!("Read connection state: {error}"))),
            }
            crate::instance::replace_file(
                &paths.config(&name).join("config.json"),
                &serde_json::to_vec_pretty(&config)
                    .map_err(|_| Error::new(1, "Cannot encode config"))?,
            )?;
        } else {
            paths.save(&name, &config, &answer.credential)?;
        }
        Ok(Enrolled {
            instance: name,
            machine_id: answer.machine_id.clone(),
            roles: answer.roles.clone(),
            run_as: config.run_as.to_string(),
        })
    })();
    saved.map_err(|error: Error| {
        use std::io::Write;
        let recovered = (|| -> std::io::Result<std::path::PathBuf> {
            let mut file = tempfile::Builder::new().prefix("recovered-credential-").tempfile_in(&recovery_dir)
                .or_else(|_| tempfile::Builder::new().prefix("recovered-credential-").tempfile_in(&paths.config_root))?;
            writeln!(file, "{}", answer.credential)?;
            file.as_file().sync_all()?;
            let (_, path) = file.keep().map_err(|e| e.error)?;
            Ok(path)
        })();
        match recovered {
            Ok(path) => Error::new(error.code, format!("{error}. The server issued a credential; saved a recovery copy at {}. Keep it private and restore it before enrolling again.", path.display())),
            Err(_) => Error::new(error.code, format!("{error}. Could not save the issued credential or its recovery file in {}", paths.config_root.display())),
        }
    })
}
