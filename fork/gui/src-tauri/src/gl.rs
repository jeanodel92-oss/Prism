//! The window's start on Hyprland with an NVIDIA GPU.
//!
//! There, WebKitGTK's window stopped before showing anything: `wp_linux_drm_syncobj_surface_v1 "Missing acquire
//! timeline"`, then `Error 71 (Protocol error)`. The probable cause is the GL context GTK creates at the first draw,
//! committed with explicit sync but without an acquire point (WebKit bug 324551). `GDK_GL=always` (the context made
//! at the start) gave the maintainer a smooth, usable window on that machine; `WEBKIT_DISABLE_DMABUF_RENDERER=1` opened
//! it but was slow. So `GDK_GL=always` is set only there: GTK on Wayland, an NVIDIA driver, Hyprland, and no
//! `GDK_GL` of the user's. Other desktops and GPUs are left as they are, without evidence that they need it.

use std::path::Path;

/// Whether to set `GDK_GL=always`, from the environment (`var`) and the kernel's modules under `sys` (`/sys`).
pub fn needs_gl_always(var: impl Fn(&str) -> Option<String>, sys: &Path) -> bool {
    // An explicit choice, even empty, is the user's.
    if var("GDK_GL").is_some() {
        return false;
    }
    let wayland_display = var("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty());
    // GTK takes the first backend of GDK_BACKEND it can open ("wayland,x11,*"); unset, Wayland when there is one.
    let wayland = match var("GDK_BACKEND").filter(|backends| !backends.trim().is_empty()) {
        Some(backends) => match backends.split(',').map(str::trim).find(|backend| !backend.is_empty()) {
            Some("wayland") | Some("*") => wayland_display,
            _ => false,
        },
        None => wayland_display,
    };
    let hyprland = var("HYPRLAND_INSTANCE_SIGNATURE").is_some_and(|signature| !signature.is_empty())
        || var("XDG_CURRENT_DESKTOP")
            .is_some_and(|desktops| desktops.split(':').any(|desktop| desktop.eq_ignore_ascii_case("hyprland")));
    let nvidia = sys.join("module/nvidia_drm").exists() || sys.join("module/nvidia").exists();
    wayland && hyprland && nvidia
}

/// Sets `GDK_GL=always` when `needs_gl_always`; called first in `main`, before GTK starts and before any thread.
pub fn apply() {
    if needs_gl_always(|name| std::env::var(name).ok(), Path::new("/sys")) {
        std::env::set_var("GDK_GL", "always");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static RUN: AtomicUsize = AtomicUsize::new(0);

    fn check(vars: &[(&str, &str)], modules: &[&str]) -> bool {
        let run = RUN.fetch_add(1, Ordering::SeqCst);
        let sys = std::env::temp_dir().join(format!("prism-gl-{}-{run}", std::process::id()));
        for module in modules {
            std::fs::create_dir_all(sys.join("module").join(module)).unwrap();
        }
        std::fs::create_dir_all(&sys).unwrap();
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let result = needs_gl_always(|name| vars.get(name).cloned(), &sys);
        std::fs::remove_dir_all(&sys).unwrap();
        result
    }

    const HYPR_WAYLAND: [(&str, &str); 2] = [("WAYLAND_DISPLAY", "wayland-1"), ("HYPRLAND_INSTANCE_SIGNATURE", "abc")];

    #[test]
    fn set_on_hyprland_wayland_with_nvidia() {
        assert!(check(&HYPR_WAYLAND, &["nvidia_drm", "nvidia"]));
        assert!(check(&HYPR_WAYLAND, &["nvidia"]));
        assert!(check(&[("WAYLAND_DISPLAY", "wayland-1"), ("XDG_CURRENT_DESKTOP", "Hyprland")], &["nvidia_drm"]));
        let mut listed = HYPR_WAYLAND.to_vec();
        listed.push(("GDK_BACKEND", "wayland,x11,*"));
        assert!(check(&listed, &["nvidia_drm"]));
    }

    #[test]
    fn left_alone_elsewhere_or_when_the_user_chose() {
        let mut chosen = HYPR_WAYLAND.to_vec();
        chosen.push(("GDK_GL", "disable"));
        assert!(!check(&chosen, &["nvidia_drm"]), "the user's GDK_GL");
        let mut empty = HYPR_WAYLAND.to_vec();
        empty.push(("GDK_GL", ""));
        assert!(!check(&empty, &["nvidia_drm"]), "an empty GDK_GL is a choice too");
        assert!(!check(&HYPR_WAYLAND, &["i915"]), "another GPU");
        let mut x11 = HYPR_WAYLAND.to_vec();
        x11.push(("GDK_BACKEND", "x11"));
        assert!(!check(&x11, &["nvidia_drm"]), "GTK on X11 (Xwayland)");
        assert!(
            !check(&[("WAYLAND_DISPLAY", "wayland-0"), ("XDG_CURRENT_DESKTOP", "GNOME")], &["nvidia_drm"]),
            "another desktop"
        );
        assert!(!check(&[("HYPRLAND_INSTANCE_SIGNATURE", "abc"), ("DISPLAY", ":0")], &["nvidia_drm"]), "no Wayland");
    }
}
