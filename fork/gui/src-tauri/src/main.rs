//! Prism desktop client.
//!
//! The window is a system webview (WebKitGTK) that loads its own files from the binary through Tauri's
//! custom scheme: no HTTP server, no remote content. The engine is the Prism CLI in RPC mode, one child
//! process per open session (see `engine.rs`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "drive")]
mod drive;

/// Initial title of the test variant; drive.sh's Hyprland rule matches it.
const DRIVE_TITLE: &str = "Prism drive";
mod gl;
mod phone_link;
mod window_state;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prism_host::attach::{self, Picked};
use prism_host::connection::Shared;
use prism_host::engine::{self, Client, EngineCommand, EngineMessage, Hub, Sink};
use prism_host::project;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// The theme files of the terminal: the window reads its colours from them and defines none itself.
const THEME_DARK: &str =
    include_str!("../../../../packages/coding-agent/src/modes/interactive/theme/prism.json");
const THEME_LIGHT: &str =
    include_str!("../../../../packages/coding-agent/src/modes/interactive/theme/prism-light.json");

struct AppState {
    /// The engines, shared with the phones the window serves when the user links one.
    shared: Arc<Shared>,
    cwd: PathBuf,
    engine_error: Option<String>,
    /// Where the paths of files dropped on the window go (`drop_listen`).
    drops: Arc<Mutex<Option<Channel<Vec<String>>>>>,
    /// The files the attach button's picker returned or a drop gave, which the page may attach (`attach_picked`).
    picked: Arc<Picked>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    cwd: String,
    home: Option<String>,
    themes: [&'static str; 2],
    engine_error: Option<String>,
    locale: String,
    version: &'static str,
    /// The version of Prism the launcher runs (`prism --gui` sets `PRISM_GUI_PRODUCT_VERSION`), shown in the settings
    /// rather than the window's own.
    product_version: Option<String>,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
        .unwrap_or_default();
    AppInfo {
        cwd: state.cwd.display().to_string(),
        home: std::env::var("HOME").ok(),
        themes: [THEME_DARK, THEME_LIGHT],
        engine_error: state.engine_error.clone(),
        locale,
        version: env!("CARGO_PKG_VERSION"),
        product_version: std::env::var("PRISM_GUI_PRODUCT_VERSION").ok().filter(|v| !v.is_empty()),
    }
}

/// The page's zoom (Settings › Window › Text size, Ctrl+plus, Ctrl+minus, Ctrl+0), which the page keeps with its
/// preferences. Within 50% and 200%, as the page offers.
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    if !scale.is_finite() {
        return Err("bad zoom".into());
    }
    window.set_zoom(scale.clamp(0.5, 2.0)).map_err(|e| e.to_string())
}

#[tauri::command]
fn engine_start(
    state: State<'_, AppState>,
    session: Option<String>,
    cwd: Option<String>,
    on_message: Channel<EngineMessage>,
) -> Result<u32, String> {
    if let Some(error) = &state.engine_error {
        return Err(error.clone());
    }
    let cwd = project::resolve(cwd.as_deref().unwrap_or("."), &state.cwd)?;
    // The page's channel is the sink; a closed channel makes the host let the window's attachment go.
    let sink: Sink = Arc::new(move |_, message| on_message.send(message).is_ok());
    state.shared.hub.open(&Client::window(), cwd, session, sink)
}

/// The questions still open and the lines the window has not seen of a session the phone also shows: the page asks
/// once after it attached, and the engine's answer is shown on both sides (host crate, `Hub::replay`).
#[tauri::command]
fn engine_replay(state: State<'_, AppState>, engine: u32) -> Result<(), String> {
    state.shared.hub.replay(&Client::window(), engine)
}

/// fork: the conversations a phone has open through this window's engines, which
/// the page lists as open. Off the main thread: the host asks each such engine which session it runs.
#[tauri::command]
async fn phone_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let hub = state.shared.hub.clone();
    tauri::async_runtime::spawn_blocking(move || hub.held_elsewhere())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn project_directory(state: State<'_, AppState>, path: String) -> Result<project::Directory, String> {
    project::list(&path, &state.cwd)
}

/// The system's folder picker for the project screen's Browse: the chosen folder, or
/// nothing when the user cancels. The test variant answers with `PRISM_GUI_DRIVE_PICK` when it is set, as
/// a dialog of the desktop cannot be scripted.
#[tauri::command]
async fn pick_folder(window: tauri::WebviewWindow, start: Option<String>) -> Option<String> {
    #[cfg(feature = "drive")]
    if let Ok(path) = std::env::var("PRISM_GUI_DRIVE_PICK") {
        return Some(path);
    }
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Some(start) = start.filter(|start| Path::new(start).is_dir()) {
        dialog = dialog.set_directory(start);
    }
    let path = dialog.blocking_pick_folder()?.into_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// The system's file picker for the composer's attach button: any files, outside the
/// project too, or none when the user cancels. The test variant answers with `PRISM_GUI_DRIVE_PICK_FILES`
/// (paths separated by newlines) when it is set.
#[tauri::command]
async fn pick_files(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    start: Option<String>,
) -> Result<Vec<String>, String> {
    #[cfg(feature = "drive")]
    if let Ok(list) = std::env::var("PRISM_GUI_DRIVE_PICK_FILES") {
        let paths: Vec<PathBuf> = list.lines().map(PathBuf::from).collect();
        state.picked.allow(&paths);
        return Ok(paths.iter().map(|path| path.to_string_lossy().into_owned()).collect());
    }
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Some(start) = start.filter(|start| Path::new(start).is_dir()) {
        dialog = dialog.set_directory(start);
    }
    let paths: Vec<PathBuf> = dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    state.picked.allow(&paths);
    Ok(paths.iter().map(|path| path.to_string_lossy().into_owned()).collect())
}

/// Attaches files `pick_files` returned or a drop gave, once each: the engine's answer comes with `id`, as for a
/// request the page sends (attach.rs).
#[tauri::command]
fn attach_picked(state: State<'_, AppState>, engine: u32, id: String, paths: Vec<String>) -> Result<(), String> {
    let line = state.picked.command(&id, &paths)?;
    state.shared.hub.send(&Client::window(), engine, &line)
}

/// The page has drawn its first frames: says so once on stdout, which `prism --gui` waits for to know the window
/// started (launch-interface.ts). Nobody may be reading any more: a write error is ignored.
#[tauri::command]
fn window_ready(window: tauri::WebviewWindow) {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SAID.swap(true, std::sync::atomic::Ordering::SeqCst) {
        #[cfg(target_os = "linux")]
        stop_background_paint(&window);
        #[cfg(not(target_os = "linux"))]
        let _ = window;
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = writeln!(out, "prism-gui: ready").and_then(|_| out.flush());
    }
}

/// maintainer's QA, 2026-11-23: GTK filled the whole window with its background colour on the processor (cairo) before
/// each frame of the page, which covers it entirely. On a 2880x1800 screen at 120 Hz that was about 60% of a core
/// while the welcome scene played (measured: 2-3% without it), and the window lagged. The colour stays until the page
/// has drawn its first frames, so the start does not show an empty window, and comes back while the window changes
/// size: the page draws the new area a few frames late, and that area showed the colour, not what is behind the window.
#[cfg(target_os = "linux")]
fn stop_background_paint(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use gtk::prelude::*;
        use std::cell::Cell;
        use std::rc::Rc;
        const SETTLE: Duration = Duration::from_millis(300);
        let Ok(gtk_window) = target.gtk_window() else { return };
        let provider = gtk::CssProvider::new();
        if provider.load_from_data(b"window { background: none; }").is_err() {
            return;
        }
        let context = gtk_window.style_context();
        context.add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_USER);
        let size = Rc::new(Cell::new((gtk_window.allocated_width(), gtk_window.allocated_height())));
        let generation = Rc::new(Cell::new(0u64));
        gtk_window.connect_size_allocate(move |window, allocation| {
            let now = (allocation.width(), allocation.height());
            if size.replace(now) == now {
                return;
            }
            let context = window.style_context();
            context.remove_provider(&provider);
            let current = generation.get() + 1;
            generation.set(current);
            let (provider, generation) = (provider.clone(), generation.clone());
            gtk::glib::timeout_add_local_once(SETTLE, move || {
                if generation.get() == current {
                    context.add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_USER);
                }
            });
        });
    });
}

#[tauri::command]
fn engine_send(state: State<'_, AppState>, engine: u32, line: String) -> Result<(), String> {
    if attach::reserved(&line) {
        return Err(format!("{} is sent by the window only, and a line must be JSON the window can read", attach::COMMAND));
    }
    state.shared.hub.send(&Client::window(), engine, &line)
}

#[tauri::command]
async fn engine_stop(state: State<'_, AppState>, engine: u32) -> Result<(), String> {
    let hub = state.shared.hub.clone();
    tauri::async_runtime::spawn_blocking(move || hub.stop(&Client::window(), engine, Duration::from_secs(3)))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens a web link in the user's browser. Only http and https; the window never navigates itself.
/// The machine's memory, for the window's engine lifecycle: it puts idle conversations
/// to sleep and refuses a new engine before the system starts swapping.
#[tauri::command]
fn memory_info() -> Option<engine::MemoryInfo> {
    engine::memory_info()
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || url.contains(char::is_whitespace)
    {
        return Err("only http and https links open".into());
    }
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot open the link: {e}"))
}

/// Files dropped on the window, from the file manager: the page inserts their paths, as the terminal gets a
/// drop as a paste of the paths. The host's drop event carries the paths; the page has no event access.
#[tauri::command]
fn drop_listen(state: State<'_, AppState>, on_drop: Channel<Vec<String>>) {
    *state.drops.lock().unwrap() = Some(on_drop);
}

/// Files dropped on the window: the page may attach them (`attach_picked`).
fn dropped(drops: &Mutex<Option<Channel<Vec<String>>>>, picked: &Picked, paths: Vec<String>) {
    picked.allow(&paths.iter().map(PathBuf::from).collect::<Vec<_>>());
    if let Some(channel) = drops.lock().unwrap().as_ref() {
        let _ = channel.send(paths);
    }
}

/// The terminal's /quit: closes the window as its close button does, which stops the engines.
#[tauri::command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

/// while the agent has the user's desktop through the portal (GNOME, KDE), the window gets out
/// of its way, so the agent does not see Prism on the screen it works on; it comes back when the agent gives the
/// desktop back where the desktop allows it. Hyprland is left alone: Prism already moves the user's screen to an empty workspace there, and a
/// tiling compositor does not minimise.
#[tauri::command]
fn set_minimized(window: tauri::WebviewWindow, minimized: bool) -> Result<(), String> {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
        return Ok(());
    }
    if minimized {
        return window.minimize().map_err(|e| e.to_string());
    }
    // Measured under KWin and GNOME Shell: Wayland has no "unminimise" request, so a restore is a
    // present. KWin brings the window back; GNOME Shell keeps it minimised (no activation token).
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn working_directory() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--cwd" {
            if let Some(dir) = args.next() {
                return PathBuf::from(dir);
            }
        }
    }
    std::env::var("PRISM_GUI_CWD")
        .map(PathBuf::from)
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn main() {
    gl::apply();
    let (command, engine_error) = match EngineCommand::from_env("PRISM_GUI") {
        Ok(command) => (command, None),
        Err(error) => (EngineCommand::unusable(), Some(error)),
    };
    let cwd = working_directory();
    let cwd = cwd.canonicalize().unwrap_or(cwd);
    // The engines live in this process, as before: no socket is opened until the user links a phone
    // (phone_link.rs), and the phones then share these very engines.
    let shared = Arc::new(Shared {
        hub: Hub::new(command, Vec::new()),
        cwd: cwd.clone(),
        engine_error: engine_error.clone(),
        staging: phone_link::staging_dir(),
    });
    let drops = Arc::new(Mutex::new(None));
    let window_drops = drops.clone();
    let picked = Arc::new(Picked::default());
    let window_picked = picked.clone();
    let shared_for_link = shared.clone();

    #[cfg(not(feature = "drive"))]
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        app_info,
        project_directory,
        pick_folder,
        pick_files,
        attach_picked,
        window_ready,
        engine_start,
        engine_replay,
        phone_sessions,
        engine_send,
        engine_stop,
        memory_info,
        open_external,
        set_title,
        set_minimized,
        set_zoom,
        close_window,
        drop_listen,
        phone_link::phone_link_state,
        phone_link::phone_link_start,
        phone_link::phone_link_stop,
        phone_link::phone_link_invite,
        phone_link::phone_link_revoke,
        phone_link::qr_svg
    ]);
    #[cfg(feature = "drive")]
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        app_info,
        project_directory,
        pick_folder,
        pick_files,
        attach_picked,
        window_ready,
        engine_start,
        engine_replay,
        phone_sessions,
        engine_send,
        engine_stop,
        memory_info,
        open_external,
        set_title,
        set_minimized,
        set_zoom,
        close_window,
        drop_listen,
        phone_link::phone_link_state,
        phone_link::phone_link_start,
        phone_link::phone_link_stop,
        phone_link::phone_link_invite,
        phone_link::phone_link_revoke,
        phone_link::qr_svg,
        drive::drive_drop,
        drive::drive_script,
        drive::drive_log,
        drive::drive_shot,
        drive::drive_quit
    ]);

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(phone_link::PhoneLink::default())
        .manage(AppState {
            shared: shared.clone(),
            cwd,
            engine_error,
            drops,
            picked,
        })
        .setup(move |app| {
            // fork: the phone server the user chose to run while the window is open.
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                let shared = shared_for_link.clone();
                std::thread::spawn(move || handle.state::<phone_link::PhoneLink>().resume(&shared));
            }
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            // A throwaway profile keeps the page's storage (appearance, language) with it, apart from the
            // user's own window.
            if let Some(dir) = std::env::var_os("PRISM_GUI_DATA_DIR") {
                window = window.data_directory(dir.into());
            }
            // Audit of 2026-11-23, UX-04: the size, place and maximized state the window had when it last closed.
            let state_file = window_state::file(app.handle());
            let saved = state_file.as_deref().and_then(window_state::load);
            let screens = window_state::screens(app.handle());
            let geometry = window_state::restored(saved, &screens);
            window = window.inner_size(geometry.width, geometry.height).maximized(geometry.maximized);
            if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
                window = window.position(x, y);
            }
            let window = window
                // The test variant opens under its own title so drive.sh can keep it off the user's screen.
                .title(if cfg!(feature = "drive") { DRIVE_TITLE } else { "Prism" })
                .min_inner_size(window_state::MIN_WIDTH, window_state::MIN_HEIGHT)
                .background_color(tauri::window::Color(5, 5, 5, 255))
                // The window shows only its own pages; links go to the browser through `open_external`.
                .on_navigation(|url| {
                    matches!(url.scheme(), "tauri")
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                })
                .build()?;
            let tracker = window_state::Tracker::new(geometry, state_file);
            // Also written when the app exits without closing the window first (the test driver's quit).
            {
                use tauri::Manager;
                app.manage(tracker.clone());
            }
            #[cfg(target_os = "linux")]
            tracker.watch_size(&window);
            let watched = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    let paths = paths.iter().map(|path| path.to_string_lossy().into_owned()).collect();
                    dropped(&window_drops, &window_picked, paths);
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => tracker.follow(&watched, event),
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => tracker.save(),
                _ => {}
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("cannot build the Prism window");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            {
                use tauri::Manager;
                _handle.state::<phone_link::PhoneLink>().stop_child();
                if let Some(tracker) = _handle.try_state::<window_state::Tracker>() {
                    tracker.save();
                }
            }
            shared.hub.stop_all(Duration::from_secs(2));
        }
    });
}
