use super::Problem;

#[allow(non_upper_case_globals)]
impl Problem {
    pub const ConfigOwner: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Read instance config",
            "the directory belongs to another user",
            "Another user could control this machine's credential.",
            format!("sudo chown -R {user} ~/.config/agentum/{instance}"),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const ConfigMode: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Check private file modes",
            "config permissions are loose",
            "The credential must be readable only by the service user.",
            format!(
                "chmod 700 ~/.config/agentum/{instance}; chmod 600 ~/.config/agentum/{instance}/config.json ~/.config/agentum/{instance}/credential"
            ),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Unreachable: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Contact the server",
            "the server is unreachable",
            "Network errors retry; they do not invalidate your enrolment.",
            "agentum doctor --instance <name> # check the stored URL, DNS and network".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Tls: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Establish TLS",
            "the TLS handshake or certificate validation failed",
            "The client uses the system's native CA roots. Install the corporate root CA if needed.",
            "sudo update-ca-certificates # Fedora: sudo update-ca-trust".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Plaintext: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Validate the server URL",
            "plain http:// is allowed only on loopback",
            "The enrolment code, credential and commands would cross the network in the clear.",
            "agentum enroll --url https://<server> --code-stdin".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Redirect: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Contact the enrolment endpoint",
            "the server returned a redirect",
            "Following it could send the code to another server. Use the final HTTPS origin directly.",
            "agentum enroll --url https://<final-server> --code-stdin".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
    pub const Revoked: Self = Self(|user, instance| {
        let _ = (user, instance);
        let (tried, reason, meaning, fix) = (
            "Authenticate the machine",
            "the server rejected the credential",
            "This machine was revoked or its credential replaced. Enrol it again with a new code from the Machines page.",
            "agentum enroll --url https://<server> --code-stdin".into(),
        );
        super::Explanation {
            tried: tried.into(),
            reason: reason.into(),
            meaning: meaning.into(),
            fix,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_explanation_renders() {
        for p in [
            Problem::ConfigOwner,
            Problem::ConfigMode,
            Problem::Unreachable,
            Problem::Tls,
            Problem::Plaintext,
            Problem::Redirect,
            Problem::Revoked,
        ] {
            let e = p.explain("dom", "office");
            assert!(
                !e.tried.is_empty()
                    && !e.reason.is_empty()
                    && !e.meaning.is_empty()
                    && !e.fix.is_empty()
            );
            assert!(e.to_string().contains(&e.fix));
        }
    }
}
