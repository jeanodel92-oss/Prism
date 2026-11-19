//! Prototype commands for J0: `serve` on the PC, `connect` as the phone.
//!
//!   prism-link serve DIR PORT HOST...    shows the pairing code, accepts phones, echoes their lines
//!   prism-link connect DIR [CODE]        pairs with CODE, or reconnects to the saved PC; sends stdin lines
//!   prism-link revoke DIR FINGERPRINT

use std::io::BufRead;
use std::path::Path;
use std::time::Instant;

use prism_link::{Client, Invitation, Server};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("serve") if args.len() >= 4 => serve(&args[1], &args[2], &args[3..]),
        Some("connect") if args.len() >= 2 => connect(&args[1], args.get(2)),
        Some("revoke") if args.len() == 3 => Server::new(Path::new(&args[1]))
            .and_then(|server| server.revoke(&args[2]))
            .map(|found| println!("{}", if found { "revoked" } else { "not paired" })),
        _ => Err("usage: prism-link serve DIR PORT HOST... | connect DIR [CODE] | revoke DIR FINGERPRINT".to_string()),
    };
    if let Err(error) = result {
        eprintln!("prism-link: {error}");
        std::process::exit(1);
    }
}

fn serve(dir: &str, port: &str, hosts: &[String]) -> Result<(), String> {
    let port: u16 = port.parse().map_err(|_| "bad port")?;
    let server = Server::new(Path::new(dir))?;
    let listener = server.listen(port)?;
    let invitation = server.invite(hosts.to_vec(), port)?;
    eprintln!("{}", invitation.qr()?);
    // One line on stdout, read by the tests.
    println!("{}", invitation.encode());
    for tcp in listener.incoming() {
        let Ok(tcp) = tcp else { continue };
        let peer = tcp.peer_addr().map(|a| a.to_string()).unwrap_or_default();
        let server = server.clone();
        std::thread::spawn(move || {
            let outcome = server.accept(tcp, |lines| {
                while let Ok(Some(line)) = lines.read() {
                    if lines.write(&format!("echo {line}")).is_err() {
                        break;
                    }
                }
            });
            match outcome {
                Ok(phone) => eprintln!("served {peer} ({})", &phone[..16]),
                Err(reason) => eprintln!("refused {peer}: {reason}"),
            }
        });
    }
    Ok(())
}

fn connect(dir: &str, code: Option<&String>) -> Result<(), String> {
    let client = Client::new(Path::new(dir))?;
    let invitation = match code {
        Some(code) => Invitation::decode(code)?,
        None => client.saved().ok_or("no paired PC; give a pairing code")?,
    };
    let start = Instant::now();
    let mut lines = client.connect(&invitation)?;
    eprintln!(
        "connected in {} ms as {}",
        start.elapsed().as_millis(),
        &client.identity.fingerprint()[..16]
    );
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let sent = Instant::now();
        lines.write(&line)?;
        let answer = lines.read()?.ok_or("closed")?;
        println!("{answer}\t{} us", sent.elapsed().as_micros());
    }
    Ok(())
}
