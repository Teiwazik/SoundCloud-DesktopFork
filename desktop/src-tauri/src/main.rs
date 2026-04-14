// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Apply WebKitGTK workarounds for NVIDIA + Wayland fractional scaling.
///
/// Without these, fractional display scaling (e.g. 125%) causes severe
/// stuttering/freezes in the WebView due to DMABUF/explicit-sync issues
/// between WebKitGTK and the NVIDIA driver.
///
/// Must run BEFORE any GTK/WebKit initialization (i.e. before tauri::Builder).
#[cfg(target_os = "linux")]
fn apply_linux_gpu_workarounds() {
    let is_flatpak =
        std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists();
    let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v == "wayland")
            .unwrap_or(false);

    if !is_wayland {
        return;
    }

    // Check for NVIDIA GPU via /proc/driver/nvidia or lspci-style detection
    let has_nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::fs::read_to_string("/proc/modules")
            .map(|m| m.contains("nvidia"))
            .unwrap_or(false);

    if !has_nvidia {
        return;
    }

    println!("[GPU] NVIDIA + Wayland detected, applying WebKitGTK workarounds");

    // Native WebKitGTK on Wayland can become unusably slow on NVIDIA, while the
    // Flatpak runtime behaves much better. Prefer X11/XWayland for native runs,
    // but let users opt out if they explicitly want Wayland.
    let allow_wayland = std::env::var("SCD_NATIVE_WAYLAND")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    let has_x11_display = std::env::var("DISPLAY").is_ok();
    let gdk_backend_overridden = std::env::var("GDK_BACKEND").is_ok();

    if !is_flatpak && !allow_wayland && has_x11_display && !gdk_backend_overridden {
        println!("[GPU] Forcing native GTK/WebKit to X11 fallback for smoother rendering");
        std::env::set_var("GDK_BACKEND", "x11");
    }

    // Disable DMABUF renderer — causes white screen / rendering issues on NVIDIA
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // Disable NVIDIA explicit sync — known to cause stuttering with fractional scaling
    if std::env::var("__NV_DISABLE_EXPLICIT_SYNC").is_err() {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    apply_linux_gpu_workarounds();

    soundcloud_desktop_lib::run()
}
