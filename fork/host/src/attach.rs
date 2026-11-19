//! Files the user adds to a message: chosen with the composer's attach button or dropped on the window
//, or, on the phone, files it sent to the PC (`uploads.rs`).
//!
//! The file may be anywhere, outside the project too: adding it is the user's act. The engine turns each into an
//! image, a text, or a copy in the session's private /tmp the agent can read (`attach_files`, file-attachments.ts),
//! which gives the agent no access to the file's folder. Only the host sends `attach_files`, and only for the paths
//! the picker returned or a drop gave (or the phone uploaded), each once: a page that asked for any other path (a
//! rendered message that got script) attaches nothing.
//!
//! Merged from the window's `attach.rs` and the phone server's copy of its `reserved`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The command only the host sends to the engine.
pub const COMMAND: &str = "attach_files";

/// The engine's `attach_files` line for `paths`, which the host sends once it checked they were the user's.
pub fn command(id: &str, paths: &[String]) -> String {
    serde_json::json!({ "type": COMMAND, "id": id, "paths": paths }).to_string()
}

/// The files the window's picker returned or a drop gave.
#[derive(Default)]
pub struct Picked(Mutex<HashSet<PathBuf>>);

impl Picked {
    /// The paths the picker returned or a drop gave, which the page may now attach once each.
    pub fn allow(&self, paths: &[PathBuf]) {
        let mut allowed = self.0.lock().unwrap_or_else(|e| e.into_inner());
        allowed.extend(paths.iter().cloned());
    }

    /// The engine's `attach_files` line for `paths`, if every one was picked or dropped; they are then used up.
    pub fn command(&self, id: &str, paths: &[String]) -> Result<String, String> {
        let mut allowed = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(path) = paths.iter().find(|path| !allowed.contains(Path::new(path))) {
            return Err(format!("{path} was not chosen in the file picker nor dropped on the window"));
        }
        for path in paths {
            allowed.remove(Path::new(path));
        }
        Ok(command(id, paths))
    }
}

/// Whether a line from a client (the page, a phone) must not reach the engine: the host's own command, or a line this
/// parser cannot read. the engine's parser accepts what serde refuses (a lone
/// surrogate such as `\ud800`, a deeper nesting), so a line serde cannot read may still be the command once the engine
/// parses it.
pub fn reserved(line: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(record) => record.get("type").and_then(|kind| kind.as_str()) == Some(COMMAND),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_only_picked_files_once_each() {
        let picked = Picked::default();
        picked.allow(&[PathBuf::from("/home/u/notes.pdf")]);

        assert!(picked.command("a", &["/home/u/.ssh/id_ed25519".into()]).is_err(), "a path never picked");
        assert!(
            picked.command("b", &["/home/u/notes.pdf".into(), "/etc/shadow".into()]).is_err(),
            "one unpicked path refuses the whole command"
        );
        let line = picked.command("c", &["/home/u/notes.pdf".into()]).unwrap();
        assert_eq!(line, r#"{"id":"c","paths":["/home/u/notes.pdf"],"type":"attach_files"}"#);
        assert!(picked.command("d", &["/home/u/notes.pdf".into()]).is_err(), "a second use of the same pick");
    }

    #[test]
    fn a_client_cannot_send_the_command() {
        assert!(reserved(r#"{"type":"attach_files","paths":["/etc/shadow"]}"#));
        assert!(reserved(r#"{ "paths": [], "type" : "attach_files" }"#));
        assert!(!reserved(r#"{"type":"prompt","message":"attach_files"}"#));
        // a line serde cannot read is refused, never forwarded as "not the
        // command": the engine's parser accepts a lone surrogate or a deeper nesting and would run it.
        assert!(reserved(r#"{"type":"attach_files","id":"x","paths":["/etc/hostname"],"pad":"\ud800"}"#));
        assert!(reserved("not json"));
        let deep = format!(r#"{{"type":"attach_files","paths":["/etc/hostname"],"pad":{}{}}}"#, "[".repeat(200), "]".repeat(200));
        assert!(reserved(&deep));
        assert!(!reserved(r#"{"type":"prompt","message":"hello é"}"#));
    }
}
