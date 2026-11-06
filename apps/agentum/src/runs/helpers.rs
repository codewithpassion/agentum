//! Pure counterparts of the daemon's protocol helpers; fixtures are generated from TypeScript.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub fn max_turns(config: &Value) -> u64 {
    config["maxTurns"]
        .as_u64()
        .filter(|n| (10..=500).contains(n))
        .unwrap_or(100)
}
pub fn stop_message(stop: &Value) -> String {
    if stop["kind"] == "turn_limit" {
        format!("Stopped after {} turns, the agent's limit", stop["limit"])
    } else {
        format!(
            "Stopped after {} identical failed calls to {} in a row",
            stop["count"],
            text(&stop["tool"])
        )
    }
}
pub fn task_folder(slug: &str, run: &str) -> String {
    format!("agents/{slug}/tasks/{run}")
}
pub fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
#[derive(Clone, Default)]
pub struct Masker(Vec<(String, String)>);
impl Masker {
    pub fn new(secrets: &Value) -> Self {
        let mut needles = vec![];
        if let Some(secrets) = secrets.as_object() {
            for (name, value) in secrets {
                let Some(value) = value.as_str().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let encoded = encode(value);
                let form = encoded.replace("%20", "+");
                let strict = form
                    .chars()
                    .map(|c| {
                        if "!'()~".contains(c) {
                            format!("%{:02X}", c as u8)
                        } else {
                            c.to_string()
                        }
                    })
                    .collect::<String>();
                let escaped = serde_json::to_string(value).unwrap();
                let mut shapes = vec![
                    value.to_owned(),
                    escaped[1..escaped.len() - 1].into(),
                    STANDARD.encode(value),
                    STANDARD.encode(format!("{value}\n")),
                    encoded,
                    form,
                    strict,
                ];
                shapes.dedup();
                for shape in shapes {
                    needles.push((shape, format!("[secret:{name}]")));
                }
            }
        }
        needles.sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
        Self(needles)
    }
    pub fn mask(&self, text: &str) -> String {
        self.0
            .iter()
            .fold(text.to_owned(), |s, (needle, replacement)| {
                s.replace(needle, replacement)
            })
    }
    pub fn deep(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => json!(self.mask(s)),
            Value::Array(a) => Value::Array(a.iter().map(|v| self.deep(v)).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), self.deep(v))).collect())
            }
            _ => value.clone(),
        }
    }
}
pub fn workspace_instructions(
    home: &str,
    library: Option<&Value>,
    live: bool,
    slug: &str,
    run: &str,
) -> String {
    let mut lines = vec![
        "Your files live in three places.".into(),
        format!(
            "- Home: {home}. It is yours and keeps its files across all your sessions. Relative paths start here. Keep notes, code and data you want to find again here. Other sessions of yours may use it at the same time."
        ),
        format!(
            "- Scratch: {home}/tmp. Use it for downloads, builds and temporary files. It is emptied before your next run, so never keep anything there that you need later."
        ),
    ];
    let root_list = library
        .and_then(|l| l["roots"].as_array())
        .filter(|r| !r.is_empty())
        .map(|r| {
            r.iter()
                .map(|r| format!("{} ({})", text(&r["path"]), text(&r["mode"])))
                .collect::<Vec<_>>()
                .join(", ")
        });
    let paths = root_list
        .or_else(|| {
            library
                .and_then(|l| l["paths"].as_array())
                .map(|a| a.iter().map(text).collect::<Vec<_>>().join(", "))
        })
        .unwrap_or_default();
    if library.is_some() && !paths.is_empty() {
        let when = if live {
            "within seconds"
        } else {
            "when your run ends"
        };
        lines.push(format!("- Library: {home}/library holds a synced copy of {paths} from the workspace library. The library is shared with every agent and person in this workspace and kept for good. Your changes go back to it {when}. If someone changed the same file meanwhile, their version stays and yours is saved next to it as <file>.conflict-<runId>. The rest of the library is not on your disk, so reach it with the library tools."));
    } else if library.is_some() {
        lines.push(format!("- Library: {home}/library. It is shared with every agent and person in this workspace and kept for good. Put finished work that people or other agents should see there."));
    } else {
        lines.push("- Library: the workspace library. It is shared with every agent and person in this workspace and kept for good. It is not a folder on your disk, so reach it with the library tools. Put finished work that people or other agents should see there.".into());
    }
    if let Some(library) = library {
        if let Some(conflicts) = library["conflicts"].as_array().filter(|c| !c.is_empty()) {
            let list = conflicts
                .iter()
                .map(|p| format!("{home}/library/{}", text(p)))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("- Conflicts: some changes could not be saved because the library file changed first. Each copy listed here holds the version that was not saved. Compare it with the file beside it, keep what you want in that file, then delete the copy: {list}."));
        }
        let folder = library["taskFolder"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| task_folder(slug, run));
        lines.push(format!("Save files for the user in {home}/library/{folder}. Everything there shows in the task's Files panel."));
    }
    lines.join("\n")
}
pub fn agent_env(source: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    source
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            (matches!(
                key.as_str(),
                "CLAUDE_CONFIG_DIR"
                    | "HOME"
                    | "LANG"
                    | "LC_ALL"
                    | "LOGNAME"
                    | "PATH"
                    | "SHELL"
                    | "TERM"
                    | "TMPDIR"
                    | "USER"
            ) || key.starts_with("XDG_"))
                && !["TOKEN", "KEY", "SECRET", "CREDENTIAL", "PASSWORD", "PASSWD"]
                    .iter()
                    .any(|p| upper.contains(p))
        })
        .collect()
}
