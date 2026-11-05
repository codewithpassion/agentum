use super::{Fault, OpResult};
use crate::instance::ComputerConfig;
use regex::Regex;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub struct Policy {
    pub config: ComputerConfig,
    pub work: PathBuf,
    state: PathBuf,
    config_dir: PathBuf,
    allow: Vec<Regex>,
    deny: Vec<Regex>,
}
pub fn resolve(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => {
                result.push(other);
                if let Ok(real) = fs::canonicalize(&result) {
                    result = real;
                }
            }
        }
    }
    Ok(result)
}
impl Policy {
    pub fn new(
        config: ComputerConfig,
        state: PathBuf,
        config_dir: PathBuf,
        work: PathBuf,
    ) -> OpResult<Self> {
        let work = resolve(&work)?;
        let state = resolve(&state)?;
        let config_dir = resolve(&config_dir)?;
        // The standard work subtree is the sole exception to protecting state.
        if within(&work, &state)
            || within(&work, &config_dir)
            || within(&config_dir, &work)
            || (within(&state, &work)
                && !within(&state.join("work"), &work)
                && !within(&state.join("agent/work"), &work))
        {
            return Err(Fault::new(
                "denied",
                "the working directory overlaps private instance files; choose another --workdir",
            ));
        }
        let compile = |patterns: &[String], anchored| {
            patterns
                .iter()
                .map(|p| {
                    Regex::new(&if anchored {
                        format!("(?s)\\A(?:{})\\z", go_pattern(p))
                    } else {
                        go_pattern(p)
                    })
                    .map_err(|e| Fault::new("bad_request", e.to_string()))
                })
                .collect::<OpResult<Vec<_>>>()
        };
        let allow = compile(&config.allow, true)?;
        let deny = compile(&config.deny, false)?;
        Ok(Self {
            config,
            work,
            state,
            config_dir,
            allow,
            deny,
        })
    }
    pub fn exec(&self, command: &str) -> OpResult<()> {
        if self
            .deny
            .iter()
            .any(|r| r.is_match(command) || command.lines().any(|l| r.is_match(l)))
        {
            return Err(Fault::new(
                "denied",
                "command refused by the local deny list",
            ));
        }
        if self.config.read_only
            || command.trim().is_empty()
            || command.contains('\0')
            || (!self.allow.is_empty() && !self.allow.iter().any(|r| r.is_match(command)))
        {
            return Err(Fault::new("denied", "command refused by the local policy"));
        }
        Ok(())
    }
    pub fn env_allowed(&self, name: &str) -> bool {
        let upper = name.to_ascii_uppercase();
        if upper.starts_with("LD_") || upper.starts_with("DYLD_") {
            return false;
        }
        if !self.config.read_only
            && !self.config.workdir_only
            && self.allow.is_empty()
            && self.deny.is_empty()
        {
            return true;
        }
        ["LANG", "TZ", "TERM", "NO_COLOR", "CI"].contains(&upper.as_str())
            || ["LC_", "TFY_", "HM_SESSION_"]
                .iter()
                .any(|p| upper.starts_with(p))
            || self.config.allow_env.iter().any(|p| {
                p.strip_suffix('*')
                    .map_or(name == p, |prefix| name.starts_with(prefix))
            })
    }
    pub fn path(&self, path: &Path, write: bool) -> OpResult<PathBuf> {
        if path.as_os_str().is_empty() || path.as_os_str().as_encoded_bytes().contains(&0) {
            return Err(Fault::new("denied", "empty path or NUL byte"));
        }
        if write && self.config.read_only {
            return Err(Fault::new("read_only", "this computer is read-only"));
        }
        let resolved = resolve(path)?;
        if within(&self.config_dir, &resolved)
            || (within(&self.state, &resolved)
                && !within(&self.state.join("work"), &resolved)
                && !within(&self.state.join("agent/work"), &resolved))
            || (self.config.workdir_only && !within(&self.work, &resolved))
        {
            return Err(Fault::new("denied", "path refused by the local policy"));
        }
        Ok(resolved)
    }
    pub fn cwd(&self, requested: Option<&str>) -> OpResult<PathBuf> {
        if requested.is_some_and(|s| s.contains('\0')) {
            return Err(Fault::new(
                "bad_request",
                "working directory contains a NUL byte",
            ));
        }
        let path = resolve(
            requested
                .filter(|p| !p.is_empty())
                .map(Path::new)
                .unwrap_or(&self.work),
        )?;
        if !path.exists() && within(&self.work, &path) {
            super::ensure_directory(&path)?;
        }
        if !path.is_dir() {
            return Err(Fault::new(
                "bad_request",
                "working directory does not exist or is not a directory",
            ));
        }
        Ok(path)
    }
}

fn within(root: &Path, candidate: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(root_info) = fs::metadata(root) else {
        return candidate.starts_with(root);
    };
    candidate.ancestors().any(|part| {
        fs::metadata(part).is_ok_and(|m| m.dev() == root_info.dev() && m.ino() == root_info.ino())
    })
}

// Go's RE2 shorthand classes and word boundaries are ASCII, even in UTF-8 text.
// Rust supports nested character classes, so these also work inside [ ... ].
fn go_pattern(pattern: &str) -> String {
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(escaped) = chars.next() else {
            out.push('\\');
            break;
        };
        match escaped {
            'd' => out.push_str("[0-9]"),
            'D' => out.push_str("[^0-9]"),
            'w' => out.push_str("[A-Za-z0-9_]"),
            'W' => out.push_str("[^A-Za-z0-9_]"),
            's' => out.push_str(r"[\t\n\f\r ]"),
            'S' => out.push_str(r"[^\t\n\f\r ]"),
            'b' => out.push_str(r"(?-u:\b)"),
            'B' => out.push_str(r"(?-u:\B)"),
            'Q' => {
                let mut literal = String::new();
                while let Some(c) = chars.next() {
                    if c == '\\' && chars.peek() == Some(&'E') {
                        chars.next();
                        break;
                    }
                    literal.push(c);
                }
                out.push_str(&regex::escape(&literal));
            }
            other => {
                out.push('\\');
                out.push(other);
            }
        }
    }
    out
}
