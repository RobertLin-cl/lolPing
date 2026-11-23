use crate::{chat_state::{self, ChatState}, Pilot};
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Text { text: String },
    Whisper { peers: Vec<String>, text: String },
    Mute { peers: Vec<String>, on: bool, all: bool },
    Vote { kind: String },
}

pub fn location(app: &tauri::AppHandle) -> Value {
    let pilot = app.state::<Pilot>();
    let (x, y) = pilot.chat.state.lock().map(|s| s.at).unwrap_or((0.0, 0.0));
    let Ok(layout) = pilot.layout.lock() else { return json!({"d":1,"x":0.5,"y":0.5}); };
    let d = layout.displays.iter().find(|d| x >= d.phys.x && x < d.phys.x + d.phys.width && y >= d.phys.y && y < d.phys.y + d.phys.height)
        .or_else(|| layout.displays.first());
    d.map(|d| json!({"d":d.id + 1,"x":((x - d.phys.x) / d.phys.width).clamp(0.0, 1.0),
        "y":((y - d.phys.y) / d.phys.height).clamp(0.0, 1.0)})).unwrap_or_else(|| json!({"d":1,"x":0.5,"y":0.5}))
}

#[derive(Default)]
pub struct Chat {
    pub state: Mutex<ChatState>,
    pub smoke_started: std::sync::atomic::AtomicBool,
    pub smoke_result: Mutex<Option<bool>>,
}

fn hide_seconds(settings: &Value) -> u64 { settings["chatHideS"].as_u64().unwrap_or(8).min(60) }

pub fn snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    let pilot = app.state::<Pilot>();
    let mut snapshot = pilot.store.lock().map_err(|e| e.to_string())?.snapshot();
    {
        let state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
        snapshot["history"] = state.snapshot(); snapshot["generation"] = state.generation.into();
    }
    snapshot["room"] = pilot.rooms.snapshot()?;
    snapshot["chatSmoke"] = (std::env::var_os("LOLPING_PILOT_CHAT_SMOKE").is_some()
        && pilot.chat.smoke_started.load(std::sync::atomic::Ordering::SeqCst)).into();
    Ok(snapshot)
}

pub fn post(app: &tauri::AppHandle, line: Value, settings: &Value, enabled: bool) {
    if settings["features"]["rooms"] != true || (!chat_state::text_on(settings) && line["kind"] != "vote") { return; }
    let pilot = app.state::<Pilot>();
    let history = if let Ok(mut state) = pilot.chat.state.lock() {
        if line["kind"] == "whisperFrom" { state.reply_to = line["peer"].as_str().map(str::to_owned); }
        state.push(line.clone());
        let window_style = !matches!(settings["roomTextStyle"].as_str(), Some("spot" | "danmaku"));
        if enabled && chat_state::text_on(settings) && chat_state::visible(&line, settings) && line["kind"] != "note"
            && (window_style || line["kind"] == "whisperFrom") { state.request(false); }
        Some(state.snapshot())
    } else { None };
    if let Some(history) = history { let _ = app.emit("pilot-chat-history", history.to_string()); }
    let _ = app.emit("pilot-chat-line", line.to_string());
}

pub fn reset(app: &tauri::AppHandle) {
    let pilot = app.state::<Pilot>();
    let history = pilot.chat.state.lock().ok().map(|mut state| { state.clear(); state.snapshot() });
    if let Some(history) = history { let _ = app.emit("pilot-chat-history", history.to_string()); }
    let _ = hide(app);
    if let Some(window) = app.get_webview_window("chat") { let _ = window.destroy(); }
}

pub fn request(app: &tauri::AppHandle) -> Result<(), String> {
    let pilot = app.state::<Pilot>();
    if pilot.rooms.snapshot()?["phase"] != "active" { return Ok(()); }
    {
        let store = pilot.store.lock().map_err(|e| e.to_string())?;
        if !store.enabled || store.suspended || !chat_state::text_on(&store.settings) { return Ok(()); }
    }
    let point = app.cursor_position().map_err(|e| e.to_string())?;
    let previous = foreground();
    let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
    state.at = (point.x, point.y); state.previous = previous;
    state.request(true);
    Ok(())
}

fn typing(app: &tauri::AppHandle, focused: bool) {
    let pilot = app.state::<Pilot>();
    if let Ok(mut store) = pilot.store.lock() { store.chat_focused = focused; }
    if let Err(error) = pilot.sync_input() { eprintln!("Cannot update chat input state: {error}"); }
}

pub fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    let pilot = app.state::<Pilot>();
    let previous = {
        let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
        let previous = if state.focused { state.previous.take() } else { None };
        state.hidden(); previous
    };
    if let Some(window) = app.get_webview_window("chat") {
        if let Some(previous) = previous { restore_foreground(previous); }
        crate::panels::hide(&window)?;
    }
    typing(app, false);
    Ok(())
}

pub fn hover(app: &tauri::AppHandle, hovered: bool) -> Result<(), String> {
    let pilot = app.state::<Pilot>();
    let seconds = hide_seconds(&pilot.store.lock().map_err(|e| e.to_string())?.settings);
    let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
    state.hovered = hovered; state.restart(crate::rooms::now(), seconds);
    Ok(())
}

pub fn ready(app: &tauri::AppHandle) -> Result<(), String> {
    let pilot = app.state::<Pilot>();
    let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
    state.ready = true; state.loading_since = None;
    Ok(())
}

fn create(app: &tauri::AppHandle, settings: &Value) -> Result<(), String> {
    let generation = {
        let pilot = app.state::<Pilot>();
        let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
        state.generation += 1; state.ready = false; state.loading_since = Some(crate::rooms::now()); state.generation
    };
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().map_err(|e| e.to_string())?.ok_or("No primary monitor")?;
    let area = primary.work_area();
    let saved = &settings["chatBounds"];
    let saved_x = saved["x"].as_f64().filter(|v| v.abs() <= 100_000.0);
    let saved_y = saved["y"].as_f64().filter(|v| v.abs() <= 100_000.0);
    let target = monitors.iter().find(|m| {
        let scale = m.scale_factor(); let a = m.work_area();
        saved_x.zip(saved_y).is_some_and(|(x, y)| x + 80.0 <= (a.position.x as f64 + a.size.width as f64) / scale
            && x + saved["width"].as_f64().unwrap_or(0.0) >= a.position.x as f64 / scale + 80.0
            && y + 40.0 <= (a.position.y as f64 + a.size.height as f64) / scale
            && y + saved["height"].as_f64().unwrap_or(0.0) >= a.position.y as f64 / scale + 40.0)
    });
    let monitor = target.unwrap_or(&primary);
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let width = if target.is_some() { saved["width"].as_f64().unwrap_or(360.0).clamp(260.0, 1600.0) } else { 360.0 };
    let height = if target.is_some() { saved["height"].as_f64().unwrap_or(240.0).clamp(140.0, 1200.0) } else { 240.0 };
    let width = width.min(work.size.width as f64 / scale);
    let height = height.min(work.size.height as f64 / scale);
    let (x, y) = if target.is_some() { (saved_x.unwrap_or(0.0) * scale, saved_y.unwrap_or(0.0) * scale) }
        else { (area.position.x as f64 + 24.0 * scale, area.position.y as f64 + (area.size.height as f64 - height * scale) / 2.0) };
    let window = tauri::WebviewWindowBuilder::new(app, "chat", tauri::WebviewUrl::App("text/index.html".into()))
        .title("lolPing").decorations(false).resizable(true).min_inner_size(260.0, 140.0).max_inner_size(1600.0, 1200.0)
        .minimizable(false).maximizable(false).skip_taskbar(true).always_on_top(true).focused(false).visible(false)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required")
        .on_navigation(|url| url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri")
        .build().map_err(|e| e.to_string())?;
    window.set_size(PhysicalSize::new((width * scale).round() as u32, (height * scale).round() as u32)).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32)).map_err(|e| e.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        let pilot = handle.state::<Pilot>();
        if !pilot.chat.state.lock().map(|state| state.generation == generation).unwrap_or(false) { return; }
        let seconds = pilot.store.lock().map(|s| hide_seconds(&s.settings)).unwrap_or(8);
        match event {
            tauri::WindowEvent::Focused(focused) => {
                if let Ok(mut state) = pilot.chat.state.lock() {
                    state.focused = *focused; state.restart(crate::rooms::now(), seconds);
                }
                typing(&handle, *focused);
            },
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                if let Ok(mut state) = pilot.chat.state.lock() { state.bounds_due = Some(crate::rooms::now() + 500); }
            },
            tauri::WindowEvent::Destroyed => {
                if let Ok(mut state) = pilot.chat.state.lock() {
                    state.generation += 1; state.ready = false; state.loading_since = None; state.hidden();
                }
                typing(&handle, false);
            },
            _ => {},
        }
    });
    Ok(())
}

fn reveal(app: &tauri::AppHandle, focus: bool, seconds: u64) -> Result<(), String> {
    let window = app.get_webview_window("chat").ok_or("Missing chat window")?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    if focus {
        typing(app, true);
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            app.state::<Pilot>().send(&json!({"type":"activate","window":(hwnd.0 as usize).to_string()}))?;
        }
        window.eval("document.getElementById('message')?.focus()").map_err(|e| e.to_string())?;
    } else { show_inactive(&window)?; }
    let pilot = app.state::<Pilot>();
    let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
    state.visible = true; state.restart(crate::rooms::now(), seconds);
    Ok(())
}

pub fn run(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let pilot = app.state::<Pilot>();
            if pilot.exiting.load(std::sync::atomic::Ordering::SeqCst) { return; }
            let settings = match pilot.store.lock() { Ok(store) => store.settings.clone(), Err(_) => return };
            let room_live = pilot.rooms.snapshot().is_ok_and(|s| s["phase"] != "idle");
            let pending = pilot.chat.state.lock().ok().and_then(|s| s.pending);
            if !room_live || !chat_state::text_on(&settings) {
                if pending.is_some() || app.get_webview_window("chat").is_some() { let _ = hide(&app); }
                if let Some(window) = app.get_webview_window("chat") { let _ = window.destroy(); }
                continue;
            }
            if pending.is_some() && app.get_webview_window("chat").is_none() {
                if let Err(error) = create(&app, &settings) {
                    eprintln!("Cannot create chat window: {error}"); let _ = hide(&app);
                    if let Some(window) = app.get_webview_window("chat") { let _ = window.destroy(); }
                    continue;
                }
            }
            let now = crate::rooms::now();
            let timed_out = pilot.chat.state.lock().map(|s| s.loading_since.is_some_and(|at| now.saturating_sub(at) >= 15_000)).unwrap_or(false);
            if timed_out {
                eprintln!("Chat readiness timed out; leaving input untouched"); let _ = hide(&app);
                if let Some(window) = app.get_webview_window("chat") { let _ = window.destroy(); }
                continue;
            }
            let (show, expired, save) = match pilot.chat.state.lock() {
                Ok(mut state) => {
                    let show = if state.ready { state.pending.take() } else { None };
                    let save = state.bounds_due.is_some_and(|at| now >= at);
                    if save { state.bounds_due = None; }
                    (show, state.deadline.is_some_and(|at| now >= at), save)
                },
                Err(_) => return,
            };
            if let Some(focus) = show { if let Err(error) = reveal(&app, focus, hide_seconds(&settings)) { eprintln!("Cannot show chat: {error}"); let _ = hide(&app); } }
            else if expired { let _ = hide(&app); }
            if save {
                if let Some(window) = app.get_webview_window("chat") {
                    if let (Ok(position), Ok(size), Ok(scale)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                        let bounds = json!({"x":(position.x as f64 / scale).round(),"y":(position.y as f64 / scale).round(),
                            "width":(size.width as f64 / scale).round(),"height":(size.height as f64 / scale).round()});
                        if let Ok(mut store) = pilot.store.lock() { if let Err(error) = store.save_chat_bounds(bounds) { eprintln!("Cannot save chat bounds: {error}"); } }
                        let _ = pilot.emit_snapshot(&app, "pilot-settings");
                    }
                }
            }
        }
    });
}

#[cfg(windows)]
fn foreground() -> Option<isize> {
    let hwnd = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    (!hwnd.is_null()).then_some(hwnd as isize)
}
#[cfg(not(windows))]
fn foreground() -> Option<isize> { None }

#[cfg(windows)]
fn restore_foreground(hwnd: isize) {
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd as _); }
}
#[cfg(not(windows))]
fn restore_foreground(_hwnd: isize) {}

#[cfg(windows)]
fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> {
    if !window.is_visible().map_err(|e| e.to_string())? {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0, windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
    }
    Ok(())
}
#[cfg(not(windows))]
fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> { window.show().map_err(|e| e.to_string()) }
