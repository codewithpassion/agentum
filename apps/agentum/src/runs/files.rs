//! Stage all input downloads before writing the inbox, as the daemon does.
use super::{
    api::{Failure, Http, Result},
    helpers::encode,
};
use crate::files::{self, Disk};
use std::collections::HashSet;

pub async fn input_files(http: &Http, disk: &Disk, ids: &[String]) -> Result<Vec<String>> {
    let fetched = futures_util::future::try_join_all(ids.iter().map(|id| async move {
        files::download(http, id)
            .await
            .map(|(name, bytes)| (id, name, bytes))
            .map_err(|error| Failure {
                status: error.status,
                message: http
                    .masker
                    .mask(&format!("Input file {id} could not be fetched: {error}")),
            })
    }))
    .await?;
    let mut names = HashSet::new();
    let mut paths = vec![];
    for (id, mut name, bytes) in fetched {
        if names.contains(&name) {
            name = format!("{}-{name}", encode(id));
        }
        names.insert(name.clone());
        let path = format!("inbox/{name}");
        disk.write(&path, &bytes).await?;
        paths.push(path);
    }
    Ok(paths)
}
pub fn message_with_files(text: &str, paths: &[String]) -> String {
    if paths.is_empty() {
        text.into()
    } else {
        format!(
            "{text}\n\nFiles attached to this message, saved in your working directory:\n{}",
            paths
                .iter()
                .map(|p| format!("- {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}
