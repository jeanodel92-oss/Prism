//! Prism on the phone: the window's interface (fork/gui/ui) with the host commands it
//! calls answered by the PC, over `prism-link` (the protocol is in section 3 quater). Without a paired and reachable
//! PC, the page sees an `engineError` that says so.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{Manager, State};

// The link client lives in its own crate (fork/android/phone) so its tests run without WebKitGTK.
use link::download::Downloads;
use link::{Link, Sink, NOT_LINKED};
use prism_phone as link;

const THEME_DARK: &str =
    include_str!("../../../../packages/coding-agent/src/modes/interactive/theme/prism.json");
const THEME_LIGHT: &str =
    include_str!("../../../../packages/coding-agent/src/modes/interactive/theme/prism-light.json");

/// The requests block until the PC answers, so they run off the thread that serves the page.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// The PC's `app_info` with the phone's own themes: the page needs them and the PC does not send them.
fn merge_app_info(pc: Value) -> Value {
    let mut info = match pc {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    info.insert("themes".into(), json!([THEME_DARK, THEME_LIGHT]));
    info.insert("remote".into(), json!(true));
    Value::Object(info)
}

fn unlinked_info(error: String) -> Value {
    json!({
        "cwd": "",
        "home": null,
        "themes": [THEME_DARK, THEME_LIGHT],
        "engineError": error,
        "locale": "",
        "version": env!("CARGO_PKG_VERSION"),
        "remote": false,
    })
}

#[tauri::command]
async fn app_info(link: State<'_, Link>) -> Result<Value, String> {
    let link = link.inner().clone();
    blocking(move || {
        if !link.is_connected() {
            return Ok(unlinked_info(
                link.status()
                    .error
                    .unwrap_or_else(|| NOT_LINKED.to_string()),
            ));
        }
        match link.call("app_info", json!({})) {
            Ok(info) => {
                if let Some(host) = info.get("host").and_then(Value::as_str) {
                    link.set_name(host);
                }
                Ok(merge_app_info(info))
            }
            Err(error) => Ok(unlinked_info(error)),
        }
    })
    .await
}

#[tauri::command]
fn link_status(link: State<'_, Link>) -> link::Status {
    link.status()
}

#[tauri::command]
async fn link_pair(link: State<'_, Link>, code: String) -> Result<link::Status, String> {
    let link = link.inner().clone();
    blocking(move || {
        link.pair(&code)?;
        Ok(link.status())
    })
    .await
}

#[tauri::command]
fn link_forget(link: State<'_, Link>) {
    link.forget();
}

/// every PC this phone was paired with, to switch between them.
#[tauri::command]
fn link_known(link: State<'_, Link>) -> Vec<link::KnownPc> {
    link.known()
}

#[tauri::command]
fn link_switch(link: State<'_, Link>, id: String) -> Result<(), String> {
    link.switch(&id)
}

#[tauri::command]
async fn engine_start(
    link: State<'_, Link>,
    session: Option<String>,
    cwd: Option<String>,
    resume: Option<u64>,
    on_message: Channel<Value>,
) -> Result<Value, String> {
    let link = link.inner().clone();
    let sink: Sink = Arc::new(move |message| {
        let _ = on_message.send(message);
    });
    // `resume`: the engine this conversation had before the link was cut, which the PC keeps a few minutes.
    let args = json!({"session": session, "cwd": cwd, "resume": resume});
    blocking(move || link.start_engine(args, sink)).await
}

/// The questions a taken-back engine still waits an answer to, sent again as its events.
#[tauri::command]
async fn engine_replay(link: State<'_, Link>, engine: u64) -> Result<(), String> {
    let link = link.inner().clone();
    blocking(move || {
        link.call("engine_replay", json!({"engine": engine}))
            .map(|_| ())
    })
    .await
}

#[tauri::command]
async fn engine_send(link: State<'_, Link>, engine: u64, line: String) -> Result<(), String> {
    let link = link.inner().clone();
    blocking(move || {
        link.call("engine_send", json!({"engine": engine, "line": line}))
            .map(|_| ())
    })
    .await
}

#[tauri::command]
async fn engine_stop(link: State<'_, Link>, engine: u64) -> Result<(), String> {
    let link = link.inner().clone();
    // Stopping an engine that is already gone, or with no PC, is not an error for the page.
    let _ = blocking(move || link.call("engine_stop", json!({"engine": engine}))).await;
    Ok(())
}

// Files from the phone to the PC: the page reads the file it picked in
// pieces and sends them; the PC keeps them, and `attach_picked` attaches the ones this phone sent, once each.
#[tauri::command]
async fn upload_start(link: State<'_, Link>, name: String, size: u64) -> Result<Value, String> {
    let link = link.inner().clone();
    blocking(move || link.call("upload_start", json!({"name": name, "size": size}))).await
}

#[tauri::command]
async fn upload_chunk(link: State<'_, Link>, upload: String, data: String) -> Result<Value, String> {
    let link = link.inner().clone();
    blocking(move || link.call("upload_chunk", json!({"upload": upload, "data": data}))).await
}

#[tauri::command]
async fn upload_finish(link: State<'_, Link>, upload: String) -> Result<Value, String> {
    let link = link.inner().clone();
    blocking(move || link.call("upload_finish", json!({"upload": upload}))).await
}

#[tauri::command]
async fn upload_cancel(link: State<'_, Link>, upload: String) -> Result<(), String> {
    let link = link.inner().clone();
    // A file already gone, or no PC, is not an error for the page.
    let _ = blocking(move || link.call("upload_cancel", json!({"upload": upload}))).await;
    Ok(())
}

#[tauri::command]
async fn attach_picked(
    link: State<'_, Link>,
    engine: u64,
    id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let link = link.inner().clone();
    blocking(move || {
        link.call("attach_picked", json!({"engine": engine, "id": id, "paths": paths}))
            .map(|_| ())
    })
    .await
}

// Files from the PC to the phone: the page reads them from the engine (`files_read`) and gives the pieces here; the
// Android activity then saves the complete file to the phone's Downloads or opens it (MainActivity.kt `saveDownload`).
#[tauri::command]
fn download_begin(downloads: State<'_, Downloads>, name: String) -> Result<String, String> {
    downloads.begin(&name)
}

#[tauri::command]
fn download_append(downloads: State<'_, Downloads>, id: String, data: String) -> Result<u64, String> {
    downloads.append(&id, &data)
}

#[tauri::command]
fn download_finish(downloads: State<'_, Downloads>, id: String) -> Result<String, String> {
    downloads.finish(&id)
}

#[tauri::command]
fn download_discard(downloads: State<'_, Downloads>, id: String) {
    downloads.discard(&id);
}

#[tauri::command]
async fn project_directory(link: State<'_, Link>, path: String) -> Result<Value, String> {
    let link = link.inner().clone();
    blocking(move || link.call("project_directory", json!({"path": path}))).await
}

#[tauri::command]
fn pick_folder(start: Option<String>) -> Option<String> {
    let _ = start;
    None
}

#[tauri::command]
fn pick_files(start: Option<String>) -> Vec<String> {
    let _ = start;
    Vec::new()
}

#[tauri::command]
async fn memory_info(link: State<'_, Link>) -> Result<Value, String> {
    let link = link.inner().clone();
    // Nothing to show is `null`, as on the window.
    Ok(blocking(move || link.call("memory_info", json!({})))
        .await
        .unwrap_or(Value::Null))
}

#[tauri::command]
fn drop_listen(on_drop: Channel<Vec<String>>) {
    let _ = on_drop;
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let _ = url;
    Err("not in the prototype".to_string())
}

#[tauri::command]
fn set_title(title: String) {
    let _ = title;
}

#[tauri::command]
fn close_window() {}

#[tauri::command]
fn window_ready() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // The camera for the pairing QR code, opened by its button (fork/gui/ui/js/pair-screen.js).
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    // Android's notices for a conversation that waits or is done while the app is away (fork/gui/ui/phone/notices.js).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        .setup(|app| {
            let link = Link::new(&app.path().app_data_dir()?)?;
            link.connect_saved();
            app.manage(link);
            app.manage(Downloads::new(app.path().app_cache_dir()?.join("downloads")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            link_status,
            link_pair,
            link_forget,
            link_known,
            link_switch,
            engine_start,
            engine_send,
            engine_stop,
            engine_replay,
            attach_picked,
            upload_start,
            upload_chunk,
            upload_finish,
            upload_cancel,
            download_begin,
            download_append,
            download_finish,
            download_discard,
            project_directory,
            pick_folder,
            pick_files,
            memory_info,
            drop_listen,
            open_external,
            set_title,
            close_window,
            window_ready
        ])
        .run(tauri::generate_context!())
        .expect("cannot start Prism");
}
