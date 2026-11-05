use super::{
    Host,
    api::{Failure, Http, Result, RunApi},
    helpers::{text, workspace_instructions},
};
use crate::{
    approvals::Gate,
    claude::{self, Driver},
    files::{self, Disk},
    library::{self, LibraryApi, Sync},
};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub fn valid_claim(c: &Value) -> bool {
    ["id", "agentId", "workspaceId", "inputText"]
        .iter()
        .all(|key| c["run"][key].is_string())
        && ["id", "model", "slug"]
            .iter()
            .all(|key| c["agent"][key].is_string())
        && c["agent"]["runtimeConfig"].is_object()
        && c["runToken"].is_string()
        && c["instructions"].is_string()
        && c["mcpServers"].is_object()
        && c["inputFileIds"].is_array()
}
fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
async fn flush(api: &RunApi, pending: &mut VecDeque<Value>, cancel: &CancellationToken) {
    while !pending.is_empty() {
        let count = pending.len().min(100);
        let batch = pending.iter().take(count).cloned().collect::<Vec<_>>();
        match api.call("events", Some(&json!({"events":batch}))).await {
            Ok(_) => {
                pending.drain(..count);
            }
            Err(error) => {
                if error.status == 409 {
                    cancel.cancel();
                }
                if (400..500).contains(&error.status) && !matches!(error.status, 408 | 429) {
                    pending.drain(..count);
                }
                tracing::warn!(status = error.status, "Could not post run events");
                break;
            }
        }
    }
}
pub async fn execute(
    host: &Host,
    claim: &Value,
    api: RunApi,
    cancel: CancellationToken,
    mut changes: mpsc::UnboundedReceiver<Vec<String>>,
) {
    let run = text(&claim["run"]["id"]);
    let beat_stop = CancellationToken::new();
    let beat_done = beat_stop.clone();
    let beat_api = api.clone();
    let beat_cancel = cancel.clone();
    let beat = tokio::spawn(async move {
        let mut timer = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(20),
            Duration::from_secs(20),
        );
        loop {
            tokio::select! {_ = beat_done.cancelled()=>break,_ = timer.tick()=>{if let Err(e)=beat_api.call("heartbeat",None).await && e.status==409{beat_cancel.cancel();}}}
        }
    });
    let http = Http::new(
        &host.config.server,
        text(&claim["runToken"]),
        api.http.masker.clone(),
        cancel.clone(),
        120,
    );
    let (events, mut receiver) = mpsc::channel::<Value>(256);
    let event_api = api.clone();
    let event_cancel = cancel.clone();
    let batcher = tokio::spawn(async move {
        let mut pending = VecDeque::new();
        let mut seq = 1;
        let mut timer = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_millis(500),
            Duration::from_millis(500),
        );
        loop {
            tokio::select! {
                item=receiver.recv()=>match item{Some(mut event)=>{event["seq"]=json!(seq);seq+=1;pending.push_back(event);},None=>{flush(&event_api,&mut pending,&event_cancel).await;break}},
                _ = timer.tick()=>flush(&event_api,&mut pending,&event_cancel).await
            }
        }
    });
    let mut sync = None;
    let mut live = false;
    let mut watcher = None;
    let work = async {
        let workspace = text(&claim["run"]["workspaceId"]);
        let agent = text(&claim["run"]["agentId"]);
        if !id_ok(workspace) || !id_ok(agent) {
            return Err(Failure::local("Refused workspace or agent id"));
        }
        let disk = Disk::new(
            host.root.join(workspace).join(agent).join("work"),
            host.user.clone(),
        );
        disk.mkdir("").await?;
        for path in [".claude", "inbox", "tmp"] {
            disk.remove(path, true).await?;
            disk.mkdir(path).await?;
        }
        disk.remove(".mcp.json", false).await?;
        if let Err(e) = files::skills(&http, run, &disk).await {
            tracing::warn!(status = e.status, "Skills did not sync; run continues");
        }
        let (watch_send, mut watch_receive) = mpsc::unbounded_channel();
        if claim["library"].is_object() {
            let mut library = Sync::new(
                LibraryApi::new(http.clone(), run),
                disk.clone(),
                library::roots(&claim["library"]),
                run.into(),
            )
            .await;
            match library.sync_in(None).await {
                Ok(_) => {
                    if host.user.is_none() {
                        use notify::Watcher;
                        disk.mkdir("library").await?;
                        if let Ok(mut watch) = notify::recommended_watcher(
                            move |event: notify::Result<notify::Event>| {
                                if event
                                    .is_ok_and(|e| !matches!(e.kind, notify::EventKind::Access(_)))
                                {
                                    let _ = watch_send.send(());
                                }
                            },
                        ) && watch
                            .watch(&disk.root.join("library"), notify::RecursiveMode::Recursive)
                            .is_ok()
                        {
                            watcher = Some(watch);
                            live = true;
                        }
                    }
                    sync = Some(library);
                }
                Err(e) => tracing::warn!(status = e.status, "Library did not sync; run continues"),
            }
        }
        let ids = claim["inputFileIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| text(id).to_owned())
            .collect::<Vec<_>>();
        let paths = super::files::input_files(&http, &disk, &ids).await?;
        let message = super::files::message_with_files(text(&claim["run"]["inputText"]), &paths);
        let prompt = format!(
            "{}\n\n{}",
            text(&claim["instructions"]),
            workspace_instructions(
                &disk.root.display().to_string(),
                if sync.is_some() {
                    Some(&claim["library"])
                } else {
                    None
                },
                live,
                text(&claim["agent"]["slug"]),
                run
            )
        );
        let gate = if claim.get("toolRules").is_some() || claim["currentApprovals"] == true {
            Some(Arc::new(Gate::new(api.clone(), claim)))
        } else {
            None
        };
        if cancel.is_cancelled() {
            return Ok(json!({"status":"aborted"}));
        }
        let driver = claude::drive(Driver {
            binary: host.config.claude_binary.as_deref().unwrap_or("claude"),
            disk: &disk,
            claim,
            machine: &host.config.machine_id,
            prompt,
            message,
            gate,
            cancel: cancel.clone(),
            events: events.clone(),
        });
        tokio::pin!(driver);
        let mut checkpoint = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(300),
            Duration::from_secs(300),
        );
        let mut dirty = false;
        let mut first_edit = None;
        let mut quiet = tokio::time::Instant::now() + Duration::from_secs(86400);
        loop {
            tokio::select! {
                body=&mut driver=>break body,
                paths=changes.recv()=>{if let Some(paths)=paths && let Some(sync)=&mut sync && !cancel.is_cancelled() && sync.sync_in(Some(&paths)).await.is_err(){tracing::warn!("Library pull failed");}},
                _ = watch_receive.recv(), if live=>{dirty=true;let now=tokio::time::Instant::now();let first=*first_edit.get_or_insert(now);quiet=(now+Duration::from_millis(750)).min(first+Duration::from_secs(5));},
                _ = tokio::time::sleep_until(quiet), if dirty=>{dirty=false;first_edit=None;if !cancel.is_cancelled() && let Some(sync)=&mut sync && sync.sync_out().await.is_err(){tracing::warn!("Live library push failed");}},
                _ = checkpoint.tick()=>{if !cancel.is_cancelled() && let Some(sync)=&mut sync && sync.sync_out().await.is_err(){tracing::warn!("Library checkpoint failed");}}
            }
        }
    };
    let body: Result<Value> = work.await;
    // drive owns the process and must reap it before releasing the slot. Cancellation is
    // handled inside drive; preparation is cancelled by its HTTP token.
    drop(watcher);
    drop(events);
    let _ = batcher.await;
    if !cancel.is_cancelled()
        && let Some(sync) = &mut sync
        && sync.sync_out().await.is_err()
    {
        tracing::warn!("Final library sync failed");
    }
    let body = if cancel.is_cancelled() {
        json!({"status":"aborted"})
    } else {
        body.unwrap_or_else(|e| json!({"status":"failed","error":api.http.masker.mask(&e.message)}))
    };
    beat_stop.cancel();
    let _ = beat.await;
    if let Err(e) = api.call("complete", Some(&body)).await {
        tracing::warn!(status = e.status, "Could not complete run");
    }
}
