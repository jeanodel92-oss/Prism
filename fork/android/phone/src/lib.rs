//! The phone's transport to the PC. A background thread owns
//! the `prism-link` connection; callers queue requests and wait for their answers, and the PC's engine events go to
//! the sink given when the engine was started. Nothing here depends on Tauri, so it can be tested with a plain
//! callback and a fake PC.

pub mod download;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use prism_link::{Client, ClientLines, Invitation, Polled};
use serde::Serialize;
use serde_json::{json, Value};

/// Where an engine's messages go (a Tauri `Channel` in the app, a plain callback in tests).
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// What an open engine is told when the connection ends.
pub const LOST: &str = "connection to the PC lost";
/// The one thread both reads and writes the TLS stream, so it polls: this is also the delay before a queued request
/// leaves.
const POLL: Duration = Duration::from_millis(25);
/// Starting an engine can be slow on a busy PC.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// After a connection is lost, or the saved PC cannot be reached, the phone tries again: first after a second, then
/// twice as long each time, up to this, until it connects, a new pairing replaces the PC, or the PC is forgotten.
/// Asking for the status (the page does while it shows the link lost) tries again at once.
const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// Whether a kept invitation is this PC (same certificate).
fn same_pc(code: &str, pc: &Invitation) -> bool {
    Invitation::decode(code).is_ok_and(|kept| kept.fingerprint == pc.fingerprint)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Pending {
    reply: mpsc::Sender<Result<Value, String>>,
    /// For `engine_start`: registered as the engine's sink when the answer arrives, before any of its events can
    /// be read (they come after the answer on the same stream).
    sink: Option<Sink>,
}

#[derive(Default)]
struct ConnState {
    closed: Option<String>,
    next: u64,
    pending: HashMap<String, Pending>,
    engines: HashMap<u64, Sink>,
}

/// One connection to the PC. Its requests, engines and outgoing lines die with it.
struct Conn {
    host: String,
    outbox: Mutex<VecDeque<String>>,
    state: Mutex<ConnState>,
    /// Set to end the thread on purpose (forget, replaced by a new pairing).
    stop: AtomicBool,
}

impl Conn {
    fn new(host: String) -> Self {
        Self {
            host,
            outbox: Mutex::new(VecDeque::new()),
            state: Mutex::new(ConnState::default()),
            stop: AtomicBool::new(false),
        }
    }

    fn is_open(&self) -> bool {
        lock(&self.state).closed.is_none()
    }

    fn request(&self, op: &str, args: Value, sink: Option<Sink>) -> Result<Value, String> {
        let (reply, answer) = mpsc::channel();
        let id = {
            let mut state = lock(&self.state);
            if let Some(reason) = &state.closed {
                return Err(reason.clone());
            }
            state.next += 1;
            let id = format!("m{}", state.next);
            state.pending.insert(id.clone(), Pending { reply, sink });
            id
        };
        lock(&self.outbox).push_back(json!({"id": id, "op": op, "args": args}).to_string());
        match answer.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                lock(&self.state).pending.remove(&id);
                Err("the PC did not answer in time".to_string())
            }
        }
    }

    /// Fails every waiting request and tells every open engine it is gone. Only the first call acts.
    fn close(&self, reason: &str) {
        let (pending, engines) = {
            let mut state = lock(&self.state);
            if state.closed.is_some() {
                return;
            }
            state.closed = Some(reason.to_string());
            (
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.engines),
            )
        };
        for (_, waiting) in pending {
            let _ = waiting.reply.send(Err(reason.to_string()));
        }
        for (_, sink) in engines {
            sink(
                json!({"kind": "exit", "code": null, "signal": null, "stderr": [LOST], "lost": true}),
            );
        }
    }

    /// One line from the PC: an engine event, or the answer to a request. Anything else is ignored: the phone
    /// never closes on the PC's noise.
    fn handle(&self, line: &str) {
        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if message.get("event").and_then(Value::as_str) == Some("engine") {
            let (Some(engine), Some(inner)) = (
                message.get("engine").and_then(Value::as_u64),
                message.get("message"),
            ) else {
                return;
            };
            let exited = inner.get("kind").and_then(Value::as_str) == Some("exit");
            let sink = {
                let mut state = lock(&self.state);
                if exited {
                    state.engines.remove(&engine)
                } else {
                    state.engines.get(&engine).cloned()
                }
            };
            if let Some(sink) = sink {
                sink(inner.clone());
            }
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return;
        };
        let answer = if message.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(message
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the PC refused the request")
                .to_string())
        };
        let mut state = lock(&self.state);
        let Some(waiting) = state.pending.remove(id) else {
            return;
        };
        if let (Ok(result), Some(sink)) = (&answer, waiting.sink) {
            if let Some(engine) = result.as_u64() {
                state.engines.insert(engine, sink);
            }
        }
        drop(state);
        let _ = waiting.reply.send(answer);
    }

    /// The thread's body: read with a short wait, send what is queued, repeat. Returns why it ended.
    fn run(&self, mut lines: ClientLines) -> String {
        loop {
            if self.stop.load(Ordering::SeqCst) {
                return "closed by the phone".to_string();
            }
            match lines.poll(POLL) {
                Ok(Polled::Line(line)) => self.handle(&line),
                Ok(Polled::Nothing) => {}
                Ok(Polled::Closed) => return "the PC closed the connection".to_string(),
                Err(error) => return error,
            }
            loop {
                let Some(next) = lock(&self.outbox).pop_front() else {
                    break;
                };
                if let Err(error) = lines.write(&next) {
                    return error;
                }
            }
        }
    }
}

#[derive(Default)]
struct LinkState {
    conn: Option<Arc<Conn>>,
    error: Option<String>,
    /// Bumped by every attempt and by `forget`: an attempt that finds it changed was superseded and drops its result.
    generation: u64,
    /// The PC's own name, once it has said it (`app_info`).
    name: Option<String>,
    /// Bumped by `pair` and `forget`: a retry loop that finds it changed stops (the PC it retried is not the one).
    epoch: u64,
    /// A retry loop runs (`keep_trying`).
    retrying: bool,
    /// Why the last connection was lost, kept after reconnecting: the page cannot see it otherwise.
    last_lost: Option<String>,
}

struct Inner {
    client: Client,
    dir: PathBuf,
    state: Mutex<LinkState>,
    /// Wakes the retry loop before its delay is over.
    kick: Condvar,
    /// Held while a connection attempt runs: prism-link writes the `pc` file when the PC accepts, so `forget` and
    /// `switch` wait for an attempt in flight before they change that file, or a retry wrote back a PC just forgotten.
    connecting: Mutex<()>,
}

/// What `link_status` returns.
#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    pub paired: bool,
    pub connected: bool,
    pub host: Option<String>,
    /// The raw reason, in English and with system wording ("Connection refused (os error 111)"): a detail.
    pub error: Option<String>,
    /// What `error` means, for the page to say it in the user's language.
    pub error_kind: Option<ErrorKind>,
    /// Not connected, and trying again in the background.
    pub reconnecting: bool,
    /// Why the last connection was lost, if one was.
    pub last_lost: Option<String>,
}

#[derive(Clone)]
pub struct Link(Arc<Inner>);

impl Link {
    /// The phone's identity and paired PC live in `dir`.
    pub fn new(dir: &Path) -> Result<Self, String> {
        Ok(Self(Arc::new(Inner {
            client: Client::new(dir)?,
            dir: dir.to_path_buf(),
            state: Mutex::new(LinkState::default()),
            kick: Condvar::new(),
            connecting: Mutex::new(()),
        })))
    }

    /// Connects to the saved PC, if any, in the background; the outcome shows in `status`.
    pub fn connect_saved(&self) {
        let Some(saved) = self.0.client.saved() else {
            return;
        };
        let epoch = lock(&self.0.state).epoch;
        let link = self.clone();
        let _ = std::thread::Builder::new()
            .name("prism-link-connect".into())
            .spawn(move || {
                // A PC that removed this phone is forgotten (`revoked`): nothing to try again.
                if link
                    .connect(&saved, Some(epoch))
                    .is_err_and(|error| error != REVOKED)
                {
                    link.keep_trying();
                }
            });
    }

    /// Tries the saved PC again until it answers, in the background; one loop at a time.
    fn keep_trying(&self) {
        let epoch = {
            let mut state = lock(&self.0.state);
            if state.retrying {
                return;
            }
            state.retrying = true;
            state.epoch
        };
        let link = self.clone();
        let spawned = std::thread::Builder::new()
            .name("prism-link-retry".into())
            .spawn(move || {
                let mut delay = RETRY_FIRST;
                loop {
                    {
                        let state = lock(&link.0.state);
                        let (mut state, _) = link
                            .0
                            .kick
                            .wait_timeout(state, delay)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        let connected = state.conn.as_ref().is_some_and(|conn| conn.is_open());
                        if state.epoch != epoch || connected {
                            state.retrying = false;
                            return;
                        }
                    }
                    let saved = link.0.client.saved();
                    let done = match &saved {
                        None => true,
                        Some(saved) => link.connect(saved, Some(epoch)).is_ok(),
                    };
                    if done {
                        lock(&link.0.state).retrying = false;
                        return;
                    }
                    delay = (delay * 2).min(RETRY_MAX);
                }
            });
        if spawned.is_err() {
            lock(&self.0.state).retrying = false;
        }
    }

    /// Pairs with a `prism-pair:v1;...` code and connects. Blocks until the PC answers.
    pub fn pair(&self, code: &str) -> Result<(), String> {
        self.new_epoch();
        match Invitation::decode(&normalize_code(code)) {
            Ok(invitation) => self.connect(&invitation, None),
            Err(error) => {
                lock(&self.0.state).error = Some(error.clone());
                Err(error)
            }
        }
    }

    /// Drops the connection and the paired PC, also from the known ones; the phone's own identity stays.
    pub fn forget(&self) {
        let current = self.0.client.saved();
        self.drop_connection();
        let _attempt = lock(&self.0.connecting);
        if let Some(current) = current {
            let records: Vec<KnownRecord> = self
                .records()
                .into_iter()
                .filter(|record| !same_pc(&record.code, &current))
                .collect();
            self.save_records(&records);
        }
        // `pc` is the file prism-link keeps the paired PC in.
        let _ = std::fs::remove_file(self.0.dir.join("pc"));
    }

    /// Stops the retry loop: the PC it tries is replaced or forgotten.
    fn new_epoch(&self) {
        lock(&self.0.state).epoch += 1;
        self.0.kick.notify_all();
    }

    pub fn set_name(&self, name: &str) {
        lock(&self.0.state).name = Some(name.to_string());
        if let Some(current) = self.0.client.saved() {
            let mut records = self.records();
            if let Some(record) = records
                .iter_mut()
                .find(|record| same_pc(&record.code, &current))
            {
                if record.name.as_deref() != Some(name) {
                    record.name = Some(name.to_string());
                    self.save_records(&records);
                }
            }
        }
    }

    fn records(&self) -> Vec<KnownRecord> {
        std::fs::read_to_string(self.0.dir.join("pcs.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save_records(&self, records: &[KnownRecord]) {
        if let Ok(text) = serde_json::to_string(records) {
            let _ = write_file_private(&self.0.dir.join("pcs.json"), text.as_bytes());
        }
    }

    /// Keeps a PC the phone just connected to among the known ones (its pairing code dropped).
    fn remember(&self, invitation: &Invitation) {
        let kept = Invitation {
            token: None,
            ..invitation.clone()
        };
        let mut records = self.records();
        match records
            .iter_mut()
            .find(|record| same_pc(&record.code, &kept))
        {
            Some(record) => record.code = kept.encode(),
            None => records.push(KnownRecord {
                code: kept.encode(),
                name: None,
            }),
        }
        self.save_records(&records);
    }

    /// Every PC paired, the current one marked.
    pub fn known(&self) -> Vec<KnownPc> {
        let current = self.0.client.saved();
        self.records()
            .into_iter()
            .filter_map(|record| {
                let invitation = Invitation::decode(&record.code).ok()?;
                Some(KnownPc {
                    current: current
                        .as_ref()
                        .is_some_and(|pc| pc.fingerprint == invitation.fingerprint),
                    id: invitation.fingerprint.clone(),
                    name: record.name,
                    host: invitation.hosts.first().cloned(),
                })
            })
            .collect()
    }

    /// Makes another known PC the current one and connects to it in the background.
    pub fn switch(&self, id: &str) -> Result<(), String> {
        let record = self
            .records()
            .into_iter()
            .find(|record| {
                Invitation::decode(&record.code)
                    .is_ok_and(|invitation| invitation.fingerprint == id)
            })
            .ok_or_else(|| "this PC is not among the paired ones".to_string())?;
        self.drop_connection();
        {
            let _attempt = lock(&self.0.connecting);
            write_file_private(&self.0.dir.join("pc"), record.code.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        self.connect_saved();
        Ok(())
    }

    /// Ends the current connection and its retries, and what the page knows of that PC.
    fn drop_connection(&self) {
        self.new_epoch();
        let old = {
            let mut state = lock(&self.0.state);
            state.generation += 1;
            state.error = None;
            state.name = None;
            state.last_lost = None;
            state.conn.take()
        };
        if let Some(conn) = old {
            conn.stop.store(true, Ordering::SeqCst);
            conn.close(LOST);
        }
    }

    /// The current PC refused this phone: forgotten, with the reason kept for the pairing screen.
    fn revoked(&self, invitation: &Invitation) {
        let records: Vec<KnownRecord> = self
            .records()
            .into_iter()
            .filter(|record| !same_pc(&record.code, invitation))
            .collect();
        self.save_records(&records);
        if self
            .0
            .client
            .saved()
            .is_some_and(|pc| pc.fingerprint == invitation.fingerprint)
        {
            let _ = std::fs::remove_file(self.0.dir.join("pc"));
        }
        self.new_epoch();
        lock(&self.0.state).error = Some(REVOKED.to_string());
    }

    /// The link's state; asked while the connection is lost, it also makes the retry loop try now.
    pub fn status(&self) -> Status {
        let state = lock(&self.0.state);
        if state.retrying {
            self.0.kick.notify_all();
        }
        let open = state.conn.as_ref().filter(|conn| conn.is_open());
        let saved = self.0.client.saved();
        let address = open
            .map(|conn| conn.host.clone())
            .or_else(|| saved.as_ref().and_then(|pc| pc.hosts.first().cloned()));
        Status {
            paired: saved.is_some(),
            connected: open.is_some(),
            host: state.name.clone().filter(|_| open.is_some()).or(address),
            error: state.error.clone(),
            error_kind: state.error.as_deref().map(ErrorKind::of),
            reconnecting: state.retrying && open.is_none(),
            last_lost: state.last_lost.clone(),
        }
    }

    pub fn is_connected(&self) -> bool {
        lock(&self.0.state)
            .conn
            .as_ref()
            .is_some_and(|conn| conn.is_open())
    }

    /// Sends a request to the PC and waits for its answer.
    pub fn call(&self, op: &str, args: Value) -> Result<Value, String> {
        self.conn()?.request(op, args, None)
    }

    /// `engine_start`: the engine's messages go to `sink` until it exits or the connection ends.
    pub fn start_engine(&self, args: Value, sink: Sink) -> Result<Value, String> {
        self.conn()?.request("engine_start", args, Some(sink))
    }

    fn conn(&self) -> Result<Arc<Conn>, String> {
        let state = lock(&self.0.state);
        match &state.conn {
            Some(conn) if conn.is_open() => Ok(conn.clone()),
            _ => Err(state
                .error
                .clone()
                .unwrap_or_else(|| NOT_LINKED.to_string())),
        }
    }

    /// `epoch`: an attempt for the saved PC, given up when `forget`, `pair` or `switch` came since (the PC it was
    /// started for is no longer the one): it would write that PC back.
    fn connect(&self, invitation: &Invitation, epoch: Option<u64>) -> Result<(), String> {
        let generation = {
            let mut state = lock(&self.0.state);
            state.generation += 1;
            state.error = None;
            state.generation
        };
        let attempt = lock(&self.0.connecting);
        if epoch.is_some_and(|epoch| epoch != lock(&self.0.state).epoch) {
            return Err("superseded by another connection attempt".to_string());
        }
        let lines = match self.0.client.connect(invitation) {
            Ok(lines) => lines,
            Err(error) => {
                if invitation.token.is_none() && error == NOT_PAIRED_ANSWER {
                    self.revoked(invitation);
                    return Err(REVOKED.to_string());
                }
                let mut state = lock(&self.0.state);
                if state.generation == generation {
                    state.error = Some(error.clone());
                }
                return Err(error);
            }
        };
        let conn = Arc::new(Conn::new(
            invitation.hosts.first().cloned().unwrap_or_default(),
        ));
        let old = {
            let mut state = lock(&self.0.state);
            if state.generation != generation {
                return Err("superseded by another connection attempt".to_string());
            }
            state.conn.replace(conn.clone())
        };
        self.remember(invitation);
        drop(attempt);
        if let Some(old) = old {
            old.stop.store(true, Ordering::SeqCst);
            old.close(LOST);
        }
        let link = self.clone();
        let thread_conn = conn.clone();
        let spawned = std::thread::Builder::new()
            .name("prism-link".into())
            .spawn(move || {
                let reason = thread_conn.run(lines);
                thread_conn.close(LOST);
                let mut state = lock(&link.0.state);
                let current = state
                    .conn
                    .as_ref()
                    .is_some_and(|c| Arc::ptr_eq(c, &thread_conn));
                let lost = current && !thread_conn.stop.load(Ordering::SeqCst);
                if current {
                    state.conn = None;
                    if lost {
                        state.error = Some(format!("{LOST}: {reason}"));
                        state.last_lost = Some(reason);
                    }
                }
                drop(state);
                if lost {
                    link.keep_trying();
                }
            });
        if let Err(error) = spawned {
            conn.close(LOST);
            let mut state = lock(&self.0.state);
            state.conn = None;
            state.error = Some(error.to_string());
            return Err(error.to_string());
        }
        Ok(())
    }
}

pub const NOT_LINKED: &str = "Not linked to a PC: pair one in the pairing screen.";
/// the PC removed this phone (`prism-remote revoke`, or the window's list). The phone forgets
/// it and shows the pairing screen with this, instead of failing to reach it for ever.
pub const REVOKED: &str = "This PC removed this phone: pair it again with a code from the PC.";
/// What the PC answers a phone it does not know (prism-link).
const NOT_PAIRED_ANSWER: &str = "DENIED this device is not paired (or was revoked)";

/// What a link error means, whatever its wording: the page says it in the user's language and keeps the raw error as
/// a detail (audit 2026-11-23, FIN-33: "127.0.0.1:47512: Connection refused (os error 111)" was all the user saw).
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// No PC paired yet.
    NotLinked,
    /// The PC removed this phone.
    Revoked,
    /// The connection was up, then dropped.
    Lost,
    /// The PC's machine answers but nothing listens on the port: Prism, or its phone link, is not running there.
    Refused,
    /// No answer at all: the PC is off, asleep, or on another network.
    Timeout,
    /// The phone has no route to that address (no network, or not on the same network as the PC, local or Tailscale).
    Unreachable,
    /// The PC refused the pairing code: already used, expired, or never given.
    CodeRefused,
    /// The text is not a Prism pairing code.
    CodeInvalid,
    /// The machine at that address is not the PC this phone was paired with (its certificate differs).
    OtherPc,
    /// Anything else: only the raw error says.
    Other,
}

impl ErrorKind {
    pub fn of(error: &str) -> Self {
        // Linux and Android errno values: they do not change with the system's language or C library wording.
        let os = |codes: &[u32]| {
            codes
                .iter()
                .any(|code| error.contains(&format!("(os error {code})")))
        };
        if error == NOT_LINKED {
            Self::NotLinked
        } else if error == REVOKED || error == NOT_PAIRED_ANSWER {
            Self::Revoked
        } else if error.starts_with(LOST) {
            Self::Lost
        } else if os(&[111]) {
            Self::Refused
        } else if os(&[110]) || error.ends_with("connection timed out") {
            Self::Timeout
        } else if os(&[100, 101, 113]) {
            Self::Unreachable
        } else if error.starts_with("DENIED") && error.contains("pairing code") {
            Self::CodeRefused
        } else if error.contains("certificate is not the one paired") {
            Self::OtherPc
        } else if [
            "not a Prism pairing code",
            "unexpected field",
            "no address",
            "no port",
            "no fingerprint",
            "invalid socket address syntax",
        ]
        .iter()
        .any(|text| error.contains(text))
        {
            Self::CodeInvalid
        } else {
            Self::Other
        }
    }
}

/// A pairing code typed on the phone's keyboard comes back with spaces and capitals the keyboard added
///, and one pasted from the terminal with line breaks. A code has no
/// whitespace, and every part of it is lower case (hex fingerprint and token, digits, IP addresses): both are undone.
pub fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// A PC this phone was paired with (several PCs, and a way to switch between them).
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct KnownPc {
    /// The PC's certificate fingerprint.
    pub id: String,
    pub name: Option<String>,
    pub host: Option<String>,
    /// The PC the phone connects to.
    pub current: bool,
}

/// `pcs.json`: every PC paired, as its invitation without the pairing code, and its name once it said it.
#[derive(serde::Deserialize, Serialize, Clone, Default)]
struct KnownRecord {
    code: String,
    name: Option<String>,
}

fn write_file_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use prism_link::{Server, ServerLines};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path =
                std::env::temp_dir().join(format!("prism-mobile-test-{}-{n}", std::process::id()));
            Self(path)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    type Handler = Arc<dyn Fn(&mut ServerLines) + Send + Sync>;

    /// A PC that follows the protocol's framing and lets each test script what it says after `OK`.
    struct FakePc {
        server: Arc<Server>,
        port: u16,
        _dir: Dir,
    }

    impl FakePc {
        fn start(handler: Handler) -> Self {
            let dir = Dir::new();
            let server = Server::new(&dir.0.join("pc")).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let accepting = server.clone();
            std::thread::spawn(move || {
                for tcp in listener.incoming().flatten() {
                    let (server, handler) = (accepting.clone(), handler.clone());
                    std::thread::spawn(move || {
                        let _ = server.accept(tcp, |lines| handler(lines));
                    });
                }
            });
            Self {
                server,
                port,
                _dir: dir,
            }
        }

        fn code(&self) -> String {
            self.server
                .invite(vec!["127.0.0.1".to_string()], self.port)
                .unwrap()
                .encode()
        }
    }

    fn request(lines: &mut ServerLines) -> Option<Value> {
        serde_json::from_str(&lines.read().ok()??).ok()
    }

    fn ok(lines: &mut ServerLines, request: &Value, result: Value) {
        let id = &request["id"];
        lines
            .write(&json!({"id": id, "ok": true, "result": result}).to_string())
            .unwrap();
    }

    /// Answers every request with its own `args`.
    fn echo() -> Handler {
        Arc::new(|lines| {
            while let Some(req) = request(lines) {
                let args = req["args"].clone();
                ok(lines, &req, args);
            }
        })
    }

    fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// removed on the PC, the phone kept failing to reach it instead of asking for a new code.
    #[test]
    fn a_phone_the_pc_removed_forgets_it_and_says_why() {
        let pc = FakePc::start(echo());
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&pc.code()).unwrap();
        assert_eq!(link.known().len(), 1);
        for fingerprint in pc.server.paired() {
            pc.server.revoke(&fingerprint).unwrap();
        }
        // The next connection (a restart of the app, or a retry after a loss) is refused.
        let again = Link::new(&phone.0).unwrap();
        again.connect_saved();
        wait_for("the refusal", || again.status().error.is_some());
        let status = again.status();
        assert!(!status.paired && !status.connected && !status.reconnecting);
        assert_eq!(status.error.as_deref(), Some(REVOKED));
        assert!(again.known().is_empty());
    }

    /// a phone paired with two PCs can switch between them.
    #[test]
    fn keeps_every_paired_pc_and_switches_between_them() {
        let first = FakePc::start(echo());
        let second = FakePc::start(echo());
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&first.code()).unwrap();
        link.set_name("desk");
        link.pair(&second.code()).unwrap();
        let known = link.known();
        assert_eq!(known.len(), 2);
        assert_eq!(known[0].name.as_deref(), Some("desk"));
        assert!(!known[0].current && known[1].current);
        link.switch(&known[0].id).unwrap();
        wait_for("the first PC", || link.is_connected());
        assert!(link.known()[0].current);
        assert_eq!(link.call("echo", json!({"n": 1})).unwrap(), json!({"n": 1}));
        assert!(link.switch("nope").is_err());
        // Forgetting the current PC keeps the other one.
        link.forget();
        let known = link.known();
        assert_eq!(known.len(), 1);
        assert!(!known[0].current);
    }

    #[test]
    fn pairs_with_a_code_then_reconnects_from_the_saved_pc() {
        let pc = FakePc::start(echo());
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        assert_eq!(
            link.status(),
            Status {
                paired: false,
                connected: false,
                host: None,
                error: None,
                error_kind: None,
                reconnecting: false,
                last_lost: None
            }
        );
        assert_eq!(link.call("x", json!({})).unwrap_err(), NOT_LINKED);

        link.pair(&pc.code()).unwrap();
        let status = link.status();
        assert!(status.paired && status.connected && status.error.is_none());
        assert_eq!(status.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(link.call("echo", json!({"a": 1})).unwrap(), json!({"a": 1}));
        assert_eq!(pc.server.paired().len(), 1);

        // A new start of the app: same folder, no code.
        let again = Link::new(&phone.0).unwrap();
        assert!(again.status().paired && !again.status().connected);
        again.connect_saved();
        wait_for("reconnection", || again.is_connected());
        assert_eq!(again.call("echo", json!("hi")).unwrap(), json!("hi"));
        assert_eq!(pc.server.paired().len(), 1);

        again.forget();
        let status = again.status();
        assert!(!status.paired && !status.connected);
        assert!(Link::new(&phone.0).unwrap().status().paired == false);
    }

    #[test]
    fn a_refused_answer_is_an_error_and_the_connection_stays() {
        let pc = FakePc::start(Arc::new(|lines| {
            while let Some(req) = request(lines) {
                let id = req["id"].clone();
                lines
                    .write(&json!({"id": id, "ok": false, "error": "no such op"}).to_string())
                    .unwrap();
                lines.write("not json at all").unwrap();
            }
        }));
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&pc.code()).unwrap();
        assert_eq!(link.call("nope", json!({})).unwrap_err(), "no such op");
        assert_eq!(link.call("nope", json!({})).unwrap_err(), "no such op");
        assert!(link.is_connected());
    }

    #[test]
    fn answers_out_of_order_reach_the_right_request() {
        let pc = FakePc::start(Arc::new(|lines| {
            // Reads three requests, answers them in reverse.
            let mut held = Vec::new();
            for _ in 0..3 {
                match request(lines) {
                    Some(req) => held.push(req),
                    None => return,
                }
            }
            for req in held.iter().rev() {
                let args = req["args"].clone();
                ok(lines, req, args);
            }
            while request(lines).is_some() {}
        }));
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&pc.code()).unwrap();
        let callers: Vec<_> = (0..3)
            .map(|n| {
                let link = link.clone();
                std::thread::spawn(move || link.call("op", json!({"n": n})))
            })
            .collect();
        for (n, caller) in callers.into_iter().enumerate() {
            assert_eq!(caller.join().unwrap().unwrap(), json!({"n": n}));
        }
    }

    #[test]
    fn engine_events_reach_only_their_engine() {
        let pc = FakePc::start(Arc::new(|lines| {
            let mut started = Vec::new();
            while started.len() < 2 {
                let Some(req) = request(lines) else { return };
                let engine = req["args"]["engine"].clone();
                ok(lines, &req, engine.clone());
                started.push(engine);
            }
            let event = |lines: &mut ServerLines, engine: u64, message: Value| {
                lines
                    .write(
                        &json!({"event": "engine", "engine": engine, "message": message})
                            .to_string(),
                    )
                    .unwrap();
            };
            event(lines, 8, json!({"kind": "line", "line": "b1"}));
            event(lines, 7, json!({"kind": "line", "line": "a1"}));
            event(lines, 8, json!({"kind": "stderr", "line": "b2"}));
            event(lines, 99, json!({"kind": "line", "line": "nobody"}));
            event(
                lines,
                7,
                json!({"kind": "exit", "code": 0, "signal": null, "stderr": []}),
            );
            event(lines, 7, json!({"kind": "line", "line": "after exit"}));
            while request(lines).is_some() {}
        }));
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&pc.code()).unwrap();
        let collect = || {
            let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
            let sink: Sink = {
                let seen = seen.clone();
                Arc::new(move |message| lock(&seen).push(message))
            };
            (seen, sink)
        };
        let ((a, sink_a), (b, sink_b)) = (collect(), collect());
        assert_eq!(
            link.start_engine(json!({"engine": 7}), sink_a).unwrap(),
            json!(7)
        );
        assert_eq!(
            link.start_engine(json!({"engine": 8}), sink_b).unwrap(),
            json!(8)
        );
        wait_for("engine events", || {
            lock(&a).len() == 2 && lock(&b).len() == 2
        });
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            *lock(&a),
            vec![
                json!({"kind": "line", "line": "a1"}),
                json!({"kind": "exit", "code": 0, "signal": null, "stderr": []}),
            ]
        );
        assert_eq!(
            *lock(&b),
            vec![
                json!({"kind": "line", "line": "b1"}),
                json!({"kind": "stderr", "line": "b2"}),
            ]
        );
    }

    #[test]
    fn losing_the_connection_fails_requests_and_ends_engines() {
        let pc = FakePc::start(Arc::new(|lines| {
            let Some(first) = request(lines) else { return };
            ok(lines, &first, json!(1));
            // The next request is never answered: the PC goes away instead.
            let _ = request(lines);
        }));
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&pc.code()).unwrap();
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink: Sink = {
            let seen = seen.clone();
            Arc::new(move |message| lock(&seen).push(message))
        };
        link.start_engine(json!({}), sink).unwrap();
        let error = link.call("hang", json!({})).unwrap_err();
        assert!(error.contains("PC"), "unreadable error: {error}");
        assert_eq!(
            *lock(&seen),
            vec![
                json!({"kind": "exit", "code": null, "signal": null, "stderr": [LOST], "lost": true})
            ]
        );
        wait_for("the status to notice", || !link.status().connected);
        let status = link.status();
        assert!(status.paired && status.error.unwrap().starts_with(LOST));
        assert!(link.call("again", json!({})).is_err());
    }

    #[test]
    fn a_lost_connection_comes_back_by_itself_until_the_pc_is_forgotten() {
        // Each connection answers one request, then the PC drops it.
        let pc = FakePc::start(Arc::new(|lines| {
            if let Some(req) = request(lines) {
                let args = req["args"].clone();
                ok(lines, &req, args);
            }
        }));
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        link.pair(&pc.code()).unwrap();
        assert_eq!(link.call("echo", json!(1)).unwrap(), json!(1));
        wait_for("the loss", || link.status().reconnecting);
        wait_for("the reconnection", || link.is_connected());
        let status = link.status();
        assert!(status.connected && !status.reconnecting);
        assert_eq!(link.call("echo", json!(2)).unwrap(), json!(2));

        // Forgotten while it retries: the loop stops and nothing connects again.
        wait_for("the second loss", || link.status().reconnecting);
        link.forget();
        std::thread::sleep(RETRY_FIRST * 3);
        let status = link.status();
        assert!(
            !status.paired && !status.connected && !status.reconnecting,
            "{status:?}"
        );
    }

    #[test]
    fn a_refused_pairing_code_shows_in_the_status() {
        let pc = FakePc::start(echo());
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        let code = pc.code();
        link.pair(&code).unwrap();

        // The same one-time code from another phone.
        let other = Dir::new();
        let intruder = Link::new(&other.0).unwrap();
        let error = intruder.pair(&code).unwrap_err();
        assert!(error.contains("pairing code"), "{error}");
        let status = intruder.status();
        assert!(!status.paired && !status.connected);
        assert_eq!(status.error.as_deref(), Some(error.as_str()));

        // A code that is not one.
        let error = intruder.pair("hello").unwrap_err();
        assert_eq!(intruder.status().error, Some(error));
    }

    /// Audit 2026-11-23, FIN-35: a code typed on the phone's keyboard got a space and a capital ("prism-pair: V1").
    #[test]
    fn a_code_mangled_by_the_keyboard_still_pairs() {
        let pc = FakePc::start(echo());
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();
        let mangled = pc
            .code()
            .replacen("prism-pair:v1;", "Prism-pair: V1; ", 1)
            .replace(";t=", ";\nT=")
            .to_uppercase()
            .replacen("PRISM", "Prism", 1);
        assert_ne!(mangled, pc.code());
        link.pair(&mangled).unwrap();
        assert!(link.status().connected);
        assert_eq!(
            normalize_code(" prism-pair:V1;\n h=10.0.0.2 "),
            "prism-pair:v1;h=10.0.0.2"
        );
    }

    /// Audit 2026-11-23, FIN-33: the page says what went wrong in the user's language, from `error_kind`.
    #[test]
    fn link_errors_have_a_kind_the_page_can_translate() {
        let phone = Dir::new();
        let link = Link::new(&phone.0).unwrap();

        // Nothing listens on the PC's port: refused.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let pc = FakePc::start(echo());
        let code = pc
            .code()
            .replace(&format!(";p={}", pc.port), &format!(";p={port}"));
        let error = link.pair(&code).unwrap_err();
        assert!(error.contains("(os error 111)"), "{error}");
        assert_eq!(link.status().error_kind, Some(ErrorKind::Refused));

        // Not a code.
        link.pair("hello").unwrap_err();
        assert_eq!(link.status().error_kind, Some(ErrorKind::CodeInvalid));

        // A code already used.
        let code = pc.code();
        Link::new(&Dir::new().0).unwrap().pair(&code).unwrap();
        link.pair(&code).unwrap_err();
        assert_eq!(link.status().error_kind, Some(ErrorKind::CodeRefused));

        // The wordings that cannot be produced here without a network.
        for (error, kind) in [
            ("10.0.0.9:47392: connection timed out", ErrorKind::Timeout),
            (
                "10.0.0.9:47392: Connection timed out (os error 110)",
                ErrorKind::Timeout,
            ),
            (
                "10.0.0.9:47392: Network is unreachable (os error 101)",
                ErrorKind::Unreachable,
            ),
            (
                "10.0.0.9:47392: No route to host (os error 113)",
                ErrorKind::Unreachable,
            ),
            (
                "invalid peer certificate: Other(the PC's certificate is not the one paired)",
                ErrorKind::OtherPc,
            ),
            (REVOKED, ErrorKind::Revoked),
            (NOT_LINKED, ErrorKind::NotLinked),
            (
                "connection to the PC lost: the PC closed the connection",
                ErrorKind::Lost,
            ),
            (
                "10.0.0.9:47392: Connection reset by peer (os error 104)",
                ErrorKind::Other,
            ),
        ] {
            assert_eq!(ErrorKind::of(error), kind, "{error}");
        }
        assert_eq!(
            serde_json::to_value(ErrorKind::CodeRefused).unwrap(),
            json!("code_refused")
        );
    }
}
