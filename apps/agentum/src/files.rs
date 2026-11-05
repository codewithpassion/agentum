//! Work-directory access, directly or through the per-instance agent user's sudo rule.
use crate::runs::{
    api::{Failure, Http, Result},
    helpers::{encode, text},
};
use reqwest::Method;
use std::path::{Path, PathBuf};

pub fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path.split('/').all(|s| !matches!(s, "" | "." | ".."))
}
#[derive(Clone)]
pub struct Disk {
    pub root: PathBuf,
    pub user: Option<String>,
}
impl Disk {
    pub fn new(root: PathBuf, user: Option<String>) -> Self {
        Self { root, user }
    }
    fn under(&self, rel: &str) -> Result<PathBuf> {
        if !rel.is_empty() && !safe_path(rel) {
            return Err(Failure::local("Refused path outside work directory"));
        }
        let path = self.root.join(rel);
        if self.user.is_none() {
            let mut at = Some(path.as_path());
            while let Some(parent) = at.filter(|p| *p != self.root) {
                if std::fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err(Failure::local("Refused symbolic link in work directory"));
                }
                at = parent.parent();
            }
        }
        Ok(path)
    }
    async fn sudo(&self, binary: &str, args: &[String], input: Option<&[u8]>) -> Result<Vec<u8>> {
        crate::privilege::agent::disk_command(self.user.as_deref().unwrap(), binary, args, input)
            .await
    }
    pub async fn mkdir(&self, rel: &str) -> Result<()> {
        let path = self.under(rel)?;
        if self.user.is_some() {
            self.sudo(
                "/bin/mkdir",
                &["-p".into(), path.display().to_string()],
                None,
            )
            .await?;
        } else {
            tokio::fs::create_dir_all(path).await?;
        }
        Ok(())
    }
    pub async fn write(&self, rel: &str, bytes: &[u8]) -> Result<()> {
        let path = self.under(rel)?;
        let parent = Path::new(rel)
            .parent()
            .unwrap_or(Path::new(""))
            .to_str()
            .unwrap();
        self.mkdir(parent).await?;
        if self.user.is_some() {
            self.sudo(
                "/usr/bin/dd",
                &[format!("of={}", path.display()), "status=none".into()],
                Some(bytes),
            )
            .await?;
        } else {
            tokio::fs::write(path, bytes).await?;
        }
        Ok(())
    }
    pub async fn read(&self, rel: &str) -> Result<Vec<u8>> {
        let path = self.under(rel)?;
        if self.user.is_some() {
            self.sudo(
                "/usr/bin/dd",
                &[format!("if={}", path.display()), "status=none".into()],
                None,
            )
            .await
        } else {
            Ok(tokio::fs::read(path).await?)
        }
    }
    pub async fn remove(&self, rel: &str, recursive: bool) -> Result<()> {
        let path = self.under(rel)?;
        if self.user.is_some() {
            self.sudo(
                "/bin/rm",
                &[
                    if recursive { "-rf" } else { "-f" }.into(),
                    "--".into(),
                    path.display().to_string(),
                ],
                None,
            )
            .await?;
        } else if recursive {
            if tokio::fs::symlink_metadata(&path).await.is_ok() {
                tokio::fs::remove_dir_all(path).await?;
            }
        } else {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
    pub async fn stat(&self, rel: &str) -> Result<Option<(String, u64)>> {
        if self.user.is_none()
            && (rel.is_empty() || safe_path(rel))
            && tokio::fs::symlink_metadata(self.root.join(rel))
                .await
                .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Ok(None);
        }
        let path = self.under(rel)?;
        if self.user.is_some() {
            let result = self
                .sudo(
                    "/usr/bin/stat",
                    &[
                        "-c".into(),
                        "%s %f".into(),
                        "--".into(),
                        path.display().to_string(),
                    ],
                    None,
                )
                .await;
            let bytes = match result {
                Ok(b) => b,
                Err(e) if e.status == 404 => return Ok(None),
                Err(e) => return Err(e),
            };
            let answer = String::from_utf8_lossy(&bytes);
            let parts = answer.split_whitespace().collect::<Vec<_>>();
            if parts.len() != 2 {
                return Err(Failure::local("Unexpected stat answer"));
            }
            let size = parts[0]
                .parse()
                .map_err(|_| Failure::local("Invalid stat size"))?;
            let mode = u32::from_str_radix(parts[1], 16)
                .map_err(|_| Failure::local("Invalid stat mode"))?;
            return Ok(match mode >> 12 {
                8 => Some(("file".into(), size)),
                4 => Some(("dir".into(), size)),
                _ => None,
            });
        }
        match tokio::fs::symlink_metadata(path).await {
            Ok(m) if m.is_file() => Ok(Some(("file".into(), m.len()))),
            Ok(m) if m.is_dir() => Ok(Some(("dir".into(), m.len()))),
            Ok(_) => Ok(None),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }
    pub async fn list(&self, rel: &str) -> Result<Vec<(String, String)>> {
        let path = self.under(rel)?;
        let mut entries = vec![];
        if self.user.is_some() {
            let result = self
                .sudo(
                    "/usr/bin/find",
                    &[
                        path.display().to_string(),
                        "-mindepth".into(),
                        "1".into(),
                        "-maxdepth".into(),
                        "1".into(),
                        "-printf".into(),
                        "%y\\t%f\\0".into(),
                    ],
                    None,
                )
                .await;
            let bytes = match result {
                Ok(b) => b,
                Err(e) if e.status == 404 => return Ok(entries),
                Err(e) => return Err(e),
            };
            for entry in String::from_utf8_lossy(&bytes).split('\0') {
                if let Some((kind, name)) = entry.split_once('\t') {
                    match kind {
                        "f" => entries.push(("file".into(), name.into())),
                        "d" => entries.push(("dir".into(), name.into())),
                        _ => {}
                    }
                }
            }
        } else {
            let mut dir = match tokio::fs::read_dir(path).await {
                Ok(d) => d,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
                Err(e) => return Err(e.into()),
            };
            while let Some(entry) = dir.next_entry().await? {
                let kind = entry.file_type().await?;
                if kind.is_file() || kind.is_dir() {
                    entries.push((
                        if kind.is_file() { "file" } else { "dir" }.into(),
                        entry.file_name().to_string_lossy().into(),
                    ));
                }
            }
        }
        entries.sort();
        Ok(entries)
    }
}
pub fn filename(header: &str) -> String {
    let encoded = regex::Regex::new(r"(?i)filename\*\s*=\s*UTF-8''([^;]+)").unwrap();
    let plain = regex::Regex::new(r#"(?i)filename\s*=\s*(?:"([^"]*)"|([^;\s]*))"#).unwrap();
    let decoded = encoded.captures(header).and_then(|c| decode(c[1].trim()));
    let raw = decoded
        .or_else(|| {
            plain
                .captures(header)
                .map(|c| c.get(1).or_else(|| c.get(2)).unwrap().as_str().to_owned())
        })
        .unwrap_or_default();
    let name = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() { '_' } else { c })
        .collect::<String>();
    let name = name.trim_start_matches('.');
    if name.is_empty() {
        "file".into()
    } else {
        name.into()
    }
}
fn decode(value: &str) -> Option<String> {
    let mut out = vec![];
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(value.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
pub async fn download(http: &Http, id: &str) -> Result<(String, Vec<u8>)> {
    let response = http
        .send(http.request(Method::GET, &format!("/files/{}", encode(id))))
        .await?;
    let name = filename(
        response
            .headers()
            .get("content-disposition")
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
    );
    Ok((name, http.bytes(response).await?))
}
pub async fn upload(http: &Http, name: &str, bytes: Vec<u8>) -> Result<String> {
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name.to_owned());
    let response = http
        .json(
            http.request(Method::POST, "/api/files")
                .multipart(reqwest::multipart::Form::new().part("file", part)),
        )
        .await?;
    response["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Failure::local("Upload carries no file id"))
}
pub async fn skills(http: &Http, run: &str, disk: &Disk) -> Result<usize> {
    let base = format!("/api/runs/{}/skills", encode(run));
    let value = http.json(http.request(Method::GET, &base)).await?;
    let files = value["files"]
        .as_array()
        .ok_or_else(|| Failure::local("Invalid skills list"))?;
    if files.len() > 200
        || files
            .iter()
            .map(|f| f["size"].as_u64().unwrap_or(u64::MAX))
            .try_fold(0u64, |a, b| a.checked_add(b))
            .unwrap_or(u64::MAX)
            > 5 * 1024 * 1024
    {
        return Err(Failure::local("Skills exceed size or count limits"));
    }
    for file in files {
        let path = text(&file["path"]);
        if !safe_path(path) || path.split('/').count() < 2 {
            return Err(Failure::local("Refused skill path"));
        }
    }
    let mut downloaded = vec![];
    for file in files {
        let path = text(&file["path"]);
        let response = http
            .send(http.request(Method::GET, &format!("{base}/file?path={}", encode(path))))
            .await?;
        let bytes = http.bytes(response).await?;
        downloaded.push((path, bytes));
    }
    for (path, bytes) in downloaded {
        disk.write(&format!(".claude/skills/{path}"), &bytes)
            .await?;
    }
    Ok(files.len())
}
