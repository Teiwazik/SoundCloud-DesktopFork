use crate::emit_window_visibility;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let play_pause = MenuItemBuilder::with_id("play_pause", "Play / Pause").build(app)?;
    let next = MenuItemBuilder::with_id("next", "Next").build(app)?;
    let prev = MenuItemBuilder::with_id("prev", "Previous").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &play_pause, &prev, &next, &quit])
        .build()?;

    // ID lets `app.tray_by_id("main")` find this tray later — required so
    // the `set_app_icon` command can swap the tray icon at runtime.
    //
    // We use a pre-rendered 64x64 tray PNG instead of the 256x256 window
    // icon. Windows downscales 256→16 with low-quality interpolation and
    // the result is muddy; 64→16 looks crisp because the source already
    // went through high-quality LANCZOS at build time.
    TrayIconBuilder::with_id("main")
        .icon(tauri::include_image!("icons/variants/default-tray.png"))
        .tooltip("SoundCloud Desktop")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                        emit_window_visibility(&app.clone(), true);
                    }
                }
                "play_pause" | "next" | "prev" => {
                    let _ = app.emit("tray-action", id);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    emit_window_visibility(&tray.app_handle(), true);
                }
            }
        })
        .build(app)?;

    Ok(())
}
