//! The window's size, place and maximized state across launches (it always opened at ! 1180x780, not maximized)
//. Kept in `window-state.json` in the window's data folder (`PRISM_GUI_DATA_DIR` for a
//! throwaway profile, else the app's local data folder), written when the window closes or the app exits.
//!
//! Sizes and places are logical pixels. Wayland gives a window no place of its own: there only the size and the
//! maximized state come back, and the compositor places the window.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_WIDTH: f64 = 1180.0;
pub const DEFAULT_HEIGHT: f64 = 780.0;
pub const MIN_WIDTH: f64 = 420.0;
pub const MIN_HEIGHT: f64 = 360.0;
const FILE_NAME: &str = "window-state.json";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    /// The size when not maximized, so that leaving the maximized state comes back to it.
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

/// A screen's area in logical pixels: x, y, width, height.
pub type Screen = (f64, f64, f64, f64);

/// Where the state is kept, if the app has a data folder.
pub fn file(app: &AppHandle) -> Option<PathBuf> {
    let dir = std::env::var_os("PRISM_GUI_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_local_data_dir().ok())?;
    Some(dir.join(FILE_NAME))
}

pub fn load(path: &Path) -> Option<Geometry> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The screens the window may open on, in logical pixels.
pub fn screens(app: &AppHandle) -> Vec<Screen> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor().max(0.1);
            let (position, size) = (monitor.position(), monitor.size());
            (
                f64::from(position.x) / scale,
                f64::from(position.y) / scale,
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        })
        .collect()
}

/// The geometry to open with: the saved one, no larger than the largest screen and no smaller than the window's
/// minimum, and its place only if it is still on a screen (one unplugged since leaves the window to the desktop).
pub fn restored(saved: Option<Geometry>, screens: &[Screen]) -> Geometry {
    let Some(saved) = saved.filter(|g| g.width.is_finite() && g.height.is_finite()) else {
        return Geometry::default();
    };
    let widest = screens.iter().map(|s| s.2).fold(f64::NAN, f64::max);
    let tallest = screens.iter().map(|s| s.3).fold(f64::NAN, f64::max);
    let width = saved
        .width
        .min(if widest.is_nan() { saved.width } else { widest })
        .max(MIN_WIDTH);
    let height = saved
        .height
        .min(if tallest.is_nan() {
            saved.height
        } else {
            tallest
        })
        .max(MIN_HEIGHT);
    let place = match (saved.x, saved.y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
            // Its title bar's start must be on a screen, so the user can take hold of it.
            let on_screen = screens.iter().any(|&(sx, sy, sw, sh)| {
                x + 40.0 >= sx && x + 40.0 < sx + sw && y >= sy && y + 20.0 < sy + sh
            });
            on_screen.then_some((x, y))
        }
        _ => None,
    };
    Geometry {
        width,
        height,
        x: place.map(|p| p.0),
        y: place.map(|p| p.1),
        maximized: saved.maximized,
    }
}

/// Whether the desktop tells a window where it is: not on Wayland.
#[cfg(target_os = "linux")]
fn places_known(window: &tauri::WebviewWindow) -> bool {
    use gtk::prelude::*;
    window
        .gtk_window()
        .map(|gtk_window| !gtk_window.display().type_().name().contains("Wayland"))
        .unwrap_or(true)
}

#[cfg(not(target_os = "linux"))]
fn places_known(_window: &tauri::WebviewWindow) -> bool {
    true
}

/// Follows the window's size and place while it is open, and writes them when it closes.
#[derive(Clone)]
pub struct Tracker {
    state: Arc<Mutex<Geometry>>,
    file: Option<PathBuf>,
}

impl Tracker {
    pub fn new(geometry: Geometry, file: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(geometry)),
            file,
        }
    }

    pub fn follow(&self, window: &tauri::WebviewWindow, event: &tauri::WindowEvent) {
        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        let maximized = window.is_maximized().unwrap_or(false);
        let mut state = self.state.lock().unwrap();
        state.maximized = maximized;
        // Maximized, the window keeps the size and place it goes back to.
        if maximized {
            return;
        }
        match event {
            // On Linux the size comes from the page's box (`watch_size`): the event's counts GTK's own decorations.
            #[cfg(not(target_os = "linux"))]
            tauri::WindowEvent::Resized(size) if size.width > 0 && size.height > 0 => {
                state.width = f64::from(size.width) / scale;
                state.height = f64::from(size.height) / scale;
            }
            // Wayland gives a window no place: what it reports (0, 0) is kept nowhere.
            tauri::WindowEvent::Moved(position) if places_known(window) => {
                state.x = Some(f64::from(position.x) / scale);
                state.y = Some(f64::from(position.y) / scale);
            }
            _ => {}
        }
    }

    /// Follows the size of the box that holds the page, which is what `inner_size` gives when the window opens. The
    /// window's own size counts GTK's decorations (title bar, shadow): measured 2026-11-23 under GNOME, 900x600 given
    /// came back as 952x689, and the window grew at each launch. GTK sizes are logical pixels already.
    #[cfg(target_os = "linux")]
    pub fn watch_size(&self, window: &tauri::WebviewWindow) {
        use gtk::prelude::*;
        let (Ok(page), Ok(gtk_window)) = (window.default_vbox(), window.gtk_window()) else {
            return;
        };
        let state = self.state.clone();
        page.connect_size_allocate(move |_, allocation| {
            if gtk_window.is_maximized() || allocation.width() <= 1 || allocation.height() <= 1 {
                return;
            }
            let mut state = state.lock().unwrap();
            state.width = f64::from(allocation.width());
            state.height = f64::from(allocation.height());
        });
    }

    /// Writes the state; a folder that cannot be written leaves the next launch at the default size.
    pub fn save(&self) {
        let Some(file) = &self.file else { return };
        let state = *self.state.lock().unwrap();
        if let Ok(text) = serde_json::to_string(&state) {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(file, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Screen = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn no_saved_state_opens_at_the_default_size() {
        assert_eq!(restored(None, &[SCREEN]), Geometry::default());
    }

    #[test]
    fn the_saved_size_place_and_maximized_state_come_back() {
        let saved = Geometry {
            width: 900.0,
            height: 600.0,
            x: Some(100.0),
            y: Some(50.0),
            maximized: true,
        };
        assert_eq!(restored(Some(saved), &[SCREEN]), saved);
    }

    #[test]
    fn a_size_larger_than_every_screen_or_under_the_minimum_is_brought_within_them() {
        let saved = Geometry {
            width: 4000.0,
            height: 100.0,
            ..Geometry::default()
        };
        let geometry = restored(Some(saved), &[SCREEN, (1920.0, 0.0, 2560.0, 1440.0)]);
        assert_eq!((geometry.width, geometry.height), (2560.0, MIN_HEIGHT));
    }

    #[test]
    fn a_place_on_a_screen_unplugged_since_is_left_to_the_desktop() {
        let saved = Geometry {
            x: Some(2500.0),
            y: Some(100.0),
            ..Geometry::default()
        };
        let geometry = restored(Some(saved), &[SCREEN]);
        assert_eq!((geometry.x, geometry.y), (None, None));
    }

    #[test]
    fn no_known_screen_keeps_the_saved_size() {
        let saved = Geometry {
            width: 1500.0,
            height: 900.0,
            ..Geometry::default()
        };
        let geometry = restored(Some(saved), &[]);
        assert_eq!(
            (geometry.width, geometry.height, geometry.x),
            (1500.0, 900.0, None)
        );
    }

    #[test]
    fn the_state_file_round_trips_and_an_old_one_without_a_place_reads() {
        let dir = std::env::temp_dir().join(format!("prism-window-state-{}", std::process::id()));
        let tracker = Tracker::new(
            Geometry {
                width: 800.0,
                height: 640.0,
                x: Some(10.0),
                y: Some(20.0),
                maximized: false,
            },
            Some(dir.join(FILE_NAME)),
        );
        tracker.save();
        assert_eq!(
            load(&dir.join(FILE_NAME)),
            Some(*tracker.state.lock().unwrap())
        );
        std::fs::write(dir.join(FILE_NAME), r#"{"width":700,"height":500}"#).unwrap();
        assert_eq!(
            load(&dir.join(FILE_NAME)),
            Some(Geometry {
                width: 700.0,
                height: 500.0,
                ..Geometry::default()
            })
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
