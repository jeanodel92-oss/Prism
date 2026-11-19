//! Files from the phone. The phone sends a
//! file in pieces; the PC keeps it in a private folder of its own, and the file may then be attached to a message once.
//!
//! This is the phone's picker: as the window's picker lets only the files the user chose be attached (`attach.rs`), only
//! a file this connection uploaded can be attached, once, and the engine still decides what the file becomes
//! (`attach_files`: an image, a text, or a copy in the session's private /tmp). Nothing here trusts the phone: names,
//! sizes and counts are bounded, and a path is only ever one this module made.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::base64;
use crate::files::{safe_name, MAX_FILE};

/// The most bytes one `upload_chunk` carries: its base64 (a third more) stays well under the line limit.
pub const MAX_CHUNK: usize = 4 * 1024 * 1024;
/// Uploads under way at once, and files waiting to be attached, per connection.
const MAX_OPEN: usize = 8;
/// Bytes a connection keeps staged (under way, waiting, or used less than `KEEP_USED` ago).
const MAX_STAGED: u64 = 512 * 1024 * 1024;
/// How long a file the engine already copied stays, in case the copy had not finished.
const KEEP_USED: Duration = Duration::from_secs(60);
/// The most files one `attach_picked` carries.
pub const MAX_ATTACH: usize = 32;

struct Upload {
    path: PathBuf,
    file: File,
    size: u64,
    received: u64,
}

/// One connection's staged files, in `dir`, a folder of its own that is removed with it.
pub struct Uploads {
    dir: PathBuf,
    next: u32,
    open: HashMap<String, Upload>,
    /// Complete, not attached yet: the paths `take` accepts.
    ready: HashMap<PathBuf, u64>,
    /// Attached: removed once old enough.
    used: Vec<(PathBuf, u64, Instant)>,
}

impl Uploads {
    /// `dir` is created (private, 0700) on the first upload only: a connection that sends no file leaves nothing.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            next: 0,
            open: HashMap::new(),
            ready: HashMap::new(),
            used: Vec::new(),
        }
    }

    fn staged(&self) -> u64 {
        self.open.values().map(|u| u.size).sum::<u64>()
            + self.ready.values().sum::<u64>()
            + self.used.iter().map(|(_, size, _)| size).sum::<u64>()
    }

    fn sweep(&mut self) {
        let now = Instant::now();
        self.used.retain(|(path, _, at)| {
            let keep = now.duration_since(*at) < KEEP_USED;
            if !keep {
                remove_with_folder(path);
            }
            keep
        });
    }

    /// Starts a file of `size` bytes named `name`; the upload's id.
    pub fn start(&mut self, name: &str, size: u64) -> Result<String, String> {
        self.sweep();
        if size > MAX_FILE {
            return Err(format!(
                "this file is larger than {} MiB, the most that can be sent to the PC",
                MAX_FILE >> 20
            ));
        }
        if self.open.len() + self.ready.len() >= MAX_OPEN {
            return Err("too many files at once: attach or cancel some first".into());
        }
        if self.staged() + size > MAX_STAGED {
            return Err("too many bytes waiting on the PC: attach or cancel some files first".into());
        }
        let name = safe_name(name)?;
        let mut folders = fs::DirBuilder::new();
        folders.recursive(true).mode(0o700);
        folders.create(&self.dir).map_err(|e| e.to_string())?;
        self.next += 1;
        let id = format!("u{}", self.next);
        // A folder per file keeps the name the phone chose, which the engine's copy keeps, without ever clashing.
        let folder = self.dir.join(&id);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&folder)
            .map_err(|e| e.to_string())?;
        let path = folder.join(name);
        // Exclusive: a file or a link that was there is never followed or replaced.
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        self.open.insert(
            id.clone(),
            Upload {
                path,
                file,
                size,
                received: 0,
            },
        );
        Ok(id)
    }

    /// Appends a piece (base64); the bytes received so far. Any refusal ends the upload and removes what it wrote.
    pub fn chunk(&mut self, id: &str, data: &str) -> Result<u64, String> {
        let outcome = self.append(id, data);
        if outcome.is_err() {
            self.cancel(id);
        }
        outcome
    }

    fn append(&mut self, id: &str, data: &str) -> Result<u64, String> {
        let upload = self.open.get_mut(id).ok_or("unknown upload")?;
        // Bound the text before decoding it: base64 of MAX_CHUNK bytes.
        if data.len() > MAX_CHUNK.div_ceil(3) * 4 {
            return Err(format!("a piece is at most {} MiB", MAX_CHUNK >> 20));
        }
        let bytes = base64::decode(data)?;
        if bytes.len() as u64 + upload.received > upload.size {
            return Err("more bytes than the size announced".into());
        }
        upload.file.write_all(&bytes).map_err(|e| e.to_string())?;
        upload.received += bytes.len() as u64;
        Ok(upload.received)
    }

    /// The file is complete: its path, which `take` now accepts.
    pub fn finish(&mut self, id: &str) -> Result<String, String> {
        let upload = self.open.get(id).ok_or("unknown upload")?;
        if upload.received != upload.size {
            let message = format!("{} of {} bytes received", upload.received, upload.size);
            self.cancel(id);
            return Err(message);
        }
        let upload = self.open.remove(id).ok_or("unknown upload")?;
        upload.file.sync_all().map_err(|e| e.to_string())?;
        let path = upload.path.to_string_lossy().into_owned();
        self.ready.insert(upload.path, upload.size);
        Ok(path)
    }

    pub fn cancel(&mut self, id: &str) {
        if let Some(upload) = self.open.remove(id) {
            remove_with_folder(&upload.path);
        }
    }

    /// Uses `paths` for one attachment: each must be a complete file of this connection not attached yet, else none is
    /// used. The engine copies them at once; they are removed a little later.
    pub fn take(&mut self, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() || paths.len() > MAX_ATTACH {
            return Err(format!("attach between 1 and {MAX_ATTACH} files"));
        }
        let wanted: Vec<&Path> = paths.iter().map(Path::new).collect();
        let distinct: HashSet<&Path> = wanted.iter().copied().collect();
        if distinct.len() != wanted.len() {
            return Err("the same file twice".into());
        }
        if let Some(path) = wanted.iter().find(|path| !self.ready.contains_key(**path)) {
            return Err(format!(
                "{} was not sent from the phone, or was already attached",
                path.display()
            ));
        }
        let now = Instant::now();
        for path in wanted {
            if let Some((path, size)) = self.ready.remove_entry(path) {
                self.used.push((path, size, now));
            }
        }
        Ok(())
    }

    /// The connection ended: everything it staged goes.
    pub fn clear(&mut self) {
        self.open.clear();
        self.ready.clear();
        self.used.clear();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn remove_with_folder(path: &Path) {
    let _ = fs::remove_file(path);
    if let Some(folder) = path.parent() {
        let _ = fs::remove_dir(folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-uploads-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn uploads_a_file_in_pieces_and_attaches_it_once() {
        let dir = temp("pieces");
        let mut uploads = Uploads::new(dir.clone());
        let id = uploads.start("../notes.txt", 11).unwrap();
        assert_eq!(uploads.chunk(&id, &base64::encode(b"hello ")).unwrap(), 6);
        assert_eq!(uploads.chunk(&id, &base64::encode(b"world")).unwrap(), 11);
        let path = uploads.finish(&id).unwrap();
        assert!(Path::new(&path).starts_with(&dir), "{path} is outside {dir:?}");
        assert!(path.ends_with("/notes.txt"));
        assert_eq!(fs::read(&path).unwrap(), b"hello world");
        assert!(uploads.take(&["/etc/shadow".into()]).is_err());
        assert!(uploads.take(&[path.clone(), "/etc/shadow".into()]).is_err());
        assert!(uploads.take(&[path.clone(), path.clone()]).is_err());
        uploads.take(&[path.clone()]).unwrap();
        assert!(uploads.take(&[path]).is_err(), "attached twice");
        uploads.clear();
        assert!(!dir.exists());
    }

    #[test]
    fn refuses_what_the_phone_must_not_do() {
        let dir = temp("refusals");
        let mut uploads = Uploads::new(dir.clone());
        assert!(uploads.start("big", MAX_FILE + 1).unwrap_err().contains("larger"));
        assert!(!dir.exists(), "a refused start leaves nothing");
        // More than announced, undecodable, or an unknown id: the upload ends.
        let id = uploads.start("a", 3).unwrap();
        assert!(uploads.chunk(&id, &base64::encode(b"four")).is_err());
        assert!(uploads.chunk(&id, "AAAA").unwrap_err().contains("unknown"), "ended by the refusal");
        let id = uploads.start("a", 3).unwrap();
        assert!(uploads.chunk(&id, "not base64!").is_err());
        assert!(uploads.finish(&id).is_err());
        // Too small at the end.
        let id = uploads.start("a", 3).unwrap();
        uploads.chunk(&id, &base64::encode(b"ab")).unwrap();
        assert!(uploads.finish(&id).unwrap_err().contains("2 of 3"));
        // A piece above the bound, even if the file would take it.
        let id = uploads.start("a", MAX_FILE).unwrap();
        let huge = base64::encode(&vec![0u8; MAX_CHUNK + 3]);
        assert!(uploads.chunk(&id, &huge).unwrap_err().contains("at most"));
        // Counts.
        let mut ids = Vec::new();
        for n in 0..MAX_OPEN {
            ids.push(uploads.start(&format!("f{n}"), 1).unwrap());
        }
        assert!(uploads.start("one more", 1).unwrap_err().contains("too many files"));
        for id in ids {
            uploads.cancel(&id);
        }
        // Bytes: 512 MiB waiting at most.
        for _ in 0..5 {
            uploads.start("x", MAX_FILE).unwrap();
        }
        assert!(uploads.start("x", MAX_FILE).unwrap_err().contains("too many bytes"));
        uploads.clear();
        assert!(!dir.exists());
    }

    #[test]
    fn the_staging_folder_is_private_and_a_planted_link_is_not_followed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("private");
        let mut uploads = Uploads::new(dir.clone());
        let id = uploads.start("a", 1).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        let path = uploads.finish_path_for_test(&id);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        assert_eq!(mode(&path), 0o600);
        // Something planted under the next file's name (the folder is fresh, so only an attacker inside it could).
        let next = dir.join("u2");
        fs::create_dir(&next).unwrap();
        std::os::unix::fs::symlink("/etc/hostname", next.join("b")).unwrap();
        assert!(uploads.start("b", 1).is_err(), "u2 exists: refused, not reused");
        uploads.clear();
    }

    impl Uploads {
        fn finish_path_for_test(&self, id: &str) -> PathBuf {
            self.open[id].path.clone()
        }
    }
}
