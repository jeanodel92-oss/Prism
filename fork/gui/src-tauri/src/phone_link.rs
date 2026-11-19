//! "Link a phone": the window starts
//! Prism's phone server (`prism-remote`, fork/android/server) and shows its pairing code. Two ways to run it, the
//! user's choice: while the window is open (a child of the window, started again with it), or always, as a systemd
//! user service. The server's folder is `~/.prism/remote`, the one `prism-remote` uses by default; the window only
//! runs `prism-remote` and reads its JSON answers, it holds no key.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use prism_host::connection::{serve_socket, Shared};
use prism_host::engine::EngineCommand;
use prism_host::lines;

const SERVICE: &str = "prism-remote.service";

/// The window's own server, while it runs one.
#[derive(Default)]
pub struct PhoneLink {
    child: Mutex<Option<Child>>,
    /// The socket the phones the server brings are served on: the window's engines are theirs too.
    /// Open only while the window's own server runs; a socket of the user's own, mode 0600, never a network port.
    socket: Mutex<Option<PathBuf>>,
}

impl PhoneLink {
    /// Starts the server again if the user chose "while the window is open" (`window-mode` in its folder).
    pub fn resume(&self, shared: &Arc<Shared>) {
        if dir().is_some_and(|dir| dir.join("window-mode").exists()) && status().is_none() {
            let _ = self.spawn(shared);
        }
    }

    /// Stops the window's own server; a service keeps running.
    pub fn stop_child(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        // Nothing listens any more: the socket goes with the server. (The thread that accepted on it stays blocked on
        // a socket nobody can reach, and ends with the window.)
        if let Some(socket) = self.socket.lock().unwrap().take() {
            let _ = std::fs::remove_file(socket);
        }
    }

    /// Opens the window's hub socket and serves the phones the server brings on it.
    fn open_hub(&self, shared: &Arc<Shared>) -> Result<PathBuf, String> {
        let dir = dir().ok_or("no home folder")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Private like the pairing folder the server makes of it (prism-link): the socket takes its own mode only
        // after it is bound.
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700)).map_err(|e| e.to_string())?;
        let socket = dir.join("hub.sock");
        let listener = lines::bind(&socket)?;
        // Files phones sent and left behind by an earlier run; the server does not clean them when it bridges.
        let _ = std::fs::remove_dir_all(&shared.staging);
        let shared = shared.clone();
        std::thread::spawn(move || serve_socket(listener, shared));
        *self.socket.lock().unwrap() = Some(socket.clone());
        Ok(socket)
    }

    fn spawn(&self, shared: &Arc<Shared>) -> Result<(), String> {
        let program = program().ok_or("prism-remote is not installed")?;
        let socket = self.open_hub(shared)?;
        let spawned = self.spawn_with(&program, &socket);
        if spawned.is_err() {
            self.stop_child();
        }
        spawned
    }

    fn spawn_with(&self, program: &Path, socket: &Path) -> Result<(), String> {
        let mut child = Command::new(program)
            .arg("serve")
            .arg("--hub")
            .arg(socket)
            .envs(engine_env())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start prism-remote: {e}"))?;
        // Its error when it stops at once (a taken port, a folder it cannot use), instead of a guess.
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if status().is_some() {
                // Running: what it writes later is not read, so it must not fill a pipe nobody empties.
                if let Some(mut stderr) = child.stderr.take() {
                    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
                }
                *self.child.lock().unwrap() = Some(child);
                return Ok(());
            }
            if let Ok(Some(_)) = child.try_wait() {
                let mut error = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut stderr, &mut error);
                }
                let error = error.trim().trim_start_matches("prism-remote: ");
                return Err(if error.is_empty() {
                    "prism-remote stopped at once".into()
                } else {
                    error.to_string()
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        Err("prism-remote did not answer within 5 s".into())
    }
}

/// `PRISM_REMOTE_DIR` (tests), else `~/.prism/remote`, as `prism-remote` itself.
fn dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PRISM_REMOTE_DIR") {
        return Some(dir.into());
    }
    Some(
        PathBuf::from(std::env::var_os("HOME")?)
            .join(".prism")
            .join("remote"),
    )
}

/// Where the files phones send wait to be attached: the server's own `uploads` folder, as when it runs the engines.
pub fn staging_dir() -> PathBuf {
    dir().unwrap_or_else(std::env::temp_dir).join("uploads")
}

/// `PRISM_REMOTE_BIN`, else `prism-remote` next to the window's own program, else on PATH.
fn program() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PRISM_REMOTE_BIN") {
        return Some(path.into());
    }
    let beside = std::env::current_exe().ok()?.with_file_name("prism-remote");
    if beside.is_file() {
        return Some(beside);
    }
    on_path("prism-remote")
}

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

/// `prism-remote <request>`: its JSON answer.
fn ask(request: &str, extra: &[&str]) -> Result<Value, String> {
    let program = program().ok_or("prism-remote is not installed")?;
    let output = Command::new(program)
        .arg(request)
        .args(extra)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(error
            .trim()
            .trim_start_matches("prism-remote: ")
            .to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(text.trim()).map_err(|e| format!("prism-remote answered {text:?}: {e}"))
}

/// The running server's addresses, port and paired phones; none when no server runs.
fn status() -> Option<Value> {
    ask("status", &[]).ok()
}

fn wait_running() -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if status().is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "the {SERVICE} service did not answer within 5 s (journalctl --user -u {SERVICE})"
    ))
}

fn systemctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|e| format!("systemctl: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn unit_path() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| Some(PathBuf::from(std::env::var_os("HOME")?).join(".config")))?;
    Some(config.join("systemd").join("user").join(SERVICE))
}

/// The engine the phone's sessions run: the window's own, under the server's names (`prism-remote` reads
/// `PRISM_REMOTE_ENGINE`, else the `prism` on PATH). `prism --gui` sets `PRISM_GUI_ENGINE` to its launcher; without
/// this, a window started from another Prism than the installed one gave the phone the installed engine
//. An engine already set for the server is kept (tests).
fn engine_env() -> Vec<(&'static str, String)> {
    if std::env::var_os("PRISM_REMOTE_ENGINE").is_some() {
        return Vec::new();
    }
    let Ok(engine) = EngineCommand::from_env("PRISM_GUI") else {
        return Vec::new();
    };
    let mut env = vec![("PRISM_REMOTE_ENGINE", engine.program)];
    if !engine.args.is_empty() {
        env.push((
            "PRISM_REMOTE_ENGINE_ARGS",
            serde_json::to_string(&engine.args).unwrap_or_default(),
        ));
    }
    env
}

/// One `Environment=` line of a unit: quoted, with systemd's escapes (backslash, quote, and `%` for specifiers).
fn unit_env(name: &str, value: &str) -> String {
    let value = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("Environment=\"{name}={value}\"\n")
}

/// The service's unit: the server with the user's PATH, so it finds `prism` as the window does, and the window's
/// engine.
fn unit(program: &Path) -> String {
    let mut env = unit_env("PATH", &std::env::var("PATH").unwrap_or_default());
    for (name, value) in engine_env() {
        env.push_str(&unit_env(name, &value));
    }
    format!(
        "[Unit]\nDescription=Prism phone server (prism-remote)\n\n[Service]\nExecStart={} serve\nWorkingDirectory=%h\n{env}Restart=on-failure\n\n[Install]\nWantedBy=default.target\n",
        program.display()
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkState {
    /// `prism-remote` found.
    available: bool,
    /// "window", "service", or none.
    mode: Option<&'static str>,
    /// The running server's `status` answer.
    server: Option<Value>,
    /// The fingerprints of the paired phones, running or not.
    paired: Vec<String>,
    tailscale: Tailscale,
}

#[derive(Serialize)]
pub struct Tailscale {
    installed: bool,
    /// Its IPv4 address when it is up.
    address: Option<String>,
}

fn tailscale() -> Tailscale {
    let installed = on_path("tailscale").is_some();
    let address = installed
        .then(|| Command::new("tailscale").args(["ip", "-4"]).output().ok())
        .flatten()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::to_string)
        });
    Tailscale { installed, address }
}

fn paired() -> Vec<String> {
    let Some(program) = program() else {
        return Vec::new();
    };
    Command::new(program)
        .arg("devices")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn service_enabled() -> bool {
    systemctl(&["is-enabled", SERVICE]).is_ok_and(|state| state == "enabled")
}

#[tauri::command]
pub fn phone_link_state(link: tauri::State<'_, PhoneLink>) -> LinkState {
    let own = link
        .child
        .lock()
        .unwrap()
        .as_mut()
        .is_some_and(|child| child.try_wait().ok().flatten().is_none());
    let server = status();
    let mode = if own {
        Some("window")
    } else if service_enabled() {
        Some("service")
    } else {
        None
    };
    LinkState {
        available: program().is_some(),
        mode,
        server,
        paired: paired(),
        tailscale: tailscale(),
    }
}

/// Starts the server: "window" (with the window, and again at its next start) or "service" (always).
#[tauri::command]
pub async fn phone_link_start(
    link: tauri::State<'_, PhoneLink>,
    app: tauri::State<'_, crate::AppState>,
    mode: String,
) -> Result<(), String> {
    let dir = dir().ok_or("no home folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    match mode.as_str() {
        "window" => {
            if service_enabled() {
                systemctl(&["disable", "--now", SERVICE])?;
            }
            std::fs::write(dir.join("window-mode"), "").map_err(|e| e.to_string())?;
            if status().is_none() {
                link.spawn(&app.shared)?;
            }
            Ok(())
        }
        "service" => {
            let program = program().ok_or("prism-remote is not installed")?;
            let _ = std::fs::remove_file(dir.join("window-mode"));
            link.stop_child();
            let path = unit_path().ok_or("no configuration folder")?;
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&path, unit(&program)).map_err(|e| e.to_string())?;
            systemctl(&["daemon-reload"])?;
            systemctl(&["enable", "--now", SERVICE])?;
            wait_running()
        }
        _ => Err(format!("unknown mode {mode}")),
    }
}

/// Stops the server, whichever way it runs, and forgets the choice.
#[tauri::command]
pub async fn phone_link_stop(link: tauri::State<'_, PhoneLink>) -> Result<(), String> {
    if let Some(dir) = dir() {
        let _ = std::fs::remove_file(dir.join("window-mode"));
    }
    link.stop_child();
    if service_enabled() {
        systemctl(&["disable", "--now", SERVICE])?;
    }
    Ok(())
}

/// A new one-time pairing code: `{code, svg, hosts, port}`.
#[tauri::command]
pub async fn phone_link_invite() -> Result<Value, String> {
    ask("invite", &[])
}

#[tauri::command]
pub async fn phone_link_revoke(fingerprint: String) -> Result<(), String> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not a phone's fingerprint".into());
    }
    let program = program().ok_or("prism-remote is not installed")?;
    let output = Command::new(program)
        .args(["revoke", &fingerprint])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// A QR image (SVG) of a short text: the Android app's download address, for the phone's own camera (js/android-app.js).
#[tauri::command]
pub fn qr_svg(text: String) -> Result<String, String> {
    if text.len() > 512 {
        return Err("text too long for a QR code".into());
    }
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .quiet_zone(true)
        .min_dimensions(200, 200)
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test owns these variables: the others in this crate never read or set them.
    #[test]
    fn the_phone_server_runs_the_windows_engine() {
        std::env::remove_var("PRISM_REMOTE_ENGINE");
        std::env::set_var("PRISM_GUI_ENGINE", "/opt/prism 11/prism");
        std::env::set_var("PRISM_GUI_ENGINE_ARGS", r#"["cli.js","--x=50%"]"#);
        assert_eq!(
            engine_env(),
            vec![
                ("PRISM_REMOTE_ENGINE", "/opt/prism 11/prism".to_string()),
                ("PRISM_REMOTE_ENGINE_ARGS", r#"["cli.js","--x=50%"]"#.to_string()),
            ]
        );
        let unit = unit(Path::new("/opt/prism-remote"));
        assert!(unit.contains("Environment=\"PRISM_REMOTE_ENGINE=/opt/prism 11/prism\"\n"), "{unit}");
        assert!(
            unit.contains(r#"Environment="PRISM_REMOTE_ENGINE_ARGS=[\"cli.js\",\"--x=50%%\"]""#),
            "{unit}"
        );

        // An engine already chosen for the server (tests, a user's override) is kept.
        std::env::set_var("PRISM_REMOTE_ENGINE", "/elsewhere/prism");
        assert!(engine_env().is_empty());
        std::env::remove_var("PRISM_REMOTE_ENGINE");
        std::env::remove_var("PRISM_GUI_ENGINE");
        std::env::remove_var("PRISM_GUI_ENGINE_ARGS");

        // A window with no engine set runs the installed `prism`, and so does its server.
        assert_eq!(engine_env(), vec![("PRISM_REMOTE_ENGINE", "prism".to_string())]);
    }

    // One test owns PRISM_REMOTE_DIR as well.
    #[test]
    fn the_hub_socket_exists_only_while_the_link_runs_and_serves_phones_the_server_brings() {
        use prism_host::engine::{EngineCommand, Hub};
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;

        let root = std::env::temp_dir().join(format!("prism-gui-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::env::set_var("PRISM_REMOTE_DIR", &root);
        let shared = Arc::new(Shared {
            hub: Hub::new(EngineCommand::unusable(), Vec::new()),
            cwd: root.clone(),
            engine_error: Some("no engine in this test".into()),
            staging: staging_dir(),
        });
        let link = PhoneLink::default();
        let socket = root.join("hub.sock");
        assert!(!socket.exists(), "nothing listens before the link is started");

        link.open_hub(&shared).unwrap();
        assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);

        // A phone the server brings is served: the window answers its first request.
        let stream = UnixStream::connect(&socket).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        writeln!(writer, "{}", prism_host::connection::hello_line("a".repeat(64).as_str())).unwrap();
        writeln!(writer, r#"{{"id":"1","op":"app_info"}}"#).unwrap();
        let mut answer = String::new();
        reader.read_line(&mut answer).unwrap();
        let answer: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!((answer["id"].as_str(), answer["ok"].as_bool()), (Some("1"), Some(true)), "{answer}");

        // Something that is not a hello is let go.
        let mut stranger = UnixStream::connect(&socket).unwrap();
        writeln!(stranger, "not a hello").unwrap();
        let mut rest = String::new();
        assert_eq!(BufReader::new(stranger).read_line(&mut rest).unwrap(), 0);

        // Stopping the link removes the socket.
        link.stop_child();
        assert!(!socket.exists());
        std::env::remove_var("PRISM_REMOTE_DIR");
        let _ = std::fs::remove_dir_all(&root);
    }
}
