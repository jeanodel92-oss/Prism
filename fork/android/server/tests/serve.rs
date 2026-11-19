//! The phone server over loopback: a real `prism_link::Client` as the phone, the real `prism-remote` binary as the
//! PC, a shell script as the engine.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use prism_host::base64;
use prism_link::{Client, ClientLines, Invitation};
use serde_json::{json, Value};

/// Prints one JSON line when it starts (its pid and folder), then echoes every line; `{"type":"quit"}` makes it
/// leave with code 3. With `stubborn` in its arguments it ignores its stdin and TERM, so only a kill stops it.
const ENGINE: &str = r#"#!/bin/sh
echo "{\"type\":\"ready\",\"pid\":$$,\"cwd\":\"$(pwd)\",\"args\":\"$*\"}"
echo "booting key=sk-0123456789abcdefghij" >&2
session=""; prev=""
for a in "$@"; do if [ "$prev" = "--session" ]; then session="$a"; fi; prev="$a"; done
case " $* " in *" stubborn "*) trap '' TERM HUP; while :; do sleep 0.05; done;; esac
while IFS= read -r line; do
  case "$line" in
    *'"get_state"'*)
      id=$(printf '%s' "$line" | grep -o '"id":"h[0-9]*"' | head -1 | cut -d'"' -f4)
      printf '{"id":"%s","type":"response","command":"get_state","success":true,"data":{"sessionFile":"%s"}}\n' "$id" "$session";;
    *'"ping"'*)
      id=$(printf '%s' "$line" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      printf '{"id":"%s","type":"response","command":"ping","success":true,"data":{"pid":%s}}\n' "$id" "$$";;
    *'"ask"'*) echo '{"type":"extension_ui_request","id":"q1","method":"confirm","title":"Run?"}';;
    *'"quit"'*) echo '{"type":"bye"}'; echo "leaving" >&2; exit 3;;
    *) printf '%s\n' "$line";;
  esac
done
"#;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prism-remote-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The server process, killed when dropped.
struct Pc {
    child: Child,
    invitation: Invitation,
    dir: PathBuf,
    cwd: PathBuf,
}

impl Drop for Pc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pc(name: &str) -> Pc {
    pc_with(name, json!(["engine.sh"]).to_string())
}

fn pc_with(name: &str, engine_args: String) -> Pc {
    spawn_pc(name, engine_args, &[])
}

fn spawn_pc(name: &str, engine_args: String, extra: &[&OsStr]) -> Pc {
    let root = temp(name);
    let (dir, cwd) = (root.join("pc"), root.join("work"));
    std::fs::create_dir_all(cwd.join("sub")).unwrap();
    std::fs::write(cwd.join("file.txt"), "x").unwrap();
    let script = root.join("engine.sh");
    std::fs::write(&script, ENGINE).unwrap();
    let engine_args = engine_args.replace("engine.sh", script.to_str().unwrap());
    let mut child = Command::new(env!("CARGO_BIN_EXE_prism-remote"))
        .args(["serve", "--port", "0", "--host", "127.0.0.1", "--dir"])
        .arg(&dir)
        .arg("--cwd")
        .arg(&cwd)
        .args(extra)
        .env("PRISM_REMOTE_ENGINE", "sh")
        .env("PRISM_REMOTE_ENGINE_ARGS", engine_args)
        // Engines left by a phone that went away run 2 s here, not minutes.
        .env("PRISM_REMOTE_KEEP_ALIVE", "2")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    // Not a terminal: the server writes no code at start (AS-003); the code comes from the running server, as the
    // window and /phone get it.
    if let Err(error) = wait_serving(&mut child, &dir) {
        let _ = child.kill();
        let _ = child.wait();
        panic!("{error}");
    }
    let code = control(&dir, "invite").unwrap();
    Pc {
        child,
        invitation: Invitation::decode(code["code"].as_str().unwrap()).unwrap(),
        dir,
        cwd: cwd.canonicalize().unwrap(),
    }
}

/// Waits until the server answers `status`; an error when it stops or takes more than 10 s.
fn wait_serving(child: &mut Child, dir: &Path) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(10);
    while control(dir, "status").is_err() {
        if child.try_wait().unwrap().is_some() {
            return Err("prism-remote stopped at once".into());
        }
        if Instant::now() > end {
            return Err("prism-remote did not start".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

struct Phone {
    lines: ClientLines,
    events: VecDeque<Value>,
    next_id: u32,
    /// Events that arrived before the response of the last call.
    early: usize,
}

impl Phone {
    fn new(lines: ClientLines) -> Self {
        lines
            .stream
            .sock
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        Self {
            lines,
            events: VecDeque::new(),
            next_id: 0,
            early: 0,
        }
    }

    fn read(&mut self) -> Value {
        let line = self.lines.read().unwrap().expect("the PC closed");
        serde_json::from_str(&line).unwrap()
    }

    /// Sends a request and returns its response; events met on the way are kept, in order.
    fn call(&mut self, op: &str, args: Value) -> Value {
        self.next_id += 1;
        let id = format!("r{}", self.next_id);
        let request = json!({ "id": id, "op": op, "args": args });
        self.lines.write(&request.to_string()).unwrap();
        let before = self.events.len();
        loop {
            let message = self.read();
            if message.get("event").is_some() {
                self.events.push_back(message);
            } else {
                assert_eq!(message["id"], json!(id));
                self.early = self.events.len() - before;
                return message;
            }
        }
    }

    fn ok(&mut self, op: &str, args: Value) -> Value {
        let response = self.call(op, args);
        assert_eq!(response["ok"], json!(true), "{op}: {response}");
        response["result"].clone()
    }

    fn refused(&mut self, op: &str, args: Value) -> String {
        let response = self.call(op, args);
        assert_eq!(
            response["ok"],
            json!(false),
            "{op} should be refused: {response}"
        );
        response["error"].as_str().unwrap().to_string()
    }

    fn start(&mut self, session: Option<&str>) -> u64 {
        let id = self.ok("engine_start", json!({ "session": session, "cwd": null }));
        assert_eq!(
            self.early, 0,
            "an event came before the response that names its engine"
        );
        id.as_u64().unwrap()
    }

    fn event(&mut self) -> Value {
        match self.events.pop_front() {
            Some(event) => event,
            None => loop {
                let message = self.read();
                assert!(message.get("event").is_some(), "unexpected {message}");
                return message;
            },
        }
    }

    /// The engine's next stdout line, as JSON. Events of other engines and stderr events stay queued: the streams
    /// are not ordered together, only each engine's stdout lines among themselves.
    fn line(&mut self, engine: u64) -> Value {
        loop {
            let found = self.events.iter().position(|event| {
                event["engine"] == json!(engine) && event["message"]["kind"] == "line"
            });
            if let Some(index) = found {
                let event = self.events.remove(index).unwrap();
                return serde_json::from_str(event["message"]["line"].as_str().unwrap()).unwrap();
            }
            let message = self.read();
            assert!(message.get("event").is_some(), "unexpected {message}");
            self.events.push_back(message);
        }
    }
}

fn pair(pc: &Pc, name: &str) -> (Phone, Client) {
    let client = Client::new(&temp(name)).unwrap();
    let lines = client.connect(&pc.invitation).unwrap();
    (Phone::new(lines), client)
}

fn reconnect(pc: &Pc, client: &Client) -> Phone {
    let saved = client.saved().unwrap();
    assert_eq!(saved.fingerprint, pc.invitation.fingerprint);
    Phone::new(client.connect(&saved).unwrap())
}

fn alive(pid: u64) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn wait_gone(pid: u64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still there");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn answers_app_and_memory_info() {
    let pc = pc("info");
    let (mut phone, _) = pair(&pc, "info-phone");
    let info = phone.ok("app_info", Value::Null);
    assert_eq!(info["cwd"], json!(pc.cwd.display().to_string()));
    assert_eq!(info["engineError"], Value::Null);
    assert!(!info["host"].as_str().unwrap().is_empty());
    assert_eq!(info["version"], json!(env!("CARGO_PKG_VERSION")));
    for key in ["home", "locale"] {
        assert!(info.get(key).is_some(), "{key} missing");
    }
    let memory = phone.ok("memory_info", json!({}));
    assert!(memory["available"].as_u64().unwrap() > 0);
    assert!(memory["total"].as_u64().unwrap() >= memory["available"].as_u64().unwrap());
}

#[test]
fn runs_an_engine_and_forwards_its_output_in_order() {
    let pc = pc("engine");
    let (mut phone, _) = pair(&pc, "engine-phone");
    let engine = phone.start(None);
    let ready = phone.line(engine);
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["cwd"], json!(pc.cwd.display().to_string()));
    assert!(ready["args"].as_str().unwrap().ends_with("--mode rpc"));

    for n in 1..=3 {
        let line = json!({ "type": "prompt", "n": n }).to_string();
        assert_eq!(
            phone.ok("engine_send", json!({ "engine": engine, "line": line })),
            Value::Null
        );
    }
    for n in 1..=3 {
        assert_eq!(phone.line(engine), json!({ "type": "prompt", "n": n }));
    }

    phone.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"quit\"}" }),
    );
    assert_eq!(phone.line(engine)["type"], "bye");
    // Anything left is stderr, then the exit, which comes last with the engine's tail of stderr, secrets masked.
    let mut stderr = Vec::new();
    let exit = loop {
        let event = phone.event();
        assert_eq!(event["event"], "engine");
        let message = event["message"].clone();
        match message["kind"].as_str().unwrap() {
            "stderr" => stderr.push(message["line"].as_str().unwrap().to_string()),
            "exit" => break message,
            other => panic!("unexpected {other}"),
        }
    };
    assert_eq!(exit["code"], json!(3));
    assert_eq!(exit["signal"], Value::Null);
    let tail: Vec<&str> = exit["stderr"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert_eq!(tail, ["booting key=•••", "leaving"]);
    assert!(
        stderr.iter().all(|line| !line.contains("sk-0123")),
        "{stderr:?}"
    );
    // The engine is gone: its number is no longer usable.
    assert!(!phone
        .refused("engine_send", json!({ "engine": engine, "line": "{}" }))
        .is_empty());
}

#[test]
fn starts_an_engine_in_a_chosen_folder_and_refuses_a_bad_one() {
    let pc = pc("folder");
    let (mut phone, _) = pair(&pc, "folder-phone");
    let engine = phone
        .ok("engine_start", json!({ "cwd": "sub" }))
        .as_u64()
        .unwrap();
    assert_eq!(
        phone.line(engine)["cwd"],
        json!(pc.cwd.join("sub").display().to_string())
    );
    phone.refused("engine_start", json!({ "cwd": "missing" }));
    phone.refused("engine_start", json!({ "cwd": "file.txt" }));
    phone.refused("engine_start", json!({ "cwd": 5 }));
    // The session is passed to the engine.
    let resumed = phone
        .ok("engine_start", json!({ "session": "s.jsonl", "cwd": null }))
        .as_u64()
        .unwrap();
    assert!(phone.line(resumed)["args"]
        .as_str()
        .unwrap()
        .contains("--session s.jsonl"));
}

#[test]
fn stops_an_engine() {
    let pc = pc("stop");
    let (mut phone, _) = pair(&pc, "stop-phone");
    let engine = phone.start(None);
    let pid = phone.line(engine)["pid"].as_u64().unwrap();
    assert!(alive(pid));
    assert_eq!(
        phone.ok("engine_stop", json!({ "engine": engine })),
        Value::Null
    );
    loop {
        let event = phone.event();
        if event["message"]["kind"] == "exit" {
            break;
        }
    }
    wait_gone(pid);
    // Stopping twice is harmless; talking to it is refused.
    phone.refused("engine_send", json!({ "engine": engine, "line": "{}" }));
    phone.refused("engine_stop", json!({ "engine": engine }));
}

#[test]
fn lists_folders() {
    let pc = pc("folders");
    let (mut phone, _) = pair(&pc, "folders-phone");
    let listed = phone.ok(
        "project_directory",
        json!({ "path": pc.cwd.to_str().unwrap() }),
    );
    assert_eq!(listed["path"], json!(pc.cwd.display().to_string()));
    assert_eq!(listed["folders"], json!(["sub"]));
    assert_eq!(
        listed["parent"],
        json!(pc.cwd.parent().unwrap().display().to_string())
    );
    // A relative path is read from the server's folder.
    assert_eq!(
        phone.ok("project_directory", json!({ "path": "sub" }))["folders"],
        json!([])
    );
    phone.refused("project_directory", json!({ "path": "missing" }));
    phone.refused("project_directory", json!({ "path": "file.txt" }));
    phone.refused("project_directory", json!({ "path": "" }));
    phone.refused("project_directory", json!({}));
}

#[test]
fn refuses_an_engine_of_another_connection() {
    let pc = pc("owner");
    let (mut first, client) = pair(&pc, "owner-phone");
    let mine = first.start(None);
    first.line(mine);
    let mut second = reconnect(&pc, &client);
    let theirs = second.start(None);
    assert_ne!(mine, theirs, "engine numbers are unique across connections");
    second.line(theirs);
    for engine in [mine, 999] {
        second.refused(
            "engine_send",
            json!({ "engine": engine, "line": "{\"type\":\"x\"}" }),
        );
        second.refused("engine_stop", json!({ "engine": engine }));
    }
    // The first connection's engine is untouched.
    first.ok(
        "engine_send",
        json!({ "engine": mine, "line": "{\"type\":\"still\"}" }),
    );
    assert_eq!(first.line(mine)["type"], "still");
}

#[test]
fn does_not_forward_the_hosts_attach_command() {
    let pc = pc("attach");
    let (mut phone, _) = pair(&pc, "attach-phone");
    let engine = phone.start(None);
    phone.line(engine);
    for line in [
        r#"{"type":"attach_files","paths":["/etc/hostname"]}"#,
        r#"{ "paths": [], "type" : "attach_files" }"#,
        r#"{"type":"attach_files","pad":"\ud800"}"#,
        "not json",
        "two\nlines",
    ] {
        phone.refused("engine_send", json!({ "engine": engine, "line": line }));
    }
    // Nothing reached the engine: its next echo is the next ordinary line.
    phone.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"prompt\",\"text\":\"attach_files\"}" }),
    );
    assert_eq!(phone.line(engine)["text"], "attach_files");
}

#[test]
fn answers_a_bad_request_and_stays_open() {
    let pc = pc("bad");
    let (mut phone, _) = pair(&pc, "bad-phone");
    assert!(phone
        .refused("no_such_op", json!({}))
        .contains("no_such_op"));
    phone.refused("engine_send", json!("not an object"));
    phone.refused("engine_send", json!({ "line": "{}" }));
    phone.refused("engine_send", json!({ "engine": "one", "line": "{}" }));
    phone.refused("engine_stop", json!({}));
    // A request with an id but no op is an unknown op, not a protocol break.
    phone.lines.write(r#"{"id":"bare"}"#).unwrap();
    let response = phone.read();
    assert_eq!(
        (response["id"].as_str(), response["ok"].as_bool()),
        (Some("bare"), Some(false))
    );
    assert_eq!(
        phone.ok("app_info", Value::Null)["engineError"],
        Value::Null
    );
}

#[test]
fn closes_on_a_line_that_is_not_a_request_and_keeps_serving() {
    let pc = pc("malformed");
    let (phone, client) = pair(&pc, "malformed-phone");
    drop(phone);
    for bad in [
        "not json",
        r#"{"op":"app_info"}"#,
        "[1,2]",
        r#"{"id":7,"op":"app_info"}"#,
        "\"id\"",
    ] {
        let mut phone = reconnect(&pc, &client);
        let engine = phone.start(None);
        let pid = phone.line(engine)["pid"].as_u64().unwrap();
        phone.lines.write(bad).unwrap();
        // The PC closes: nothing more than possibly queued events, then the end.
        let closed = loop {
            match phone.lines.read() {
                Ok(Some(line)) => assert!(line.contains("\"event\""), "answered {bad:?}: {line}"),
                Ok(None) | Err(_) => break true,
            }
        };
        assert!(closed);
        // Its engine stopped with it.
        wait_gone(pid);
    }
    let mut phone = reconnect(&pc, &client);
    phone.ok("app_info", Value::Null);
}

#[test]
fn keeps_the_engines_of_a_phone_that_went_away_and_gives_them_back_to_it() {
    let pc = pc("keep");
    let (mut phone, client) = pair(&pc, "keep-phone");
    let engine = phone.start(None);
    let pid = phone.line(engine)["pid"].as_u64().unwrap();
    // A question the engine asks (the fake engine asks one on "ask"), then a cut before any answer.
    let question =
        json!({"type": "extension_ui_request", "id": "q1", "method": "confirm", "title": "Run?"});
    phone.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"ask\"}" }),
    );
    assert_eq!(phone.line(engine), question);
    drop(phone);
    std::thread::sleep(Duration::from_millis(300));
    assert!(alive(pid), "the engine stopped with the connection");

    // Another device may not take it.
    let (mut other, _) = pair_again(&pc, "keep-other");
    let fresh = other
        .ok("engine_start", json!({ "resume": engine }))
        .as_u64()
        .unwrap();
    assert_ne!(fresh, engine);
    other.refused("engine_send", json!({ "engine": engine, "line": "{}" }));

    // Its own phone takes it back: same engine, same process, and the unanswered question again.
    let mut back = reconnect(&pc, &client);
    assert_eq!(
        back.ok("engine_start", json!({ "resume": engine })),
        json!(engine)
    );
    back.ok("engine_replay", json!({ "engine": engine }));
    assert_eq!(back.line(engine), question);
    let answer = json!({"type": "extension_ui_response", "id": "q1", "confirmed": true});
    back.ok(
        "engine_send",
        json!({ "engine": engine, "line": answer.to_string() }),
    );
    assert_eq!(back.line(engine), answer);
    // Answered: not asked again.
    back.ok("engine_replay", json!({ "engine": engine }));
    back.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"mark\"}" }),
    );
    assert_eq!(back.line(engine), json!({"type": "mark"}));
    assert!(alive(pid));

    // Taken by a new connection while the PC still holds the old one open (a cut network says nothing): the old one
    // ending later leaves it running.
    let mut again = reconnect(&pc, &client);
    assert_eq!(
        again.ok("engine_start", json!({ "resume": engine })),
        json!(engine)
    );
    drop(back);
    std::thread::sleep(Duration::from_millis(2500));
    assert!(
        alive(pid),
        "the old connection stopped the engine the new one has"
    );
    again.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"mark2\"}" }),
    );
    assert_eq!(again.line(engine), json!({"type": "mark2"}));

    // Left again and not taken back: it stops once the keep-alive is over.
    drop(again);
    wait_gone(pid);
}

/// A second phone, paired with a new code from the running server.
fn pair_again(pc: &Pc, name: &str) -> (Phone, Client) {
    let code = control(&pc.dir, "invite").unwrap();
    let invitation = Invitation::decode(code["code"].as_str().unwrap()).unwrap();
    let client = Client::new(&temp(name)).unwrap();
    let lines = client.connect(&invitation).unwrap();
    (Phone::new(lines), client)
}

#[test]
fn stops_the_engines_when_the_phone_disconnects() {
    let pc = pc("disconnect");
    let (mut phone, _) = pair(&pc, "disconnect-phone");
    let (quiet, stubborn) = (phone.start(None), phone.start(Some("stubborn")));
    let pids = [
        phone.line(quiet)["pid"].as_u64().unwrap(),
        phone.line(stubborn)["pid"].as_u64().unwrap(),
    ];
    assert!(pids.iter().all(|pid| alive(*pid)));
    drop(phone);
    for pid in pids {
        wait_gone(pid);
    }
}

#[test]
fn refuses_unpaired_reused_and_revoked_devices() {
    let pc = pc("auth");
    let (_phone, paired) = pair(&pc, "auth-phone");

    // A device that never paired.
    let stranger = Client::new(&temp("auth-stranger")).unwrap();
    let hello = Invitation {
        token: None,
        ..pc.invitation.clone()
    };
    let denied = stranger.connect(&hello).err().unwrap();
    assert!(denied.starts_with("DENIED"), "{denied}");
    // The pairing code, used once, is spent.
    let denied = stranger.connect(&pc.invitation).err().unwrap();
    assert!(denied.starts_with("DENIED"), "{denied}");

    // The paired phone is listed, and refused after it is revoked.
    let bin = env!("CARGO_BIN_EXE_prism-remote");
    let list = Command::new(bin)
        .args(["devices", "--dir"])
        .arg(&pc.dir)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&list.stdout).trim(),
        paired.identity.fingerprint()
    );
    let revoke = Command::new(bin)
        .args(["revoke", "--dir"])
        .arg(&pc.dir)
        .arg(paired.identity.fingerprint())
        .output()
        .unwrap();
    assert!(revoke.status.success());
    let denied = paired.connect(&paired.saved().unwrap()).err().unwrap();
    assert!(denied.starts_with("DENIED"), "{denied}");
    // Revoking something that is not paired fails.
    let again = Command::new(bin)
        .args(["revoke", "--dir"])
        .arg(&pc.dir)
        .arg(paired.identity.fingerprint())
        .output()
        .unwrap();
    assert!(!again.status.success());
}

#[test]
fn reports_why_no_engine_can_start() {
    let pc = pc_with("noengine", "not json".to_string());
    let (mut phone, _) = pair(&pc, "noengine-phone");
    let info = phone.ok("app_info", Value::Null);
    assert!(info["engineError"]
        .as_str()
        .unwrap()
        .contains("PRISM_REMOTE_ENGINE_ARGS"));
    assert!(phone
        .refused("engine_start", json!({}))
        .contains("PRISM_REMOTE_ENGINE_ARGS"));
}

/// `prism-remote <request> --dir DIR`: its stdout as JSON, or its error.
fn control(dir: &Path, request: &str) -> Result<Value, String> {
    let output = Command::new(env!("CARGO_BIN_EXE_prism-remote"))
        .args([request, "--dir"])
        .arg(dir)
        .output()
        .unwrap();
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(serde_json::from_slice(&output.stdout).unwrap())
}

// fork: the window asks the running server for new codes.
#[test]
fn makes_new_pairing_codes_while_it_runs_and_refuses_a_second_server() {
    let pc = pc("control");
    let first = control(&pc.dir, "invite").unwrap();
    let code = Invitation::decode(first["code"].as_str().unwrap()).unwrap();
    assert_eq!(code.port, pc.invitation.port);
    assert_eq!(code.fingerprint, pc.invitation.fingerprint);
    assert_ne!(code.token, pc.invitation.token);
    assert!(first["svg"].as_str().unwrap().starts_with("<?xml"));
    // The terminal's /phone draws the same code with block characters.
    assert!(first["qr"].as_str().unwrap().contains('█'));
    assert_eq!(first["hosts"], json!(["127.0.0.1"]));

    // A phone pairs with the new code; the status lists it.
    let client = Client::new(&temp("control-phone")).unwrap();
    let mut phone = Phone::new(client.connect(&code).unwrap());
    phone.ok("app_info", Value::Null);
    let status = control(&pc.dir, "status").unwrap();
    assert_eq!(status["paired"], json!([client.identity.fingerprint()]));
    assert_eq!(status["port"], json!(pc.invitation.port));
    // The port is kept for the next start.
    let kept = std::fs::read_to_string(pc.dir.join("port")).unwrap();
    assert_eq!(kept.trim(), pc.invitation.port.to_string());

    // A second server on the same folder is refused; the first keeps serving.
    let second = Command::new(env!("CARGO_BIN_EXE_prism-remote"))
        .args(["serve", "--port", "0", "--host", "127.0.0.1", "--dir"])
        .arg(&pc.dir)
        .output()
        .unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("already runs"));
    assert!(control(&pc.dir, "invite").is_ok());
}

// fork: run as a user service, the server's output is the journal. A code written
// there at each start could pair any device that reaches the port; the user asks for one when they want it.
#[test]
fn writes_no_pairing_code_when_its_output_is_not_a_terminal() {
    let dir = temp("no-code-in-journal").join("pc");
    let mut child = Command::new(env!("CARGO_BIN_EXE_prism-remote"))
        .args(["serve", "--port", "0", "--host", "127.0.0.1", "--dir"])
        .arg(&dir)
        .arg("--cwd")
        .arg(std::env::temp_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = wait_serving(&mut child, &dir);
    // A code asked for afterwards goes to the one who asked, not to the server's output.
    let asked = started.as_ref().ok().map(|_| control(&dir, "invite"));
    let _ = child.kill();
    let output = child.wait_with_output().unwrap();
    started.unwrap();
    let asked = asked.unwrap().unwrap();
    let token = Invitation::decode(asked["code"].as_str().unwrap())
        .unwrap()
        .token
        .unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    for text in [&stdout, &stderr] {
        assert!(
            !text.contains("prism-pair:"),
            "a pairing code was written: {text}"
        );
        assert!(!text.contains('█'), "a QR code was written: {text}");
        assert!(!text.contains(&token), "the asked code was written: {text}");
    }
    assert!(stderr.contains("prism-remote invite"), "{stderr}");
}

#[test]
fn says_when_no_server_runs() {
    let dir = temp("control-none");
    let error = control(&dir, "invite").err().unwrap();
    assert!(error.contains("no server runs"), "{error}");
}

/// Sends `bytes` as the phone does, in pieces of `piece` bytes; the staged path on the PC.
fn upload(phone: &mut Phone, name: &str, bytes: &[u8], piece: usize) -> String {
    let started = phone.ok(
        "upload_start",
        json!({ "name": name, "size": bytes.len() }),
    );
    let id = started["upload"].as_str().unwrap().to_string();
    for chunk in bytes.chunks(piece.max(1)) {
        phone.ok(
            "upload_chunk",
            json!({ "upload": id, "data": base64::encode(chunk) }),
        );
    }
    phone.ok("upload_finish", json!({ "upload": id }))["path"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn takes_a_file_from_the_phone_and_attaches_it_to_the_engine_once() {
    let pc = pc("upload");
    let (mut phone, _) = pair(&pc, "upload-phone");
    let engine = phone.start(None);
    phone.line(engine);
    // Not text, not an image: a PDF-like file with every byte value, sent in odd pieces.
    let bytes: Vec<u8> = (0..=255u8).cycle().take(200_003).collect();
    let path = upload(&mut phone, "../../report.pdf", &bytes, 70_001);
    assert!(path.ends_with("/report.pdf"), "{path}");
    assert!(
        Path::new(&path).starts_with(pc.dir.join("uploads")),
        "{path} is not under the server's staging folder"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);

    phone.ok(
        "attach_picked",
        json!({ "engine": engine, "id": "gui-7", "paths": [path] }),
    );
    // The engine (an echo here) got the host's command, with the staged path.
    let line = phone.line(engine);
    assert_eq!(line["type"], "attach_files");
    // The host swapped the request's id for its own, to give the engine's answer back to this phone only.
    assert!(line["id"].as_str().unwrap().starts_with('h'), "{line}");
    assert_eq!(line["paths"], json!([path]));
    // Once each.
    let again = phone.refused(
        "attach_picked",
        json!({ "engine": engine, "id": "gui-8", "paths": [path] }),
    );
    assert!(again.contains("already attached"), "{again}");
}

#[test]
fn refuses_what_the_phone_must_not_upload_or_attach() {
    let pc = pc("upload-refused");
    let (mut phone, client) = pair(&pc, "upload-refused-phone");
    let engine = phone.start(None);
    phone.line(engine);

    // Size and shape of the request.
    let big = phone.refused(
        "upload_start",
        json!({ "name": "big.bin", "size": 100 * 1024 * 1024 + 1 }),
    );
    assert!(big.contains("larger than 100 MiB"), "{big}");
    phone.refused("upload_start", json!({ "name": "x", "size": -1 }));
    phone.refused("upload_start", json!({ "name": "x" }));
    phone.refused("upload_start", json!({ "size": 1 }));
    phone.refused("upload_chunk", json!({ "upload": "u99", "data": "AAAA" }));
    phone.refused("upload_finish", json!({ "upload": "u99" }));

    // More than announced ends the upload; so does bad base64; an incomplete file cannot be finished.
    let id = phone.ok("upload_start", json!({ "name": "a", "size": 2 }))["upload"].clone();
    phone.refused("upload_chunk", json!({ "upload": id, "data": base64::encode(b"abc") }));
    phone.refused("upload_chunk", json!({ "upload": id, "data": "AA" }));
    let id = phone.ok("upload_start", json!({ "name": "a", "size": 2 }))["upload"].clone();
    phone.refused("upload_chunk", json!({ "upload": id, "data": "no base64 here" }));
    let id = phone.ok("upload_start", json!({ "name": "a", "size": 2 }))["upload"].clone();
    phone.ok("upload_chunk", json!({ "upload": id, "data": base64::encode(b"a") }));
    assert!(phone
        .refused("upload_finish", json!({ "upload": id }))
        .contains("1 of 2"));

    // A piece above the bound, whatever the file's size.
    let id = phone.ok("upload_start", json!({ "name": "a", "size": 100 * 1024 * 1024 }))["upload"].clone();
    let piece = base64::encode(&vec![1u8; 4 * 1024 * 1024 + 3]);
    assert!(phone
        .refused("upload_chunk", json!({ "upload": id, "data": piece }))
        .contains("at most"));

    // Only what this phone sent can be attached: no other path, not a mix, not an engine that is not its own.
    let mine = upload(&mut phone, "mine.zip", b"PK\x03\x04", 100);
    for paths in [
        json!(["/etc/hostname"]),
        json!([pc.cwd.join("file.txt").to_str().unwrap()]),
        json!([mine, "/etc/shadow"]),
        json!([mine, mine]),
        json!([]),
        json!("mine.zip"),
        json!([1]),
        json!([format!("{mine}/../../../etc/hostname")]),
    ] {
        phone.refused(
            "attach_picked",
            json!({ "engine": engine, "id": "x", "paths": paths }),
        );
    }
    phone.refused(
        "attach_picked",
        json!({ "engine": 999, "id": "x", "paths": [mine] }),
    );
    phone.refused("attach_picked", json!({ "engine": engine, "paths": [mine] }));

    // Another connection of the same device cannot attach this one's file, nor use its engine.
    let mut other = reconnect(&pc, &client);
    let theirs = other.start(None);
    other.line(theirs);
    other.refused(
        "attach_picked",
        json!({ "engine": theirs, "id": "x", "paths": [mine] }),
    );
    other.refused(
        "attach_picked",
        json!({ "engine": engine, "id": "x", "paths": [mine] }),
    );
    other.refused("upload_chunk", json!({ "upload": "u1", "data": "AAAA" }));

    // None of that reached an engine; this phone's own file still attaches.
    phone.ok(
        "attach_picked",
        json!({ "engine": engine, "id": "ok", "paths": [mine] }),
    );
    let line = phone.line(engine);
    assert_eq!(line["type"], "attach_files", "{line}");
    assert_eq!(line["paths"], json!([mine]));
}

#[test]
fn removes_the_staged_files_when_the_phone_goes_and_never_keeps_them_for_the_next_one() {
    let pc = pc("upload-cleanup");
    let (mut phone, client) = pair(&pc, "upload-cleanup-phone");
    let path = upload(&mut phone, "x.bin", &[1, 2, 3], 10);
    assert!(Path::new(&path).exists());
    let folder = Path::new(&path).parent().unwrap().parent().unwrap().to_path_buf();
    drop(phone);
    let deadline = Instant::now() + Duration::from_secs(10);
    while folder.exists() {
        assert!(Instant::now() < deadline, "{folder:?} is still there");
        std::thread::sleep(Duration::from_millis(50));
    }
    // A new connection cannot attach what the old one sent.
    let mut next = reconnect(&pc, &client);
    let engine = next.start(None);
    next.line(engine);
    next.refused(
        "attach_picked",
        json!({ "engine": engine, "id": "x", "paths": [path] }),
    );
}

// ------------------------------------------------------------------------------------------------------------------
// Decision B1: the PC window and the phones share their engines live. The window's engines are a `Hub` in this test
// process; the server, started with `--hub`, hands each phone to it over a local socket. The test is the window.

use prism_host::connection::{serve_socket, Shared};
use prism_host::engine::{Client as WindowClient, EngineCommand, EngineMessage, Hub};
use prism_host::lines;
use std::sync::{Arc, Mutex};

/// A server whose phones are served by `hub`, which this test owns as the window does.
struct Shared2 {
    pc: Pc,
    hub: Arc<Hub>,
    /// What the window's attachments received.
    inbox: Arc<Mutex<Vec<Value>>>,
}

fn window_engine_command(root: &Path) -> EngineCommand {
    EngineCommand {
        program: "sh".into(),
        args: vec![root.join("engine.sh").to_str().unwrap().into()],
    }
}

fn bridged(name: &str) -> Shared2 {
    // The server writes its folder and engine script as `pc_with` does; this one only needs a hub socket first.
    let root = temp(&format!("{name}-hub"));
    let script = root.join("engine.sh");
    std::fs::write(&script, ENGINE).unwrap();
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let hub = Hub::new(window_engine_command(&root), Vec::new());
    let socket = root.join("hub.sock");
    let listener = lines::bind(&socket).unwrap();
    let shared = Arc::new(Shared {
        hub: hub.clone(),
        cwd: work.canonicalize().unwrap(),
        engine_error: None,
        staging: root.join("uploads"),
    });
    std::thread::spawn(move || serve_socket(listener, shared));
    let pc = spawn_pc(
        name,
        json!(["engine.sh"]).to_string(),
        &[OsStr::new("--hub"), socket.as_os_str()],
    );
    Shared2 {
        pc,
        hub,
        inbox: Arc::new(Mutex::new(Vec::new())),
    }
}

impl Shared2 {
    fn window_sink(&self) -> prism_host::engine::Sink {
        let inbox = self.inbox.clone();
        Arc::new(move |_, message| {
            if let EngineMessage::Line { line } = message {
                inbox.lock().unwrap().push(serde_json::from_str(&line).unwrap());
            }
            true
        })
    }

    /// The window's lines of this type so far.
    fn window_lines(&self, kind: &str) -> Vec<Value> {
        self.inbox.lock().unwrap().iter().filter(|l| l["type"] == kind).cloned().collect()
    }

    fn wait_window(&self, kind: &str, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let lines = self.window_lines(kind);
            if lines.len() >= count {
                return lines;
            }
            assert!(Instant::now() < deadline, "the window never got {count} {kind}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn window_send(&self, handle: u32, line: Value) {
        self.hub.send(&WindowClient::window(), handle, &line.to_string()).unwrap();
    }
}

fn session_in(shared: &Shared2) -> String {
    let path = shared.pc.cwd.join("shared.jsonl");
    std::fs::write(&path, "").unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn a_phone_and_the_window_share_one_live_session() {
    let shared = bridged("share");
    let session = session_in(&shared);
    let on_window = shared
        .hub
        .open(&WindowClient::window(), shared.pc.cwd.clone(), Some(session.clone()), shared.window_sink())
        .unwrap();
    let (mut phone, _client) = pair(&shared.pc, "share-phone");

    // The phone opens the session the window already runs: one engine, shared.
    let engine = phone.start(Some(&session));
    assert_eq!(shared.hub.running_engines(), 1, "no second engine on the same session file");

    // Responses go to who asked, with the id they gave.
    phone.ok("engine_send", json!({ "engine": engine, "line": "{\"id\":\"gui-1\",\"type\":\"ping\"}" }));
    let answer = phone.line(engine);
    assert_eq!((answer["type"].as_str(), answer["id"].as_str()), (Some("response"), Some("gui-1")));
    let pid = answer["data"]["pid"].as_u64().unwrap();
    shared.window_send(on_window, json!({"id":"gui-1","type":"ping"}));
    let window_answer = shared.wait_window("response", 1);
    assert_eq!(window_answer[0]["data"]["pid"].as_u64(), Some(pid), "the same process");
    assert_eq!(shared.window_lines("response").len(), 1, "the phone's answer did not go to the window");

    // What either side types appears on the other, in order, and went to the same engine.
    phone.ok("engine_send", json!({ "engine": engine, "line": "{\"type\":\"prompt\",\"n\":1}" }));
    shared.window_send(on_window, json!({"type":"prompt","n":2}));
    phone.ok("engine_send", json!({ "engine": engine, "line": "{\"type\":\"prompt\",\"n\":3}" }));
    let from_window: Vec<Value> = shared.wait_window("prompt", 3).iter().map(|l| l["n"].clone()).collect();
    assert_eq!(from_window, [json!(1), json!(2), json!(3)]);
    let from_phone: Vec<Value> = (0..3).map(|_| phone.line(engine)["n"].clone()).collect();
    assert_eq!(from_phone, [json!(1), json!(2), json!(3)]);

    // A question appears on both; answering on the phone closes the window's, and the engine hears it once.
    shared.window_send(on_window, json!({"type":"ask"}));
    assert_eq!(phone.line(engine)["id"], "q1");
    shared.wait_window("extension_ui_request", 1);
    phone.ok("engine_replay", json!({ "engine": engine }));
    phone.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"extension_ui_response\",\"id\":\"q1\",\"confirmed\":true}" }),
    );
    let closed = shared.wait_window("extension_ui_dismissed", 1);
    assert_eq!((closed[0]["id"].as_str(), closed[0]["reason"].as_str()), (Some("q1"), Some("answered")));
    // The echo of the answer is the only thing the phone sees next: nothing was replayed or doubled.
    assert_eq!(phone.line(engine)["type"], "extension_ui_response");
    assert_eq!(shared.window_lines("extension_ui_response").len(), 1);

    // The window closes its conversation: the phone still has the engine, and the process goes on.
    shared.hub.stop(&WindowClient::window(), on_window, Duration::from_secs(2)).unwrap();
    assert!(alive(pid));
    phone.ok("engine_send", json!({ "engine": engine, "line": "{\"type\":\"prompt\",\"n\":4}" }));
    assert_eq!(phone.line(engine)["n"], 4);
    phone.ok("engine_stop", json!({ "engine": engine }));
    wait_gone(pid);
}

#[test]
fn a_phone_that_opens_late_gets_the_open_question_once_and_a_phone_that_comes_back_keeps_its_engine() {
    let shared = bridged("late");
    let session = session_in(&shared);
    let on_window = shared
        .hub
        .open(&WindowClient::window(), shared.pc.cwd.clone(), Some(session.clone()), shared.window_sink())
        .unwrap();
    shared.window_send(on_window, json!({"type":"ask"}));
    shared.wait_window("extension_ui_request", 1);

    let (mut phone, client) = pair(&shared.pc, "late-phone");
    let engine = phone.start(Some(&session));
    phone.ok("engine_replay", json!({ "engine": engine }));
    phone.ok("engine_replay", json!({ "engine": engine }));
    assert_eq!(phone.line(engine)["id"], "q1");
    phone.ok("engine_send", json!({ "engine": engine, "line": "{\"type\":\"mark\"}" }));
    assert_eq!(phone.line(engine)["type"], "mark", "the question came once");

    // The phone is cut: the window carries on alone; on its return the phone has the same engine back and the
    // question that is still open.
    drop(phone);
    std::thread::sleep(Duration::from_millis(300));
    shared.window_send(on_window, json!({"type":"prompt","n":1}));
    let mut back = reconnect(&shared.pc, &client);
    assert_eq!(back.ok("engine_start", json!({ "session": session, "resume": engine })), json!(engine));
    assert_eq!(shared.hub.running_engines(), 1);
    back.ok("engine_replay", json!({ "engine": engine }));
    assert_eq!(back.line(engine)["id"], "q1");
    // The window's own question closed with the phone's answer, and the engine hears one answer.
    back.ok(
        "engine_send",
        json!({ "engine": engine, "line": "{\"type\":\"extension_ui_response\",\"id\":\"q1\",\"confirmed\":false}" }),
    );
    shared.wait_window("extension_ui_dismissed", 1);

    // Away for good: the phone's share ends after the keep-alive (2 s here), and the engine stays for the window.
    drop(back);
    std::thread::sleep(Duration::from_millis(3500));
    let (mut other, _) = pair_again(&shared.pc, "late-other");
    let fresh = other.ok("engine_start", json!({ "session": session, "resume": engine })).as_u64().unwrap();
    assert_ne!(fresh, engine, "another phone cannot take the first one's engine back");
    assert_eq!(shared.hub.running_engines(), 1, "it joined the window's engine, it did not start a second");
    other.refused("engine_send", json!({ "engine": engine, "line": "{}" }));
    shared.window_send(on_window, json!({"type":"prompt","n":2}));
    assert_eq!(other.line(fresh)["n"], 2);
}

#[test]
fn a_phone_served_by_the_window_is_refused_what_any_phone_is_refused() {
    let shared = bridged("refusals");
    let session = session_in(&shared);
    let (mut first, client) = pair(&shared.pc, "refusals-phone");
    let mine = first.start(Some(&session));
    first.line(mine);
    // Another connection of the same phone, an engine number it never had, an unknown operation, the reserved command.
    let mut second = reconnect(&shared.pc, &client);
    for engine in [mine, 999] {
        second.refused("engine_send", json!({ "engine": engine, "line": "{\"type\":\"x\"}" }));
        second.refused("engine_stop", json!({ "engine": engine }));
        second.refused("engine_replay", json!({ "engine": engine }));
    }
    assert!(second.refused("no_such_op", json!({})).contains("no_such_op"));
    second.refused("engine_send", json!({ "args": "x" }));
    let theirs = second.start(None);
    for line in [r#"{"type":"attach_files","paths":["/etc/hostname"]}"#, "not json", "two\nlines"] {
        second.refused("engine_send", json!({ "engine": theirs, "line": line }));
    }
    second.refused("attach_picked", json!({ "engine": theirs, "id": "x", "paths": ["/etc/hostname"] }));
    // The first connection's engine is untouched.
    first.ok("engine_send", json!({ "engine": mine, "line": "{\"type\":\"still\"}" }));
    assert_eq!(first.line(mine)["type"], "still");
    // A line that is not a request ends that connection, and only that one.
    second.lines.write("not a request").unwrap();
    assert!(second.lines.read().map(|line| line.is_none()).unwrap_or(true), "the connection should have closed");
    first.ok("app_info", Value::Null);
    let mut third = reconnect(&shared.pc, &client);
    third.ok("app_info", Value::Null);
}

#[test]
fn files_sent_by_a_phone_are_attached_to_the_windows_engine_and_removed_after() {
    let shared = bridged("bridged-files");
    let (mut phone, _) = pair(&shared.pc, "bridged-files-phone");
    let engine = phone.start(None);
    phone.line(engine);
    let path = upload(&mut phone, "doc.pdf", b"%PDF-1.7 \x00\xff", 4);
    phone.ok("attach_picked", json!({ "engine": engine, "id": "gui-1", "paths": [path] }));
    let line = phone.line(engine);
    assert_eq!((line["type"].as_str(), &line["paths"]), (Some("attach_files"), &json!([path])));
    assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.7 \x00\xff");
    phone.refused("attach_picked", json!({ "engine": engine, "id": "gui-2", "paths": [path] }));
    drop(phone);
    let folder = Path::new(&path).parent().unwrap().parent().unwrap().to_path_buf();
    let deadline = Instant::now() + Duration::from_secs(10);
    while folder.exists() {
        assert!(Instant::now() < deadline, "{folder:?} is still there");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_revoked_phone_is_cut_off_while_it_is_connected() {
    for bridge in [false, true] {
        // The bridged server serves through a hub; the other one has its own engines (no `--hub`).
        let bridged_server = if bridge { Some(bridged("revoke-bridged")) } else { None };
        let direct_server = if bridge { None } else { Some(pc("revoke-direct")) };
        let pc = bridged_server.as_ref().map(|s| &s.pc).or(direct_server.as_ref()).unwrap();
        let (mut phone, client) = pair(pc, "revoke-phone");
        phone.ok("app_info", Value::Null);
        let fingerprint = client.identity.fingerprint();
        let revoked = Command::new(env!("CARGO_BIN_EXE_prism-remote"))
            .args(["revoke", "--dir"])
            .arg(&pc.dir)
            .arg(&fingerprint)
            .output()
            .unwrap();
        assert!(revoked.status.success(), "{}", String::from_utf8_lossy(&revoked.stderr));
        // Cut off within a few seconds, not only refused when it comes back.
        phone
            .lines
            .stream
            .sock
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        let started = Instant::now();
        let ended = loop {
            match phone.lines.read() {
                Ok(None) | Err(_) => break true,
                Ok(Some(_)) => {}
            }
            if started.elapsed() > Duration::from_secs(8) {
                break false;
            }
        };
        assert!(ended, "the revoked phone is still connected (bridge: {bridge})");
    }
}

#[test]
fn a_server_whose_windows_engines_are_gone_closes_the_phone_and_keeps_serving() {
    let root = temp("hub-gone");
    let socket = root.join("nowhere.sock");
    let pc = spawn_pc("hub-gone", json!(["engine.sh"]).to_string(), &[OsStr::new("--hub"), socket.as_os_str()]);
    let (mut phone, client) = pair_or_connect(&pc);
    phone
        .lines
        .stream
        .sock
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    assert!(phone.lines.read().map(|line| line.is_none()).unwrap_or(true), "the phone should be let go");
    // The server is still there: a new code works.
    let _ = client;
    assert!(control(&pc.dir, "status").is_ok());
}

/// Pairs a phone with the invitation printed at start (without the engine calls `pair` waits for).
fn pair_or_connect(pc: &Pc) -> (Phone, Client) {
    let client = Client::new(&temp("hub-gone-phone")).unwrap();
    let lines = client.connect(&pc.invitation).unwrap();
    (Phone::new(lines), client)
}
