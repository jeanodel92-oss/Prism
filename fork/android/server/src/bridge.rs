//! A phone served by the PC window's engines: the server checked the phone's
//! certificate, so it only carries the lines, unread, between the phone's TLS stream and a local socket of the window
//! (`prism_host::connection::serve_socket`), after telling it whose phone this is. The socket is private to the user;
//! nothing here listens on a network any more than the server already does.
//!
//! The two directions never wait for each other: a thread reads the window's side and another writes to it, while this
//! one polls the phone, so a large line each way at the same time cannot stall both.

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::mpsc::{channel, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use prism_host::connection::{hello_line, Backlog};
use prism_host::lines::{Polled, UnixLines};
use prism_link::{Polled as Tls, Server, ServerLines};

const POLL: Duration = Duration::from_millis(20);
/// How often the device list is read again, to cut off a phone revoked while it is connected.
const ALLOWED_EVERY: Duration = Duration::from_secs(1);

/// Whether the phone is still paired, read again at most every `ALLOWED_EVERY`.
fn still_paired(server: &Server, peer: &str, checked: &mut Instant) -> bool {
    if checked.elapsed() < ALLOWED_EVERY {
        return true;
    }
    *checked = Instant::now();
    server.paired().iter().any(|paired| paired == peer)
}

pub fn run(phone: &mut ServerLines, hub: &Path, server: &Arc<Server>) {
    let fingerprint = phone.peer().unwrap_or_default();
    let peer = fingerprint.clone();
    let stream = match UnixStream::connect(hub) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("prism-remote: the window's engines are not there ({}): {error}", hub.display());
            return;
        }
    };
    let (Ok(read_half), Ok(write_half)) = (stream.try_clone(), stream.try_clone()) else {
        return;
    };
    let (down_tx, down) = channel::<Option<String>>();
    // fork: what waits for the phone is bounded; past it, the reader
    // stops and the phone is cut off. The window keeps its engines, which the phone takes back when it reconnects.
    let backlog = Backlog::default();
    let queued = backlog.clone();
    let reader = thread::spawn(move || {
        let mut lines = UnixLines::new(read_half);
        loop {
            match lines.poll(Duration::from_millis(500)) {
                Ok(Polled::Line(line)) => {
                    if !queued.add(line.len()) || down_tx.send(Some(line)).is_err() {
                        let _ = down_tx.send(None);
                        return;
                    }
                }
                Ok(Polled::Nothing) => {}
                Ok(Polled::Closed) | Err(_) => {
                    let _ = down_tx.send(None);
                    return;
                }
            }
        }
    });
    let (up, up_rx) = channel::<String>();
    let writer = thread::spawn(move || {
        let mut lines = UnixLines::new(write_half);
        if lines.write(&hello_line(&fingerprint)).is_err() {
            return;
        }
        for line in up_rx {
            if lines.write(&line).is_err() {
                return;
            }
        }
    });

    let mut checked = Instant::now();
    let outcome = (|| -> Result<(), String> {
        loop {
            match phone.poll(POLL)? {
                Tls::Line(line) => {
                    if up.send(line).is_err() {
                        return Ok(());
                    }
                }
                Tls::Closed => return Ok(()),
                Tls::Nothing => {}
            }
            loop {
                // Too far behind: cut off now, not after writing all that waits.
                if backlog.overflowed() {
                    return Ok(());
                }
                match down.try_recv() {
                    Ok(Some(line)) => {
                        backlog.written(line.len());
                        phone.write(&line)?
                    }
                    // The window's side ended (the window closed, or the line was not a request).
                    Ok(None) | Err(TryRecvError::Disconnected) => return Ok(()),
                    Err(TryRecvError::Empty) => break,
                }
                // fork: between writes too, or a phone that reads slower than the
                // window writes is never checked again.
                if !still_paired(server, &peer, &mut checked) {
                    return Ok(());
                }
            }
            if !still_paired(server, &peer, &mut checked) {
                return Ok(());
            }
        }
    })();
    let _ = outcome;
    drop(up);
    let _ = stream.shutdown(std::net::Shutdown::Both);
    let _ = reader.join();
    let _ = writer.join();
}
