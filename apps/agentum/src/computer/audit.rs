use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
pub struct Log {
    path: PathBuf,
    max: u64,
    keep: i32,
}
impl Log {
    pub fn new(state: &Path, max: u64, keep: i32) -> std::io::Result<Self> {
        fs::create_dir_all(state)?;
        let log = Self {
            path: state.join("audit.jsonl"),
            max: if max == 0 { 8 << 20 } else { max },
            keep: if keep == 0 { 3 } else { keep.max(0) },
        };
        log.open()?;
        Ok(log)
    }
    fn open(&self) -> std::io::Result<std::fs::File> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    pub fn record(&mut self, mut entry: Value) -> std::io::Result<()> {
        entry["time"] = json!(chrono::Utc::now().to_rfc3339());
        if let Some(command) = entry["command"].as_str().filter(|s| s.len() > 4096) {
            let mut end = 4096;
            while !command.is_char_boundary(end) {
                end -= 1;
            }
            entry["command"] = json!(format!("{}…", &command[..end]));
        }
        let line = format!("{entry}\n");
        if fs::metadata(&self.path)?.len() + line.len() as u64 > self.max {
            let rotated = |i| self.path.with_file_name(format!("audit.jsonl.{i}"));
            if self.keep > 0 {
                let _ = fs::remove_file(rotated(self.keep));
                for i in (1..self.keep).rev() {
                    let _ = fs::rename(rotated(i), rotated(i + 1));
                }
                fs::rename(&self.path, rotated(1))?;
            } else {
                fs::remove_file(&self.path)?;
            }
        }
        self.open()?.write_all(line.as_bytes())
    }
}
