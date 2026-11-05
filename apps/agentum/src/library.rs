//! Library compare-and-swap sync. The manifest lives beside the copy and survives runs.
use crate::{
    files::{Disk, safe_path},
    runs::{
        api::{Failure, Http, Result},
        helpers::{encode, text},
    },
};
use async_trait::async_trait;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub etag: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub path: String,
    pub etag: String,
    pub sha256: String,
}
#[async_trait]
pub trait Remote: Send + std::marker::Sync {
    async fn stat(&self, path: &str) -> Result<Option<Entry>>;
    async fn list(&self, path: &str) -> Result<Vec<Entry>>;
    async fn read(&self, path: &str) -> Result<Option<(Vec<u8>, String)>>;
    async fn write(&self, path: &str, bytes: Vec<u8>, etag: Option<&str>)
    -> Result<Option<String>>;
    async fn remove(&self, path: &str) -> Result<()>;
    async fn conflict(&self, path: &str, copy: &str) -> Result<()>;
}
#[derive(Clone)]
pub struct LibraryApi {
    pub http: Http,
    pub base: String,
}
impl LibraryApi {
    pub fn new(http: Http, run: &str) -> Self {
        Self {
            http,
            base: format!("/api/runs/{}/library", encode(run)),
        }
    }
    fn route(&self, kind: &str, path: &str) -> String {
        format!("{}/{}?path={}", self.base, kind, encode(path))
    }
}
#[async_trait]
impl Remote for LibraryApi {
    async fn stat(&self, path: &str) -> Result<Option<Entry>> {
        match self
            .http
            .json(self.http.request(Method::GET, &self.route("stat", path)))
            .await
        {
            Err(e) if e.status == 404 => Ok(None),
            Err(e) => Err(e),
            Ok(v) if v["entry"].is_null() => Ok(None),
            Ok(v) => serde_json::from_value(v["entry"].clone())
                .map(Some)
                .map_err(|_| Failure::local("Invalid library entry")),
        }
    }
    async fn list(&self, path: &str) -> Result<Vec<Entry>> {
        match self
            .http
            .json(self.http.request(Method::GET, &self.route("list", path)))
            .await
        {
            Err(e) if e.status == 404 => Ok(vec![]),
            Err(e) => Err(e),
            Ok(v) => serde_json::from_value(v["entries"].clone())
                .map_err(|_| Failure::local("Invalid library list")),
        }
    }
    async fn read(&self, path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let response = match self
            .http
            .send(self.http.request(Method::GET, &self.route("file", path)))
            .await
        {
            Err(e) if matches!(e.status, 400 | 404) => return Ok(None),
            other => other?,
        };
        let etag = response
            .headers()
            .get("X-Library-Etag")
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| Failure::local("Library file has no etag"))?
            .to_owned();
        let bytes = self.http.bytes(response).await?;
        Ok(Some((bytes, etag)))
    }
    async fn write(
        &self,
        path: &str,
        bytes: Vec<u8>,
        etag: Option<&str>,
    ) -> Result<Option<String>> {
        let mut request = self
            .http
            .request(Method::PUT, &self.route("file", path))
            .header("content-type", "application/octet-stream")
            .body(bytes);
        if let Some(etag) = etag {
            request = request.header("X-Library-If-Etag", etag);
        }
        match self.http.json(request).await {
            Err(e) if e.status == 409 => Ok(None),
            Err(e) => Err(e),
            Ok(v) => v["etag"]
                .as_str()
                .map(|s| Some(s.to_owned()))
                .ok_or_else(|| Failure::local("Library write has no etag")),
        }
    }
    async fn remove(&self, path: &str) -> Result<()> {
        match self
            .http
            .send(self.http.request(Method::DELETE, &self.route("file", path)))
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if e.status == 404 => Ok(()),
            Err(e) => Err(e),
        }
    }
    async fn conflict(&self, path: &str, copy: &str) -> Result<()> {
        self.http
            .send(
                self.http
                    .request(Method::POST, &format!("{}/conflicts", self.base))
                    .json(&json!({"path":path,"conflictPath":copy})),
            )
            .await?;
        Ok(())
    }
}
pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn mode<'a>(path: &str, roots: &'a Value) -> Option<&'a str> {
    let mut selected = None;
    let mut length = 0;
    for root in roots.as_array().into_iter().flatten() {
        let p = text(&root["path"]).trim_matches('/');
        if !p.is_empty()
            && (path == p || path.starts_with(&format!("{p}/")))
            && (p.len() > length || p.len() == length && root["mode"] == "read")
        {
            length = p.len();
            selected = root["mode"].as_str();
        }
    }
    selected
}
pub fn roots(library: &Value) -> Value {
    library["roots"]
        .as_array()
        .filter(|r| !r.is_empty())
        .map(|_| library["roots"].clone())
        .unwrap_or_else(|| {
            json!(
                library["paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| json!({"path":p,"mode":"write"}))
                    .collect::<Vec<_>>()
            )
        })
}
pub struct Sync<R: Remote> {
    pub remote: R,
    pub disk: Disk,
    pub roots: Value,
    pub run: String,
    manifest: BTreeMap<String, Manifest>,
}
impl<R: Remote> Sync<R> {
    pub async fn new(remote: R, disk: Disk, roots: Value, run: String) -> Self {
        let entries: Vec<Manifest> = disk
            .read("library.manifest.json")
            .await
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            remote,
            disk,
            roots,
            run,
            manifest: entries
                .into_iter()
                .filter(|e| safe_path(&e.path))
                .map(|e| (e.path.clone(), e))
                .collect(),
        }
    }
    async fn save(&self) -> Result<()> {
        self.disk
            .write(
                "library.manifest.json",
                &serde_json::to_vec(&self.manifest.values().collect::<Vec<_>>()).unwrap(),
            )
            .await
    }
    fn local(&self, path: &str) -> String {
        format!("library/{path}")
    }
    fn starts(&self, only: Option<&[String]>) -> Vec<String> {
        let mut roots = only
            .map(|p| {
                p.iter()
                    .map(|p| p.trim_matches('/').to_owned())
                    .filter(|p| mode(p, &self.roots).is_some())
                    .collect()
            })
            .unwrap_or_else(|| {
                self.roots
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| text(&r["path"]).trim_matches('/').into())
                    .collect::<Vec<String>>()
            });
        roots.sort();
        roots.dedup();
        let all = roots.clone();
        roots.retain(|p| {
            safe_path(p)
                && !all
                    .iter()
                    .any(|other| p != other && p.starts_with(&format!("{other}/")))
        });
        roots
    }
    async fn remote_files(&self, only: Option<&[String]>) -> Result<Vec<Entry>> {
        let mut pending = self.starts(only);
        let mut seen = BTreeSet::new();
        let mut files = vec![];
        while let Some(path) = pending.pop() {
            if !seen.insert(path.clone()) {
                continue;
            }
            if let Some(entry) = self.remote.stat(&path).await? {
                if entry.kind == "file" {
                    files.push(entry)
                } else if entry.kind == "dir" {
                    for child in self.remote.list(&path).await? {
                        if safe_path(&child.path)
                            && child.path.starts_with(&format!("{path}/"))
                            && !child.path[path.len() + 1..].contains('/')
                        {
                            pending.push(child.path);
                        }
                    }
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }
    async fn local_files(&self) -> Result<Vec<(String, u64)>> {
        let mut pending = self.starts(None);
        let mut files = vec![];
        let mut seen = BTreeSet::new();
        while let Some(path) = pending.pop() {
            if !seen.insert(path.clone()) {
                continue;
            }
            if let Some((kind, size)) = self.disk.stat(&self.local(&path)).await? {
                if kind == "file" {
                    files.push((path, size));
                } else {
                    for (_, name) in self.disk.list(&self.local(&path)).await? {
                        let child = format!("{path}/{name}");
                        if safe_path(&child) {
                            pending.push(child);
                        }
                    }
                }
            }
        }
        files.sort();
        Ok(files)
    }
    async fn keep(&mut self, path: &str, etag: String, sha256: String) -> Result<()> {
        self.manifest.insert(
            path.into(),
            Manifest {
                path: path.into(),
                etag,
                sha256,
            },
        );
        self.save().await
    }
    async fn pull_file(&mut self, file: &Entry, result: &mut Value) -> Result<()> {
        let path = &file.path;
        let local = self.local(path);
        if file.size > MAX_FILE_BYTES {
            push(result, "skipped", path);
            return Ok(());
        }
        let saved = self.manifest.get(path).cloned();
        let stat = self.disk.stat(&local).await?;
        if stat.as_ref().is_some_and(|(kind, _)| kind == "dir") {
            return Err(Failure::local("A folder is in the way"));
        }
        let read_mode = mode(path, &self.roots) == Some("read");
        if !read_mode
            && saved
                .as_ref()
                .is_some_and(|e| Some(&e.etag) == file.etag.as_ref())
        {
            return Ok(());
        }
        let before = if stat.is_some() {
            Some(hash(&self.disk.read(&local).await?))
        } else {
            None
        };
        if read_mode
            && saved.as_ref().is_some_and(|s| {
                Some(&s.etag) == file.etag.as_ref() && Some(&s.sha256) == before.as_ref()
            })
        {
            return Ok(());
        }
        if !read_mode {
            if let Some(saved) = &saved {
                if before.as_ref() != Some(&saved.sha256) {
                    push(result, "kept", path);
                    return Ok(());
                }
            } else if let Some(before) = &before {
                if let Some((bytes, etag)) = self.remote.read(path).await?
                    && hash(&bytes) == *before
                {
                    self.keep(path, etag, before.clone()).await?;
                } else {
                    push(result, "kept", path);
                }
                return Ok(());
            }
        }
        if let Some((bytes, etag)) = self.remote.read(path).await? {
            if bytes.len() as u64 > MAX_FILE_BYTES {
                push(result, "skipped", path);
                return Ok(());
            }
            if !read_mode
                && let Some(before) = before
                && hash(&self.disk.read(&local).await?) != before
            {
                push(result, "kept", path);
                return Ok(());
            }
            self.disk.write(&local, &bytes).await?;
            self.keep(path, etag, hash(&bytes)).await?;
            push(result, "pulled", path);
        }
        Ok(())
    }
    pub async fn sync_in(&mut self, only: Option<&[String]>) -> Result<Value> {
        let mut result =
            json!({"conflicts":[],"failed":[],"kept":[],"pulled":[],"removed":[],"skipped":[]});
        let files = self.remote_files(only).await?;
        let remote_paths = files
            .iter()
            .map(|f| f.path.clone())
            .collect::<BTreeSet<_>>();
        for file in &files {
            if file
                .path
                .rsplit('/')
                .next()
                .unwrap_or("")
                .contains(".conflict-")
            {
                push(&mut result, "conflicts", &file.path);
            }
            if let Err(e) = self.pull_file(file, &mut result).await {
                failed(&mut result, &file.path, &e);
            }
        }
        let roots = self.starts(only);
        let gone = self
            .manifest
            .values()
            .filter(|e| {
                roots
                    .iter()
                    .any(|r| e.path == *r || e.path.starts_with(&format!("{r}/")))
                    && !remote_paths.contains(&e.path)
            })
            .cloned()
            .collect::<Vec<_>>();
        for entry in gone {
            let work = async {
                let local = self.local(&entry.path);
                if let Some((kind, _)) = self.disk.stat(&local).await? {
                    if kind == "dir" {
                        return Err(Failure::local("A folder is in the way"));
                    }
                    if mode(&entry.path, &self.roots) == Some("read")
                        || hash(&self.disk.read(&local).await?) == entry.sha256
                    {
                        self.disk.remove(&local, false).await?;
                        push(&mut result, "removed", &entry.path);
                    } else {
                        push(&mut result, "kept", &entry.path);
                    }
                }
                self.manifest.remove(&entry.path);
                Ok(())
            }
            .await;
            if let Err(e) = work {
                failed(&mut result, &entry.path, &e);
            }
        }
        self.save().await?;
        sort_result(&mut result);
        Ok(result)
    }
    async fn conflict_file(
        &mut self,
        path: &str,
        bytes: Vec<u8>,
        sha: String,
        result: &mut Value,
        paths: &mut BTreeSet<String>,
    ) -> Result<()> {
        let current = self.remote.read(path).await?;
        if let Some((current, etag)) = &current
            && hash(current) == sha
        {
            return self.keep(path, etag.clone(), sha).await;
        }
        let copy = format!("{path}.conflict-{}", self.run);
        let etag = self
            .remote
            .write(&copy, bytes.clone(), None)
            .await?
            .ok_or_else(|| Failure::local("Conflict write has no etag"))?;
        result["conflicts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"path":path,"conflictPath":copy}));
        paths.insert(copy.clone());
        self.disk.write(&self.local(&copy), &bytes).await?;
        self.manifest.insert(
            copy.clone(),
            Manifest {
                path: copy.clone(),
                etag,
                sha256: sha.clone(),
            },
        );
        if let Some((bytes, etag)) = current {
            if hash(&self.disk.read(&self.local(path)).await?) == sha {
                self.disk.write(&self.local(path), &bytes).await?;
                self.keep(path, etag, hash(&bytes)).await?;
            }
        } else {
            self.manifest.remove(path);
        }
        self.save().await?;
        if self.remote.conflict(path, &copy).await.is_err() {
            tracing::warn!("Could not record library conflict");
        }
        Ok(())
    }
    async fn push_file(
        &mut self,
        path: &str,
        size: u64,
        result: &mut Value,
        paths: &mut BTreeSet<String>,
    ) -> Result<()> {
        let saved = self.manifest.get(path).cloned();
        if mode(path, &self.roots) == Some("read") {
            if saved.as_ref().map(|s| s.sha256.clone())
                != Some(hash(&self.disk.read(&self.local(path)).await?))
            {
                push(result, "refused", path);
            }
            return Ok(());
        }
        if size > MAX_FILE_BYTES {
            push(result, "skipped", path);
            return Ok(());
        }
        let bytes = self.disk.read(&self.local(path)).await?;
        let sha = hash(&bytes);
        if saved.as_ref().is_some_and(|s| s.sha256 == sha) {
            return Ok(());
        }
        if saved.is_none() && self.remote.stat(path).await?.is_some() {
            return self.conflict_file(path, bytes, sha, result, paths).await;
        }
        if let Some(etag) = self
            .remote
            .write(path, bytes.clone(), saved.as_ref().map(|s| s.etag.as_str()))
            .await?
        {
            self.keep(path, etag, sha).await?;
            push(result, "written", path);
        } else {
            self.conflict_file(path, bytes, sha, result, paths).await?;
        }
        Ok(())
    }
    pub async fn sync_out(&mut self) -> Result<Value> {
        let mut result = json!({"conflicts":[],"deleted":[],"deleteSkipped":[],"failed":[],"refused":[],"skipped":[],"written":[]});
        let files = self.local_files().await?;
        let mut paths = files
            .iter()
            .map(|(p, _)| p.clone())
            .collect::<BTreeSet<_>>();
        for (path, size) in files {
            if let Err(e) = self.push_file(&path, size, &mut result, &mut paths).await {
                failed(&mut result, &path, &e);
            }
        }
        let gone = self
            .manifest
            .values()
            .filter(|e| mode(&e.path, &self.roots).is_some() && !paths.contains(&e.path))
            .cloned()
            .collect::<Vec<_>>();
        for entry in gone {
            if mode(&entry.path, &self.roots) == Some("read") {
                push(&mut result, "refused", &entry.path);
                continue;
            }
            let work = async {
                if let Some(existing) = self.remote.stat(&entry.path).await? {
                    if existing.kind == "file" && existing.etag.as_deref() == Some(&entry.etag) {
                        self.remote.remove(&entry.path).await?;
                        push(&mut result, "deleted", &entry.path);
                    } else {
                        push(&mut result, "deleteSkipped", &entry.path);
                    }
                }
                self.manifest.remove(&entry.path);
                self.save().await
            }
            .await;
            if let Err(e) = work {
                failed(&mut result, &entry.path, &e);
            }
        }
        self.save().await?;
        sort_result(&mut result);
        Ok(result)
    }
}
fn push(result: &mut Value, key: &str, path: &str) {
    result[key].as_array_mut().unwrap().push(json!(path));
}
fn failed(result: &mut Value, path: &str, error: &Failure) {
    result["failed"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":path,"message":error.message}));
}
fn sort_result(result: &mut Value) {
    for (_, values) in result.as_object_mut().unwrap() {
        values.as_array_mut().unwrap().sort_by_key(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| text(&v["path"]).into())
        });
    }
}
