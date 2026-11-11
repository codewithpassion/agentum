//! agent-desktop as a second desktop backend: typed snapshot, act and list-apps ops.
//!
//! The model never writes an agent-desktop command line. It names an allow-listed app and, for an
//! action, a ref from an earlier snapshot. Every refusal here happens before a process starts, so
//! none of it needs agent-desktop on the machine.
use super::{Desktop, Finished, bad, run_process, unavailable};
use crate::computer::{Fault, OpResult};
use crate::instance::ComputerConfig;
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

/// A snapshot's tree is the largest thing this op returns; a bigger one is refused, not cut.
const SNAPSHOT_CAP: usize = 512 << 10;
const ACT_CAP: usize = 64 << 10;
const APPS_CAP: usize = 64 << 10;
const SNAPSHOT_BUDGET: Duration = Duration::from_millis(10_000);
const ACT_BASE_BUDGET_MS: u64 = 12_000;
const ACT_MS_PER_CHAR: u64 = 30;
const APPS_BUDGET: Duration = Duration::from_millis(6_000);
const MAX_REMEMBERED_SNAPSHOTS: usize = 256;
const MAX_TEXT_CHARS: usize = 512;
/// The actions `desktop_act` takes. Each one is a fixed agent-desktop command.
const ACTIONS: [&str; 7] = [
    "click",
    "set_value",
    "type",
    "toggle",
    "select",
    "expand",
    "collapse",
];

/// An app name as `list-apps` prints it. It becomes one argv word, so it may not start with `-`.
pub fn valid_app(name: &str) -> bool {
    let length = name.chars().count();
    (1..=64).contains(&length)
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " ._+-".contains(c))
}

/// The allow-list entry an app name means, or None when the computer does not allow it.
fn allowed<'a>(config: &'a ComputerConfig, app: &str) -> Option<&'a str> {
    if !valid_app(app) {
        return None;
    }
    config
        .allow_apps
        .iter()
        .map(String::as_str)
        .find(|entry| entry.eq_ignore_ascii_case(app))
}

/// The snapshot id inside a ref such as `@s8f3k2p9:e8`.
fn snapshot_of(reference: &str) -> Option<&str> {
    let (id, element) = reference.strip_prefix('@')?.split_once(":e")?;
    let id_ok = (2..=40).contains(&id.len())
        && id.starts_with('s')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let element_ok =
        (1..=9).contains(&element.len()) && element.bytes().all(|b| b.is_ascii_digit());
    (id_ok && element_ok).then_some(id)
}

/// Which app each snapshot read, so an action can be checked against the allow list through its
/// ref. A ref names only its snapshot. Bounded, oldest first out.
#[derive(Default)]
pub(super) struct Snapshots(Mutex<Vec<(String, String)>>);
impl Snapshots {
    pub(super) fn record(&self, id: &str, app: &str) {
        let mut known = self.0.lock().unwrap();
        known.retain(|(known_id, _)| known_id != id);
        if known.len() >= MAX_REMEMBERED_SNAPSHOTS {
            known.remove(0);
        }
        known.push((id.into(), app.into()));
    }
    fn app(&self, id: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .find(|(known_id, _)| known_id == id)
            .map(|(_, app)| app.clone())
    }
}

#[derive(Debug, PartialEq)]
enum Kind {
    Snapshot,
    Act,
    Apps,
}
#[derive(Debug)]
struct Plan {
    kind: Kind,
    /// The allow-listed app the op reads or acts on. Empty for `desktop_apps`.
    app: String,
    args: Vec<String>,
    /// Text for stdin, so it never appears in a process list.
    input: Option<String>,
    cap: usize,
    budget: Duration,
    headed: bool,
    /// The allow list, so `desktop_apps` can show only what the computer lets agents see.
    allow: Vec<String>,
}

fn denied(message: &str) -> Fault {
    Fault::new("denied", message)
}

/// Every policy decision, from the request alone.
fn plan(frame: &Value, config: &ComputerConfig, snapshots: &Snapshots) -> OpResult<Plan> {
    let op = frame["op"].as_str().unwrap_or("");
    if op == "desktop_act" && config.read_only {
        return Err(Fault::new(
            "read_only",
            "this computer refuses desktop writes",
        ));
    }
    if config.allow_apps.is_empty() {
        return Err(denied(
            "agent-desktop is off on this computer: no app is allowed (--allow-app)",
        ));
    }
    match op {
        "desktop_snapshot" => plan_snapshot(frame, config, snapshots),
        "desktop_act" => plan_act(frame, config, snapshots),
        _ => Ok(Plan {
            kind: Kind::Apps,
            app: String::new(),
            args: vec!["list-apps".into()],
            input: None,
            cap: APPS_CAP,
            budget: APPS_BUDGET,
            headed: false,
            allow: config.allow_apps.clone(),
        }),
    }
}

fn plan_snapshot(frame: &Value, config: &ComputerConfig, snapshots: &Snapshots) -> OpResult<Plan> {
    let Some(requested) = frame["app"].as_str().filter(|app| !app.is_empty()) else {
        return Err(denied(
            "a snapshot names one app, because with no app it would read every app",
        ));
    };
    let app = allowed(config, requested)
        .ok_or_else(|| denied("this computer does not allow agent-desktop for that app"))?;
    let mut args: Vec<String> = vec!["snapshot".into(), "--app".into(), app.into()];
    if let Some(root) = frame.get("root").filter(|root| !root.is_null()) {
        let root = root.as_str().ok_or_else(|| bad("root must be a ref"))?;
        let id = snapshot_of(root).ok_or_else(|| bad("root is not a ref like @s1abc:e3"))?;
        if snapshots.app(id).as_deref() != Some(app) {
            return Err(denied("root belongs to a snapshot of another app"));
        }
        args.extend(["--root".into(), root.into()]);
    }
    for (key, flag) in [
        ("interactive", "-i"),
        ("compact", "--compact"),
        ("skeleton", "--skeleton"),
    ] {
        if frame[key].as_bool().unwrap_or(false) {
            args.push(flag.into());
        }
    }
    args.extend(["--timeout-ms".into(), "8000".into()]);
    Ok(Plan {
        kind: Kind::Snapshot,
        app: app.into(),
        args,
        input: None,
        cap: SNAPSHOT_CAP,
        budget: SNAPSHOT_BUDGET,
        headed: false,
        allow: vec![],
    })
}

fn plan_act(frame: &Value, config: &ComputerConfig, snapshots: &Snapshots) -> OpResult<Plan> {
    let reference = frame["ref"].as_str().unwrap_or("");
    let id = snapshot_of(reference).ok_or_else(|| bad("ref is not a ref like @s1abc:e3"))?;
    let action = frame["action"].as_str().unwrap_or("");
    if !ACTIONS.contains(&action) {
        return Err(bad("unknown action"));
    }
    let text = match frame.get("text").filter(|text| !text.is_null()) {
        None => None,
        Some(text) => Some(text.as_str().ok_or_else(|| bad("text must be a string"))?),
    };
    let needs_text = matches!(action, "set_value" | "type" | "select");
    match text {
        Some(text) if needs_text && (1..=MAX_TEXT_CHARS).contains(&text.chars().count()) => {}
        None if !needs_text => {}
        _ => {
            return Err(bad(
                "text is required, 1 to 512 characters, for set_value, type and select, and only for those",
            ));
        }
    }
    let headed = match frame.get("headed") {
        None | Some(Value::Null) => false,
        Some(headed) => headed
            .as_bool()
            .ok_or_else(|| bad("headed must be a boolean"))?,
    };
    if headed && !config.allow_headed {
        return Err(denied(
            "this computer refuses physical input for agent-desktop (--allow-headed)",
        ));
    }
    let app = snapshots
        .app(id)
        .ok_or_else(|| denied("unknown snapshot: take a new snapshot and use its refs"))?;
    if allowed(config, &app).is_none() {
        return Err(denied(
            "this computer does not allow agent-desktop for that app",
        ));
    }
    let command = action.replace('_', "-");
    let mut args: Vec<String> = vec![command, reference.into()];
    let mut input = None;
    match (action, text) {
        ("select", Some(text)) => args.push(text.into()),
        (_, Some(text)) => {
            args.push("--stdin".into());
            input = Some(text.to_owned());
        }
        _ => {}
    }
    if headed {
        args.push("--headed".into());
    }
    let typed = text.map_or(0, |text| text.chars().count()) as u64;
    Ok(Plan {
        kind: Kind::Act,
        app,
        args,
        input,
        cap: ACT_CAP,
        budget: Duration::from_millis(ACT_BASE_BUDGET_MS + ACT_MS_PER_CHAR * typed),
        headed,
        allow: vec![],
    })
}

/// What agent-desktop printed. Its exit code is nonzero for a refused action, but the JSON on
/// stdout still says why, and the model needs that.
fn envelope(finished: &Finished) -> OpResult<Value> {
    serde_json::from_slice::<Value>(&finished.data).map_err(|_| {
        Fault::new(
            "op_failed",
            "agent-desktop printed nothing readable; check that it is installed",
        )
    })
}

fn refusal(envelope: &Value) -> Fault {
    let error = &envelope["error"];
    let mut message = format!(
        "{}: {}",
        error["code"].as_str().unwrap_or("ERROR"),
        error["message"].as_str().unwrap_or("agent-desktop failed")
    );
    if let Some(suggestion) = error["suggestion"].as_str() {
        message.push(' ');
        message.push_str(suggestion);
    }
    if let Some(details) = error
        .get("details")
        .filter(|d| d.is_object() || d.is_array())
    {
        let details = details.to_string();
        if details.len() <= 400 {
            message.push(' ');
            message.push_str(&details);
        }
    }
    Fault::new("op_failed", message.chars().take(1000).collect::<String>())
}

fn run(d: &Desktop, plan: &Plan, deadline: Instant) -> OpResult<Value> {
    let state = d.dir.join("agent-desktop-state");
    crate::instance::private_dir(&state).map_err(|e| unavailable(e.to_string()))?;
    let mut command = d.command(&d.agent_desktop);
    command.env("AGENT_DESKTOP_HOME", &state).args(&plan.args);
    let remaining = deadline.saturating_duration_since(Instant::now());
    let finished = run_process(command, plan.input.as_deref(), remaining, plan.cap)?;
    let envelope = envelope(&finished)?;
    if envelope["ok"] != true {
        return Err(refusal(&envelope));
    }
    let data = &envelope["data"];
    match plan.kind {
        Kind::Snapshot => {
            let id = data["snapshot_id"].as_str().unwrap_or("");
            let read = data["app"].as_str().unwrap_or("");
            if snapshot_of(&format!("@{id}:e0")).is_none() || !read.eq_ignore_ascii_case(&plan.app)
            {
                // The name matched something else, or the answer is not one app's tree.
                return Err(denied(
                    "agent-desktop answered for an app this computer does not allow",
                ));
            }
            d.snapshots.record(id, &plan.app);
            Ok(json!({
                "snapshot_id": id,
                "ref_count": data["ref_count"].as_u64().unwrap_or(0),
                "complete": data["complete"].as_bool().unwrap_or(true),
                "text": String::from_utf8_lossy(&finished.data).trim(),
            }))
        }
        Kind::Act => Ok(json!({
            "ok": true,
            "app": plan.app,
            "text": String::from_utf8_lossy(&finished.data).trim(),
        })),
        Kind::Apps => Ok(json!({"apps": allowed_apps(data, &plan.allow)})),
    }
}

fn allowed_apps(data: &Value, allow: &[String]) -> Vec<Value> {
    data["apps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|app| {
            let name = app["name"].as_str()?;
            allow
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(name))
                .then(|| json!({"name": name}))
        })
        .collect()
}

pub(super) async fn dispatch(
    desktop: Option<&Desktop>,
    frame: &Value,
    config: &ComputerConfig,
) -> OpResult<Value> {
    let empty = Snapshots::default();
    let known = desktop.map_or(&empty, |d| &d.snapshots);
    let plan = plan(frame, config, known)?;
    let d = desktop.ok_or_else(|| unavailable("desktop is not running; use --desktop"))?;
    let start = Instant::now();
    let _permit = tokio::time::timeout(plan.budget, d.turn.acquire())
        .await
        .map_err(|_| Fault::new("op_failed", "desktop busy"))?
        .map_err(|_| unavailable("desktop stopped"))?;
    if !d.owns() {
        return Err(unavailable("X server is not owned by this desktop"));
    }
    let deadline = start + plan.budget;
    let plan = &plan;
    let result = tokio::task::block_in_place(|| run(d, plan, deadline));
    // A headed action moves the real pointer, so it is the one op worth a note in the log.
    if plan.headed && result.is_ok() {
        tracing::info!(app = %plan.app, "agent-desktop acted with physical input");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn config(apps: &[&str]) -> ComputerConfig {
        ComputerConfig {
            allow_apps: apps.iter().map(|app| (*app).into()).collect(),
            ..Default::default()
        }
    }
    fn code(result: OpResult<Plan>) -> &'static str {
        result.unwrap_err().code
    }
    fn known(id: &str, app: &str) -> Snapshots {
        let snapshots = Snapshots::default();
        snapshots.record(id, app);
        snapshots
    }

    #[test]
    fn an_empty_allow_list_means_no_agent_desktop() {
        let none = Snapshots::default();
        for frame in [
            json!({"op":"desktop_snapshot","app":"chromium"}),
            json!({"op":"desktop_apps"}),
            json!({"op":"desktop_act","ref":"@s1:e1","action":"click"}),
        ] {
            assert_eq!(code(plan(&frame, &config(&[]), &none)), "denied");
        }
    }

    #[test]
    fn a_snapshot_with_no_app_is_refused() {
        let none = Snapshots::default();
        for frame in [
            json!({"op":"desktop_snapshot"}),
            json!({"op":"desktop_snapshot","app":""}),
            json!({"op":"desktop_snapshot","app":null}),
        ] {
            assert_eq!(code(plan(&frame, &config(&["chromium"]), &none)), "denied");
        }
    }

    #[test]
    fn only_listed_apps_are_read_and_the_match_ignores_case() {
        let none = Snapshots::default();
        let config = config(&["chromium", "Mousepad"]);
        let p = plan(
            &json!({"op":"desktop_snapshot","app":"mousepad","interactive":true,"compact":true}),
            &config,
            &none,
        )
        .unwrap();
        assert_eq!(p.app, "Mousepad");
        assert_eq!(
            p.args,
            [
                "snapshot",
                "--app",
                "Mousepad",
                "-i",
                "--compact",
                "--timeout-ms",
                "8000"
            ]
        );
        for app in ["xterm", "chrom", "chromium --x", "-chromium", "chromium\n"] {
            assert_eq!(
                code(plan(
                    &json!({"op":"desktop_snapshot","app":app}),
                    &config,
                    &none
                )),
                "denied",
                "{app}"
            );
        }
    }

    #[test]
    fn a_root_must_come_from_a_snapshot_of_the_same_app() {
        let config = config(&["chromium", "mousepad"]);
        let snapshots = known("sabc", "chromium");
        let ok = plan(
            &json!({"op":"desktop_snapshot","app":"chromium","root":"@sabc:e3"}),
            &config,
            &snapshots,
        )
        .unwrap();
        assert!(ok.args.windows(2).any(|w| w == ["--root", "@sabc:e3"]));
        assert_eq!(
            code(plan(
                &json!({"op":"desktop_snapshot","app":"mousepad","root":"@sabc:e3"}),
                &config,
                &snapshots
            )),
            "denied"
        );
        assert_eq!(
            code(plan(
                &json!({"op":"desktop_snapshot","app":"chromium","root":"@sother:e3"}),
                &config,
                &snapshots
            )),
            "denied"
        );
        assert_eq!(
            code(plan(
                &json!({"op":"desktop_snapshot","app":"chromium","root":"--help"}),
                &config,
                &snapshots
            )),
            "bad_request"
        );
    }

    #[test]
    fn an_action_on_an_unknown_snapshot_is_refused() {
        let frame = json!({"op":"desktop_act","ref":"@sabc:e1","action":"click"});
        assert_eq!(
            code(plan(&frame, &config(&["chromium"]), &Snapshots::default())),
            "denied"
        );
        assert!(plan(&frame, &config(&["chromium"]), &known("sabc", "chromium")).is_ok());
    }

    #[test]
    fn an_action_rechecks_the_app_through_its_snapshot() {
        // The snapshot was read when the app was allowed; the list no longer names it.
        let frame = json!({"op":"desktop_act","ref":"@sabc:e1","action":"click"});
        assert_eq!(
            code(plan(
                &frame,
                &config(&["mousepad"]),
                &known("sabc", "chromium")
            )),
            "denied"
        );
    }

    #[test]
    fn read_only_refuses_act_but_not_snapshot() {
        let mut config = config(&["chromium"]);
        config.read_only = true;
        let snapshots = known("sabc", "chromium");
        assert_eq!(
            code(plan(
                &json!({"op":"desktop_act","ref":"@sabc:e1","action":"click"}),
                &config,
                &snapshots
            )),
            "read_only"
        );
        assert!(
            plan(
                &json!({"op":"desktop_snapshot","app":"chromium"}),
                &config,
                &snapshots
            )
            .is_ok()
        );
        assert!(plan(&json!({"op":"desktop_apps"}), &config, &snapshots).is_ok());
    }

    #[test]
    fn refs_and_actions_are_checked_before_anything_runs() {
        let config = config(&["chromium"]);
        let snapshots = known("sabc", "chromium");
        for (frame, expected) in [
            (json!({"ref":"@e1","action":"click"}), "bad_request"),
            (
                json!({"ref":"@sabc:e1; id","action":"click"}),
                "bad_request",
            ),
            (json!({"ref":"--help","action":"click"}), "bad_request"),
            (
                json!({"ref":"@sabc:e1","action":"close-app"}),
                "bad_request",
            ),
            (
                json!({"ref":"@sabc:e1","action":"click","text":"x"}),
                "bad_request",
            ),
            (json!({"ref":"@sabc:e1","action":"type"}), "bad_request"),
            (
                json!({"ref":"@sabc:e1","action":"type","text":""}),
                "bad_request",
            ),
            (
                json!({"ref":"@sabc:e1","action":"type","text":"x".repeat(513)}),
                "bad_request",
            ),
        ] {
            let mut frame = frame;
            frame["op"] = json!("desktop_act");
            assert_eq!(code(plan(&frame, &config, &snapshots)), expected, "{frame}");
        }
    }

    #[test]
    fn typed_text_goes_through_stdin_and_never_argv() {
        let config = config(&["chromium"]);
        let snapshots = known("sabc", "chromium");
        for action in ["type", "set_value"] {
            let p = plan(
                &json!({"op":"desktop_act","ref":"@sabc:e2","action":action,"text":"hunter2"}),
                &config,
                &snapshots,
            )
            .unwrap();
            assert_eq!(p.input.as_deref(), Some("hunter2"));
            assert!(!p.args.iter().any(|arg| arg.contains("hunter2")));
            assert_eq!(p.args[1], "@sabc:e2");
            assert!(p.args.contains(&"--stdin".to_string()));
        }
        let p = plan(
            &json!({"op":"desktop_act","ref":"@sabc:e2","action":"set_value","text":"a"}),
            &config,
            &snapshots,
        )
        .unwrap();
        assert_eq!(p.args[0], "set-value");
        let p = plan(
            &json!({"op":"desktop_act","ref":"@sabc:e2","action":"select","text":"Large"}),
            &config,
            &snapshots,
        )
        .unwrap();
        assert_eq!(p.args, ["select", "@sabc:e2", "Large"]);
    }

    #[test]
    fn headed_is_denied_until_the_computer_allows_it() {
        let snapshots = known("sabc", "chromium");
        let frame =
            json!({"op":"desktop_act","ref":"@sabc:e2","action":"type","text":"Ada","headed":true});
        assert_eq!(
            code(plan(&frame, &config(&["chromium"]), &snapshots)),
            "denied"
        );
        let mut allowing = config(&["chromium"]);
        allowing.allow_headed = true;
        let p = plan(&frame, &allowing, &snapshots).unwrap();
        assert!(p.headed && p.args.last().unwrap() == "--headed");
        let p = plan(
            &json!({"op":"desktop_act","ref":"@sabc:e2","action":"click"}),
            &config(&["chromium"]),
            &snapshots,
        )
        .unwrap();
        assert!(!p.headed && !p.args.contains(&"--headed".to_string()));
    }

    #[test]
    fn the_snapshot_memory_is_bounded() {
        let snapshots = Snapshots::default();
        for n in 0..MAX_REMEMBERED_SNAPSHOTS + 10 {
            snapshots.record(&format!("s{n}"), "chromium");
        }
        assert!(snapshots.app("s0").is_none());
        assert_eq!(
            snapshots
                .app(&format!("s{}", MAX_REMEMBERED_SNAPSHOTS + 9))
                .as_deref(),
            Some("chromium")
        );
    }

    #[test]
    fn app_names_are_one_safe_argv_word() {
        for ok in ["chromium", "Google Chrome", "gnome-text-editor", "a.b_c+d"] {
            assert!(valid_app(ok), "{ok}");
        }
        for bad in ["", "-x", " x", "a;b", "a\nb", "a/b", &"x".repeat(65)] {
            assert!(!valid_app(bad), "{bad}");
        }
    }

    #[test]
    fn the_app_list_shows_only_allowed_apps() {
        let data = json!({"apps":[{"name":"chromium","pid":1},{"name":"keepassxc","pid":2}]});
        assert_eq!(
            allowed_apps(&data, &["Chromium".to_string()]),
            vec![json!({"name":"chromium"})]
        );
    }

    #[test]
    fn refusals_carry_the_code_and_suggestion_without_the_tree() {
        let fault = refusal(
            &json!({"ok":false,"error":{"code":"STALE_REF","message":"gone","suggestion":"Snapshot again."}}),
        );
        assert_eq!(fault.code, "op_failed");
        assert_eq!(fault.message, "STALE_REF: gone Snapshot again.");
    }

    /// A stand-in for agent-desktop, so the run path is covered without the real one.
    fn fake_desktop(dir: &std::path::Path, script: &str) -> Desktop {
        use std::os::unix::fs::PermissionsExt;
        let binary = dir.join("agent-desktop");
        fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let mut d = Desktop::for_test(dir);
        d.agent_desktop = binary.to_string_lossy().into_owned();
        d
    }
    fn plan_of(frame: Value, config: &ComputerConfig, d: &Desktop) -> Plan {
        plan(&frame, config, &d.snapshots).unwrap()
    }
    fn run_now(d: &Desktop, plan: &Plan) -> OpResult<Value> {
        run(d, plan, Instant::now() + Duration::from_secs(5))
    }

    #[test]
    fn a_snapshot_is_remembered_and_an_action_reaches_the_command_with_stdin_text() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let d = fake_desktop(
            dir.path(),
            &format!(
                r#"echo "$@" >> {log}
case "$1" in
  snapshot) printf '{{"ok":true,"data":{{"app":"Chromium","snapshot_id":"sfake1","ref_count":2,"complete":true,"tree":{{}}}}}}';;
  type) cat >> {log}; printf '{{"ok":true,"data":{{"action":"type"}}}}';;
  click) printf '{{"ok":false,"error":{{"code":"STALE_REF","message":"gone"}}}}'; exit 1;;
esac"#,
                log = log.display()
            ),
        );
        let config = ComputerConfig {
            allow_apps: vec!["chromium".into()],
            allow_headed: true,
            ..Default::default()
        };
        let snapshot = run_now(
            &d,
            &plan_of(
                json!({"op":"desktop_snapshot","app":"chromium"}),
                &config,
                &d,
            ),
        )
        .unwrap();
        assert_eq!(snapshot["snapshot_id"], "sfake1");
        assert_eq!(snapshot["ref_count"], 2);
        assert_eq!(d.snapshots.app("sfake1").as_deref(), Some("chromium"));
        let acted = run_now(
            &d,
            &plan_of(
                json!({"op":"desktop_act","ref":"@sfake1:e1","action":"type","text":"Ada","headed":true}),
                &config,
                &d,
            ),
        )
        .unwrap();
        assert_eq!(acted["app"], "chromium");
        let log = fs::read_to_string(&log).unwrap();
        assert!(log.contains("type @sfake1:e1 --stdin --headed"), "{log}");
        assert!(log.contains("Ada"));
        // A refused action still tells the model why.
        let error = run_now(
            &d,
            &plan_of(
                json!({"op":"desktop_act","ref":"@sfake1:e1","action":"click"}),
                &config,
                &d,
            ),
        )
        .unwrap_err();
        assert_eq!(error.message, "STALE_REF: gone");
    }

    #[test]
    fn an_answer_for_another_app_is_refused_and_not_remembered() {
        let dir = tempfile::tempdir().unwrap();
        let d = fake_desktop(
            dir.path(),
            r#"printf '{"ok":true,"data":{"app":"keepassxc","snapshot_id":"sother","ref_count":1,"complete":true}}'"#,
        );
        let config = ComputerConfig {
            allow_apps: vec!["chrom".into()],
            ..Default::default()
        };
        let error = run_now(
            &d,
            &plan_of(json!({"op":"desktop_snapshot","app":"chrom"}), &config, &d),
        )
        .unwrap_err();
        assert_eq!(error.code, "denied");
        assert!(d.snapshots.app("sother").is_none());
    }

    #[test]
    fn accessibility_and_the_bus_reach_programs_only_as_the_opt_in_and_bus_allow() {
        let dir = tempfile::tempdir().unwrap();
        let mut d = Desktop::for_test(dir.path());
        let names = |d: &Desktop| {
            d.environment()
                .into_iter()
                .map(|(key, _)| key)
                .collect::<Vec<_>>()
        };
        assert!(names(&d).contains(&"ACCESSIBILITY_ENABLED".to_string()));
        assert!(names(&d).contains(&"CHROMIUM_FLAGS".to_string()));
        assert!(!names(&d).contains(&"DBUS_SESSION_BUS_ADDRESS".to_string()));
        d.bus.set("unix:path=/x/bus".into()).unwrap();
        let environment = d.environment();
        assert!(
            environment.contains(&("DBUS_SESSION_BUS_ADDRESS".into(), "unix:path=/x/bus".into()))
        );
        assert!(names(&d).contains(&"XDG_RUNTIME_DIR".to_string()));
        d.agent_apps = false;
        assert!(!names(&d).contains(&"ACCESSIBILITY_ENABLED".to_string()));
        assert!(!names(&d).contains(&"CHROMIUM_FLAGS".to_string()));
    }
}
