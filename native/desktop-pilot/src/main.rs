mod assets;
mod settings;
mod emote_format;
mod emote_library;

use serde::Serialize;
use serde_json::Value;
use settings::{HelperConfig, SettingsState, SettingsUpdate};
use emote_library::EmoteLibrary;
use std::{collections::HashSet, io::{BufRead, BufReader, Write}, path::PathBuf,
    process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Serialize)]
struct Rect { x: f64, y: f64, width: f64, height: f64 }

#[derive(Clone, Serialize)]
struct Display { id: usize, scale: f64, dip: Rect, phys: Rect }

struct Pilot {
    displays: Vec<Display>,
    ready: Mutex<HashSet<String>>,
    helper: Mutex<Option<Child>>,
    store: Mutex<SettingsState>,
    library: EmoteLibrary,
}

impl Pilot {
    fn stop(&self) {
        if let Ok(mut helper) = self.helper.lock() {
            if let Some(mut child) = helper.take() {
                // EOF removes hooks through the helper's normal shutdown path.
                drop(child.stdin.take());
                for _ in 0..50 {
                    if matches!(child.try_wait(), Ok(Some(_))) { return; }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn send(&self, command: &Value) -> Result<(), String> {
        let mut helper = self.helper.lock().map_err(|e| e.to_string())?;
        if let Some(stdin) = helper.as_mut().and_then(|child| child.stdin.as_mut()) {
            if let Err(error) = writeln!(stdin, "{command}") {
                // An unreachable helper must not keep intercepting gestures with stale configuration.
                if let Some(child) = helper.as_mut() { let _ = child.kill(); }
                return Err(error.to_string());
            }
        }
        Ok(())
    }

    fn emit_snapshot(&self, app: &tauri::AppHandle, event: &str) -> Result<(), String> {
        let snapshot = self.store.lock().map_err(|e| e.to_string())?.snapshot();
        app.emit(event, snapshot.to_string()).map_err(|e| e.to_string())
    }
}

fn settings_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" { return Err("Settings window required".into()); }
    Ok(())
}

fn display_for<'a>(pilot: &'a Pilot, label: &str) -> Result<&'a Display, String> {
    pilot.displays.iter().find(|d| label == format!("overlay-{}", d.id)).ok_or_else(|| "Unknown overlay".into())
}

fn start_helper(app: &tauri::AppHandle, pilot: &Pilot) -> Result<(), String> {
    if pilot.helper.lock().map_err(|e| e.to_string())?.is_some() { return Ok(()); }
    let (config, suspended) = {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        let mut config = store.config.clone().ok_or("Overlay is not ready")?;
        config.0["enabled"] = store.enabled.into();
        store.helper_status = "starting";
        (config, store.suspended)
    };
    let mut helper = pilot.helper.lock().map_err(|e| e.to_string())?;
    if helper.is_some() { return Ok(()); }
    let mut command = Command::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../hook-helper/build/hook-helper.exe"));
    if std::env::var_os("LOLPING_PILOT_SIMULATE").is_some() { command.arg("--simulate"); }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let id = child.id();
    let stdout = child.stdout.take().ok_or("Missing helper stdout")?;
    if let Some(stdin) = child.stdin.as_mut() {
        let commands = format!("{}\n{}\n", config.0, serde_json::json!({ "type": "suspend", "on": suspended }));
        if let Err(error) = stdin.write_all(commands.as_bytes()) {
            let _ = child.kill(); let _ = child.wait(); return Err(error.to_string());
        }
    }
    *helper = Some(child);
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break; };
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue; };
            println!("helper: {line}");
            let pilot = handle.state::<Pilot>();
            if let Ok(mut store) = pilot.store.lock() {
                if event["type"] == "ready" {
                    if event["version"] != 8 { handle.exit(1); return; }
                    store.helper_status = "running";
                }
                if event["type"] == "toggled" {
                    if let Some(enabled) = event["enabled"].as_bool() { store.enabled = enabled; }
                }
            }
            if event["type"] == "ready" || event["type"] == "toggled" { let _ = pilot.emit_snapshot(&handle, "pilot-status"); }
            if handle.emit("pilot-input", &line).is_err() { handle.exit(1); return; }
        }
        let pilot = handle.state::<Pilot>();
        let mut gone = false;
        if let Ok(mut helper) = pilot.helper.lock() {
            if helper.as_ref().is_some_and(|child| child.id() == id) {
                if let Some(mut child) = helper.take() { let _ = child.kill(); let _ = child.wait(); }
                gone = true;
            }
        }
        if gone {
            if let Ok(mut store) = pilot.store.lock() { store.helper_status = "failed"; }
            let _ = pilot.emit_snapshot(&handle, "pilot-status");
        }
    });
    println!("Pilot ready: {} displays", pilot.displays.len());
    Ok(())
}

#[tauri::command]
fn pilot_bootstrap(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>) -> Result<Value, String> {
    let display = display_for(&pilot, window.label())?;
    let mut snapshot = pilot.store.lock().map_err(|e| e.to_string())?.snapshot();
    snapshot["displayId"] = display.id.into();
    snapshot["displays"] = serde_json::to_value(&pilot.displays).map_err(|e| e.to_string())?;
    snapshot["demo"] = std::env::var_os("LOLPING_PILOT_DEMO").is_some().into();
    Ok(snapshot)
}

#[tauri::command]
fn pilot_snapshot(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>) -> Result<Value, String> {
    settings_window(&window)?;
    let mut snapshot = pilot.store.lock().map_err(|e| e.to_string())?.snapshot();
    snapshot["smoke"] = (std::env::var_os("LOLPING_PILOT_SMOKE").is_some()
        && std::env::var_os("LOLPING_PILOT_DATA_DIR").is_some()).into();
    Ok(snapshot)
}

#[tauri::command]
fn pilot_smoke_result(window: tauri::WebviewWindow, passed: bool) -> Result<(), String> {
    settings_window(&window)?;
    if std::env::var_os("LOLPING_PILOT_SMOKE").is_none() || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none() {
        return Err("Smoke test is not enabled".into());
    }
    println!("Pilot settings smoke: {}", if passed { "passed" } else { "failed" });
    Ok(())
}

#[tauri::command]
fn pilot_ready(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, config: HelperConfig) -> Result<Value, String> {
    display_for(&pilot, window.label())?;
    {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        if store.config.is_none() { store.config = Some(config); }
    }
    let mut ready = pilot.ready.lock().map_err(|e| e.to_string())?;
    ready.insert(window.label().to_owned());
    if ready.len() == pilot.displays.len() { start_helper(&app, &pilot)?; }
    Ok(pilot.store.lock().map_err(|e| e.to_string())?.snapshot())
}

#[tauri::command]
fn pilot_save(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, settings: Value, config: HelperConfig, revision: u64) -> Result<(), String> {
    settings_window(&window)?;
    {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        store.save(settings, config, revision)?;
        if let Some(config) = &store.config {
            if let Err(error) = pilot.send(&config.0) { eprintln!("Cannot update input helper: {error}"); }
        }
    }
    pilot.emit_snapshot(&app, "pilot-settings")
}

#[tauri::command]
async fn pilot_import_emote(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<'_, Pilot>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    settings_window(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Ok(serde_json::json!({ "ok": false, "error": "type" })); };
    let upload = match emote_format::image_upload(bytes) {
        Ok(upload) => upload,
        Err(error) => return Ok(serde_json::json!({ "ok": false, "error": error })),
    };
    let result = {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        pilot.library.import(&mut store, upload)
    };
    match result {
        Ok(id) => { pilot.emit_snapshot(&app, "pilot-settings")?; Ok(serde_json::json!({ "ok": true, "id": id })) },
        Err(error) => Ok(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[tauri::command]
async fn pilot_emote_sound(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<'_, Pilot>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    settings_window(&window)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Ok(serde_json::json!({ "ok": false, "error": "type" })); };
    let (header, sound) = match emote_format::sound_upload(bytes) {
        Ok(upload) => upload,
        Err(error) => return Ok(serde_json::json!({ "ok": false, "error": error })),
    };
    let result = {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        pilot.library.sound(&mut store, header, sound)
    };
    match result {
        Ok(()) => { pilot.emit_snapshot(&app, "pilot-settings")?; Ok(serde_json::json!({ "ok": true })) },
        Err(error) => Ok(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[tauri::command]
async fn pilot_remove_emote(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<'_, Pilot>, id: String, live: SettingsUpdate) -> Result<(), String> {
    settings_window(&window)?;
    {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        pilot.library.remove(&mut store, &id, live).map_err(str::to_owned)?;
    }
    pilot.emit_snapshot(&app, "pilot-settings")
}

#[tauri::command]
fn pilot_enabled(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, enabled: bool) -> Result<(), String> {
    settings_window(&window)?;
    pilot.store.lock().map_err(|e| e.to_string())?.enabled = enabled;
    pilot.send(&serde_json::json!({ "type": "setEnabled", "enabled": enabled }))?;
    pilot.emit_snapshot(&app, "pilot-status")
}

#[tauri::command]
fn pilot_capture(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>, on: bool) -> Result<(), String> {
    settings_window(&window)?;
    pilot.store.lock().map_err(|e| e.to_string())?.suspended = on;
    pilot.send(&serde_json::json!({ "type": "suspend", "on": on }))
}

#[tauri::command]
fn pilot_retry(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>) -> Result<(), String> {
    settings_window(&window)?;
    start_helper(&app, &pilot)
}

#[tauri::command]
fn pilot_placed(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, kind: String) -> Result<(), String> {
    let display = display_for(&pilot, window.label())?;
    if kind != "ping" && kind != "emote" { return Err("Unknown wheel".into()); }
    app.emit("pilot-placed", serde_json::json!({ "displayId": display.id, "kind": kind }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pilot_preview(window: tauri::WebviewWindow, app: tauri::AppHandle, kind: String, reference: String) -> Result<(), String> {
    settings_window(&window)?;
    if (kind != "ping" && kind != "emote") || reference.len() > 40
        || !reference.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b':') { return Err("Invalid preview".into()); }
    app.emit("pilot-preview", serde_json::json!({ "kind": kind, "ref": reference }).to_string()).map_err(|e| e.to_string())
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

#[tauri::command]
fn pilot_idle(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>, idle: bool) -> Result<(), String> {
    let d = display_for(&pilot, window.label())?;
    let mut bounds = d.phys.clone(); bounds.height -= d.scale;
    if idle {
        let candidates = [Rect { y: d.phys.y - bounds.height + d.scale, ..bounds.clone() },
            Rect { y: d.phys.y + d.phys.height - d.scale, ..bounds.clone() },
            Rect { x: d.phys.x - bounds.width + d.scale, ..bounds.clone() },
            Rect { x: d.phys.x + d.phys.width - d.scale, ..bounds.clone() }];
        if let Some(parked) = candidates.iter().find(|r| !pilot.displays.iter().any(|o| o.id != d.id && overlaps(r, &o.phys))) {
            bounds = parked.clone();
        } else { return window.hide().map_err(|e| e.to_string()); }
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
    }
    window.set_position(PhysicalPosition::new(bounds.x as i32, bounds.y as i32)).map_err(|e| e.to_string())
}

#[tauri::command]
fn pilot_open_folder(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>) -> Result<(), String> {
    settings_window(&window)?;
    let store = pilot.store.lock().map_err(|e| e.to_string())?;
    let dir = store.file.parent().ok_or("Missing settings directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    Command::new("explorer.exe").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pilot_open_project(window: tauri::WebviewWindow) -> Result<(), String> {
    settings_window(&window)?;
    Command::new("explorer.exe").arg("https://github.com/RobertLin-cl/lolPing").spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pilot_stop(app: tauri::AppHandle) { app.exit(0); }

fn show_settings(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") { return window.set_focus().map_err(|e| e.to_string()); }
    let window = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings/index.html".into()))
        .title("lolPing").inner_size(980.0, 680.0).min_inner_size(720.0, 520.0)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required")
        .disable_drag_drop_handler()
        .on_navigation(|url| url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri")
        .build().map_err(|e| e.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut store) = handle.state::<Pilot>().store.lock() { store.suspended = false; }
            let _ = handle.state::<Pilot>().send(&serde_json::json!({ "type": "suspend", "on": false }));
        }
    });
    Ok(())
}

fn main() {
    if !cfg!(windows) { eprintln!("The desktop pilot currently targets Windows only"); std::process::exit(1); }
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("lolping", |context, request| {
            let pilot = context.app_handle().state::<Pilot>();
            let store = pilot.store.lock().ok();
            let allowed = assets::asset_id(request.uri().path()).is_some_and(|id|
                store.as_ref().is_some_and(|store| emote_library::has_emote(&store.settings, &id)));
            let file = if allowed { assets::find_library_asset(&pilot.library.root, &pilot.library.inherited, request.uri().path()) } else { None };
            let mut response = tauri::http::Response::new(Vec::new());
            *response.status_mut() = tauri::http::StatusCode::NOT_FOUND;
            if let Some(file) = file {
                if let Ok(bytes) = std::fs::read(&file) {
                    let mime = match file.extension().and_then(|s| s.to_str()) {
                        Some("gif") => "image/gif", Some("ogg") => "audio/ogg", Some("mp3") => "audio/mpeg",
                        Some("wav") => "audio/wav", _ => "image/webp",
                    };
                    *response.body_mut() = bytes; *response.status_mut() = tauri::http::StatusCode::OK;
                    response.headers_mut().insert("Content-Type", tauri::http::HeaderValue::from_static(mime));
                }
            }
            response.headers_mut().insert("Access-Control-Allow-Origin", tauri::http::HeaderValue::from_static("*"));
            response.headers_mut().insert("Cache-Control", tauri::http::HeaderValue::from_static("no-store"));
            response
        })
        .invoke_handler(tauri::generate_handler![pilot_bootstrap, pilot_snapshot, pilot_ready, pilot_save,
            pilot_enabled, pilot_capture, pilot_retry, pilot_placed, pilot_preview, pilot_idle,
            pilot_open_folder, pilot_open_project, pilot_stop, pilot_smoke_result,
            pilot_import_emote, pilot_emote_sound, pilot_remove_emote])
        .setup(|app| {
            let bootstrap: Value = serde_json::from_str(include_str!("../../../out/desktop-pilot/bootstrap.json"))?;
            let data_dir = std::env::var_os("LOLPING_PILOT_DATA_DIR").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            let file = data_dir.join("settings.json");
            let source = if file.exists() { file.clone() } else {
                PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("lolPing/settings.json")
            };
            let settings = if std::env::var_os("LOLPING_PILOT_BENCHMARK").is_some() { bootstrap["settings"].clone() } else { match std::fs::read(&source) {
                Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                    eprintln!("Cannot parse settings: {error}"); bootstrap["settings"].clone()
                }),
                Err(_) => bootstrap["settings"].clone(),
            } };
            let displays: Vec<Display> = app.available_monitors()?.iter().enumerate().map(|(id, m)| {
                let scale = m.scale_factor();
                let phys = Rect { x: m.position().x as f64, y: m.position().y as f64, width: m.size().width as f64, height: m.size().height as f64 };
                Display { id, scale, dip: Rect { x: phys.x / scale, y: phys.y / scale, width: phys.width / scale, height: phys.height / scale }, phys }
            }).collect();
            if displays.is_empty() { return Err("No displays found".into()); }
            let library = EmoteLibrary { root: data_dir.join("emotes"),
                inherited: PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("lolPing/emotes") };
            app.manage(Pilot { library, displays: displays.clone(), ready: Mutex::new(HashSet::new()), helper: Mutex::new(None),
                store: Mutex::new(SettingsState::new(settings, file)) });
            let quit = tauri::menu::MenuItem::with_id(app, "quit", bootstrap["quit"].as_str().ok_or("Missing quit label")?, true, None::<&str>)?;
            let settings_item = tauri::menu::MenuItem::with_id(app, "settings", bootstrap["settingsLabel"].as_str().ok_or("Missing settings label")?, true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&settings_item, &quit])?;
            tauri::tray::TrayIconBuilder::new().icon(tauri::image::Image::from_bytes(include_bytes!("../../../build/icon.png"))?)
                .menu(&menu).on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" { app.exit(0); }
                    if event.id.as_ref() == "settings" {
                        let handle = app.clone();
                        std::thread::spawn(move || { if let Err(error) = show_settings(&handle) { eprintln!("{error}"); } });
                    }
                }).build(app)?;
            for d in &displays {
                let window = tauri::WebviewWindowBuilder::new(app, format!("overlay-{}", d.id), tauri::WebviewUrl::App("overlay/index.html".into()))
                    .title("lolPing Desktop Pilot").transparent(true).decorations(false).resizable(false).shadow(false)
                    .focused(false).focusable(false).skip_taskbar(true).always_on_top(true).visible(false)
                    .additional_browser_args("--autoplay-policy=no-user-gesture-required")
                    .on_navigation(|url| url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri").build()?;
                window.set_size(PhysicalSize::new(d.phys.width as u32, (d.phys.height - d.scale) as u32))?;
                window.set_position(PhysicalPosition::new(d.phys.x as i32, d.phys.y as i32))?;
                window.set_ignore_cursor_events(true)?; window.show()?;
            }
            if std::env::var_os("LOLPING_PILOT_SETTINGS").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || { if let Err(error) = show_settings(&handle) { eprintln!("{error}"); } });
            }
            if let Ok(seconds) = std::env::var("LOLPING_PILOT_SECONDS") {
                let seconds: u64 = seconds.parse()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(seconds)); handle.exit(0); });
            }
            Ok(())
        }).build(tauri::generate_context!()).expect("Cannot initialize desktop pilot");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) { handle.state::<Pilot>().stop(); }
    });
}
