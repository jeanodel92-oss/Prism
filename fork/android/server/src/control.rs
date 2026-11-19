//! The server's control socket: the PC window, or `prism-remote invite`, asks the
//! running server for a new pairing code, since its one-time tokens live in its memory. A Unix socket in the server's
//! folder, private to the user (0600); one request line, one JSON answer line.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use prism_link::Server;
use serde_json::json;

/// Listens on `path`; refuses when a server already answers there, replaces a socket left by one that is gone.
pub fn bind(path: &Path) -> Result<UnixListener, String> {
    if UnixStream::connect(path).is_ok() {
        return Err(format!(
            "a server already runs for {}",
            path.parent().unwrap_or(path).display()
        ));
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok(listener)
}

/// Answers `invite` (a new code, its QR as an image and as terminal text, and the addresses) and `status` until the process ends.
pub fn serve(listener: UnixListener, server: &Arc<Server>, hosts: &[String], port: u16) {
    for stream in listener.incoming().flatten() {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut request = String::new();
        if BufReader::new(&stream).read_line(&mut request).is_err() {
            continue;
        }
        let answer = match request.trim() {
            "invite" => server
                .invite(hosts.to_vec(), port)
                .and_then(|invitation| Ok(json!({ "code": invitation.encode(), "svg": invitation.svg()?, "qr": invitation.qr()?, "hosts": hosts, "port": port })))
                .unwrap_or_else(|error| json!({ "error": error })),
            "status" => json!({ "hosts": hosts, "port": port, "pid": std::process::id(), "paired": server.paired() }),
            other => json!({ "error": format!("unknown request {other:?}") }),
        };
        let _ = (&stream).write_all(format!("{answer}\n").as_bytes());
    }
}

/// Sends one request to the running server; its answer line, or why there is none.
pub fn ask(path: &Path, request: &str) -> Result<String, String> {
    let mut stream = UnixStream::connect(path).map_err(|_| {
        format!(
            "no server runs for {}",
            path.parent().unwrap_or(path).display()
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let mut answer = String::new();
    BufReader::new(&stream)
        .read_line(&mut answer)
        .map_err(|e| e.to_string())?;
    Ok(answer.trim_end().to_string())
}
