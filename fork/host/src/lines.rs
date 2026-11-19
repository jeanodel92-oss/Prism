//! Lines of JSON over a stream: what the phone protocol (`connection.rs`) is spoken on. The phone's own transport is
//! `prism-link`'s TLS stream; the window's is a local Unix socket, which is no network at all.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

/// A line longer than this ends the connection. A whole conversation (`get_messages`) is one line of several MiB.
pub const LINE_LIMIT: usize = 64 << 20;

/// What `poll` found.
#[derive(Debug, PartialEq)]
pub enum Polled {
    Line(String),
    Closed,
    /// Nothing arrived within the wait: the caller may write, then poll again.
    Nothing,
}

/// A stream of lines one thread both reads and writes: read with `poll`, write what is waiting, poll again.
pub trait Transport {
    fn poll(&mut self, wait: Duration) -> Result<Polled, String>;
    fn write(&mut self, line: &str) -> Result<(), String>;
    /// Who is on the other end: a phone's certificate fingerprint. Only that phone may take back the engines it left.
    fn peer(&self) -> String;
    /// False once the other end is no longer allowed to be there (its device was revoked): the connection ends.
    fn allowed(&self) -> bool {
        true
    }
}

/// Listens on a Unix socket private to the user (0600); refuses when something already answers there, replaces a
/// socket left by a process that is gone.
pub fn bind(path: &std::path::Path) -> Result<std::os::unix::net::UnixListener, String> {
    use std::os::unix::fs::PermissionsExt;
    if UnixStream::connect(path).is_ok() {
        return Err(format!("something already listens on {}", path.display()));
    }
    let _ = std::fs::remove_file(path);
    let listener = std::os::unix::net::UnixListener::bind(path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(listener)
}

/// Lines over a Unix socket.
pub struct UnixLines {
    stream: UnixStream,
    buffer: Vec<u8>,
}

impl UnixLines {
    pub fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
        }
    }

    pub fn stream(&self) -> &UnixStream {
        &self.stream
    }

    /// Waits at most `wait` for the next line.
    pub fn poll(&mut self, wait: Duration) -> Result<Polled, String> {
        self.stream
            .set_read_timeout(Some(wait.max(Duration::from_millis(1))))
            .map_err(|e| e.to_string())?;
        loop {
            if let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return String::from_utf8(line).map(Polled::Line).map_err(|_| "not UTF-8".to_string());
            }
            if self.buffer.len() > LINE_LIMIT {
                return Err("line too long".to_string());
            }
            let mut chunk = [0u8; 16384];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Ok(Polled::Closed),
                Ok(read) => self.buffer.extend_from_slice(&chunk[..read]),
                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    return Ok(Polled::Nothing)
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    pub fn write(&mut self, line: &str) -> Result<(), String> {
        self.stream
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|_| self.stream.flush())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_lines_and_keeps_a_partial_one() {
        let (a, b) = UnixStream::pair().unwrap();
        let mut reader = UnixLines::new(a);
        let mut writer = b;
        assert_eq!(reader.poll(Duration::from_millis(5)).unwrap(), Polled::Nothing);
        writer.write_all(b"one\ntw").unwrap();
        assert_eq!(reader.poll(Duration::from_millis(50)).unwrap(), Polled::Line("one".into()));
        assert_eq!(reader.poll(Duration::from_millis(5)).unwrap(), Polled::Nothing);
        writer.write_all(b"o\r\n").unwrap();
        assert_eq!(reader.poll(Duration::from_millis(50)).unwrap(), Polled::Line("two".into()));
        drop(writer);
        assert_eq!(reader.poll(Duration::from_millis(50)).unwrap(), Polled::Closed);
    }

    #[test]
    fn refuses_what_is_not_utf8() {
        let (a, mut b) = UnixStream::pair().unwrap();
        b.write_all(&[0xff, b'\n']).unwrap();
        assert!(UnixLines::new(a).poll(Duration::from_millis(50)).is_err());
    }
}
