// The phone link's successes and refusals, over loopback.

use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;

use prism_link::{Client, Invitation, Server};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("prism-link-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A PC that echoes, on a free port; each connection's outcome is sent back.
fn pc(
    dir: &PathBuf,
) -> (
    Arc<Server>,
    u16,
    std::sync::mpsc::Receiver<Result<String, String>>,
) {
    let server = Server::new(dir).unwrap();
    let listener = server.listen(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel();
    let accepting = server.clone();
    std::thread::spawn(move || {
        for tcp in listener.incoming().flatten() {
            let (server, tx) = (accepting.clone(), tx.clone());
            std::thread::spawn(move || {
                let outcome = server.accept(tcp, |lines| {
                    while let Ok(Some(line)) = lines.read() {
                        let _ = lines.write(&format!("echo {line}"));
                    }
                });
                let _ = tx.send(outcome);
            });
        }
    });
    (server, port, rx)
}

#[test]
fn pairs_reconnects_and_refuses() {
    let (pc_dir, phone_dir, other_dir) = (temp("pc"), temp("phone"), temp("other"));
    let (server, port, outcomes) = pc(&pc_dir);
    let hosts = vec!["127.0.0.1".to_string()];

    // A code that names an address where nothing listens, then the PC: the next address is tried.
    let mut invitation = server
        .invite(
            vec!["127.0.0.1:1".to_string(), "127.0.0.1".to_string()],
            port,
        )
        .unwrap();
    let decoded = Invitation::decode(&invitation.encode()).unwrap();
    assert_eq!(decoded, invitation);
    invitation.hosts = vec!["10.255.255.1".to_string(), "127.0.0.1".to_string()];

    let phone = Client::new(&phone_dir).unwrap();
    let mut lines = phone.connect(&invitation).unwrap();
    lines.write("hello é").unwrap();
    assert_eq!(lines.read().unwrap().as_deref(), Some("echo hello é"));
    drop(lines);
    assert_eq!(outcomes.recv().unwrap(), Ok(phone.identity.fingerprint()));
    assert_eq!(server.paired(), vec![phone.identity.fingerprint()]);

    // Reconnects with the saved PC, without a code.
    let saved = phone.saved().unwrap();
    assert_eq!(saved.token, None);
    let mut lines = phone
        .connect(&Invitation {
            hosts: hosts.clone(),
            ..saved.clone()
        })
        .unwrap();
    lines.write("again").unwrap();
    assert_eq!(lines.read().unwrap().as_deref(), Some("echo again"));
    drop(lines);
    assert!(outcomes.recv().unwrap().is_ok());

    // The same code a second time: refused.
    let other = Client::new(&other_dir).unwrap();
    let reused = Invitation {
        hosts: hosts.clone(),
        ..invitation.clone()
    };
    let refused = other.connect(&reused).err().unwrap();
    assert!(refused.contains("unknown, used or expired"), "{refused}");
    assert!(outcomes.recv().unwrap().is_err());

    // A device that never paired: refused.
    let refused = other
        .connect(&Invitation {
            hosts: hosts.clone(),
            ..saved.clone()
        })
        .err()
        .unwrap();
    assert!(refused.contains("not paired"), "{refused}");
    assert!(outcomes.recv().unwrap().is_err());

    // A made-up code: refused, and the device stays unpaired.
    let made_up = Invitation {
        token: Some("00".repeat(16)),
        hosts: hosts.clone(),
        ..saved.clone()
    };
    assert!(other.connect(&made_up).is_err());
    assert!(outcomes.recv().unwrap().is_err());
    assert_eq!(server.paired().len(), 1);

    // A PC whose certificate is not the paired one: the phone refuses it before sending anything.
    let impostor = Invitation {
        fingerprint: "ab".repeat(32),
        hosts: hosts.clone(),
        ..saved.clone()
    };
    let refused = phone.connect(&impostor).err().unwrap();
    assert!(
        refused.contains("not the one paired") || refused.contains("certificate"),
        "{refused}"
    );
    assert!(outcomes.recv().unwrap().is_err());

    // Revoked: refused from then on.
    assert!(server.revoke(&phone.identity.fingerprint()).unwrap());
    let refused = phone
        .connect(&Invitation {
            hosts: hosts.clone(),
            ..saved.clone()
        })
        .err()
        .unwrap();
    assert!(refused.contains("not paired"), "{refused}");
    assert!(outcomes.recv().unwrap().is_err());

    // Not TLS at all: the PC drops it and keeps serving.
    let mut plain = TcpStream::connect(("127.0.0.1", port)).unwrap();
    plain.write_all(b"HELLO\n").unwrap();
    assert!(outcomes.recv().unwrap().is_err());
    let fresh = server.invite(hosts.clone(), port).unwrap();
    assert!(phone.connect(&fresh).is_ok());
    assert!(outcomes.recv().unwrap().is_ok());

    for dir in [pc_dir, phone_dir, other_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn rejects_codes_that_are_not_prism_s() {
    assert!(Invitation::decode("https://example.com").is_err());
    assert!(Invitation::decode("prism-pair:v1;h=1.2.3.4;p=1;f=short").is_err());
    assert!(Invitation::decode("prism-pair:v1;p=1;f=".to_string().as_str()).is_err());
    assert!(Invitation::decode(&format!(
        "prism-pair:v1;h=1.2.3.4;p=1;f={};x=1",
        "a".repeat(64)
    ))
    .is_err());
}

#[test]
fn polls_without_losing_a_line_cut_in_two() {
    let (pc_dir, phone_dir) = (temp("poll-pc"), temp("poll-phone"));
    let server = Server::new(&pc_dir).unwrap();
    let listener = server.listen(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepting = server.clone();
    std::thread::spawn(move || {
        let tcp = listener.incoming().flatten().next().unwrap();
        let _ = accepting.accept(tcp, |lines| {
            // Half a line, a pause longer than the phone's poll, then the rest and a second line.
            lines.stream.write_all(b"{\"half\":").unwrap();
            lines.stream.flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
            lines.write("1}\nsecond").unwrap();
            while let Ok(Some(_)) = lines.read() {}
        });
    });
    let phone = Client::new(&phone_dir).unwrap();
    let invitation = server.invite(vec!["127.0.0.1".to_string()], port).unwrap();
    let mut lines = phone.connect(&invitation).unwrap();
    let mut got = Vec::new();
    let mut empty = 0;
    while got.len() < 2 {
        match lines.poll(std::time::Duration::from_millis(20)).unwrap() {
            prism_link::Polled::Line(line) => got.push(line),
            prism_link::Polled::Nothing => empty += 1,
            prism_link::Polled::Closed => panic!("closed"),
        }
    }
    assert_eq!(got, vec!["{\"half\":1}".to_string(), "second".to_string()]);
    assert!(
        empty > 0,
        "the pause should have been seen as nothing to read"
    );
    // Writing between polls still works.
    lines.write("bye").unwrap();
    for dir in [pc_dir, phone_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

// Security audit of 2026-11-14: what anyone who reaches the port gets before the PC knows the phone.

#[test]
fn refuses_a_long_first_line_before_reading_it_all() {
    let (pc_dir, other_dir) = (temp("long-pc"), temp("long-other"));
    let (server, port, outcomes) = pc(&pc_dir);
    let saved = server.invite(vec!["127.0.0.1".to_string()], port).unwrap();
    // An unpaired device whose "code" is 4 MiB long: refused on its size, not kept in memory to be compared.
    let other = Client::new(&other_dir).unwrap();
    let long = Invitation {
        token: Some("0".repeat(4 << 20)),
        ..saved.clone()
    };
    assert!(other.connect(&long).is_err());
    assert_eq!(outcomes.recv().unwrap(), Err("line too long".to_string()));
    assert!(server.paired().is_empty());
    // The real code still pairs.
    assert!(other.connect(&saved).is_ok());
    assert!(outcomes.recv().unwrap().is_ok());
    for dir in [pc_dir, other_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn closes_a_connection_that_drips_its_first_bytes() {
    let pc_dir = temp("drip-pc");
    let (_server, port, outcomes) = pc(&pc_dir);
    let started = std::time::Instant::now();
    let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
    // The start of a TLS handshake record of 16 KiB, then one byte a second: every read succeeds within the read
    // timeout, so only the limit on the whole wait ends it.
    slow.write_all(&[0x16, 0x03, 0x01, 0x40, 0x00]).unwrap();
    std::thread::spawn(move || {
        for _ in 0..25 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if slow.write_all(&[0]).is_err() {
                break;
            }
        }
    });
    assert!(outcomes.recv().unwrap().is_err());
    let waited = started.elapsed();
    assert!(
        waited >= prism_link::HELLO_WAIT - std::time::Duration::from_secs(1)
            && waited < prism_link::HELLO_WAIT + std::time::Duration::from_secs(4),
        "closed after {waited:?}"
    );
    let _ = std::fs::remove_dir_all(pc_dir);
}

#[test]
fn bounds_the_connections_that_have_not_said_who_they_are() {
    let (pc_dir, phone_dir) = (temp("many-pc"), temp("many-phone"));
    let (server, port, outcomes) = pc(&pc_dir);
    let phone = Client::new(&phone_dir).unwrap();
    let invitation = server.invite(vec!["127.0.0.1".to_string()], port).unwrap();
    // Silent connections take every place...
    let silent: Vec<TcpStream> = (0..prism_link::PENDING_LIMIT)
        .map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap())
        .collect();
    std::thread::sleep(std::time::Duration::from_millis(500));
    // ...so the next one is closed at once, whoever it is.
    assert!(phone.connect(&invitation).is_err());
    assert_eq!(
        outcomes.recv().unwrap(),
        Err("too many connections are waiting to say who they are".to_string())
    );
    // Once they leave, the phone pairs with the same code: it was never read.
    drop(silent);
    for _ in 0..prism_link::PENDING_LIMIT {
        assert!(outcomes.recv().unwrap().is_err());
    }
    assert!(phone.connect(&invitation).is_ok());
    assert!(outcomes.recv().unwrap().is_ok());
    for dir in [pc_dir, phone_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

// Security audit of fork.12 (follow-up of AS-001): a phone that stops reading does not hold the PC's writes forever.
#[test]
fn bounds_how_long_a_write_waits_for_a_phone() {
    let (pc_dir, phone_dir) = (temp("write-pc"), temp("write-phone"));
    let server = Server::new(&pc_dir).unwrap();
    let listener = server.listen(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepting = server.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let tcp = listener.incoming().flatten().next().unwrap();
        let _ = accepting.accept(tcp, |lines| {
            let _ = tx.send(lines.stream.sock.write_timeout().unwrap());
        });
    });
    let phone = Client::new(&phone_dir).unwrap();
    let invitation = server.invite(vec!["127.0.0.1".to_string()], port).unwrap();
    let _lines = phone.connect(&invitation).unwrap();
    let timeout = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
    assert_eq!(timeout, Some(prism_link::WRITE_WAIT));
    for dir in [pc_dir, phone_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}
