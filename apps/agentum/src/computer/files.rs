//! Bounded, atomic transfers. Uploads belong to a socket; commands do not.
use super::{Fault, OpResult, policy::Policy};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::NamedTempFile;
use tokio::{sync::Notify, time::Instant};
pub const CHUNK: usize = 256 * 1024;
#[derive(Default)]
pub struct Transfers {
    open: Mutex<HashMap<String, Arc<Upload>>>,
}
struct Upload {
    state: Mutex<UploadState>,
    changed: Notify,
}
#[derive(Default)]
struct UploadState {
    file: Option<NamedTempFile>,
    dest: std::path::PathBuf,
    next: i64,
    size: u64,
    waiting: usize,
    closed: bool,
}
#[derive(Deserialize)]
struct Put {
    transfer_id: String,
    path: String,
    seq: i64,
    data_b64: String,
    #[serde(rename = "final")]
    final_chunk: bool,
    sha256: Option<String>,
}
impl Transfers {
    pub fn abandon(&self) {
        for (_, u) in self.open.lock().unwrap().drain() {
            let mut s = u.state.lock().unwrap();
            s.closed = true;
            s.file = None;
            u.changed.notify_waiters();
        }
    }
    pub async fn put(&self, frame: Value, policy: &Policy) -> OpResult<Value> {
        let request: Put = serde_json::from_value(frame).map_err(Fault::decode)?;
        if request.transfer_id.is_empty()
            || request.seq < 0
            || request.data_b64.len() > CHUNK.div_ceil(3) * 4
        {
            return Err(Fault::new(
                "bad_request",
                "invalid transfer id, sequence or chunk size",
            ));
        }
        let data = STANDARD.decode(&request.data_b64).map_err(Fault::decode)?;
        if data.len() > CHUNK {
            return Err(Fault::new("bad_request", "chunk exceeds 256 KiB"));
        }
        let upload = {
            let mut open = self.open.lock().unwrap();
            if let Some(u) = open.get(&request.transfer_id) {
                u.clone()
            } else {
                if request.seq >= 32 {
                    return Err(Fault::new(
                        "bad_request",
                        "transfer opens outside the chunk window",
                    ));
                }
                if open.len() >= 8 {
                    return Err(Fault::new("queue_full", "too many open uploads"));
                }
                let u = Arc::new(Upload {
                    state: Mutex::new(UploadState::default()),
                    changed: Notify::new(),
                });
                open.insert(request.transfer_id.clone(), u.clone());
                u
            }
        };
        let result = self.write(&upload, &request, &data, policy).await;
        if result.is_err() || request.final_chunk {
            self.open.lock().unwrap().remove(&request.transfer_id);
            let mut s = upload.state.lock().unwrap();
            s.closed = true;
            s.file = None;
            upload.changed.notify_waiters();
        }
        result
    }
    async fn write(&self, u: &Upload, r: &Put, data: &[u8], p: &Policy) -> OpResult<Value> {
        let deadline = Instant::now() + Duration::from_secs(60);
        {
            let mut s = u.state.lock().unwrap();
            if s.waiting >= 32 {
                return Err(Fault::new("bad_request", "upload window is full"));
            }
            s.waiting += 1;
        }
        loop {
            let changed = u.changed.notified();
            {
                let mut s = u.state.lock().unwrap();
                if s.closed {
                    return Err(Fault::new("bad_request", "upload abandoned"));
                }
                if r.seq <= s.next {
                    s.waiting -= 1;
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(Fault::new("bad_request", "predecessor chunk never arrived"));
                }
            }
            // A short bounded retry also covers a notification between checking and polling.
            let _ = tokio::time::timeout(Duration::from_millis(50), changed).await;
        }
        let mut s = u.state.lock().unwrap();
        if r.seq < s.next {
            return Ok(json!({"bytes_written":data.len(),"sha256":null}));
        }
        if s.file.is_none() {
            let dest = p.path(std::path::Path::new(&r.path), true)?;
            destination(&dest)?;
            super::ensure_directory(dest.parent().unwrap())?;
            s.file = Some(NamedTempFile::new_in(dest.parent().unwrap())?);
            s.dest = dest;
        }
        if s.size + data.len() as u64 > p.config.max_file_bytes.max(1) {
            return Err(Fault::new("too_large", "upload exceeds the file limit"));
        }
        s.file.as_mut().unwrap().write_all(data)?;
        s.size += data.len() as u64;
        s.next += 1;
        u.changed.notify_waiters();
        if !r.final_chunk {
            return Ok(json!({"bytes_written":data.len(),"sha256":null}));
        }
        let mut file = s.file.take().unwrap();
        file.as_file_mut().sync_all()?;
        let digest = digest(file.path())?;
        if r.sha256
            .as_ref()
            .is_some_and(|expected| expected != &digest)
        {
            return Err(Fault::new("bad_request", "whole-file digest mismatch"));
        }
        if p.path(std::path::Path::new(&r.path), true)? != s.dest {
            return Err(Fault::new("denied", "upload destination changed"));
        }
        destination(&s.dest)?;
        if let Ok(existing) = fs::metadata(&s.dest) {
            file.as_file().set_permissions(fs::Permissions::from_mode(
                existing.permissions().mode() & 0o777,
            ))?;
        }
        file.persist(&s.dest)
            .map_err(|e| Fault::new("op_failed", e.error.to_string()))?;
        Ok(json!({"bytes_written":s.size,"sha256":digest}))
    }
}
fn destination(path: &std::path::Path) -> OpResult<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => Err(Fault::new(
            "is_a_directory",
            "upload destination is a directory",
        )),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => Err(Fault::new(
            "not_a_regular_file",
            "upload destination is not a regular file",
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn regular(path: &std::path::Path) -> OpResult<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOFOLLOW)
        .open(path)?;
    let m = file.metadata()?;
    if m.is_dir() {
        return Err(Fault::new("is_a_directory", "path is a directory"));
    }
    if !m.is_file() {
        return Err(Fault::new(
            "not_a_regular_file",
            "path is not a regular file",
        ));
    }
    Ok(file)
}
fn digest(path: &std::path::Path) -> OpResult<String> {
    let mut file = regular(path)?;
    let mut hash = Sha256::new();
    let mut data = [0; 65536];
    loop {
        let n = file.read(&mut data)?;
        if n == 0 {
            break;
        }
        hash.update(&data[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
pub fn get(frame: Value, policy: &Policy) -> OpResult<Value> {
    #[derive(Deserialize)]
    struct Get {
        path: String,
        #[serde(default)]
        offset: i64,
        #[serde(default)]
        max_bytes: i64,
    }
    let r: Get = serde_json::from_value(frame).map_err(Fault::decode)?;
    if r.offset < 0 {
        return Err(Fault::new("bad_request", "negative offset"));
    }
    let path = policy.path(std::path::Path::new(&r.path), false)?;
    let mut file = regular(&path)?;
    let size = file.metadata()?.len();
    if size > policy.config.max_file_bytes {
        return Err(Fault::new("too_large", "file exceeds local size limit"));
    }
    file.seek(SeekFrom::Start(r.offset as u64))?;
    let count = if r.max_bytes <= 0 {
        CHUNK
    } else {
        (r.max_bytes as usize).min(CHUNK)
    };
    let mut data = Vec::with_capacity(count);
    file.take(count as u64).read_to_end(&mut data)?;
    Ok(
        json!({"data_b64":STANDARD.encode(&data),"eof":r.offset as u64+data.len() as u64>=size,"size":size,"sha256":if r.offset==0 {Some(digest(&path)?)}else{None}}),
    )
}
