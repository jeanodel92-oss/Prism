//! One client's session of the phone protocol, over any line transport: a
//! phone's TLS connection (`prism-remote`), or a local socket (the window's engines, which a phone reaches through
//! `prism-remote` when the user lets the window share its sessions).
//!
//! A transport's stream cannot be split between two threads (rustls), so one thread both reads requests and writes: it
//! polls for a request for a few milliseconds, then writes what the engines produced meanwhile, and loops. A response
//! is always written before the events queued while its request ran, so the phone knows an engine's id before its
//! first event.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::attach;
use crate::engine::{self, Client, Hub, Sink};
use crate::lines::{Polled, Transport, UnixLines};
use crate::project;
use crate::uploads::Uploads;

/// How long a request is waited for before queued events are written: the most an event is delayed when idle.
const POLL: Duration = Duration::from_millis(20);
/// How long an engine gets to exit after its stdin closes, before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// How often the transport is asked whether its peer is still allowed.
const ALLOWED_EVERY: Duration = Duration::from_secs(1);
/// fork: how long the engines of a phone that went away keep running, so a turn in
/// progress ends and is saved, and the phone takes them back when it reconnects (`resume`). `PRISM_REMOTE_KEEP_ALIVE`
/// (seconds) shortens it for the tests.
const KEEP_ALIVE: Duration = Duration::from_secs(5 * 60);

/// fork: the most a phone may have waiting to be written to it, in
/// bytes. Twice the longest line a phone reads (`prism_link`'s 64 MiB), so one large event always fits. A phone that
/// falls further behind is cut off: its engines go on, and it takes them back when it reconnects (`resume`).
pub const MAX_BACKLOG: usize = 128 << 20;

/// The bytes waiting for one reader, bounded by `MAX_BACKLOG`; shared by who queues and who writes.
#[derive(Clone, Default)]
pub struct Backlog(Arc<(AtomicUsize, AtomicBool)>);

impl Backlog {
    /// Counts `bytes` more to write; false, from then on, once that would go over `MAX_BACKLOG`.
    pub fn add(&self, bytes: usize) -> bool {
        if self.overflowed() {
            return false;
        }
        if self.0 .0.fetch_add(bytes, Ordering::SeqCst) + bytes > MAX_BACKLOG {
            self.0 .1.store(true, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// `bytes` were written, or dropped.
    pub fn written(&self, bytes: usize) {
        self.0 .0.fetch_sub(bytes, Ordering::SeqCst);
    }

    /// The reader fell too far behind: it is to be cut off.
    pub fn overflowed(&self) -> bool {
        self.0 .1.load(Ordering::SeqCst)
    }
}

/// Numbers each connection, for the engines to know which one has them.
static CONNECTIONS: AtomicU64 = AtomicU64::new(1);

fn keep_alive() -> Duration {
    std::env::var("PRISM_REMOTE_KEEP_ALIVE")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(KEEP_ALIVE)
}

/// What every connection shares.
pub struct Shared {
    pub hub: Arc<Hub>,
    pub cwd: std::path::PathBuf,
    /// Why no engine can be started, if so (the engine command's variables are invalid).
    pub engine_error: Option<String>,
    /// Where the files phones send are kept while they wait to be attached: a folder of the host's, private to it.
    pub staging: std::path::PathBuf,
}

/// Serves the client until it closes, is no longer allowed or breaks the protocol, then leaves its engines running for a while.
pub fn run(transport: &mut impl Transport, shared: &Shared) {
    let (events, queued) = channel();
    let backlog = Backlog::default();
    let serial = CONNECTIONS.fetch_add(1, Ordering::Relaxed);
    let mut connection = Connection {
        shared,
        client: Client {
            owner: transport.peer(),
            holder: serial,
        },
        owned: HashSet::new(),
        events,
        backlog: backlog.clone(),
        uploads: Uploads::new(shared.staging.join(format!("c{serial}"))),
    };
    let _ = connection.serve(transport, &queued, &backlog);
    drop(queued);
    connection.uploads.clear();
    connection.detach_engines();
}

/// Fails once the transport's peer is no longer allowed, asked at most every `ALLOWED_EVERY`.
fn still_allowed(transport: &impl Transport, checked: &mut Instant) -> Result<(), String> {
    if checked.elapsed() >= ALLOWED_EVERY {
        *checked = Instant::now();
        if !transport.allowed() {
            return Err("this device is no longer allowed".into());
        }
    }
    Ok(())
}

/// Writes the queued events until the queue is empty. fork: the check that the
/// device is still allowed runs between writes too. Run only once the queue was empty, it never ran for a phone that
/// read slower than the engines wrote, which kept receiving their events long after it was revoked.
fn write_queued(
    transport: &mut impl Transport,
    queued: &Receiver<String>,
    backlog: &Backlog,
    checked: &mut Instant,
) -> Result<(), String> {
    loop {
        if backlog.overflowed() {
            return Err("this device reads too slowly: over MAX_BACKLOG bytes wait for it".into());
        }
        match queued.try_recv() {
            Ok(event) => {
                backlog.written(event.len());
                transport.write(&event)?
            }
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => return Ok(()),
        }
        still_allowed(transport, checked)?;
    }
}

struct Connection<'a> {
    shared: &'a Shared,
    /// Who is on the other end (a phone's certificate fingerprint) and which connection: the engines it started are its
    /// own, and it alone may take them back after a cut.
    client: Client,
    /// The engines this connection opened or took back: the only ones it may talk to.
    owned: HashSet<u32>,
    events: Sender<String>,
    /// What `events` holds, in bytes: past `MAX_BACKLOG`, nothing more is queued and the connection ends.
    backlog: Backlog,
    /// The files this phone sent (`upload_*`), which it may attach to a message once each (`attach_picked`).
    uploads: Uploads,
}

impl Connection<'_> {
    fn serve(
        &mut self,
        transport: &mut impl Transport,
        queued: &Receiver<String>,
        backlog: &Backlog,
    ) -> Result<(), String> {
        let mut checked = Instant::now();
        loop {
            match transport.poll(POLL)? {
                Polled::Line(line) => {
                    // A line that is not a request ends the connection: the peer is not a Prism phone.
                    let response = self.handle(&line).ok_or("not a request")?;
                    transport.write(&response)?;
                }
                Polled::Closed => return Ok(()),
                Polled::Nothing => {}
            }
            write_queued(transport, queued, backlog, &mut checked)?;
            // A device revoked while it is connected is cut off, not only refused when it comes back.
            still_allowed(transport, &mut checked)?;
        }
    }

    /// The response line, or nothing when `line` is not a request (not JSON, not an object, no text `id`).
    fn handle(&mut self, line: &str) -> Option<String> {
        let Ok(Value::Object(mut request)) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        let Some(Value::String(id)) = request.remove("id") else {
            return None;
        };
        let op = request.get("op").and_then(Value::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or(Value::Null);
        let outcome = self.dispatch(op, &args);
        Some(
            match outcome {
                Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                Err(error) => json!({ "id": id, "ok": false, "error": error }),
            }
            .to_string(),
        )
    }

    fn dispatch(&mut self, op: &str, args: &Value) -> Result<Value, String> {
        let args = match args {
            Value::Null => &Value::Object(Default::default()),
            Value::Object(_) => args,
            _ => return Err("args must be an object".into()),
        };
        match op {
            "app_info" => Ok(self.app_info()),
            "memory_info" => Ok(serde_json::to_value(engine::memory_info()).unwrap_or(Value::Null)),
            "project_directory" => {
                let path = text(args, "path")?;
                let listed = project::list(&path, &self.shared.cwd)?;
                serde_json::to_value(listed).map_err(|e| e.to_string())
            }
            "engine_start" => self.engine_start(args),
            // The questions a taken-back engine still waits an answer to, sent again as its events.
            "engine_replay" => {
                let id = self.engine(args)?;
                self.shared.hub.replay(&self.client, id)?;
                Ok(Value::Null)
            }
            "engine_send" => {
                let id = self.engine(args)?;
                let line = text(args, "line")?;
                if attach::reserved(&line) {
                    return Err("this command is reserved to the host".into());
                }
                self.shared.hub.send(&self.client, id, &line)?;
                Ok(Value::Null)
            }
            "upload_start" => {
                let name = text(args, "name")?;
                let size = args
                    .get("size")
                    .and_then(Value::as_u64)
                    .ok_or("size must be a number of bytes")?;
                Ok(json!({ "upload": self.uploads.start(&name, size)? }))
            }
            "upload_chunk" => {
                let upload = text(args, "upload")?;
                let received = self.uploads.chunk(&upload, &text(args, "data")?)?;
                Ok(json!({ "received": received }))
            }
            "upload_finish" => {
                let path = self.uploads.finish(&text(args, "upload")?)?;
                Ok(json!({ "path": path }))
            }
            "upload_cancel" => {
                self.uploads.cancel(&text(args, "upload")?);
                Ok(Value::Null)
            }
            // The window's attach (attach.rs `Picked::command`): only files this phone sent, once each. The engine's
            // answer to `id` comes as its event, as for any command.
            "attach_picked" => {
                let engine = self.engine(args)?;
                let id = text(args, "id")?;
                let paths: Vec<String> = match args.get("paths") {
                    Some(Value::Array(list)) => list
                        .iter()
                        .map(|path| path.as_str().map(str::to_string).ok_or("paths must be texts"))
                        .collect::<Result<_, _>>()?,
                    _ => return Err("paths must be a list".into()),
                };
                self.uploads.take(&paths)?;
                self.shared
                    .hub
                    .send(&self.client, engine, &attach::command(&id, &paths))?;
                Ok(Value::Null)
            }
            "engine_stop" => {
                let id = self.engine(args)?;
                self.shared.hub.stop(&self.client, id, STOP_GRACE)?;
                self.owned.remove(&id);
                Ok(Value::Null)
            }
            _ => Err(format!("unknown op {op:?}")),
        }
    }

    fn app_info(&self) -> Value {
        let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
            .unwrap_or_default();
        let host = std::fs::read_to_string("/proc/sys/kernel/hostname")
            .map(|name| name.trim().to_string())
            .unwrap_or_default();
        json!({
            "cwd": self.shared.cwd.display().to_string(),
            "home": std::env::var("HOME").ok(),
            "engineError": self.shared.engine_error,
            "locale": locale,
            "version": env!("CARGO_PKG_VERSION"),
            "host": host,
        })
    }

    fn engine_start(&mut self, args: &Value) -> Result<Value, String> {
        if let Some(error) = &self.shared.engine_error {
            return Err(error.clone());
        }
        let session = optional_text(args, "session")?;
        let cwd = optional_text(args, "cwd")?;
        let cwd = project::resolve(cwd.as_deref().unwrap_or("."), &self.shared.cwd)?;
        let events = self.events.clone();
        let backlog = self.backlog.clone();
        // Past the backlog, the sink says nobody listens: the engine keeps the attachment as a lost one, for `resume`.
        let sink: Sink = Arc::new(move |engine, message| {
            let event =
                json!({ "event": "engine", "engine": engine, "message": message }).to_string();
            backlog.add(event.len()) && events.send(event).is_ok()
        });
        // A phone back after a cut asks for the attachment it had; it gets it if its engine still runs and it was its
        // own, else the session is opened again (a new number, so it knows).
        let resume = args
            .get("resume")
            .and_then(Value::as_u64)
            .and_then(|id| u32::try_from(id).ok());
        if let Some(id) = resume {
            if self.shared.hub.resume(&self.client, id, sink.clone()) {
                self.owned.insert(id);
                return Ok(json!(id));
            }
        }
        // The session may already run, started by the window or by another phone: this phone then shares that engine.
        let id = self.shared.hub.open(&self.client, cwd, session, sink)?;
        self.owned.insert(id);
        Ok(json!(id))
    }

    /// The `engine` argument, if this connection opened it.
    fn engine(&self, args: &Value) -> Result<u32, String> {
        let id = args
            .get("engine")
            .and_then(Value::as_u64)
            .and_then(|id| u32::try_from(id).ok())
            .ok_or("engine must be an engine number")?;
        if self.owned.contains(&id) {
            Ok(id)
        } else {
            Err("this engine does not belong to this connection".into())
        }
    }

    /// The client went away: its engines go on for `keep_alive()`, then it lets them go unless it takes them back.
    fn detach_engines(&mut self) {
        let keep = keep_alive();
        for id in self.owned.drain() {
            self.shared.hub.lost(id, self.client.holder, keep, STOP_GRACE);
        }
    }
}

fn text(args: &Value, name: &str) -> Result<String, String> {
    match args.get(name) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(format!("{name} must be a text")),
    }
}

fn optional_text(args: &Value, name: &str) -> Result<Option<String>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("{name} must be a text or null")),
    }
}

/// A phone brought by the phone server over a local socket (`prism-remote serve --hub`): the server checked the
/// phone's certificate, and says whose it is in a first line `{"hello":{"phone": <fingerprint>}}`; then the phone
/// protocol goes on as over TLS. The socket is private to the user (see `lines::bind`); nothing listens on a network.
struct Bridged {
    lines: UnixLines,
    phone: String,
}

impl Transport for Bridged {
    fn poll(&mut self, wait: Duration) -> Result<Polled, String> {
        self.lines.poll(wait)
    }
    fn write(&mut self, line: &str) -> Result<(), String> {
        self.lines.write(line)
    }
    fn peer(&self) -> String {
        self.phone.clone()
    }
}

/// How long the server has to say whose phone it brings.
const HELLO_WITHIN: Duration = Duration::from_secs(5);

/// The phone named by a hello line.
pub fn hello(line: &str) -> Option<String> {
    let record: Value = serde_json::from_str(line).ok()?;
    let phone = record.get("hello")?.get("phone")?.as_str()?;
    (!phone.is_empty() && phone.len() <= 128).then(|| phone.to_string())
}

/// The hello line for `phone`.
pub fn hello_line(phone: &str) -> String {
    json!({ "hello": { "phone": phone } }).to_string()
}

/// Serves the phones the server brings over `listener` until the process ends, one thread each.
pub fn serve_socket(listener: UnixListener, shared: Arc<Shared>) {
    for stream in listener.incoming().flatten() {
        let shared = shared.clone();
        thread::spawn(move || {
            let mut lines = UnixLines::new(stream);
            let phone = match lines.poll(HELLO_WITHIN) {
                Ok(Polled::Line(line)) => hello(&line),
                _ => None,
            };
            if let Some(phone) = phone {
                run(&mut Bridged { lines, phone }, &shared);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A phone that reads one event every 50 ms, revoked after its fifth.
    struct SlowPhone {
        written: usize,
        revoked_at: Cell<Option<usize>>,
    }

    impl Transport for SlowPhone {
        fn poll(&mut self, _wait: Duration) -> Result<Polled, String> {
            Ok(Polled::Nothing)
        }
        fn write(&mut self, _line: &str) -> Result<(), String> {
            thread::sleep(Duration::from_millis(50));
            self.written += 1;
            if self.written == 5 {
                self.revoked_at.set(Some(self.written));
            }
            Ok(())
        }
        fn peer(&self) -> String {
            "phone".into()
        }
        fn allowed(&self) -> bool {
            self.revoked_at.get().is_none()
        }
    }

    // fork: the queue never empties for a phone that reads slower than the
    // engines write; the device list was read only once it did.
    #[test]
    fn a_phone_revoked_while_the_queue_is_never_empty_is_cut_off_within_the_check_interval() {
        let (events, queued) = channel();
        for tick in 0..1000 {
            events.send(format!("event {tick}")).unwrap();
        }
        let mut phone = SlowPhone {
            written: 0,
            revoked_at: Cell::new(None),
        };
        let mut checked = Instant::now();
        let outcome = write_queued(&mut phone, &queued, &Backlog::default(), &mut checked);
        assert_eq!(outcome, Err("this device is no longer allowed".to_string()));
        // At 50 ms a write, a check every second lets about 20 events through, never the 995 left.
        assert!(phone.written <= 5 + 25, "{} events written", phone.written);
    }

    // fork: a phone that stops reading is not given the engines'
    // events without end; past `MAX_BACKLOG` nothing more is queued and the connection ends.
    #[test]
    fn the_backlog_of_a_phone_that_stops_reading_is_bounded() {
        let backlog = Backlog::default();
        let event = "x".repeat(1 << 20);
        let mut queued = 0;
        while backlog.add(event.len()) {
            queued += 1;
        }
        assert_eq!(queued, MAX_BACKLOG >> 20);
        assert!(backlog.overflowed());
        assert!(!backlog.add(1), "nothing more once over");
        let (_events, queue) = channel::<String>();
        let mut phone = SlowPhone {
            written: 0,
            revoked_at: Cell::new(None),
        };
        let outcome = write_queued(&mut phone, &queue, &backlog, &mut Instant::now());
        assert!(outcome.unwrap_err().contains("reads too slowly"));
        // Writing frees the room again for a reader that keeps up.
        let steady = Backlog::default();
        assert!(steady.add(MAX_BACKLOG));
        steady.written(MAX_BACKLOG);
        assert!(steady.add(MAX_BACKLOG));
    }
}
