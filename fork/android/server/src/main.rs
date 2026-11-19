//! Prism's phone server: serves the window's host calls
//! (engines, folders, machine info) to phones paired through prism-link.
//!
//! ```text
//! prism-remote serve [--dir DIR] [--port PORT] [--host ADDR]... [--cwd DIR] [--hub SOCKET]
//! prism-remote invite [--dir DIR]
//! prism-remote status [--dir DIR]
//! prism-remote devices [--dir DIR]
//! prism-remote revoke [--dir DIR] FINGERPRINT
//! ```
//!
//! fork: the PC window starts the server and asks it for a new
//! pairing code while it runs, through a socket in its folder (`invite`, `status`: one JSON line each). Without
//! `--dir`, `~/.prism/remote`; without `--port`, the one this folder used last, else 47392, so a paired phone finds the
//! PC again after a restart. Without `--host`, every address of the machine, Tailscale's first.
//!
//! fork: with `--hub SOCKET` (or `PRISM_REMOTE_HUB`) the server owns no engine: it checks the
//! phone's certificate, then hands the phone to the PC window's engines over that local socket (`bridge.rs`), so the
//! window and the phone share their sessions live. Without it, the server runs its own engines (a machine with no
//! window).

mod bridge;
mod control;

use std::io::IsTerminal;
use std::net::{SocketAddr, TcpListener, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::Arc;
use std::thread;

use prism_host::connection::{self, Shared};
use prism_host::engine::{EngineCommand, Hub};
use prism_host::lines::{Polled, Transport};
use prism_link::{Server, ServerLines};

const USAGE: &str = "usage:
  prism-remote serve [--dir DIR] [--port PORT] [--host ADDR]... [--cwd DIR] [--hub SOCKET]
  prism-remote invite [--dir DIR]
  prism-remote status [--dir DIR]
  prism-remote devices [--dir DIR]
  prism-remote revoke [--dir DIR] FINGERPRINT";

/// The port a new folder serves on.
const DEFAULT_PORT: u16 = 47392;
/// The control socket, in the server's folder.
const CONTROL: &str = "control.sock";

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("prism-remote: {error}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Default)]
struct Options {
    dir: Option<PathBuf>,
    port: Option<u16>,
    hosts: Vec<String>,
    cwd: Option<PathBuf>,
    hub: Option<PathBuf>,
    positional: Vec<String>,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().cloned().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--dir" => options.dir = Some(value("--dir")?.into()),
            "--port" => {
                options.port = Some(
                    value("--port")?
                        .parse()
                        .map_err(|_| "--port must be 0-65535")?,
                )
            }
            "--host" => options.hosts.push(value("--host")?),
            "--cwd" => options.cwd = Some(value("--cwd")?.into()),
            "--hub" => options.hub = Some(value("--hub")?.into()),
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option {flag}\n{USAGE}"))
            }
            _ => options.positional.push(arg.clone()),
        }
    }
    Ok(options)
}

fn run(args: Vec<String>) -> Result<(), String> {
    let Some((command, rest)) = args.split_first() else {
        return Err(USAGE.into());
    };
    let options = parse(rest)?;
    // PRISM_REMOTE_DIR: the window's tests, apart from the user's folder.
    let dir = match options
        .dir
        .clone()
        .or_else(|| std::env::var_os("PRISM_REMOTE_DIR").map(PathBuf::from))
    {
        Some(dir) => dir,
        None => PathBuf::from(std::env::var_os("HOME").ok_or("--dir is required without HOME")?)
            .join(".prism")
            .join("remote"),
    };
    match command.as_str() {
        "serve" => serve(&dir, &options),
        "invite" | "status" => {
            println!("{}", control::ask(&dir.join(CONTROL), command)?);
            Ok(())
        }
        "devices" => {
            for fingerprint in Server::new(&dir)?.paired() {
                println!("{fingerprint}");
            }
            Ok(())
        }
        "revoke" => {
            let [fingerprint] = options.positional.as_slice() else {
                return Err(format!("revoke takes one fingerprint\n{USAGE}"));
            };
            if Server::new(&dir)?.revoke(fingerprint)? {
                println!("revoked {fingerprint}");
                Ok(())
            } else {
                Err(format!("{fingerprint} is not a paired device"))
            }
        }
        _ => Err(USAGE.into()),
    }
}

/// The machine's non-loopback IPv4 addresses, from `ip -4 -o addr` (no dependency needed). They include Tailscale's
/// and any container bridge's: pass `--host` to choose.
fn local_addresses() -> Vec<String> {
    let Ok(output) = Command::new("ip").args(["-4", "-o", "addr"]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            fields.find(|field| *field == "inet")?;
            let address = fields.next()?.split('/').next()?;
            (!address.starts_with("127.")).then(|| address.to_string())
        })
        .collect()
}

/// Listens only on the chosen addresses, not on every interface as `Server::listen` does. With port 0 the first
/// address picks a free port and the others reuse it, so one invitation fits all.
fn listen(hosts: &[String], port: u16) -> Result<(Vec<TcpListener>, u16), String> {
    let mut port = port;
    let mut listeners = Vec::new();
    for host in hosts {
        let address: SocketAddr = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("{host}: {e}"))?
            .next()
            .ok_or(format!("{host}: no address"))?;
        let listener = TcpListener::bind(address).map_err(|e| format!("{address}: {e}"))?;
        port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listeners.push(listener);
    }
    Ok((listeners, port))
}

/// Tailscale's addresses (100.64.0.0/10) first: they reach the PC from anywhere, the local ones only at home.
fn tailscale_first(mut hosts: Vec<String>) -> Vec<String> {
    let tailscale = |host: &String| {
        let mut parts = host.split('.').map(|part| part.parse::<u8>().unwrap_or(0));
        parts.next() == Some(100) && (64..128).contains(&parts.next().unwrap_or(0))
    };
    hosts.sort_by_key(|host| !tailscale(host));
    hosts
}

fn serve(dir: &std::path::Path, options: &Options) -> Result<(), String> {
    let server = Server::new(dir)?;
    // PRISM_REMOTE_PORT and PRISM_REMOTE_HOSTS (comma-separated): the window's tests, never the user's port or network.
    let env_port = std::env::var("PRISM_REMOTE_PORT")
        .ok()
        .and_then(|port| port.parse().ok());
    let env_hosts: Vec<String> = std::env::var("PRISM_REMOTE_HOSTS")
        .map(|hosts| {
            hosts
                .split(',')
                .filter(|h| !h.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let port = options.port.or(env_port).unwrap_or_else(|| {
        std::fs::read_to_string(dir.join("port"))
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(DEFAULT_PORT)
    });
    let hosts = if !options.hosts.is_empty() {
        options.hosts.clone()
    } else if !env_hosts.is_empty() {
        env_hosts
    } else {
        tailscale_first(local_addresses())
    };
    if hosts.is_empty() {
        return Err("no network address found: pass --host".into());
    }
    let cwd = match &options.cwd {
        Some(cwd) => cwd.clone(),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let cwd = cwd
        .canonicalize()
        .map_err(|e| format!("{}: {e}", cwd.display()))?;
    // Files left by a server that was killed: nobody can attach them any more. (Not when the window's engines serve the
    // phones: its host owns that folder then.)
    let staging = dir.join("uploads");
    if options.hub.is_none() && std::env::var_os("PRISM_REMOTE_HUB").is_none() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    let (command, engine_error) = match EngineCommand::from_env("PRISM_REMOTE") {
        Ok(command) => (command, None),
        Err(error) => (EngineCommand::unusable(), Some(error)),
    };
    // The engines know their screen is a phone: what only makes sense on the PC itself (the browser's setup assistant)
    // is not offered there.
    let hub = Hub::new(command, vec![("PRISM_REMOTE_CLIENT".into(), "phone".into())]);
    let shared = Arc::new(Shared {
        hub,
        cwd,
        engine_error,
        staging,
    });
    let bridge_to: Option<PathBuf> = options
        .hub
        .clone()
        .or_else(|| std::env::var_os("PRISM_REMOTE_HUB").map(PathBuf::from));
    let control = control::bind(&dir.join(CONTROL))?;
    let (listeners, port) = listen(&hosts, port)?;
    std::fs::write(dir.join("port"), format!("{port}\n")).map_err(|e| e.to_string())?;
    {
        let (server, hosts) = (server.clone(), hosts.clone());
        thread::spawn(move || control::serve(control, &server, &hosts, port));
    }
    // fork: a code made at start is only for a person at a terminal. Run as a
    // user service, stdout and stderr go to the journal, where a live code could pair any device that reaches the
    // port; the window and /phone ask the running server for one (`invite`) when the user wants it.
    if std::io::stdout().is_terminal() && std::io::stderr().is_terminal() {
        let invitation = server.invite(hosts, port)?;
        eprintln!("{}", invitation.qr()?);
        println!("{}", invitation.encode());
        eprintln!("prism-remote: listening on port {port}; the code is valid for 5 minutes");
    } else {
        eprintln!(
            "prism-remote: listening on port {port}; `prism-remote invite` makes a pairing code"
        );
    }

    let accepting: Vec<_> = listeners
        .into_iter()
        .map(|listener| {
            let (server, shared, bridge_to) = (server.clone(), shared.clone(), bridge_to.clone());
            thread::spawn(move || {
                for tcp in listener.incoming().flatten() {
                    let (server, shared, bridge_to) = (server.clone(), shared.clone(), bridge_to.clone());
                    thread::spawn(move || {
                        let from = tcp.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                        let paired = server.clone();
                        let outcome = server.accept(tcp, |lines| match &bridge_to {
                            Some(hub) => bridge::run(lines, hub, &paired),
                            None => connection::run(&mut Tls { lines, server: &paired }, &shared),
                        });
                        match outcome {
                            Ok(phone) => eprintln!("prism-remote: {phone} ({from}) disconnected"),
                            Err(reason) => eprintln!("prism-remote: {from} refused: {reason}"),
                        }
                    });
                }
            })
        })
        .collect();
    for thread in accepting {
        let _ = thread.join();
    }
    Ok(())
}

/// The phone's TLS stream as the protocol's transport. The device list is read again every second, so a phone
/// revoked while it is connected is cut off.
struct Tls<'a> {
    lines: &'a mut ServerLines,
    server: &'a Arc<Server>,
}

impl Transport for Tls<'_> {
    fn poll(&mut self, wait: std::time::Duration) -> Result<Polled, String> {
        Ok(match self.lines.poll(wait)? {
            prism_link::Polled::Line(line) => Polled::Line(line),
            prism_link::Polled::Closed => Polled::Closed,
            prism_link::Polled::Nothing => Polled::Nothing,
        })
    }

    fn write(&mut self, line: &str) -> Result<(), String> {
        self.lines.write(line)
    }

    fn peer(&self) -> String {
        self.lines.peer().unwrap_or_default()
    }

    fn allowed(&self) -> bool {
        self.server.paired().contains(&self.peer())
    }
}
