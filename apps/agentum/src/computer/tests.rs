use super::*;
use serde_json::json;
use std::os::unix::process::CommandExt;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

fn setup(config: crate::instance::ComputerConfig) -> (tempfile::TempDir, Arc<Engine>) {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let work = state.join("work");
    fs::create_dir_all(&work).unwrap();
    let engine = Engine::new(config, state, dir.path().join("config"), work, None).unwrap();
    (dir, Arc::new(engine))
}
#[test]
fn policy_flags_paths_and_environment() {
    let (dir, e) = setup(crate::instance::ComputerConfig {
        allow: vec!["git status".into()],
        deny: vec!["^rm".into()],
        workdir_only: true,
        allow_env: vec!["GIT_CONFIG_*".into()],
        ..Default::default()
    });
    assert!(e.policy.exec("git status").is_ok());
    for command in ["git status; evil", "git status\nrm foo", "\0"] {
        assert!(e.policy.exec(command).is_err());
    }
    for name in ["HOME", "PATH", "LD_PRELOAD", "dyld_insert_libraries"] {
        assert!(!e.policy.env_allowed(name));
    }
    for name in ["LANG", "LC_ALL", "TFY_SESSION", "GIT_CONFIG_COUNT"] {
        assert!(e.policy.env_allowed(name));
    }
    assert!(e.policy.path(&e.state.join("credential"), false).is_err());
    assert!(e.policy.path(&dir.path().join("outside"), false).is_err());
    symlink(dir.path(), e.policy.work.join("escape")).unwrap();
    assert!(
        e.policy
            .path(&e.policy.work.join("escape/no-file"), false)
            .is_err()
    );
    assert!(
        e.policy
            .cwd(Some(&e.policy.work.join("new/sub").to_string_lossy()))
            .unwrap()
            .is_dir()
    );
    assert!(
        e.policy
            .cwd(Some(&dir.path().join("missing").to_string_lossy()))
            .is_err()
    );
}
#[tokio::test]
async fn agent_exec_cancel_limits_and_audit() {
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        max_concurrent: 1,
        max_queue: 1,
        ..Default::default()
    });
    e.reserve("one").unwrap();
    assert_eq!(e.reserve("one").unwrap_err().code, "duplicate_id");
    assert!(e.cancel("one"));
    let result = e
        .dispatch(json!({"id":"one","op":"exec","command":"echo must-not-run"}))
        .await
        .unwrap();
    assert_eq!(result["exit_code"], 137);
    e.reserve("two").unwrap();
    let result = e
        .dispatch(json!({"id":"two","op":"exec","command":"printf out; printf err >&2; exit 7"}))
        .await
        .unwrap();
    assert_eq!(result["stdout"], "out");
    assert_eq!(result["stderr"], "err");
    assert_eq!(result["exit_code"], 7);
    e.reserve("timeout").unwrap();
    let result = e
        .dispatch(json!({"id":"timeout","op":"exec","command":"sleep 30", "timeout_ms":20}))
        .await
        .unwrap();
    assert_eq!(result["exit_code"], 124);
    let audit = fs::read_to_string(e.state.join("audit.jsonl")).unwrap();
    assert!(audit.contains("\"exit_code\":7"));
    assert!(!audit.contains("env"));
}
#[tokio::test]
async fn files_chunking_atomicity_modes_and_errors() {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let (_dir, e) = setup(Default::default());
    let path = e.policy.work.join("file");
    fs::write(&path, "original").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    let put = |seq, data: &str, final_chunk, hash: Option<String>| json!({"id":format!("p{seq}"),"op":"file_put","transfer_id":"t","path":path,"seq":seq,"data_b64":base64::engine::general_purpose::STANDARD.encode(data),"final":final_chunk,"sha256":hash});
    e.dispatch(put(0, "new", false, None)).await.unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert!(
        e.dispatch(put(1, "bad", true, Some("wrong".into())))
            .await
            .is_err()
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    let later = {
        let e = e.clone();
        let frame = put(
            1,
            "world",
            true,
            Some(hex::encode(Sha256::digest(b"hello world"))),
        );
        tokio::spawn(async move { e.dispatch(frame).await })
    };
    tokio::task::yield_now().await;
    e.dispatch(put(0, "hello ", false, None)).await.unwrap();
    later.await.unwrap().unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "hello world");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o750
    );
    let get = e
        .dispatch(json!({"op":"file_get","path":path,"offset":0,"max_bytes":99999999}))
        .await
        .unwrap();
    assert_eq!(get["size"], 11);
    assert!(get["sha256"].is_string());
    assert_eq!(
        e.dispatch(json!({"op":"file_get","path":e.policy.work}))
            .await
            .unwrap_err()
            .code,
        "is_a_directory"
    );
}
#[test]
fn audit_rotation_and_output_head_tail() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = audit::Log::new(dir.path(), 100, 2).unwrap();
    for _ in 0..6 {
        log.record(json!({"op":"exec","command":"x".repeat(5000)}))
            .unwrap();
    }
    assert!(dir.path().join("audit.jsonl.2").exists());
    assert!(!dir.path().join("audit.jsonl.3").exists());
    assert_eq!(
        fs::metadata(dir.path().join("audit.jsonl"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let mut output = runner::Output::default();
    output.push(&vec![b'x'; 2 << 20]);
    output.push(b"THE END");
    let (text, total, truncated) = output.snapshot();
    assert_eq!(total, (2 << 20) + 7);
    assert!(truncated);
    assert!(text.ends_with("THE END"));
    assert!(text.len() <= 1 << 19);
}
#[tokio::test]
async fn read_only_and_desktop_validation() {
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        read_only: true,
        ..Default::default()
    });
    for frame in [
        json!({"op":"exec","command":"true","id":"r"}),
        json!({"op":"file_put","path":e.policy.work.join("f"),"transfer_id":"t","seq":0,"data_b64":"","final":true}),
    ] {
        assert!(e.dispatch(frame).await.is_err());
    }
    assert_eq!(
        e.dispatch(json!({"op":"desktop_input","actions":[{"type":"key","keys":"ctrl+a"}]}))
            .await
            .unwrap_err()
            .code,
        "read_only"
    );
    assert_eq!(
        e.dispatch(json!({"op":"desktop_input","actions":[{"type":"key","keys":"exec"}]}))
            .await
            .unwrap_err()
            .code,
        "bad_request"
    );
    assert_eq!(
        e.dispatch(json!({"op":"desktop_screenshot"}))
            .await
            .unwrap_err()
            .code,
        "desktop_unavailable"
    );
    assert_eq!(
        e.dispatch(json!({"op":"nonsense"})).await.unwrap_err().code,
        "unknown_op"
    );
}

#[test]
fn policy_startup_read_only_unrestricted_and_symlink_edges() {
    let (dir, e) = setup(Default::default());
    assert!(e.policy.exec("anything; goes").is_ok());
    assert!(e.policy.env_allowed("HOME"));
    assert!(!e.policy.env_allowed("LD_LIBRARY_PATH"));
    assert!(
        e.policy
            .path(&dir.path().join("state-old/file"), false)
            .is_ok()
    );
    assert!(
        e.policy
            .path(&dir.path().join("config/credential"), false)
            .is_err()
    );
    assert!(
        policy::Policy::new(
            crate::instance::ComputerConfig {
                allow: vec!["[".into()],
                ..Default::default()
            },
            e.state.clone(),
            dir.path().join("config"),
            e.policy.work.clone()
        )
        .is_err()
    );
    assert!(
        policy::Policy::new(
            Default::default(),
            e.state.clone(),
            dir.path().join("config"),
            dir.path().to_owned()
        )
        .is_err()
    );
    fs::write(e.policy.work.join("file"), "").unwrap();
    assert!(
        e.policy
            .cwd(Some(&e.policy.work.join("file").to_string_lossy()))
            .is_err()
    );
    symlink(dir.path(), e.policy.work.join("link")).unwrap();
    assert!(
        e.policy
            .cwd(Some(&e.policy.work.join("link/missing").to_string_lossy()))
            .is_err()
    );
}
#[tokio::test]
async fn queue_cancel_shutdown_and_environment_scrubbing() {
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        max_concurrent: 1,
        max_queue: 1,
        ..Default::default()
    });
    e.reserve("active").unwrap();
    e.reserve("queued").unwrap();
    assert_eq!(e.reserve("overflow").unwrap_err().code, "queue_full");
    let active = {
        let e = e.clone();
        tokio::spawn(async move {
            e.dispatch(json!({"op":"exec","id":"active","command":"sleep 30"}))
                .await
        })
    };
    let queued = {
        let e = e.clone();
        tokio::spawn(async move {
            e.dispatch(json!({"op":"exec","id":"queued","command":"echo nope"}))
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    e.stop();
    assert_eq!(active.await.unwrap().unwrap()["exit_code"], 137);
    assert_eq!(queued.await.unwrap().unwrap()["exit_code"], 137);
    e.reserve("env").unwrap();
    let r = e
        .dispatch(json!({"op":"exec","id":"env","command":"env","env":{"JUST_THIS":"yes"}}))
        .await
        .unwrap();
    let out = r["stdout"].as_str().unwrap();
    assert!(out.contains("JUST_THIS=yes"));
    assert!(!out.contains("AGENTUM_ENROLL_CODE="));
    assert!(!out.contains("CARGO="));
    e.reserve("signal").unwrap();
    let r = e
        .dispatch(json!({"op":"exec","id":"signal","command":"kill -TERM $$"}))
        .await
        .unwrap();
    assert_eq!(r["exit_code"], 143);
}
#[tokio::test]
async fn cancelled_and_denied_reservations_can_be_reused() {
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        allow: vec!["true".into()],
        ..Default::default()
    });
    e.reserve("denied").unwrap();
    assert_eq!(
        e.dispatch(json!({"op":"exec","id":"denied","command":"false"}))
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    e.reserve("denied").unwrap();
    assert_eq!(
        e.dispatch(json!({"op":"exec","id":"denied","command":"true","env":{"HOME":"/tmp"}}))
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    e.reserve("denied").unwrap();
    assert!(
        e.dispatch(json!({"op":"exec","id":"denied","command":2}))
            .await
            .is_err()
    );
    e.reserve("denied").unwrap();
}
#[tokio::test]
async fn file_caps_nonregular_abandon_and_rechecks() {
    use base64::Engine as _;
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        max_file_bytes: 4,
        ..Default::default()
    });
    let path = e.policy.work.join("f");
    let put = |id: &str, path: &std::path::Path, seq: i64, data: &[u8], final_chunk: bool| json!({"op":"file_put","transfer_id":id,"path":path,"seq":seq,"data_b64":base64::engine::general_purpose::STANDARD.encode(data),"final":final_chunk});
    for (frame, code) in [
        (put("t", &path, -1, b"", false), "bad_request"),
        (put("t", &path, 32, b"", false), "bad_request"),
        (
            put("t", &path, 0, &vec![0; files::CHUNK + 1], false),
            "bad_request",
        ),
        (put("t", &path, 0, b"12345", false), "too_large"),
    ] {
        assert_eq!(e.dispatch(frame).await.unwrap_err().code, code);
    }
    fs::write(&path, b"old").unwrap();
    e.dispatch(put("t", &path, 0, b"new", false)).await.unwrap();
    e.transfers.abandon();
    assert_eq!(fs::read(&path).unwrap(), b"old");
    e.dispatch(put("t", &path, 0, b"a", false)).await.unwrap();
    fs::remove_file(&path).unwrap();
    symlink(e.state.join("credential"), &path).unwrap();
    assert!(e.dispatch(put("t", &path, 1, b"b", true)).await.is_err());
    assert!(
        fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let fifo = e.policy.work.join("fifo");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRUSR).unwrap();
    assert_eq!(
        e.dispatch(json!({"op":"file_get","path":fifo}))
            .await
            .unwrap_err()
            .code,
        "not_a_regular_file"
    );
    assert_eq!(
        e.dispatch(put("fifo", &fifo, 0, b"", true))
            .await
            .unwrap_err()
            .code,
        "not_a_regular_file"
    );
    assert_eq!(
        e.dispatch(json!({"op":"file_get","path":e.policy.work.join("missing")}))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    fs::write(e.policy.work.join("large"), b"12345").unwrap();
    assert_eq!(
        e.dispatch(json!({"op":"file_get","path":e.policy.work.join("large")}))
            .await
            .unwrap_err()
            .code,
        "too_large"
    );
    for i in 0..8 {
        e.dispatch(put(
            &i.to_string(),
            &e.policy.work.join(i.to_string()),
            0,
            b"",
            false,
        ))
        .await
        .unwrap();
    }
    assert_eq!(
        e.dispatch(put("ninth", &path, 0, b"", false))
            .await
            .unwrap_err()
            .code,
        "queue_full"
    );
}
#[tokio::test(start_paused = true)]
async fn missing_predecessor_times_out_and_abandon_wakes_waiters() {
    let (_dir, e) = setup(Default::default());
    let frame = json!({"op":"file_put","transfer_id":"t","path":e.policy.work.join("f"),"seq":1,"data_b64":"","final":false});
    let task = {
        let e = e.clone();
        let f = frame.clone();
        tokio::spawn(async move { e.dispatch(f).await })
    };
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_secs(61)).await;

    assert!(task.await.unwrap().is_err());
}
#[tokio::test]
async fn download_window_and_output_budget() {
    use base64::Engine as _;
    let (_dir, e) = setup(Default::default());
    let path = e.policy.work.join("large");
    fs::write(&path, vec![b'x'; files::CHUNK * 2]).unwrap();
    let first = e
        .dispatch(json!({"op":"file_get","path":path,"max_bytes":99999999}))
        .await
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(first["data_b64"].as_str().unwrap())
            .unwrap()
            .len(),
        files::CHUNK
    );
    assert_eq!(first["eof"], false);
    let last = e
        .dispatch(json!({"op":"file_get","path":path,"offset":files::CHUNK}))
        .await
        .unwrap();
    assert_eq!(last["eof"], true);
    assert_eq!(last["sha256"], Value::Null);
    e.reserve("large").unwrap();
    let result = e
        .dispatch(
            json!({"op":"exec","id":"large","command":"head -c 2000000 /dev/zero; printf END"}),
        )
        .await
        .unwrap();
    assert_eq!(result["bytes_total"], 2000003);
    assert_eq!(result["truncated"], true);
    assert!(result["stdout"].as_str().unwrap().ends_with("END"));
}
#[test]
fn sweep_requires_positive_kernel_identity() {
    let (dir, e) = setup(Default::default());
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    fs::write(
        e.state.join("running/fake.json"),
        json!({"pgid":pid,"start_time":0}).to_string(),
    )
    .unwrap();
    runner::sweep(&e.state);
    assert!(child.try_wait().unwrap().is_none());
    fs::write(
        e.state.join("running/real.json"),
        json!({"pgid":pid,"start_time":runner::start_time(pid)}).to_string(),
    )
    .unwrap();
    runner::sweep(&e.state);
    assert!(!child.wait().unwrap().success());
    drop(dir);
}

#[tokio::test]
async fn real_role_keeps_commands_across_replacement_and_audits_dropped_reply() {
    use crate::{
        instance::RunAs,
        relay::{self, Timing},
    };
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        accept_async,
        tungstenite::{Message, protocol::CloseFrame},
    };
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("config"), dir.path().join("state"), false);
    let mut config = Config::new(
        "m".into(),
        "box".into(),
        "http://localhost".into(),
        vec![wire::MachineRole::Computer],
        false,
        RunAs::Current,
    );
    config.computer.allow_root = true;
    let computer = role(&paths, "box", &config);
    computer.prerequisites().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        let hello: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["protocol_version"], 1);
        assert_eq!(hello["version"], format!("agentum-rs@{}", crate::VERSION));
        assert!(hello.get("features").is_none());
        socket
            .send(Message::text(
                json!({"op":"exec","id":"long","command":"sleep 30"}).to_string(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::text(
                json!({"op":"exec","id":"long","command":"echo should-not-run"}).to_string(),
            ))
            .await
            .unwrap();
        let duplicate: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(duplicate["error"]["code"], "duplicate_id");
        socket
            .close(Some(CloseFrame {
                code: 4409.into(),
                reason: "replacement".into(),
            }))
            .await
            .unwrap();
        drop(socket);
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::text(
                json!({"op":"cancel","id":"cancel","target_id":"long"}).to_string(),
            ))
            .await
            .unwrap();
        let response: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(response["id"], "cancel");
        assert_eq!(response["result"]["cancelled"], true);
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        socket
            .close(Some(CloseFrame {
                code: 4401.into(),
                reason: "revoked".into(),
            }))
            .await
            .unwrap();
    });
    let timing = Timing {
        retry_scale: 0.00001,
        heartbeat: std::time::Duration::from_secs(10),
        ..Timing::for_role(SocketRole::Computer)
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        relay::run(
            computer,
            &url,
            "hm_mach_test",
            CancellationToken::new(),
            timing,
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, 3);
    server.await.unwrap();
    let audit = fs::read_to_string(paths.state("box").join("audit.jsonl")).unwrap();
    assert!(audit.contains("reply_dropped"));
    assert!(audit.contains("cancel"));
}

#[test]
fn output_preserves_binary_and_unicode_seams() {
    let mut output = runner::Output::default();
    output.push(&[255, b'a']);
    let (text, total, cut) = output.snapshot();
    assert_eq!(total, 2);
    assert!(!cut);
    assert_eq!(text, "�a");
    let mut output = runner::Output::default();
    output.push("☃".repeat(400000).as_bytes());
    let (text, _, cut) = output.snapshot();
    assert!(cut);
    assert!(!text.contains('�'));
    assert!(text.len() <= 1 << 19);
}

#[tokio::test]
async fn concurrency_slots_and_operator_timeout_cap_are_enforced() {
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        max_concurrent: 1,
        max_exec_seconds: 1,
        ..Default::default()
    });
    e.reserve("first").unwrap();
    let first = {
        let e = e.clone();
        tokio::spawn(async move {
            e.dispatch(json!({"op":"exec","id":"first","command":"sleep 30","timeout_ms":99999999}))
                .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while e.pids.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    e.reserve("second").unwrap();
    let second = {
        let e = e.clone();
        tokio::spawn(async move {
            e.dispatch(json!({"op":"exec","id":"second","command":"touch second-started"}))
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!e.policy.work.join("second-started").exists());
    assert_eq!(first.await.unwrap().unwrap()["exit_code"], 124);
    assert_eq!(second.await.unwrap().unwrap()["exit_code"], 0);
    assert!(e.policy.work.join("second-started").exists());
}
#[tokio::test]
async fn desktop_audit_never_contains_typed_text_or_clipboard_content() {
    let (_dir, e) = setup(Default::default());
    for frame in [
        json!({"op":"desktop_input","actions":[{"type":"type","text":"typed-secret"},{"type":"key","keys":"ctrl+a"}]}),
        json!({"op":"desktop_clipboard_set","text":"clipboard-secret","selections":["clipboard"]}),
    ] {
        assert!(e.dispatch(frame).await.is_err());
    }
    let audit = fs::read_to_string(e.state.join("audit.jsonl")).unwrap();
    for secret in ["typed-secret", "clipboard-secret", "ctrl+a"] {
        assert!(!audit.contains(secret));
    }
    assert!(audit.contains("\"actions\":[\"type\",\"key\"]"));
}

#[test]
fn policy_regexes_keep_go_ascii_classes_and_quoted_literals() {
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        allow: vec![r"[\w]+".into(), r"\Qgit status\E".into()],
        ..Default::default()
    });
    assert!(e.policy.exec("status").is_ok());
    assert!(e.policy.exec("git status").is_ok());
    assert!(e.policy.exec("é").is_err());
}

#[tokio::test]
async fn upload_carries_permission_bits_without_special_bits() {
    let (_dir, e) = setup(Default::default());
    let path = e.policy.work.join("mode");
    fs::write(&path, "old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o4750)).unwrap();
    e.dispatch(json!({"op":"file_put","transfer_id":"mode","path":path,"seq":0,"data_b64":"","final":true})).await.unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o7777,
        0o750
    );
}

#[test]
fn oversized_reply_is_refused_not_sent() {
    let reply = encode_reply("large", Ok(json!({"text":"x".repeat(8 << 20)})));
    assert_eq!(reply["error"]["code"], "frame_too_large");
    assert_eq!(reply["id"], "large");
    assert!(reply.get("result").is_none());
    assert!(serde_json::to_vec(&reply).unwrap().len() < 1024);
}

#[tokio::test]
async fn audit_records_resolved_cwd_and_path() {
    let (_dir, e) = setup(Default::default());
    let alias = e.policy.work.join("alias");
    symlink(&e.policy.work, &alias).unwrap();
    e.reserve("audit").unwrap();
    e.dispatch(json!({"op":"exec","id":"audit","command":"true","cwd":alias}))
        .await
        .unwrap();
    fs::write(e.policy.work.join("f"), "ok").unwrap();
    e.dispatch(json!({"op":"file_get","id":"file","path":alias.join("f")}))
        .await
        .unwrap();
    let entries: Vec<Value> = fs::read_to_string(e.state.join("audit.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(entries[0]["cwd"], json!(e.policy.work));
    assert_eq!(entries[1]["path"], json!(e.policy.work.join("f")));
}

#[tokio::test]
async fn deadline_reports_124_and_kills_the_group() {
    let (_dir, e) = setup(Default::default());
    e.reserve("deadline").unwrap();
    let result = e.dispatch(json!({"op":"exec","id":"deadline","command":"(sleep 1; touch survivor) & sleep 30","timeout_ms":50})).await.unwrap();
    assert_eq!(result["exit_code"], 124);
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    assert!(!e.policy.work.join("survivor").exists());
}

#[tokio::test]
async fn escaped_grandchild_cannot_hang_the_call() {
    if !on_path("setsid") {
        eprintln!("setsid missing; skipping escaped grandchild test");
        return;
    }
    let (_dir, e) = setup(Default::default());
    e.reserve("escape").unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), e.dispatch(json!({"op":"exec","id":"escape","command":"setsid sh -c 'echo $$ > escaped; exec sleep 30' & exit 0"}))).await.unwrap().unwrap();
    assert_eq!(result["exit_code"], 0);
    let pid: u32 = fs::read_to_string(e.policy.work.join("escaped"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    runner::kill(pid);
}

#[tokio::test]
async fn sweep_kills_groups_left_behind_and_simple_commands() {
    for command in ["sleep 1; touch survivor", "sleep 30"] {
        let (_dir, e) = setup(Default::default());
        e.reserve("orphan").unwrap();
        let task = {
            let e = e.clone();
            tokio::spawn(async move {
                e.dispatch(json!({"op":"exec","id":"orphan","command":command}))
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while fs::read_dir(e.state.join("running")).unwrap().count() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runner::sweep(&e.state);
        assert_eq!(task.await.unwrap().unwrap()["exit_code"], 137);
        assert_eq!(fs::read_dir(e.state.join("running")).unwrap().count(), 0);
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        assert!(!e.policy.work.join("survivor").exists());
    }
}

#[test]
fn sweep_ignores_missing_stale_and_gone_process_identity() {
    let (_dir, e) = setup(Default::default());
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    for tick in [Value::Null, json!(1), json!(0)] {
        fs::write(
            e.state.join("running/stale.json"),
            json!({"pgid":child.id(),"start_time":tick}).to_string(),
        )
        .unwrap();
        runner::sweep(&e.state);
        assert!(child.try_wait().unwrap().is_none());
    }
    runner::kill(child.id());
    child.wait().unwrap();
    fs::write(
        e.state.join("running/gone.json"),
        json!({"pgid":child.id(),"start_time":1}).to_string(),
    )
    .unwrap();
    runner::sweep(&e.state);
    assert_eq!(fs::read_dir(e.state.join("running")).unwrap().count(), 0);
}

#[test]
fn detect_capabilities_reports_skills_only_when_the_import_succeeds() {
    if let Ok(case) = std::env::var("RC5_CAP_CASE") {
        let c = detect_capabilities(false, None);
        let values: Vec<bool> = case.split(',').map(|v| v == "1").collect();
        assert_eq!(
            (c.python3, c.git, c.skills),
            (values[0], values[1], values[2])
        );
        return;
    }
    for (python, git, import) in [
        (false, true, true),
        (true, true, false),
        (true, false, true),
        (true, true, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        for (binary, body) in [
            ("timeout", "shift; exec \"$@\"".to_owned()),
            ("git", "exit 0".into()),
            (
                "python3",
                format!(
                    "[ \"$1\" = -c ] && [ \"$2\" = 'import pydantic' ] || exit 2\nexit {}",
                    if import { 0 } else { 1 }
                ),
            ),
        ] {
            if (binary == "python3" && !python) || (binary == "git" && !git) {
                continue;
            }
            let path = dir.path().join(binary);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "computer::tests::detect_capabilities_reports_skills_only_when_the_import_succeeds",
                "--nocapture",
            ])
            .env("PATH", dir.path())
            .env(
                "RC5_CAP_CASE",
                format!(
                    "{},{},{}",
                    u8::from(python),
                    u8::from(git),
                    u8::from(python && git && import)
                ),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test]
async fn encoders_match_fixtures_from_engine_replies() {
    fn fixture(name: &str) -> Value {
        serde_json::from_slice(
            &fs::read(format!(
                "../computer/testdata/protocol/client_to_server_reply_{name}.json"
            ))
            .unwrap(),
        )
        .unwrap()
    }
    let (_dir, e) = setup(crate::instance::ComputerConfig {
        deny: vec!["forbidden".into()],
        ..Default::default()
    });
    let denied = e
        .dispatch(json!({"op":"exec","id":"req-01HQC","command":"forbidden"}))
        .await;
    assert_eq!(encode_reply("req-01HQC", denied), fixture("error"));
    e.reserve("req-01HQ7").unwrap();
    let cancelled = e
        .dispatch(json!({"op":"cancel","target_id":"req-01HQ7"}))
        .await;
    assert_eq!(
        encode_reply("req-01HQ7-cancel", cancelled),
        fixture("cancel")
    );
    let path = e.policy.work.join("f");
    // The Go fixture has a 17-byte count with the digest of the 11-byte first chunk.
    // Check its exact envelope/count and independently pin the complete-file digest.
    let put = e.dispatch(json!({"op":"file_put","transfer_id":"fixture","path":path,"seq":0,"data_b64":"aGVsbG8gd29ybGQhYWdhaW4=","final":true})).await;
    let reply = encode_reply("req-01HQA", put);
    use sha2::Digest;
    let mut expected = fixture("file_put");
    expected["result"]["sha256"] = json!(hex::encode(sha2::Sha256::digest(b"hello world!again")));
    // The fixture's second chunk is six bytes: !again (17 bytes altogether).
    assert_eq!(reply, expected);
    let mut data = vec![0; files::CHUNK];
    data.extend_from_slice(b"hello world");
    fs::write(&path, data).unwrap();
    let get = e
        .dispatch(json!({"op":"file_get","path":path,"offset":files::CHUNK}))
        .await;
    assert_eq!(encode_reply("req-01HQB", get), fixture("file_get"));
}

#[tokio::test]
async fn a_symlink_swapped_in_mid_transfer_is_refused() {
    let (_dir, e) = setup(Default::default());
    let target = e.policy.work.join("target");
    let path = e.policy.work.join("upload");
    fs::write(&target, "untouched").unwrap();
    e.dispatch(json!({"op":"file_put","transfer_id":"swap","path":path,"seq":0,"data_b64":"YQ==","final":false})).await.unwrap();
    symlink(&target, &path).unwrap();
    assert!(e.dispatch(json!({"op":"file_put","transfer_id":"swap","path":path,"seq":1,"data_b64":"Yg==","final":true})).await.is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
}

#[tokio::test]
async fn frames_beyond_the_handler_cap_are_refused_and_exec_reservations_released() {
    use crate::relay::{self, Timing};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        accept_async,
        tungstenite::{Message, protocol::CloseFrame},
    };
    let (dir, engine) = setup(Default::default());
    let _handlers = engine
        .handlers
        .clone()
        .acquire_many_owned(64)
        .await
        .unwrap();
    let config = Config::new(
        "m".into(),
        "box".into(),
        "http://localhost".into(),
        vec![wire::MachineRole::Computer],
        false,
        crate::instance::RunAs::Current,
    );
    let role = Arc::new(Computer {
        name: "box".into(),
        config,
        state_file: engine.state.join("connection-computer.json"),
        config_dir: dir.path().join("config"),
        agent_home: dir.path().join("agent"),
        workdir: engine.policy.work.clone(),
        engine: OnceLock::from(engine.clone()),
        capabilities: OnceLock::new(),
        worker: OnceLock::new(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::text(
                json!({"id":"cap","op":"exec","command":"touch should-not-run"}).to_string(),
            ))
            .await
            .unwrap();
        let reply: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(reply["id"], "cap");
        assert_eq!(reply["error"]["code"], "queue_full");
        engine.reserve("cap").unwrap();
        assert!(!engine.policy.work.join("should-not-run").exists());
        socket
            .close(Some(CloseFrame {
                code: 4401.into(),
                reason: "done".into(),
            }))
            .await
            .unwrap();
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        relay::run(
            role,
            &url,
            "test",
            CancellationToken::new(),
            Timing::for_role(SocketRole::Computer),
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, 3);
    server.await.unwrap();
}
