//! The user's project picker, shared by the window and the phone server (merged from their two copies). This host-only operation is never an engine/model filesystem tool.
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct Directory {
    path: String,
    parent: Option<String>,
    folders: Vec<String>,
}

pub fn resolve(path: &str, base: &Path) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Choose a folder.".into());
    }
    let dir = base.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err("Choose a folder, not a file.".into());
    }
    Ok(dir)
}

pub fn list(path: &str, base: &Path) -> Result<Directory, String> {
    let dir = resolve(path, base)?;
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                folders.push(name.to_string());
            }
        }
    }
    folders.sort();
    Ok(Directory {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        folders,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_browses_directories_without_changing_the_process_cwd() {
        let cwd = std::env::current_dir().unwrap();
        let dir = std::env::temp_dir().join(format!("prism-project-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("project with spaces")).unwrap();
        std::fs::write(dir.join("file"), "text").unwrap();
        assert!(resolve("", &dir).is_err());
        assert!(resolve("missing", &dir).is_err());
        assert!(resolve("file", &dir).is_err());
        assert_eq!(
            resolve("project with spaces/..", &dir).unwrap(),
            dir.canonicalize().unwrap()
        );
        let listed = list(".", &dir).unwrap();
        assert_eq!(listed.folders, ["project with spaces"]);
        assert_eq!(std::env::current_dir().unwrap(), cwd);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
