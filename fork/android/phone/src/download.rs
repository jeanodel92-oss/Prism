//! Files from the PC to the phone. The page
//! asks the engine for a file piece by piece and hands each piece (base64) to `append`; `finish` gives the path of the
//! complete file in the app's private cache, which the Android activity then saves to the phone's Downloads or opens.
//!
//! The PC is trusted no more than the phone is trusted by the PC: a name is one safe component, the size is bounded
//! (`MAX_FILE`), and nothing here ever reads or writes outside the folder it was given.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::Mutex;

use prism_host::base64;
use prism_host::files::{safe_name, MAX_FILE};

/// The most downloads under way at once.
const MAX_OPEN: usize = 4;
/// The most bytes one piece carries (base64 of the engine's 3 MiB piece, with room).
const MAX_PIECE_TEXT: usize = 8 * 1024 * 1024;

struct Open {
    path: PathBuf,
    file: File,
    written: u64,
}

pub struct Downloads {
    dir: PathBuf,
    state: Mutex<State>,
}

struct State {
    next: u32,
    open: HashMap<String, Open>,
}

impl Downloads {
    /// `dir` is the app's cache folder for downloads: emptied now, since what an earlier run left is of no use.
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::remove_dir_all(&dir);
        Self {
            dir,
            state: Mutex::new(State {
                next: 0,
                open: HashMap::new(),
            }),
        }
    }

    /// Starts a download of a file named `name`; its id.
    pub fn begin(&self, name: &str) -> Result<String, String> {
        let name = safe_name(name)?;
        let mut state = self.state.lock().unwrap();
        if state.open.len() >= MAX_OPEN {
            return Err("too many downloads at once".into());
        }
        state.next += 1;
        let id = format!("d{}", state.next);
        let folder = self.dir.join(&id);
        let mut folders = fs::DirBuilder::new();
        folders.recursive(true).mode(0o700);
        folders.create(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        state.open.insert(
            id.clone(),
            Open {
                path,
                file,
                written: 0,
            },
        );
        Ok(id)
    }

    /// Adds a piece (base64); the bytes written so far. A refusal ends the download and removes what it wrote.
    pub fn append(&self, id: &str, data: &str) -> Result<u64, String> {
        let outcome = self.write(id, data);
        if outcome.is_err() {
            self.discard(id);
        }
        outcome
    }

    fn write(&self, id: &str, data: &str) -> Result<u64, String> {
        let mut state = self.state.lock().unwrap();
        let open = state.open.get_mut(id).ok_or("unknown download")?;
        if data.len() > MAX_PIECE_TEXT {
            return Err("a piece is too large".into());
        }
        let bytes = base64::decode(data)?;
        if open.written + bytes.len() as u64 > MAX_FILE {
            return Err(format!(
                "this file is larger than {} MiB",
                MAX_FILE >> 20
            ));
        }
        open.file.write_all(&bytes).map_err(|e| e.to_string())?;
        open.written += bytes.len() as u64;
        Ok(open.written)
    }

    /// The file is complete: its path in the cache, and the download is over (the file is left for the caller to move).
    pub fn finish(&self, id: &str) -> Result<String, String> {
        let open = self
            .state
            .lock()
            .unwrap()
            .open
            .remove(id)
            .ok_or("unknown download")?;
        open.file.sync_all().map_err(|e| e.to_string())?;
        Ok(open.path.to_string_lossy().into_owned())
    }

    pub fn discard(&self, id: &str) {
        if let Some(open) = self.state.lock().unwrap().open.remove(id) {
            let _ = fs::remove_file(&open.path);
            if let Some(folder) = open.path.parent() {
                let _ = fs::remove_dir(folder);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("prism-phone-dl-{}-{name}", std::process::id()))
    }

    #[test]
    fn assembles_a_file_from_its_pieces_in_a_folder_of_its_own() {
        let dir = temp("pieces");
        let downloads = Downloads::new(dir.clone());
        let id = downloads.begin("../../report.pdf").unwrap();
        assert_eq!(downloads.append(&id, &base64::encode(b"%PDF-")).unwrap(), 5);
        assert_eq!(downloads.append(&id, &base64::encode(&[0u8, 255, 7])).unwrap(), 8);
        let path = downloads.finish(&id).unwrap();
        assert!(Path::new(&path).starts_with(&dir), "{path}");
        assert!(path.ends_with("/report.pdf"));
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-\x00\xff\x07");
        assert!(downloads.append(&id, "AAAA").is_err(), "a finished download takes no more");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_bad_pieces_and_too_much() {
        let dir = temp("refused");
        let downloads = Downloads::new(dir.clone());
        let id = downloads.begin("a").unwrap();
        assert!(downloads.append(&id, "not base64!").is_err());
        assert!(downloads.finish(&id).is_err(), "the refusal ended it");
        assert!(!dir.join("d1").exists(), "and removed what it wrote");
        assert!(downloads.append("d99", "AAAA").is_err());
        assert!(downloads.begin(&"x".repeat(300)).is_err());
        // Past the bound: pieces of 3 MiB until one more would exceed 100 MiB.
        let id = downloads.begin("big").unwrap();
        let piece = base64::encode(&vec![0u8; 3 * 1024 * 1024]);
        let mut total = 0u64;
        let refused = loop {
            match downloads.append(&id, &piece) {
                Ok(written) => total = written,
                Err(error) => break error,
            }
        };
        assert!(refused.contains("larger than 100 MiB"), "{refused}");
        assert!(total <= MAX_FILE);
        assert!(!dir.join("d2").exists());
        // Too many at once.
        let open: Vec<_> = (0..MAX_OPEN).map(|_| downloads.begin("f").unwrap()).collect();
        assert!(downloads.begin("f").is_err());
        for id in open {
            downloads.discard(&id);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn starts_from_an_empty_folder() {
        let dir = temp("stale");
        fs::create_dir_all(dir.join("d1")).unwrap();
        fs::write(dir.join("d1/left"), "x").unwrap();
        let _ = Downloads::new(dir.clone());
        assert!(!dir.join("d1").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
