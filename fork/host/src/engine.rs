//! The Prism engine as a child process in RPC mode (JSON lines on stdin and stdout), shared by its clients.
//!
//! Merged from the copies the window (`fork/gui/src-tauri/src/engine.rs`) and the phone server
//! (`fork/android/server/src/engine.rs`) each had: the window and the phones are clients of the same engines.
//!
//! An engine is a process; a client holds an *attachment* to it, with a number of its own (the number the window's page
//! and the phone's protocol call "the engine"). Any number of attachments share one engine:
//! - every line the engine writes goes to every attached client, in the order it wrote them;
//! - a client's request carries its own id, which the host swaps for a unique one on the way to the engine and back on
//!   the response, so two clients may both send `gui-1` and each gets its own answer;
//! - the questions nobody answered are remembered, so a client that attaches later is shown them (`replay`), and one
//!   answered by a client is dismissed for the others;
//! - what the engine said that still holds is remembered, so a client that attaches later is first given it
//!   (`Progress`): the statuses, widgets and title its extensions set, its queue, and what it is in the middle of
//!   (the reply the model is writing, which the engine writes as a start and then fragments that mean nothing
//!   without what came before, the tool calls running, a `!` command running);
//! - opening a session that an engine already runs attaches to that engine (`open`), so a session file never has two
//!   engines.
//!
//! The host decides nothing the engine decides: permissions, sessions and models stay in the engine, which is the only
//! authority. The host only moves lines.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where an attachment's messages go, with the attachment's number; false once nobody listens any more.
pub type Sink = Arc<dyn Fn(u32, EngineMessage) -> bool + Send + Sync>;

/// How the host starts an engine: a program and the arguments that come before `--mode rpc`.
#[derive(Clone, Debug)]
pub struct EngineCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl EngineCommand {
    /// `{prefix}_ENGINE` (a program) and `{prefix}_ENGINE_ARGS` (a JSON array of strings): the window reads
    /// `PRISM_GUI_*`, the server `PRISM_REMOTE_*`; by default the installed `prism`.
    pub fn from_env(prefix: &str) -> Result<Self, String> {
        let program = std::env::var(format!("{prefix}_ENGINE")).unwrap_or_else(|_| "prism".to_string());
        let args = match std::env::var(format!("{prefix}_ENGINE_ARGS")) {
            Ok(raw) if !raw.trim().is_empty() => serde_json::from_str::<Vec<String>>(&raw)
                .map_err(|e| format!("{prefix}_ENGINE_ARGS must be a JSON array of strings: {e}"))?,
            _ => Vec::new(),
        };
        Ok(Self { program, args })
    }

    /// The command to use when `from_env` failed: nothing can start, and `error` says why.
    pub fn unusable() -> Self {
        Self {
            program: String::new(),
            args: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineMessage {
    /// One line of the engine's stdout, unchanged (but for a response's id, which is the asking client's own).
    Line { line: String },
    /// One line of the engine's stderr as it comes, with anything that looks like a secret masked: its technical
    /// output, shown in the side menu's logs for debugging.
    Stderr { line: String },
    /// The engine ended. `stderr` holds its last lines, with anything that looks like a secret masked.
    #[serde(rename_all = "camelCase")]
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
        stderr: Vec<String>,
    },
}

/// The host's own questions to an engine (to know which session it runs) carry ids of this form, and so do the
/// requests of clients once the host has swapped their ids: `h<number>`.
const ID_PREFIX: &str = "h";
const STDERR_LINES: usize = 40;
/// How often the output thread checks whether an engine whose output ended has exited.
const EXIT_POLL: Duration = Duration::from_millis(50);
/// How long an engine gets to say which session it runs before it is taken for one that does not run it.
const STATE_TIMEOUT: Duration = Duration::from_secs(3);
/// The dialogs that wait for an answer.
const QUESTIONS: [&str; 4] = ["select", "confirm", "input", "editor"];

enum Pending {
    /// A client's request: the response goes to this attachment, with the id the client gave (as JSON text).
    Client { handle: u32, original: String },
    /// The host's own request.
    Host(Sender<String>),
}

struct Process {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
    /// The session file it was started on, if any: what it runs until its own answer says otherwise.
    hint: Option<PathBuf>,
    attachments: HashSet<u32>,
    /// The questions it asked (select, confirm, input, editor) that nobody answered yet, as it wrote them.
    questions: Vec<(String, String)>,
    /// What it is in the middle of, for a client that attaches now.
    progress: Progress,
    pending: HashMap<u64, Pending>,
    /// No more attachments: it is being stopped.
    stopping: bool,
}

struct Attachment {
    process: u64,
    /// Who it belongs to: a phone's certificate fingerprint, or the window's own name. Only that owner may take it
    /// back after a cut (`resume`).
    owner: String,
    /// The connection that has it now. A phone back on a new connection takes it even when the PC has not yet seen
    /// the old one end (a cut network sends nothing); that old one, ending later, then leaves it alone.
    holder: u64,
    /// Where its messages go now; none while its client is away. The engine keeps running meanwhile, and what it
    /// says is dropped: the client reads the session again when it comes back.
    sink: Option<Sink>,
    /// Bumped by each loss, so the timer of an earlier one leaves an attachment taken back and lost again alone.
    lost: Option<u64>,
    /// The ids of the questions this client was shown as they came: `replay` shows only the others.
    seen: HashSet<String>,
}

#[derive(Default)]
struct Tables {
    processes: HashMap<u64, Process>,
    attachments: HashMap<u32, Attachment>,
}

pub struct Hub {
    command: EngineCommand,
    env: Vec<(String, String)>,
    next_process: AtomicU64,
    next_handle: AtomicU32,
    next_request: AtomicU64,
    next_mark: AtomicU64,
    tables: Mutex<Tables>,
    /// Opening a session is one at a time: two clients opening the same one at once must meet in one engine.
    opening: Mutex<()>,
}

/// Who asks the hub something: the maintainer (a phone's fingerprint, or the window's name) and the connection.
#[derive(Clone, Debug)]
pub struct Client {
    pub owner: String,
    pub holder: u64,
}

impl Client {
    /// The window's one holder number: its attachments live as long as the window.
    pub const WINDOW_HOLDER: u64 = 0;

    pub fn window() -> Self {
        Self {
            owner: "window".into(),
            holder: Self::WINDOW_HOLDER,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    /// `env`: variables added to each engine's environment (the phone server tells its engines their screen is a phone).
    pub fn new(command: EngineCommand, env: Vec<(String, String)>) -> Arc<Self> {
        Arc::new(Self {
            command,
            env,
            next_process: AtomicU64::new(1),
            next_handle: AtomicU32::new(1),
            next_request: AtomicU64::new(1),
            next_mark: AtomicU64::new(1),
            tables: Mutex::new(Tables::default()),
            opening: Mutex::new(()),
        })
    }

    /// Opens `session` (or a new one) in `cwd` for `client`: attaches it to the engine that already runs that session,
    /// else starts one. Returns the attachment's number. A session file never has two engines.
    pub fn open(
        self: &Arc<Self>,
        client: &Client,
        cwd: PathBuf,
        session: Option<String>,
        sink: Sink,
    ) -> Result<u32, String> {
        let _one_at_a_time = lock(&self.opening);
        let wanted = session.as_ref().map(|path| canonical(&cwd, path));
        if let Some(wanted) = &wanted {
            if let Some(process) = self.running(wanted) {
                return self
                    .attach_new(process, client, sink)
                    .ok_or_else(|| "this engine is stopping".to_string());
            }
        }
        let process = self.spawn(cwd, session, wanted)?;
        self.attach_new(process, client, sink)
            .ok_or_else(|| "this engine stopped at once".to_string())
    }

    /// The engine that runs `wanted`, if one does: asked, not guessed, since an engine's session changes (`/new`, fork,
    /// clone) after it started. One that does not answer in time is taken for what it was started on.
    fn running(self: &Arc<Self>, wanted: &Path) -> Option<u64> {
        let candidates: Vec<(u64, Option<PathBuf>)> = {
            let tables = lock(&self.tables);
            tables
                .processes
                .iter()
                .filter(|(_, p)| !p.stopping)
                .map(|(id, p)| (*id, p.hint.clone()))
                .collect()
        };
        for (id, hint) in candidates {
            match self.session_file(id) {
                Ok(Some(file)) => {
                    if same_file(Path::new(&file), wanted) {
                        return Some(id);
                    }
                }
                Ok(None) => {}
                // No answer: still booting, or stuck. Its start tells what it runs.
                Err(_) => {
                    if hint.as_deref().is_some_and(|hint| same_file(hint, wanted)) {
                        return Some(id);
                    }
                }
            }
        }
        None
    }

    /// The session file an engine says it runs (`get_state`), `None` when it runs none.
    fn session_file(self: &Arc<Self>, process: u64) -> Result<Option<String>, String> {
        let (tx, rx) = channel();
        let request = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (stdin, line) = {
            let mut tables = lock(&self.tables);
            let process = tables.processes.get_mut(&process).ok_or("gone")?;
            process.pending.insert(request, Pending::Host(tx));
            (
                process.stdin.clone(),
                serde_json::json!({ "id": format!("{ID_PREFIX}{request}"), "type": "get_state" }).to_string(),
            )
        };
        let forget = |hub: &Hub| {
            if let Some(process) = lock(&hub.tables).processes.get_mut(&process) {
                process.pending.remove(&request);
            }
        };
        if let Err(error) = write_line(&stdin, &line) {
            forget(self);
            return Err(error);
        }
        match rx.recv_timeout(STATE_TIMEOUT) {
            Ok(answer) => {
                let record: Value = serde_json::from_str(&answer).map_err(|e| e.to_string())?;
                Ok(record
                    .get("data")
                    .and_then(|data| data.get("sessionFile"))
                    .and_then(Value::as_str)
                    .map(str::to_string))
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                forget(self);
                Err("no answer".into())
            }
        }
    }

    fn attach_new(&self, process: u64, client: &Client, sink: Sink) -> Option<u32> {
        let mut tables = lock(&self.tables);
        let running = tables.processes.get_mut(&process)?;
        if running.stopping {
            return None;
        }
        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
        running.attachments.insert(handle);
        running.progress.give(handle, &sink);
        tables.attachments.insert(
            handle,
            Attachment {
                process,
                owner: client.owner.clone(),
                holder: client.holder,
                sink: Some(sink),
                lost: None,
                seen: HashSet::new(),
            },
        );
        Some(handle)
    }

    fn spawn(self: &Arc<Self>, cwd: PathBuf, session: Option<String>, hint: Option<PathBuf>) -> Result<u64, String> {
        let mut args = self.command.args.clone();
        args.extend(["--mode".to_string(), "rpc".to_string()]);
        if let Some(path) = session {
            args.extend(["--session".to_string(), path]);
        }
        let mut command = Command::new(&self.command.program);
        command
            .args(&args)
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|e| format!("cannot start the engine ({}): {e}", self.command.program))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("engine stderr unavailable")?;
        let child = Arc::new(Mutex::new(child));
        let id = self.next_process.fetch_add(1, Ordering::Relaxed);
        lock(&self.tables).processes.insert(
            id,
            Process {
                stdin: Arc::new(Mutex::new(stdin)),
                child: child.clone(),
                hint,
                attachments: HashSet::new(),
                questions: Vec::new(),
                progress: Progress::default(),
                pending: HashMap::new(),
                stopping: false,
            },
        );

        let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let stderr_tail = tail.clone();
        let hub = Arc::clone(self);
        let stderr_thread = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let line = mask_secrets(&line);
                {
                    let mut tail = lock(&stderr_tail);
                    if tail.len() == STDERR_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line.clone());
                }
                hub.broadcast(id, EngineMessage::Stderr { line });
            }
        });

        let hub = Arc::clone(self);
        thread::spawn(move || {
            // Lines are delivered in the order the engine wrote them: this thread alone reads them.
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                hub.deliver(id, line);
            }
            // Polled, never waited for under the lock, which `stop` needs to kill an engine that outlives its output.
            let status = loop {
                match lock(&child).try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => {}
                    Err(error) => break Err(error),
                }
                thread::sleep(EXIT_POLL);
            };
            let _ = stderr_thread.join();
            let (code, signal) = match status {
                Ok(status) => (status.code(), exit_signal(&status)),
                Err(_) => (None, None),
            };
            let stderr = lock(&tail).iter().cloned().collect();
            hub.ended(
                id,
                EngineMessage::Exit {
                    code,
                    signal,
                    stderr,
                },
            );
        });
        Ok(id)
    }

    /// One line of an engine's stdout: to the client that asked when it is the response to a request, else to everyone.
    fn deliver(&self, process: u64, line: String) {
        let mut targets: Vec<(u32, Sink, String)> = Vec::new();
        {
            let mut tables = lock(&self.tables);
            let Tables {
                processes,
                attachments,
            } = &mut *tables;
            let Some(running) = processes.get_mut(&process) else {
                return;
            };
            if let Some(request) = response_request(&line) {
                match running.pending.remove(&request) {
                    Some(Pending::Host(answer)) => {
                        let _ = answer.send(line);
                    }
                    Some(Pending::Client { handle, original }) => {
                        if let Some(sink) = attachments.get(&handle).and_then(|a| a.sink.clone()) {
                            targets.push((handle, sink, restore_id(&line, &original)));
                        }
                    }
                    // Its client left, or it is a response the host never asked for: nobody wants it.
                    None => {}
                }
            } else {
                running.progress.track(&line);
                let question = track_question(&mut running.questions, &line);
                for handle in &running.attachments {
                    let Some(attachment) = attachments.get_mut(handle) else {
                        continue;
                    };
                    let Some(sink) = attachment.sink.clone() else {
                        continue;
                    };
                    if let Some(id) = &question {
                        attachment.seen.insert(id.clone());
                    }
                    targets.push((*handle, sink, line.clone()));
                }
            }
        }
        self.write_to(targets.into_iter().map(|(h, s, line)| (h, s, EngineMessage::Line { line })));
    }

    fn broadcast(&self, process: u64, message: EngineMessage) {
        let targets: Vec<(u32, Sink, EngineMessage)> = {
            let tables = lock(&self.tables);
            let Some(running) = tables.processes.get(&process) else {
                return;
            };
            running
                .attachments
                .iter()
                .filter_map(|handle| {
                    let sink = tables.attachments.get(handle)?.sink.clone()?;
                    Some((*handle, sink, message.clone()))
                })
                .collect()
        };
        self.write_to(targets.into_iter());
    }

    /// Hands messages to their sinks, outside the lock. A sink that says nobody listens any more is dropped: the
    /// engine goes on, and the attachment is kept as a lost one until its client takes it back or the delay ends.
    fn write_to(&self, targets: impl Iterator<Item = (u32, Sink, EngineMessage)>) {
        for (handle, sink, message) in targets {
            if !sink(handle, message) {
                if let Some(attachment) = lock(&self.tables).attachments.get_mut(&handle) {
                    if attachment.sink.as_ref().is_some_and(|now| Arc::ptr_eq(now, &sink)) {
                        attachment.sink = None;
                    }
                }
            }
        }
    }

    /// The engine ended: its clients are told, then forget it.
    fn ended(&self, process: u64, exit: EngineMessage) {
        self.broadcast(process, exit);
        let mut tables = lock(&self.tables);
        if let Some(running) = tables.processes.remove(&process) {
            for handle in running.attachments {
                tables.attachments.remove(&handle);
            }
        }
    }

    /// Sends a client's line to its engine. A request's id is swapped for one of the host's, to give the response back to
    /// this client; an answer to a question is also told to the other clients, which close it.
    pub fn send(&self, client: &Client, handle: u32, line: &str) -> Result<(), String> {
        if line.contains('\n') || line.contains('\r') {
            return Err("a command is one line".into());
        }
        let record: Value = serde_json::from_str(line).map_err(|_| "a command is a JSON object")?;
        let Value::Object(mut command) = record else {
            return Err("a command is a JSON object".into());
        };
        let is_answer = command.get("type").and_then(Value::as_str) == Some("extension_ui_response");
        let mut dismissed: Vec<(u32, Sink)> = Vec::new();
        let mut answered_id = String::new();
        let (stdin, line) = {
            let mut tables = lock(&self.tables);
            let Tables {
                processes,
                attachments,
            } = &mut *tables;
            let attachment = attachments
                .get(&handle)
                .filter(|a| a.holder == client.holder)
                .ok_or("this engine does not belong to this connection")?;
            let running = processes
                .get_mut(&attachment.process)
                .ok_or("this engine is not running")?;
            let stdin = running.stdin.clone();
            let line = if is_answer {
                let answered = command.get("id").and_then(Value::as_str).map(str::to_string);
                if let Some(id) = answered {
                    answered_id = id.clone();
                    let known = running.questions.iter().any(|(asked, _)| *asked == id);
                    running.questions.retain(|(asked, _)| *asked != id);
                    if known {
                        for other in running.attachments.iter().filter(|other| **other != handle) {
                            if let Some(a) = attachments.get_mut(other) {
                                a.seen.remove(&id);
                                if let Some(sink) = a.sink.clone() {
                                    dismissed.push((*other, sink));
                                }
                            }
                        }
                    }
                }
                line.to_string()
            } else if let Some(Value::String(original)) = command.get("id").cloned() {
                let request = self.next_request.fetch_add(1, Ordering::Relaxed);
                running.pending.insert(
                    request,
                    Pending::Client {
                        handle,
                        original: Value::String(original).to_string(),
                    },
                );
                command.insert("id".into(), Value::String(format!("{ID_PREFIX}{request}")));
                Value::Object(command).to_string()
            } else {
                line.to_string()
            };
            (stdin, line)
        };
        if !dismissed.is_empty() {
            let gone = serde_json::json!({ "type": "extension_ui_dismissed", "id": answered_id, "reason": "answered" }).to_string();
            self.write_to(
                dismissed
                    .into_iter()
                    .map(|(handle, sink)| (handle, sink, EngineMessage::Line { line: gone.clone() })),
            );
        }
        write_line(&stdin, &line)
    }

    /// The questions the engine still waits an answer to that this client was not shown yet, delivered to it as the
    /// engine's lines. A client that attached late, or came back after a cut, asks for them once its transcript is shown.
    pub fn replay(&self, client: &Client, handle: u32) -> Result<(), String> {
        let (sink, lines) = {
            let mut tables = lock(&self.tables);
            let Tables {
                processes,
                attachments,
            } = &mut *tables;
            let attachment = attachments
                .get_mut(&handle)
                .filter(|a| a.holder == client.holder)
                .ok_or("this engine does not belong to this connection")?;
            let running = processes.get(&attachment.process).ok_or("this engine is not running")?;
            let mut lines = Vec::new();
            for (id, line) in &running.questions {
                if attachment.seen.insert(id.clone()) {
                    lines.push(line.clone());
                }
            }
            (attachment.sink.clone(), lines)
        };
        if let Some(sink) = sink {
            self.write_to(lines.into_iter().map(|line| (handle, sink.clone(), EngineMessage::Line { line })));
        }
        Ok(())
    }

    /// A client back after a cut takes the attachment it had, if its engine still runs and it owned it. Everything the
    /// engine said meanwhile was dropped: the client is given what the engine is in the middle of, reads the session
    /// again, then asks for the open questions.
    pub fn resume(&self, client: &Client, handle: u32, sink: Sink) -> bool {
        let mut tables = lock(&self.tables);
        let Tables {
            processes,
            attachments,
        } = &mut *tables;
        let Some(attachment) = attachments.get_mut(&handle) else {
            return false;
        };
        if attachment.owner != client.owner {
            return false;
        }
        let running = processes.get(&attachment.process).filter(|p| !p.stopping);
        if let Some(running) = running {
            running.progress.give(handle, &sink);
        }
        attachment.lost = None;
        attachment.holder = client.holder;
        attachment.sink = Some(sink);
        // Questions it was shown before the cut are shown again by `replay`: the page was reloaded.
        attachment.seen.clear();
        running.is_some()
    }

    /// The client closed its conversation: its attachment ends, and the engine with it unless another client still has it.
    pub fn stop(self: &Arc<Self>, client: &Client, handle: u32, grace: Duration) -> Result<(), String> {
        {
            let tables = lock(&self.tables);
            match tables.attachments.get(&handle) {
                Some(a) if a.holder == client.holder => {}
                _ => return Err("this engine does not belong to this connection".into()),
            }
        }
        self.release(handle, grace);
        Ok(())
    }

    fn release(self: &Arc<Self>, handle: u32, grace: Duration) {
        enum Next {
            Nothing,
            /// The last attachment: the engine stops, and tells it so when it has.
            Stop(Arc<Mutex<Option<ChildStdin>>>, Arc<Mutex<Child>>),
            /// Others keep the engine: this one is told it ended, as a stopped engine tells its client.
            Leave(Option<Sink>),
        }
        let next = {
            let mut tables = lock(&self.tables);
            let Some(process) = tables.attachments.get(&handle).map(|a| a.process) else {
                return;
            };
            let Some(running) = tables.processes.get_mut(&process) else {
                return;
            };
            running
                .pending
                .retain(|_, pending| !matches!(pending, Pending::Client { handle: asked, .. } if *asked == handle));
            if running.stopping {
                Next::Nothing
            } else if running.attachments.len() == 1 {
                running.stopping = true;
                Next::Stop(running.stdin.clone(), running.child.clone())
            } else {
                running.attachments.remove(&handle);
                Next::Leave(tables.attachments.remove(&handle).and_then(|a| a.sink))
            }
        };
        match next {
            Next::Nothing => {}
            Next::Stop(stdin, child) => stop_process(&stdin, &child, grace),
            Next::Leave(sink) => {
                if let Some(sink) = sink {
                    sink(
                        handle,
                        EngineMessage::Exit {
                            code: None,
                            signal: None,
                            stderr: Vec::new(),
                        },
                    );
                }
            }
        }
    }

    /// Its client went away: the attachment stays for `keep` (a turn in progress ends and is saved), its messages dropped,
    /// and ends then unless the client takes it back first. Nothing happens if another connection of that client has it now.
    pub fn lost(self: &Arc<Self>, handle: u32, holder: u64, keep: Duration, grace: Duration) {
        let mark = self.next_mark.fetch_add(1, Ordering::Relaxed);
        {
            let mut tables = lock(&self.tables);
            let Some(attachment) = tables.attachments.get_mut(&handle) else {
                return;
            };
            if attachment.holder != holder {
                return;
            }
            attachment.sink = None;
            attachment.lost = Some(mark);
        }
        let hub = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(keep);
            let still = lock(&hub.tables)
                .attachments
                .get(&handle)
                .is_some_and(|a| a.lost == Some(mark));
            if still {
                hub.release(handle, grace);
            }
        });
    }

    /// Stops every engine (the window closes).
    pub fn stop_all(&self, grace: Duration) {
        let all: Vec<_> = {
            let mut tables = lock(&self.tables);
            tables
                .processes
                .values_mut()
                .map(|p| {
                    p.stopping = true;
                    (p.stdin.clone(), p.child.clone())
                })
                .collect()
        };
        for (stdin, child) in all {
            stop_process(&stdin, &child, grace);
        }
    }

    /// The session files of the engines a client other than the window holds (a phone's conversations, a phone away
    /// for a few minutes included), each once: the window lists them as open.
    /// Asks each such engine which session it runs, so it may take up to `STATE_TIMEOUT` per engine: never on the
    /// window's main thread.
    pub fn held_elsewhere(self: &Arc<Self>) -> Vec<String> {
        let candidates: Vec<(u64, Option<PathBuf>)> = {
            let tables = lock(&self.tables);
            tables
                .processes
                .iter()
                .filter(|(_, p)| {
                    !p.stopping
                        && p.attachments.iter().any(|handle| {
                            tables
                                .attachments
                                .get(handle)
                                .is_some_and(|a| a.holder != Client::WINDOW_HOLDER)
                        })
                })
                .map(|(id, p)| (*id, p.hint.clone()))
                .collect()
        };
        let mut files: Vec<String> = Vec::new();
        for (id, hint) in candidates {
            let file = match self.session_file(id) {
                Ok(file) => file,
                Err(_) => hint.map(|hint| hint.display().to_string()),
            };
            // A conversation with nothing in it yet has no file: nothing to list.
            if let Some(file) = file.filter(|file| Path::new(file).exists()) {
                if !files.contains(&file) {
                    files.push(file);
                }
            }
        }
        files
    }

    /// How many engines run, for tests and diagnostics.
    pub fn running_engines(&self) -> usize {
        lock(&self.tables).processes.len()
    }
}

fn write_line(stdin: &Mutex<Option<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut stdin = lock(stdin);
    let stdin = stdin.as_mut().ok_or("this engine is stopping")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("cannot write to the engine: {e}"))
}

/// Closes the engine's stdin, which makes it shut down cleanly; kills it if it is still running after the grace period.
fn stop_process(stdin: &Mutex<Option<ChildStdin>>, child: &Mutex<Child>, grace: Duration) {
    lock(stdin).take();
    let deadline = Instant::now() + grace;
    loop {
        if let Ok(Some(_)) = lock(child).try_wait() {
            return;
        }
        if Instant::now() >= deadline {
            let _ = lock(child).kill();
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// The file `path` names, as the engine would reach it from `cwd`.
fn canonical(cwd: &Path, path: &str) -> PathBuf {
    let joined = cwd.join(path);
    joined.canonicalize().unwrap_or(joined)
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// The number of the request a response answers, if the line is the response to a request of the host's (its id is
/// `h<number>`, which the engine echoes first in the line).
fn response_request(line: &str) -> Option<u64> {
    let rest = line.strip_prefix("{\"id\":\"h")?;
    let end = rest.find('"')?;
    let request = rest[..end].parse().ok()?;
    line.contains("\"type\":\"response\"").then_some(request)
}

/// `line`, a response whose id is the host's, with the id its client gave (`original`, as JSON text).
fn restore_id(line: &str, original: &str) -> String {
    let Some(rest) = line.strip_prefix("{\"id\":\"") else {
        return line.to_string();
    };
    let Some(end) = rest.find('"') else {
        return line.to_string();
    };
    format!("{{\"id\":{original}{}", &rest[end + 1..])
}

/// Notes a question the engine asks (an `extension_ui_request` that waits for an answer), or forgets one it dismissed.
/// Returns the id of a question just asked. Only these few fields of the protocol are read.
fn track_question(questions: &mut Vec<(String, String)>, line: &str) -> Option<String> {
    if !line.contains("extension_ui_") {
        return None;
    }
    let record = serde_json::from_str::<Value>(line).ok()?;
    let id = record.get("id")?.as_str()?.to_string();
    match record.get("type")?.as_str()? {
        "extension_ui_request" if QUESTIONS.contains(&record.get("method")?.as_str()?) => {
            questions.push((id.clone(), line.to_string()));
            Some(id)
        }
        "extension_ui_dismissed" => {
            questions.retain(|(asked, _)| *asked != id);
            None
        }
        _ => None,
    }
}

/// How much of a running `!` command's output is kept for a client that attaches: its latest lines.
const BASH_OUTPUT: usize = 256 * 1024;

/// What an engine said that still holds, as the lines it wrote: what its extensions show (statuses, widgets, title),
/// its queue, and what it is in the middle of (the reply the model is writing, the tool calls running, a `!` command).
/// A client that attaches is given these lines before anything else, so it shows what the others show, the fragments
/// that follow have their beginning, and a call that runs shows as running.
#[derive(Default)]
struct Progress {
    /// The latest line of each thing shown until it is replaced or taken away, in the order they first came: a
    /// status or a widget by its key, the title, the queue, the notice of a turn cut short.
    shown: Vec<(String, String)>,
    /// The reply being written: its `message_start`, then each `message_update`.
    reply: Vec<String>,
    /// The calls running, in the order they started: the call's id, its `tool_execution_start`, and its latest
    /// `tool_execution_update` (each update carries the whole output so far).
    tools: Vec<(String, String, Option<String>)>,
    /// The `!` command running: its `bash_execution_start`, then the latest of its output (`BASH_OUTPUT` bytes of
    /// `bash_execution_update` lines).
    bash: Option<(String, VecDeque<String>, usize)>,
    /// The `!` commands that ended during a turn: the session holds them only once the turn has settled, so a client
    /// that reads it before then would not see them.
    ended: Vec<String>,
}

/// The few fields of an event that say whose it is; the rest of the line is skipped, not kept.
#[derive(Deserialize)]
struct EventHead {
    message: Option<MessageHead>,
    #[serde(rename = "toolCallId")]
    tool_call_id: Option<String>,
    pending: Option<bool>,
}

#[derive(Deserialize)]
struct MessageHead {
    role: String,
}

impl Progress {
    /// Notes one line of the engine's stdout. Only events whose `type` comes first in the line are read, as the
    /// engine writes them; any other line changes nothing.
    fn track(&mut self, line: &str) {
        let Some(kind) = line.strip_prefix("{\"type\":\"").and_then(|rest| rest.split('"').next()) else {
            return;
        };
        let head = || serde_json::from_str::<EventHead>(line).ok();
        let assistant = || head().and_then(|h| h.message).is_some_and(|m| m.role == "assistant");
        match kind {
            "extension_ui_request" | "queue_update" | "session_state" => self.show(kind, line),
            "message_start" if assistant() => self.reply = vec![line.to_string()],
            "message_update" if !self.reply.is_empty() => self.reply.push(line.to_string()),
            "message_end" if assistant() => self.reply.clear(),
            "tool_execution_start" => {
                if let Some(id) = head().and_then(|h| h.tool_call_id) {
                    self.tools.retain(|(running, _, _)| *running != id);
                    self.tools.push((id, line.to_string(), None));
                }
            }
            "tool_execution_update" => {
                if let Some(id) = head().and_then(|h| h.tool_call_id) {
                    if let Some(tool) = self.tools.iter_mut().find(|(running, _, _)| *running == id) {
                        tool.2 = Some(line.to_string());
                    }
                }
            }
            "tool_execution_end" => {
                if let Some(id) = head().and_then(|h| h.tool_call_id) {
                    self.tools.retain(|(running, _, _)| *running != id);
                }
            }
            // The turn's run is over, however it ended: no reply and no call is in progress. A `!` command is the
            // user's own and goes on.
            "agent_end" => {
                self.reply.clear();
                self.tools.clear();
            }
            "bash_execution_start" => self.bash = Some((line.to_string(), VecDeque::new(), 0)),
            "bash_execution_update" => {
                if let Some((_, output, size)) = &mut self.bash {
                    *size += line.len();
                    output.push_back(line.to_string());
                    while *size > BASH_OUTPUT && output.len() > 1 {
                        *size -= output.pop_front().map_or(0, |dropped| dropped.len());
                    }
                }
            }
            "bash_execution_end" => {
                self.bash = None;
                if head().and_then(|h| h.pending) == Some(true) {
                    self.ended.push(line.to_string());
                }
            }
            // The session now holds the commands that ended during the turn.
            "agent_settled" => self.ended.clear(),
            _ => {}
        }
    }

    /// A line that says what is shown from now on: kept under its key in place of the one before, or dropped with
    /// it when it takes the thing away (a status without text, a widget without lines, an empty queue).
    fn show(&mut self, kind: &str, line: &str) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let text = |name: &str| record.get(name).and_then(Value::as_str);
        let filled = |name: &str| record.get(name).and_then(Value::as_array).is_some_and(|list| !list.is_empty());
        let (key, present) = match (kind, text("method")) {
            ("extension_ui_request", Some("setStatus")) => (
                format!("status:{}", text("statusKey").unwrap_or_default()),
                text("statusText").is_some_and(|status| !status.is_empty()),
            ),
            ("extension_ui_request", Some("setWidget")) => {
                (format!("widget:{}", text("widgetKey").unwrap_or_default()), filled("widgetLines"))
            }
            ("extension_ui_request", Some("setTitle")) => ("title".to_string(), true),
            ("queue_update", _) => ("queue".to_string(), filled("steering") || filled("followUp")),
            ("session_state", _) => ("session".to_string(), record.get("state").is_some_and(|state| !state.is_null())),
            _ => return,
        };
        let at = self.shown.iter().position(|(shown, _)| *shown == key);
        match (at, present) {
            (Some(at), true) => self.shown[at].1 = line.to_string(),
            (Some(at), false) => {
                self.shown.remove(at);
            }
            (None, true) => self.shown.push((key, line.to_string())),
            (None, false) => {}
        }
    }

    /// Hands a client that attaches the lines that still hold. Called with the hub's tables locked, so that the lines
    /// the engine writes next reach this client after these: a sink only queues, it never blocks nor calls the hub.
    fn give(&self, handle: u32, sink: &Sink) {
        let shown = self.shown.iter().map(|(_, line)| line);
        let tools = self.tools.iter().flat_map(|(_, start, update)| std::iter::once(start).chain(update));
        let bash = self.bash.iter().flat_map(|(start, output, _)| std::iter::once(start).chain(output));
        for line in shown.chain(&self.reply).chain(tools).chain(bash).chain(&self.ended) {
            sink(handle, EngineMessage::Line { line: line.clone() });
        }
    }
}

/// Available and total memory in bytes, from `/proc/meminfo` (Linux); `None` elsewhere or when unreadable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MemoryInfo {
    pub available: u64,
    pub total: u64,
}

pub fn memory_info() -> Option<MemoryInfo> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

fn parse_meminfo(text: &str) -> Option<MemoryInfo> {
    let field = |name: &str| {
        text.lines().find_map(|line| {
            let rest = line.strip_prefix(name)?.strip_prefix(':')?;
            let kib: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            Some(kib * 1024)
        })
    };
    Some(MemoryInfo {
        available: field("MemAvailable")?,
        total: field("MemTotal")?,
    })
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Masks what looks like a credential in a line of engine diagnostics before a client shows it: values after `Bearer`,
/// known key prefixes, and long unbroken runs of key-like characters.
pub fn mask_secrets(line: &str) -> String {
    const PREFIXES: [&str; 7] = ["sk-", "sk_", "xai-", "AIza", "ghp_", "gho_", "glpat-"];
    let masked = |core: &str, after_bearer: bool| {
        let keylike = core.len() >= 32
            && core
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.+/=".contains(c))
            && core.chars().any(|c| c.is_ascii_digit())
            && core.chars().any(|c| c.is_ascii_alphabetic());
        after_bearer
            || keylike
            || PREFIXES
                .iter()
                .any(|prefix| core.starts_with(prefix) && core.len() > prefix.len() + 8)
    };
    // Words are cut at separators too, so `KEY="sk-…"` and `token:abc…` expose their value.
    let mut out = String::with_capacity(line.len());
    let mut after_bearer = false;
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String, after_bearer: &mut bool| {
        if !word.is_empty() {
            out.push_str(if masked(word, *after_bearer) {
                "•••"
            } else {
                word
            });
            *after_bearer = word.eq_ignore_ascii_case("bearer");
            word.clear();
        }
    };
    for c in line.chars() {
        if c.is_whitespace() || "\"'`,;:=()[]{}<>".contains(c) {
            flush(&mut word, &mut out, &mut after_bearer);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out, &mut after_bearer);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines `progress` gives a client that connects now.
    fn given(progress: &Progress) -> Vec<String> {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let into = lines.clone();
        let sink: Sink = Arc::new(move |_, message| {
            if let EngineMessage::Line { line } = message {
                lock(&into).push(line);
            }
            true
        });
        progress.give(1, &sink);
        let lines = lock(&lines).clone();
        lines
    }

    #[test]
    fn reads_available_memory() {
        let text = "MemTotal:       15728640 kB\nMemFree:  100 kB\nMemAvailable:    2097152 kB\n";
        assert_eq!(
            parse_meminfo(text),
            Some(MemoryInfo {
                available: 2 << 30,
                total: 15 << 30
            })
        );
        assert_eq!(parse_meminfo("MemTotal: 1 kB\n"), None);
    }

    #[test]
    fn masks_keys_and_bearer_tokens() {
        assert_eq!(
            mask_secrets("Authorization: Bearer abc.def"),
            "Authorization: Bearer •••"
        );
        assert_eq!(
            mask_secrets("key=\"sk-proj-1234567890abcdef\" failed"),
            "key=\"•••\" failed"
        );
        assert_eq!(
            mask_secrets("token 0123456789abcdefghij0123456789abcdef"),
            "token •••"
        );
        assert_eq!(
            mask_secrets(
                "OPENAI_API_KEY=sk-0123456789abcdef {\"apiKey\":\"AIza0123456789abcdef\"}"
            ),
            "OPENAI_API_KEY=••• {\"apiKey\":\"•••\"}"
        );
    }

    #[test]
    fn keeps_ordinary_text() {
        let line = "Error: connect ECONNREFUSED 127.0.0.1:8080 /home/user/project/src/main.rs";
        assert_eq!(mask_secrets(line), line);
    }

    #[test]
    fn recognises_and_restores_the_hosts_ids_in_responses() {
        let line = r#"{"id":"h42","type":"response","command":"get_state","success":true,"data":{"a":"\"id\":\"x\""}}"#;
        assert_eq!(response_request(line), Some(42));
        assert_eq!(
            restore_id(line, "\"gui-7\""),
            r#"{"id":"gui-7","type":"response","command":"get_state","success":true,"data":{"a":"\"id\":\"x\""}}"#
        );
        // An id that needs escaping goes back as it came.
        assert_eq!(
            restore_id(r#"{"id":"h1","type":"response"}"#, r#""a\"b""#),
            r#"{"id":"a\"b","type":"response"}"#
        );
        // Not responses of the host's: events, other ids, a nested look-alike.
        assert_eq!(response_request(r#"{"type":"response","id":"h4"}"#), None);
        assert_eq!(response_request(r#"{"id":"gui-1","type":"response"}"#), None);
        assert_eq!(response_request(r#"{"id":"h9","type":"agent_end"}"#), None);
        assert_eq!(response_request(r#"{"id":"hx","type":"response"}"#), None);
    }

    #[test]
    fn keeps_the_reply_being_written_and_the_calls_running_until_they_end() {
        let mut progress = Progress::default();
        let start = r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#;
        let delta = |text: &str| format!(r#"{{"type":"message_update","assistantMessageEvent":{{"type":"text_delta","delta":"{text}"}}}}"#);
        // A user's message is not a reply being written, and an update without its start is not kept.
        progress.track(r#"{"type":"message_start","message":{"role":"user","content":"go"}}"#);
        progress.track(&delta("x"));
        assert!(given(&progress).is_empty());
        progress.track(start);
        progress.track(&delta("a"));
        progress.track(&delta("b"));
        assert_eq!(given(&progress), vec![start.to_string(), delta("a"), delta("b")]);
        // Another message's end leaves the reply; its own end closes it.
        progress.track(r#"{"type":"message_end","message":{"role":"custom","content":"note"}}"#);
        assert_eq!(given(&progress).len(), 3);
        progress.track(r#"{"type":"message_end","message":{"role":"assistant","content":[]}}"#);
        assert!(given(&progress).is_empty());
        // Two calls running: each one's start and its latest update, until its end.
        let call = |kind: &str, id: &str, extra: &str| format!(r#"{{"type":"tool_execution_{kind}","toolCallId":"{id}"{extra}}}"#);
        progress.track(&call("start", "t1", ""));
        progress.track(&call("start", "t2", ""));
        progress.track(&call("update", "t1", r#","partialResult":1"#));
        progress.track(&call("update", "t1", r#","partialResult":2"#));
        assert_eq!(
            given(&progress),
            vec![call("start", "t1", ""), call("update", "t1", r#","partialResult":2"#), call("start", "t2", "")]
        );
        progress.track(&call("end", "t1", ""));
        assert_eq!(given(&progress), vec![call("start", "t2", "")]);
        // A turn that ends leaves nothing in progress, whatever was left open.
        progress.track(start);
        progress.track(r#"{"type":"agent_end","messages":[]}"#);
        assert!(given(&progress).is_empty());
        // Lines that are not the engine's events change nothing.
        progress.track("not json");
        progress.track(r#"{"id":"h1","type":"message_start","message":{"role":"assistant"}}"#);
        assert!(given(&progress).is_empty());
    }

    #[test]
    fn keeps_what_is_shown_until_it_is_replaced_or_taken_away() {
        let mut progress = Progress::default();
        let status = |key: &str, text: &str| format!(r#"{{"type":"extension_ui_request","id":"x","method":"setStatus","statusKey":"{key}","statusText":"{text}"}}"#);
        let widget = |lines: &str| format!(r#"{{"type":"extension_ui_request","id":"x","method":"setWidget","widgetKey":"goal","widgetLines":{lines}}}"#);
        let queue = |steering: &str| format!(r#"{{"type":"queue_update","steering":{steering},"followUp":[]}}"#);
        progress.track(&status("plan", "Plan mode"));
        progress.track(&status("goal", "1 of 3"));
        progress.track(&widget(r#"["step one"]"#));
        progress.track(&queue(r#"["and then"]"#));
        progress.track(r#"{"type":"session_state","state":{"interrupted":true}}"#);
        // A notice and a question are not things that stay shown.
        progress.track(r#"{"type":"extension_ui_request","id":"n","method":"notify","message":"hello"}"#);
        progress.track(r#"{"type":"extension_ui_request","id":"q","method":"confirm","title":"Run?"}"#);
        assert_eq!(given(&progress).len(), 5);
        // The latest of each, in the place of the one before.
        progress.track(&status("plan", "Plan mode, step 2"));
        assert_eq!(given(&progress)[0], status("plan", "Plan mode, step 2"));
        // Taken away: a status without text (or without the field), a widget without lines, an empty queue, no state.
        progress.track(r#"{"type":"extension_ui_request","id":"x","method":"setStatus","statusKey":"plan"}"#);
        progress.track(&status("goal", ""));
        progress.track(&widget("[]"));
        progress.track(&queue("[]"));
        progress.track(r#"{"type":"session_state","state":null}"#);
        assert!(given(&progress).is_empty());
    }

    #[test]
    fn keeps_a_running_user_command_and_the_ones_the_session_does_not_hold_yet() {
        let mut progress = Progress::default();
        let start = r#"{"type":"bash_execution_start","command":"make"}"#;
        let output = |text: &str| format!(r#"{{"type":"bash_execution_update","delta":"{text}"}}"#);
        // Output without a command running is not kept.
        progress.track(&output("stray"));
        assert!(given(&progress).is_empty());
        progress.track(start);
        progress.track(&output("one"));
        progress.track(&output("two"));
        assert_eq!(given(&progress), vec![start.to_string(), output("one"), output("two")]);
        // The end of a turn's run does not end the user's command.
        progress.track(r#"{"type":"agent_end","messages":[]}"#);
        assert_eq!(given(&progress).len(), 3);
        // Only the latest of a long output is kept.
        let long = "x".repeat(BASH_OUTPUT / 2);
        for _ in 0..4 {
            progress.track(&output(&long));
        }
        let kept = given(&progress);
        assert_eq!(kept.len(), 2, "the start and the latest output that fits");
        assert_eq!(kept[0], start);
        // Ended outside a turn, the session holds it: nothing is kept. Ended during a turn, its end is kept until
        // the turn has settled.
        progress.track(r#"{"type":"bash_execution_end","message":{"role":"bashExecution"}}"#);
        assert!(given(&progress).is_empty());
        let pending = r#"{"type":"bash_execution_end","message":{"role":"bashExecution"},"pending":true}"#;
        progress.track(start);
        progress.track(pending);
        assert_eq!(given(&progress), vec![pending.to_string()]);
        progress.track(r#"{"type":"agent_settled"}"#);
        assert!(given(&progress).is_empty());
    }

    #[test]
    fn tracks_questions_until_they_are_dismissed() {
        let mut questions = Vec::new();
        let ask = r#"{"type":"extension_ui_request","id":"q1","method":"confirm","title":"Run?"}"#;
        assert_eq!(track_question(&mut questions, ask).as_deref(), Some("q1"));
        // A notice is not a question.
        assert_eq!(
            track_question(&mut questions, r#"{"type":"extension_ui_request","id":"n1","method":"notify"}"#),
            None
        );
        assert_eq!(questions.len(), 1);
        track_question(&mut questions, r#"{"type":"extension_ui_dismissed","id":"q1","reason":"timeout"}"#);
        assert!(questions.is_empty());
    }
}
