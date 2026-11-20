use serde::Serialize;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::ShellExt;

static HELPER: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Serialize)]
struct HelperStatus {
    running: bool,
    pid: Option<u32>,
}

fn spawn_helper(app: &tauri::AppHandle) {
    // Auto-spawn the local Python helper on desktop startup.
    let resource = app.path().resource_dir().ok();
    let helper_dir = resource
        .map(|p| p.join("helper"))
        .unwrap_or_else(|| std::path::PathBuf::from("../helper"));
    let python = if cfg!(target_os = "windows") { "python" } else { "python3" };
    let child = Command::new(python)
        .arg("main.py")
        .current_dir(&helper_dir)
        .spawn();
    if let Ok(c) = child {
        let pid = c.id();
        *HELPER.lock().unwrap() = Some(c);
        println!("[nova] helper spawned pid={}", pid);
    } else {
        eprintln!("[nova] failed to spawn helper: {:?}", child.err());
    }
}

fn stop_helper() {
    if let Some(mut c) = HELPER.lock().unwrap().take() {
        let _ = c.kill();
    }
}

#[tauri::command]
fn helper_status() -> HelperStatus {
    let guard = HELPER.lock().unwrap();
    HelperStatus {
        running: guard.is_some(),
        pid: guard.as_ref().map(|c| c.id()),
    }
}

#[tauri::command]
fn toggle_frameless(window: tauri::Window) -> bool {
    let cur = window.is_decorations().unwrap_or(true);
    let _ = window.set_decorations(!cur);
    !cur
}

#[tauri::command]
fn toggle_always_on_top(window: tauri::Window) -> bool {
    let cur = window.is_always_on_top().unwrap_or(false);
    let _ = window.set_always_on_top(!cur);
    !cur
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Global shortcut Ctrl+Alt+N toggles window show/hide.
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
            app.global_shortcut().on_shortcut(shortcut, |app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                }
            })?;

            // System tray.
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let frame_i = MenuItem::with_id(app, "frame", "Toggle Frameless", true, None::<&str>)?;
            let aot_i = MenuItem::with_id(app, "aot", "Toggle Always-on-Top", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &frame_i, &aot_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "frame" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let cur = w.is_decorations().unwrap_or(true);
                            let _ = w.set_decorations(!cur);
                        }
                    }
                    "aot" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let cur = w.is_always_on_top().unwrap_or(false);
                            let _ = w.set_always_on_top(!cur);
                        }
                    }
                    "quit" => {
                        stop_helper();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Autostart: start minimized to tray when launched at boot.
            let launched_at_boot = std::env::args().any(|a| a == "--autostart");
            if launched_at_boot {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            } else {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }

            spawn_helper(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide to tray instead of quitting.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![helper_status, toggle_frameless, toggle_always_on_top])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}