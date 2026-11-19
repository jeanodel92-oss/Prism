//! Test driver, compiled only with `--features drive` (never in the normal binary).
//!
//! `PRISM_GUI_DRIVE` names a JSON file of steps that `ui/js/drive.js` plays inside the window as a user
//! would (typing, clicks on visible buttons). Screenshots go through `grim` on the output named by
//! `PRISM_GUI_DRIVE_OUTPUT`; progress lines go to stdout for the calling script.

use std::io::Write;

#[tauri::command]
pub fn drive_script() -> Option<String> {
    let path = std::env::var("PRISM_GUI_DRIVE").ok()?;
    std::fs::read_to_string(path).ok()
}

#[tauri::command]
pub fn drive_log(line: String) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "drive: {line}");
    let _ = out.flush();
}

#[tauri::command]
pub async fn drive_shot(name: String) -> Result<String, String> {
    if name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("bad screenshot name".into());
    }
    let dir =
        std::env::var("PRISM_GUI_DRIVE_SHOTS").map_err(|_| "PRISM_GUI_DRIVE_SHOTS is not set")?;
    let output =
        std::env::var("PRISM_GUI_DRIVE_OUTPUT").map_err(|_| "PRISM_GUI_DRIVE_OUTPUT is not set")?;
    let path = format!("{dir}/{name}.png");
    let status = std::process::Command::new("grim")
        .args(["-o", &output, &path])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(path)
    } else {
        Err(format!("grim failed: {status}"))
    }
}

/// Ends the run: 0 when the scenario passed, the code given otherwise (VAL-001: a failed step exited 0).
#[tauri::command]
pub fn drive_quit(app: tauri::AppHandle, code: Option<i32>) {
    app.exit(code.unwrap_or(0));
}

/// A drop from the file manager as the host's drop event delivers it (the OS drag itself cannot be scripted).
#[tauri::command]
pub fn drive_drop(state: tauri::State<'_, crate::AppState>, paths: Vec<String>) {
    crate::dropped(&state.drops, &state.picked, paths);
}
