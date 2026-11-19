//! The engine hub with a shell script as the engine: several clients share one
//! engine, each gets its own responses, a late client gets the open questions once, and a session never has two engines.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use prism_host::engine::{Client, EngineCommand, EngineMessage, Hub, Sink};
use serde_json::{json, Value};

/// Says hello, answers `get_state` (with the session it was given) and `ping` (with its pid) like an engine answers a
/// request, asks a question on `ask`, tells what it was answered, leaves on `quit`, and echoes anything else.
const ENGINE: &str = r#"#!/bin/sh
session=""
while [ $# -gt 0 ]; do case "$1" in --session) session="$2";; esac; shift; done
echo "{\"type\":\"ready\",\"pid\":$$}"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | grep -o '"id":"h[0-9]*"' | head -1 | cut -d'"' -f4)
  case "$line" in
    *'"get_state"'*) printf '{"id":"%s","type":"response","command":"get_state","success":true,"data":{"sessionFile":"%s"}}\n' "$id" "$session";;
    *'"ping"'*) printf '{"id":"%s","type":"response","command":"ping","success":true,"data":{"pid":%s}}\n' "$id" "$$";;
    *'"ask"'*) echo '{"type":"extension_ui_request","id":"q1","method":"confirm","title":"Run it?"}';;
    *extension_ui_response*) printf '{"type":"answered","got":%s}\n' "$line";;
    *'"quit"'*) echo '{"type":"bye"}'; exit 3;;
    *) printf '%s\n' "$line";;
  esac
done
"#;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prism-hub-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hub(name: &str) -> (Arc<Hub>, PathBuf) {
    let dir = temp(name);
    let script = dir.join("engine.sh");
    std::fs::write(&script, ENGINE).unwrap();
    let command = EngineCommand {
        program: "sh".into(),
        args: vec![script.to_str().unwrap().into()],
    };
    (Hub::new(command, Vec::new()), dir)
}

/// What one client received: its attachment's messages, in order.
#[derive(Default)]
struct Inbox {
    messages: Mutex<Vec<EngineMessage>>,
    changed: Condvar,
}

impl Inbox {
    fn sink(self: &Arc<Self>) -> Sink {
        let inbox = self.clone();
        Arc::new(move |_, message| {
            inbox.messages.lock().unwrap().push(message);
            inbox.changed.notify_all();
            true
        })
    }

    /// The engine's stdout lines so far, as JSON.
    fn lines(&self) -> Vec<Value> {
        self.messages
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| match m {
                EngineMessage::Line { line } => serde_json::from_str(line).ok(),
                _ => None,
            })
            .collect()
    }

    /// Waits until `found` is true of the lines; the lines then.
    fn wait(&self, what: &str, found: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut guard = self.messages.lock().unwrap();
        loop {
            let lines: Vec<Value> = guard
                .iter()
                .filter_map(|m| match m {
                    EngineMessage::Line { line } => serde_json::from_str(line).ok(),
                    _ => None,
                })
                .collect();
            if found(&lines) {
                return lines;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}; got {lines:?}");
            guard = self.changed.wait_timeout(guard, left).unwrap().0;
        }
    }

    fn wait_type(&self, kind: &str, count: usize) -> Vec<Value> {
        let kind = kind.to_string();
        self.wait(&format!("{count} {kind}"), move |lines| {
            lines.iter().filter(|l| l["type"] == kind.as_str()).count() >= count
        })
    }

    fn count(&self, kind: &str) -> usize {
        self.lines().iter().filter(|l| l["type"] == kind).count()
    }
}

fn phone(owner: &str, holder: u64) -> Client {
    Client {
        owner: owner.into(),
        holder,
    }
}

fn open(hub: &Arc<Hub>, client: &Client, dir: &Path, session: &str, inbox: &Arc<Inbox>) -> u32 {
    hub.open(client, dir.to_path_buf(), Some(session.into()), inbox.sink()).unwrap()
}

fn session_file(dir: &Path, name: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, "").unwrap();
    path.canonicalize().unwrap().to_string_lossy().into_owned()
}

fn send(hub: &Hub, client: &Client, handle: u32, line: Value) {
    hub.send(client, handle, &line.to_string()).unwrap();
}

#[test]
fn two_clients_share_one_engine_and_each_gets_its_own_answers() {
    let (hub, dir) = hub("share");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    assert_ne!(on_window, on_phone, "each client has an attachment of its own");
    assert_eq!(hub.running_engines(), 1, "one engine for one session");

    // Both ask with the same request id: each gets exactly its own answer, with the id it gave.
    send(&hub, &window, on_window, json!({"id":"gui-1","type":"ping"}));
    send(&hub, &phone1, on_phone, json!({"id":"gui-1","type":"ping"}));
    let (from_a, from_b) = (a.wait_type("response", 1), b.wait_type("response", 1));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!((a.count("response"), b.count("response")), (1, 1));
    for lines in [&from_a, &from_b] {
        let response = lines.iter().find(|l| l["type"] == "response").unwrap();
        assert_eq!(response["id"], "gui-1");
        assert_eq!(response["command"], "ping");
    }
    assert_eq!(
        from_a.iter().find(|l| l["type"] == "response").unwrap()["data"]["pid"],
        from_b.iter().find(|l| l["type"] == "response").unwrap()["data"]["pid"],
        "the same process answered both"
    );

    // What one types appears for the other, in order, and goes to the same engine.
    for n in 1..=3 {
        let side = if n % 2 == 0 { (&window, on_window) } else { (&phone1, on_phone) };
        send(&hub, side.0, side.1, json!({"type":"prompt","n":n}));
    }
    for inbox in [&a, &b] {
        let lines = inbox.wait_type("prompt", 3);
        let sent: Vec<_> = lines.iter().filter(|l| l["type"] == "prompt").map(|l| l["n"].clone()).collect();
        assert_eq!(sent, [json!(1), json!(2), json!(3)]);
    }
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn ids_come_back_exactly_as_the_client_wrote_them() {
    let (hub, dir) = hub("ids");
    let session = session_file(&dir, "s.jsonl");
    let (client, inbox) = (Client::window(), Arc::new(Inbox::default()));
    let handle = open(&hub, &client, &dir, &session, &inbox);
    for id in ["a\"b\\c", "é\u{1F600}", "", "h1", "{\"id\":\"h2\""] {
        let before = inbox.count("response");
        send(&hub, &client, handle, json!({"id": id, "type":"ping"}));
        let lines = inbox.wait_type("response", before + 1);
        assert_eq!(lines.iter().filter(|l| l["type"] == "response").last().unwrap()["id"], json!(id));
    }
    // A command without an id keeps none and is not rewritten; one with a number is left alone too.
    send(&hub, &client, handle, json!({"type":"prompt","n":1}));
    assert_eq!(inbox.wait_type("prompt", 1).last().unwrap().get("id"), None);
    send(&hub, &client, handle, json!({"id":7,"type":"prompt","n":2}));
    assert_eq!(inbox.wait_type("prompt", 2).last().unwrap()["id"], json!(7));
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn a_late_client_gets_what_comes_after_it_attached_and_nothing_twice() {
    let (hub, dir) = hub("late");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    for n in 1..=5 {
        send(&hub, &window, on_window, json!({"type":"prompt","n":n}));
    }
    a.wait_type("prompt", 5);
    // The phone opens the session already running on the PC: it attaches to the engine, so it starts with its present
    // state (it reads that with its own `get_messages`) and then gets the stream.
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    assert_eq!(hub.running_engines(), 1);
    for n in 6..=10 {
        send(&hub, &window, on_window, json!({"type":"prompt","n":n}));
    }
    let seen: Vec<Value> = b.wait_type("prompt", 5).iter().filter(|l| l["type"] == "prompt").map(|l| l["n"].clone()).collect();
    assert_eq!(seen, (6..=10).map(|n| json!(n)).collect::<Vec<_>>(), "after attaching, in order, once");
    send(&hub, &phone1, on_phone, json!({"type":"prompt","n":11}));
    let all: Vec<Value> = a.wait_type("prompt", 11).iter().filter(|l| l["type"] == "prompt").map(|l| l["n"].clone()).collect();
    assert_eq!(all, (1..=11).map(|n| json!(n)).collect::<Vec<_>>(), "the first client lost and doubled nothing");
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn a_client_that_attaches_during_a_reply_gets_its_lines_so_far_first_then_the_rest_in_order() {
    let (hub, dir) = hub("reply");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b, c) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    // The scripted engine writes back what it is sent: the lines of a turn, as the real one writes them (`type` first).
    let say = |line: &str| hub.send(&window, on_window, line).unwrap();
    let delta = |n: u32| format!(r#"{{"type":"message_update","assistantMessageEvent":{{"type":"text_delta","delta":"{n}"}}}}"#);
    let deltas = |lines: &[Value]| -> Vec<Value> {
        lines.iter().filter(|l| l["type"] == "message_update").map(|l| l["assistantMessageEvent"]["delta"].clone()).collect()
    };
    say(r#"{"type":"message_start","message":{"role":"user","content":"go"}}"#);
    say(r#"{"type":"message_end","message":{"role":"user","content":"go"}}"#);
    say(r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#);
    for n in 1..=3 {
        say(&delta(n));
    }
    a.wait_type("message_update", 3);
    // The phone opens the session in the middle of the reply: the reply's start and its three fragments come first.
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    let first = b.lines();
    assert_eq!(first.len(), 4, "the reply so far, and only it: {first:?}");
    assert_eq!(first[0]["message"]["role"], "assistant");
    for n in 4..=6 {
        say(&delta(n));
    }
    let seen = deltas(&b.wait_type("message_update", 6));
    assert_eq!(seen, (1..=6).map(|n| json!(n.to_string())).collect::<Vec<_>>(), "every fragment, in order, once");
    assert_eq!(deltas(&a.wait_type("message_update", 6)).len(), 6, "the first client got nothing twice");
    // A phone cut during the reply and back gets it from its start again: what it missed was dropped.
    hub.lost(on_phone, 1, Duration::from_secs(60), Duration::from_secs(2));
    say(&delta(7));
    a.wait_type("message_update", 7);
    assert!(hub.resume(&phone("fp", 2), on_phone, c.sink()));
    assert_eq!(deltas(&c.lines()), (1..=7).map(|n| json!(n.to_string())).collect::<Vec<_>>());
    // Once the reply has ended, a client that attaches is given nothing: it reads the session.
    say(r#"{"type":"message_end","message":{"role":"assistant","content":[]}}"#);
    a.wait_type("message_end", 2);
    let late = Arc::new(Inbox::default());
    open(&hub, &phone("other", 3), &dir, &session, &late);
    assert!(late.lines().is_empty(), "{:?}", late.lines());
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn a_question_is_shown_to_a_late_client_once_and_closed_on_the_other_side_when_answered() {
    let (hub, dir) = hub("questions");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    send(&hub, &window, on_window, json!({"type":"ask"}));
    a.wait_type("extension_ui_request", 1);
    // The window already got it live: its replay adds nothing.
    hub.replay(&window, on_window).unwrap();
    // The phone attaches late, then asks for the open questions: it gets it, once, however often it asks.
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    hub.replay(&phone1, on_phone).unwrap();
    hub.replay(&phone1, on_phone).unwrap();
    b.wait_type("extension_ui_request", 1);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!((a.count("extension_ui_request"), b.count("extension_ui_request")), (1, 1));

    // The phone answers: the engine gets the answer once, and the window's dialog is closed.
    send(&hub, &phone1, on_phone, json!({"type":"extension_ui_response","id":"q1","confirmed":true}));
    let dismissed = a.wait_type("extension_ui_dismissed", 1);
    let gone = dismissed.iter().find(|l| l["type"] == "extension_ui_dismissed").unwrap();
    assert_eq!((gone["id"].as_str(), gone["reason"].as_str()), (Some("q1"), Some("answered")));
    assert_eq!(a.wait_type("answered", 1).iter().filter(|l| l["type"] == "answered").count(), 1);
    assert_eq!(b.count("extension_ui_dismissed"), 0, "the one who answered needs no telling");
    // A question answered is no longer replayed, and a second answer closes nothing more.
    let on_third = open(&hub, &Client::window(), &dir, &session, &Arc::new(Inbox::default()));
    let c = Arc::new(Inbox::default());
    let third = Client { owner: "other".into(), holder: 9 };
    let on_c = open(&hub, &third, &dir, &session, &c);
    hub.replay(&third, on_c).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(c.count("extension_ui_request"), 0);
    send(&hub, &window, on_window, json!({"type":"extension_ui_response","id":"q1","confirmed":false}));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(b.count("extension_ui_dismissed"), 0);
    let _ = on_third;
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn a_session_never_gets_two_engines_even_opened_at_the_same_moment() {
    let (hub, dir) = hub("one-engine");
    let session = session_file(&dir, "s.jsonl");
    let other = session_file(&dir, "other.jsonl");
    let threads: Vec<_> = (0..4)
        .map(|n| {
            let (hub, dir, session) = (hub.clone(), dir.clone(), session.clone());
            std::thread::spawn(move || {
                let client = phone(&format!("fp{n}"), 10 + n);
                open(&hub, &client, &dir, &session, &Arc::new(Inbox::default()))
            })
        })
        .collect();
    let handles: Vec<u32> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(hub.running_engines(), 1, "four clients, one session, one engine");
    assert_eq!(handles.iter().collect::<std::collections::HashSet<_>>().len(), 4);
    // Another session is another engine; a session with no file yet (a new conversation) always starts its own.
    open(&hub, &Client::window(), &dir, &other, &Arc::new(Inbox::default()));
    assert_eq!(hub.running_engines(), 2);
    hub.open(&Client::window(), dir.clone(), None, Arc::new(Inbox::default()).sink()).unwrap();
    hub.open(&Client::window(), dir.clone(), None, Arc::new(Inbox::default()).sink()).unwrap();
    assert_eq!(hub.running_engines(), 4);
    // A relative path and a link to the file are the same session.
    let link = dir.join("link.jsonl");
    std::os::unix::fs::symlink(&session, &link).unwrap();
    hub.open(&Client::window(), dir.clone(), Some("link.jsonl".into()), Arc::new(Inbox::default()).sink()).unwrap();
    hub.open(&Client::window(), dir.clone(), Some("./s.jsonl".into()), Arc::new(Inbox::default()).sink()).unwrap();
    assert_eq!(hub.running_engines(), 4);
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn one_client_closing_leaves_the_engine_to_the_other_and_the_last_one_stops_it() {
    let (hub, dir) = hub("stop");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    hub.stop(&window, on_window, Duration::from_secs(2)).unwrap();
    assert_eq!(hub.running_engines(), 1, "the phone still has it");
    assert!(hub.send(&window, on_window, "{\"type\":\"x\"}").is_err(), "the window let go of it");
    send(&hub, &phone1, on_phone, json!({"type":"prompt","n":1}));
    b.wait_type("prompt", 1);
    assert_eq!(a.count("prompt"), 0, "nothing reaches a client that closed");
    hub.stop(&phone1, on_phone, Duration::from_secs(2)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while hub.running_engines() > 0 {
        assert!(Instant::now() < deadline, "the engine is still running");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn what_a_client_that_went_away_misses_is_dropped_and_it_takes_its_engine_back_only_if_it_is_its_own() {
    let (hub, dir) = hub("lost");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    hub.lost(on_phone, 1, Duration::from_secs(3), Duration::from_secs(2));
    send(&hub, &window, on_window, json!({"type":"prompt","n":1}));
    a.wait_type("prompt", 1);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(b.count("prompt"), 0, "dropped while the phone is away");
    // Another phone cannot take it; its owner, on a new connection, can; the old connection ending later leaves it alone.
    let again = Arc::new(Inbox::default());
    assert!(!hub.resume(&phone("someone else", 2), on_phone, again.sink()));
    assert!(hub.resume(&phone("fp", 3), on_phone, again.sink()));
    hub.lost(on_phone, 1, Duration::from_millis(50), Duration::from_secs(1));
    send(&hub, &window, on_window, json!({"type":"prompt","n":2}));
    again.wait_type("prompt", 1);
    std::thread::sleep(Duration::from_millis(300));
    assert!(hub.send(&phone("fp", 3), on_phone, "{\"type\":\"x\"}").is_ok(), "the old connection's end changed nothing");
    // Away for good: after the delay it is released, and the engine goes on for the window.
    hub.lost(on_phone, 3, Duration::from_millis(100), Duration::from_secs(1));
    std::thread::sleep(Duration::from_millis(600));
    assert!(hub.send(&phone("fp", 3), on_phone, "{\"type\":\"x\"}").is_err());
    assert_eq!(hub.running_engines(), 1);
    // The window closing last stops the engine; an engine left by the last one away stops after the delay.
    hub.lost(on_window, 0, Duration::from_millis(100), Duration::from_secs(1));
    let deadline = Instant::now() + Duration::from_secs(10);
    while hub.running_engines() > 0 {
        assert!(Instant::now() < deadline, "the engine is still running");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_client_cannot_touch_the_engine_of_another() {
    let (hub, dir) = hub("holders");
    let session = session_file(&dir, "s.jsonl");
    let (mine, theirs) = (phone("fp", 1), phone("fp", 2));
    let on_mine = open(&hub, &mine, &dir, &session, &Arc::new(Inbox::default()));
    // Same phone, another connection: not its attachment (it must `resume` it).
    for result in [
        hub.send(&theirs, on_mine, "{\"type\":\"x\"}"),
        hub.replay(&theirs, on_mine),
        hub.stop(&theirs, on_mine, Duration::from_secs(1)),
        hub.send(&mine, 999, "{\"type\":\"x\"}"),
    ] {
        assert!(result.unwrap_err().contains("does not belong"));
    }
    // Lines that are not a command.
    assert!(hub.send(&mine, on_mine, "two\nlines").is_err());
    assert!(hub.send(&mine, on_mine, "not json").is_err());
    assert!(hub.send(&mine, on_mine, "[1]").is_err());
    assert_eq!(hub.running_engines(), 1);
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn every_client_is_told_when_the_engine_ends_and_then_forgets_it() {
    let (hub, dir) = hub("exit");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    open(&hub, &phone1, &dir, &session, &b);
    send(&hub, &window, on_window, json!({"type":"quit"}));
    for inbox in [&a, &b] {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let exited = inbox.messages.lock().unwrap().iter().any(|m| matches!(m, EngineMessage::Exit { code: Some(3), .. }));
            if exited {
                break;
            }
            assert!(Instant::now() < deadline, "no exit message");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    assert_eq!(hub.running_engines(), 0);
    assert!(hub.send(&window, on_window, "{\"type\":\"x\"}").is_err());
    // The session can be opened again: a new engine.
    open(&hub, &window, &dir, &session, &Arc::new(Inbox::default()));
    assert_eq!(hub.running_engines(), 1);
    hub.stop_all(Duration::from_secs(2));
}

#[test]
fn a_response_for_a_client_that_left_is_dropped_not_given_to_the_others() {
    let (hub, dir) = hub("orphan");
    let session = session_file(&dir, "s.jsonl");
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let (a, b) = (Arc::new(Inbox::default()), Arc::new(Inbox::default()));
    let on_window = open(&hub, &window, &dir, &session, &a);
    let on_phone = open(&hub, &phone1, &dir, &session, &b);
    send(&hub, &phone1, on_phone, json!({"id":"mine","type":"ping"}));
    hub.stop(&phone1, on_phone, Duration::from_secs(1)).unwrap();
    // Whatever the engine answers next (to the window, later) is the window's alone.
    send(&hub, &window, on_window, json!({"id":"w","type":"ping"}));
    let lines = a.wait_type("response", 1);
    assert!(lines.iter().filter(|l| l["type"] == "response").all(|l| l["id"] == "w"), "{lines:?}");
    hub.stop_all(Duration::from_secs(2));
}

// the window lists as open the conversations a phone has open through its engines.
#[test]
fn the_window_learns_which_sessions_a_phone_holds_and_not_its_own() {
    let (hub, dir) = hub("held");
    let (mine, theirs, shared) = (
        session_file(&dir, "mine.jsonl"),
        session_file(&dir, "theirs.jsonl"),
        session_file(&dir, "shared.jsonl"),
    );
    let (window, phone1) = (Client::window(), phone("fp", 1));
    let inbox = Arc::new(Inbox::default());
    open(&hub, &window, &dir, &mine, &inbox);
    assert!(hub.held_elsewhere().is_empty(), "the window's own conversation is not a phone's");
    let on_phone = open(&hub, &phone1, &dir, &theirs, &inbox);
    open(&hub, &window, &dir, &shared, &inbox);
    open(&hub, &phone1, &dir, &shared, &inbox);
    let mut held = hub.held_elsewhere();
    held.sort();
    let mut expected = vec![theirs.clone(), shared.clone()];
    expected.sort();
    assert_eq!(held, expected);
    hub.stop(&phone1, on_phone, Duration::from_secs(2)).unwrap();
    assert_eq!(hub.held_elsewhere(), vec![shared], "a conversation the phone let go of is no longer its");
    hub.stop_all(Duration::from_secs(2));
}
