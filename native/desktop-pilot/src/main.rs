mod assets;
mod settings;
mod emote_format;
mod emote_library;
mod displays;
mod display_smoke;
mod rooms;
mod chat;
mod chat_state;
mod panels;
mod spells;
mod votes;

use serde_json::Value;
use settings::{HelperConfig, SettingsState, SettingsUpdate};
use emote_library::EmoteLibrary;
use displays::{Display, DisplayChange, DisplayWatch, Layout, Rect, parked_bounds};
use std::{io::{BufRead, BufReader, Write}, path::PathBuf,
    process::{Child, Command, Stdio}, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

struct Pilot {
    layout: Mutex<Layout>,
    exiting: AtomicBool,
    helper: Mutex<Option<Child>>,
    store: Mutex<SettingsState>,
    library: EmoteLibrary,
    rooms: rooms::Service,
    chat: chat::Chat,
    panels: panels::Panels,
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

    fn sync_input(&self) -> Result<(), String> {
        let active = self.rooms.snapshot()?["phase"] == "active";
        let mut store = self.store.lock().map_err(|e| e.to_string())?;
        if let Some(config) = &store.config {
            let mut config = chat_state::runtime_config(&config.0, &store.settings, store.enabled, active);
            if store.suspended { config["summonerKeys"] = false.into(); }
            let suspended = store.suspended || store.chat_focused;
            // Roster updates must not cancel a gesture by re-sending an unchanged helper config.
            if store.sent_config.as_ref() != Some(&config) { self.send(&config)?; store.sent_config = Some(config); }
            if store.sent_suspended != Some(suspended) {
                self.send(&serde_json::json!({"type":"suspend","on":suspended}))?; store.sent_suspended = Some(suspended);
            }
        }
        Ok(())
    }
}

fn settings_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" { return Err("Settings window required".into()); }
    Ok(())
}

fn display_for(pilot: &Pilot, label: &str) -> Result<Display, String> {
    pilot.layout.lock().map_err(|e| e.to_string())?.display(label).cloned().ok_or_else(|| "Unknown overlay".into())
}

fn start_helper(app: &tauri::AppHandle, pilot: &Pilot, layout: &Layout) -> Result<(), String> {
    if !layout.is_ready() || pilot.exiting.load(Ordering::SeqCst) { return Ok(()); }
    if pilot.helper.lock().map_err(|e| e.to_string())?.is_some() { return Ok(()); }
    let (config, suspended) = {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        let mut config = store.config.clone().ok_or("Overlay is not ready")?;
        config.0 = chat_state::runtime_config(&config.0, &store.settings, store.enabled, pilot.rooms.snapshot()?["phase"] == "active");
        if store.suspended { config.0["summonerKeys"] = false.into(); }
        store.helper_status = "starting";
        let suspended = store.suspended || store.chat_focused;
        store.sent_config = Some(config.0.clone()); store.sent_suspended = Some(suspended);
        (config, suspended)
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
    let labels: Vec<String> = layout.displays.iter().map(|d| layout.label(d.id)).collect();
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break; };
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue; };
            println!("helper: {line}");
            let pilot = handle.state::<Pilot>();
            if let Ok(mut store) = pilot.store.lock() {
                if !pilot.helper.lock().map(|h| h.as_ref().is_some_and(|child| child.id() == id)).unwrap_or(false) {
                    return;
                }
                if event["type"] == "ready" {
                    if event["version"] != 8 { handle.exit(1); return; }
                    store.helper_status = "running";
                }
                if event["type"] == "toggled" {
                    if let Some(enabled) = event["enabled"].as_bool() { store.enabled = enabled; }
                }
            }
            if event["type"] == "ready" || event["type"] == "toggled" { let _ = pilot.emit_snapshot(&handle, "pilot-status"); }
            if event["type"] == "textRequested" {
                if let Err(error) = chat::request(&handle) { eprintln!("Cannot open chat: {error}"); }
            }
            if event["type"] == "panel" { panels::held(&handle, event["show"] == true); }
            if event["type"] == "ready" { panels::held(&handle, false); }
            if event["type"] == "summonerCast" {
                if let Some(slot) = event["slot"].as_str().filter(|s| ["d","f"].contains(s)) {
                    handle.state::<Pilot>().rooms.enqueue(rooms::Operation::Cast(slot.into()));
                }
            }
            for label in &labels {
                if handle.emit_to(tauri::EventTarget::webview_window(label), "pilot-input", &line).is_err() {
                    handle.exit(1); return;
                }
            }
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
    println!("Pilot ready: {} displays (generation {})", layout.displays.len(), layout.generation);
    Ok(())
}

#[tauri::command]
fn pilot_bootstrap(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>) -> Result<Value, String> {
    let layout = pilot.layout.lock().map_err(|e| e.to_string())?;
    let display = layout.display(window.label()).ok_or("Unknown overlay")?;
    let mut snapshot = pilot.store.lock().map_err(|e| e.to_string())?.snapshot();
    snapshot["displayId"] = display.id.into();
    snapshot["displays"] = serde_json::to_value(&layout.displays).map_err(|e| e.to_string())?;
    snapshot["demo"] = std::env::var_os("LOLPING_PILOT_DEMO").is_some().into();
    Ok(snapshot)
}

#[tauri::command]
fn pilot_snapshot(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>) -> Result<Value, String> {
    settings_window(&window)?;
    let mut snapshot = pilot.store.lock().map_err(|e| e.to_string())?.snapshot();
    snapshot["smoke"] = (std::env::var_os("LOLPING_PILOT_SMOKE").is_some()
        && std::env::var_os("LOLPING_PILOT_DATA_DIR").is_some()).into();
    snapshot["roomSmoke"] = std::env::var_os("LOLPING_PILOT_ROOM_SMOKE").is_some().into();
    snapshot["chatSmoke"] = std::env::var_os("LOLPING_PILOT_CHAT_SMOKE").is_some().into();
    snapshot["panelSmoke"] = std::env::var_os("LOLPING_PILOT_PANEL_SMOKE").is_some().into();
    Ok(snapshot)
}

#[tauri::command]
async fn pilot_room(window: tauri::WebviewWindow, app: tauri::AppHandle, action: String,
    code: Option<String>, peer: Option<String>, on: Option<bool>) -> Result<Value, String> {
    settings_window(&window)?;
    if action == "get" { return app.state::<Pilot>().rooms.snapshot(); }
    if action == "clipboard" { return Ok(rooms::clipboard::read().unwrap_or_default().into()); }
    if action == "copy" {
        if let Some(code) = app.state::<Pilot>().rooms.snapshot()?["code"].as_str() { rooms::clipboard::write(&window, code)?; }
        return Ok(Value::Null);
    }
    let operation = match action.as_str() {
        "create" => rooms::Operation::Create,
        "join" => rooms::Operation::Join(code.ok_or("Missing room code")?),
        "leave" => rooms::Operation::Leave,
        "mute" => rooms::Operation::Mute(peer.ok_or("Missing member")?, on.ok_or("Missing mute state")?),
        "retry" => rooms::Operation::Retry,
        _ => return Err("Unknown room operation".into()),
    };
    tauri::async_runtime::spawn_blocking(move || app.state::<Pilot>().rooms.call(operation)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pilot_panel_smoke(window: tauri::WebviewWindow, app: tauri::AppHandle, phase: String, detail: Option<String>) -> Result<Value, String> {
    if !["settings","roster","vote"].contains(&window.label()) || std::env::var_os("LOLPING_PILOT_PANEL_SMOKE").is_none()
        || std::env::var_os("LOLPING_PILOT_ROOM_SMOKE").is_none() || std::env::var_os("LOLPING_PILOT_SIMULATE").is_none()
        || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none() { return Err("Panel smoke is not enabled".into()); }
    let pilot = app.state::<Pilot>();
    match phase.as_str() {
        "down" | "up" | "tap" | "cast" => {
            pilot.sync_input()?;
            let vk = if phase == "cast" {68} else {pilot.store.lock().map_err(|e| e.to_string())?.settings["panelKey"].as_u64().unwrap_or(9)};
            let now = rooms::now();
            if phase != "up" { pilot.send(&serde_json::json!({"type":"sim","ev":"kdown","vk":vk,"t":now}))?; }
            if phase != "down" { pilot.send(&serde_json::json!({"type":"sim","ev":"kup","vk":vk,"t":now+1}))?; }
        },
        "incoming" => {
            let generation = pilot.chat.state.lock().map_err(|e| e.to_string())?.generation;
            return tauri::async_runtime::spawn_blocking(move || app.state::<Pilot>().rooms.call(rooms::Operation::Chat(generation, chat::Command::Text { text: "panel incoming ready".into() })))
                .await.map_err(|e| e.to_string())?;
        },
        "roster-page" | "vote-page" => {
            let detail = detail.unwrap_or_default();
            let mut result = pilot.panels.smoke.lock().map_err(|e| e.to_string())?;
            if !result.is_object() { *result = serde_json::json!({}); }
            result[&phase] = detail.clone().into(); println!("Pilot {phase}: {detail}");
        },
        "passed" | "failed" => println!("Pilot panel smoke: {phase} {}",detail.unwrap_or_default()),
        "status" => {},
        _ => return Err("Unknown panel smoke phase".into()),
    }
    let visible = |label| app.get_webview_window(label).is_some_and(|w| w.is_visible().unwrap_or(false));
    let focused = |label| app.get_webview_window(label).is_some_and(|w| w.is_focused().unwrap_or(false));
    let store = pilot.store.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"room":pilot.rooms.snapshot()?,"history":pilot.chat.state.lock().map_err(|e| e.to_string())?.snapshot(),
        "roster":visible("roster"),"vote":visible("vote"),"focused":focused("roster") || focused("vote"),
        "config":store.sent_config,"result":pilot.panels.smoke.lock().map_err(|e| e.to_string())?.as_object().cloned().unwrap_or_default()}))
}

#[tauri::command]
async fn pilot_panel(window: tauri::WebviewWindow, app: tauri::AppHandle, action: Option<Value>, session: Option<String>) -> Result<Value, String> {
    let roster = window.label() == "roster";
    if !roster && window.label() != "vote" { return Err("Panel window required".into()); }
    let Some(action) = action else { return panels::snapshot(&app, window.label()); };
    if action["t"] == "ready" {
        app.state::<Pilot>().panels.ready.lock().map_err(|e| e.to_string())?.insert(window.label().into());
        return Ok(Value::Null);
    }
    if !roster && action["t"] == "title" {
        let title = action["text"].as_str().filter(|s| s.chars().count() <= 256).ok_or("Invalid panel title")?;
        window.set_title(title).map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    if action.to_string().len() > 2048 { return Err("Invalid panel action".into()); }
    let kind = action["t"].as_str().unwrap_or("");
    if !panels::valid_action(&action, roster) {
        return Err("Action is not allowed in this panel".into());
    }
    if !window.is_visible().map_err(|e| e.to_string())? { return Err("Panel is hidden".into()); }
    let state = app.state::<Pilot>().rooms.snapshot()?;
    let session = session.ok_or("Missing room session")?;
    if state["phase"] != "active" || state["members"][0]["peer"] != session { return Err("Retired room session".into()); }
    if kind == "chatCategory" { panels::category(&app, &action)?; return Ok(Value::Null); }
    tauri::async_runtime::spawn_blocking(move || app.state::<Pilot>().rooms.call(rooms::Operation::Panel(session, action)))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pilot_chat(window: tauri::WebviewWindow, app: tauri::AppHandle, action: String,
    command: Option<chat::Command>, on: Option<bool>, generation: Option<u64>) -> Result<Value, String> {
    if window.label() != "chat" { return Err("Chat window required".into()); }
    if action != "snapshot" {
        let current = app.state::<Pilot>().chat.state.lock().map_err(|e| e.to_string())?.generation;
        if Some(current) != generation { return Err("Retired chat window".into()); }
    }
    match action.as_str() {
        "snapshot" => chat::snapshot(&app),
        "ready" => { chat::ready(&app)?; Ok(Value::Null) },
        "hide" => { chat::hide(&app)?; Ok(Value::Null) },
        "hover" => { chat::hover(&app, on.ok_or("Missing hover state")?)?; Ok(Value::Null) },
        "drag" => { window.start_dragging().map_err(|e| e.to_string())?; Ok(Value::Null) },
        "submit" => {
            let command = command.ok_or("Missing chat command")?;
            let generation = generation.ok_or("Missing chat generation")?;
            tauri::async_runtime::spawn_blocking(move || app.state::<Pilot>().rooms.call(rooms::Operation::Chat(generation, command)))
                .await.map_err(|e| e.to_string())?
        },
        _ => Err("Unknown chat action".into()),
    }
}

#[tauri::command]
async fn pilot_chat_smoke(window: tauri::WebviewWindow, app: tauri::AppHandle, phase: String, detail: Option<String>) -> Result<Value, String> {
    if !matches!(window.label(), "chat" | "settings") || std::env::var_os("LOLPING_PILOT_CHAT_SMOKE").is_none()
        || std::env::var_os("LOLPING_PILOT_ROOM_SMOKE").is_none() || std::env::var_os("LOLPING_PILOT_SIMULATE").is_none()
        || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none() { return Err("Chat smoke is not enabled".into()); }
    let pilot = app.state::<Pilot>();
    match phase.as_str() {
        "start" => {
            pilot.chat.smoke_started.store(true, Ordering::SeqCst);
            pilot.sync_input()?;
            for (i, (event, vk)) in [("kdown", 17), ("kdown", 13), ("kup", 13), ("kup", 17)].iter().enumerate() {
                pilot.send(&serde_json::json!({"type":"sim","ev":event,"vk":vk,"t":rooms::now() + i as u64}))?;
            }
            app.emit("pilot-chat-smoke-start", "").map_err(|e| e.to_string())?;
        },
        "passed" | "failed" => {
            *pilot.chat.smoke_result.lock().map_err(|e| e.to_string())? = Some(phase == "passed");
            if let Some(detail) = detail { eprintln!("Chat smoke detail: {}", detail.chars().take(2000).collect::<String>()); }
            println!("Pilot chat smoke: {phase}");
        },
        "quiet" => {
            let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
            let mut settings = store.settings.clone(); settings["roomMuted"] = true.into();
            let config = store.config.clone().ok_or("Missing config")?;
            let revision = store.revision; store.save(settings, config, revision)?;
        },
        "expire" => {
            let mut state = pilot.chat.state.lock().map_err(|e| e.to_string())?;
            state.focused = false; state.hovered = false;
            state.restart(rooms::now().saturating_sub(1001), 1);
        },
        "resize" => {
            let chat = app.get_webview_window("chat").ok_or("Missing chat")?;
            chat.set_size(tauri::LogicalSize::new(460.0, 280.0)).map_err(|e| e.to_string())?;
        },
        "status" => {},
        _ => return Err("Unknown chat smoke phase".into()),
    }
    let mut status = chat::snapshot(&app)?;
    if let Some(chat) = app.get_webview_window("chat") {
        status["visible"] = chat.is_visible().map_err(|e| e.to_string())?.into();
        status["focused"] = chat.is_focused().map_err(|e| e.to_string())?.into();
    }
    status["result"] = serde_json::to_value(*pilot.chat.smoke_result.lock().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    {
        let store = pilot.store.lock().map_err(|e| e.to_string())?;
        status["suspended"] = (store.suspended || store.chat_focused).into();
    }
    Ok(status)
}

#[tauri::command]
fn pilot_room_smoke(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, kind: String, detail: Option<String>) -> Result<(), String> {
    settings_window(&window)?;
    if std::env::var_os("LOLPING_PILOT_ROOM_SMOKE").is_none() || std::env::var_os("LOLPING_PILOT_SIMULATE").is_none()
        || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none() { return Err("Room smoke is not enabled".into()); }
    if kind == "passed" || kind == "failed" {
        if let Some(detail) = detail { eprintln!("Room smoke detail: {}", detail.chars().take(2000).collect::<String>()); }
        println!("Pilot room smoke: {kind}"); app.exit(if kind == "passed" { 0 } else { 1 }); return Ok(());
    }
    let vk = match kind.as_str() { "ping" => 18, "emote" => 17, _ => return Err("Unknown smoke gesture".into()) };
    let (x, y) = {
        let layout = pilot.layout.lock().map_err(|e| e.to_string())?;
        let d = layout.displays.first().ok_or("No display")?;
        ((d.phys.x + d.phys.width / 2.0).round() as i32, (d.phys.y + d.phys.height / 2.0).round() as i32)
    };
    for (i, (event, key)) in [("kdown", vk), ("mdown", 0), ("mup", 0), ("kup", vk)].iter().enumerate() {
        pilot.send(&serde_json::json!({"type":"sim","ev":event,"t":rooms::now() + i as u64,"vk":key,"btn":"left","x":x,"y":y}))?;
    }
    Ok(())
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
fn pilot_ready(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, config: HelperConfig, settings: Value) -> Result<Value, String> {
    let mut layout = pilot.layout.lock().map_err(|e| e.to_string())?;
    if layout.display(window.label()).is_none() { return Err("Unknown overlay".into()); }
    {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        if store.config.is_none() {
            store.check_update(&settings, store.revision)?;
            store.settings = settings;
            store.config = Some(config);
        }
    }
    if layout.mark_ready(window.label()) { start_helper(&app, &pilot, &layout)?; }
    Ok(pilot.store.lock().map_err(|e| e.to_string())?.snapshot())
}

#[tauri::command]
fn pilot_save(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, settings: Value, config: HelperConfig, revision: u64) -> Result<(), String> {
    settings_window(&window)?;
    {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        store.save(settings, config, revision)?;
    }
    pilot.sync_input()?;
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
    pilot.sync_input()?;
    pilot.emit_snapshot(&app, "pilot-status")
}

#[tauri::command]
fn pilot_capture(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>, on: bool) -> Result<(), String> {
    settings_window(&window)?;
    pilot.store.lock().map_err(|e| e.to_string())?.suspended = on;
    pilot.sync_input()
}

#[tauri::command]
fn pilot_retry(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>) -> Result<(), String> {
    settings_window(&window)?;
    let layout = pilot.layout.lock().map_err(|e| e.to_string())?;
    start_helper(&app, &pilot, &layout)
}

#[tauri::command]
fn pilot_placed(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>, kind: String,
    reference: Option<String>, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    let display = display_for(&pilot, window.label())?;
    if kind != "ping" && kind != "emote" { return Err("Unknown wheel".into()); }
    if let (Some(reference), Some(x), Some(y)) = (reference, x, y) { pilot.rooms.share(display.id, kind.clone(), reference, x, y); }
    app.emit("pilot-placed", serde_json::json!({ "displayId": display.id, "kind": kind }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pilot_preview(window: tauri::WebviewWindow, app: tauri::AppHandle, kind: String, reference: String) -> Result<(), String> {
    settings_window(&window)?;
    if (kind != "ping" && kind != "emote") || reference.len() > 40
        || !reference.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b':') { return Err("Invalid preview".into()); }
    app.emit("pilot-preview", serde_json::json!({ "kind": kind, "ref": reference }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pilot_idle(window: tauri::WebviewWindow, pilot: tauri::State<Pilot>, idle: bool) -> Result<(), String> {
    let layout = pilot.layout.lock().map_err(|e| e.to_string())?;
    let d = layout.display(window.label()).ok_or("Unknown overlay")?;
    let mut bounds = d.phys.clone();
    if idle {
        if let Some(parked) = parked_bounds(d, &layout.displays) {
            bounds = parked;
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
fn pilot_stop(window: tauri::WebviewWindow, app: tauri::AppHandle, pilot: tauri::State<Pilot>) {
    // Commands already queued by a retired renderer must not stop its replacement.
    if window.label() == "settings" || display_for(&pilot, window.label()).is_ok() { app.exit(0); }
}

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
            let _ = handle.state::<Pilot>().sync_input();
        }
    });
    Ok(())
}

fn available_displays(app: &tauri::AppHandle) -> Result<Vec<Display>, String> {
    let mut monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    monitors.sort_by_key(|m| (primary.as_ref().is_none_or(|p| p.position() != m.position()), m.position().x, m.position().y));
    Ok(monitors.iter().enumerate().map(|(id, m)| {
        let scale = m.scale_factor();
        let phys = Rect { x: m.position().x as f64, y: m.position().y as f64,
            width: m.size().width as f64, height: m.size().height as f64 };
        Display { id, scale, dip: Rect { x: phys.x / scale, y: phys.y / scale,
            width: phys.width / scale, height: phys.height / scale }, phys }
    }).collect())
}

fn create_overlay(app: &tauri::AppHandle, label: &str, d: &Display) -> Result<(), String> {
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("overlay/index.html".into()))
        .title("lolPing Desktop Pilot").transparent(true).decorations(false).resizable(false).shadow(false)
        .focused(false).focusable(false).skip_taskbar(true).always_on_top(true).visible(false)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required")
        .on_navigation(|url| url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri")
        .build().map_err(|e| e.to_string())?;
    window.set_size(PhysicalSize::new(d.phys.width as u32, (d.phys.height - d.scale) as u32)).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new(d.phys.x as i32, d.phys.y as i32)).map_err(|e| e.to_string())?;
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
}

fn replace_overlays(app: &tauri::AppHandle, displays: Vec<Display>) -> Result<(), String> {
    let pilot = app.state::<Pilot>();
    let (old_labels, new_displays) = {
        let mut layout = pilot.layout.lock().map_err(|e| e.to_string())?;
        let old_labels: Vec<String> = layout.displays.iter().map(|d| layout.label(d.id)).collect();
        layout.replace(displays);
        let new_displays: Vec<(String, Display)> = layout.displays.iter().map(|d| (layout.label(d.id), d.clone())).collect();
        (old_labels, new_displays)
    };
    // Release global hooks before loading replacements; no gesture may target an unready renderer.
    pilot.stop();
    pilot.store.lock().map_err(|e| e.to_string())?.helper_status = "starting";
    pilot.emit_snapshot(app, "pilot-status")?;
    for label in old_labels {
        if let Some(window) = app.get_webview_window(&label) { window.destroy().map_err(|e| e.to_string())?; }
    }
    if pilot.exiting.load(Ordering::SeqCst) { return Ok(()); }
    for (label, display) in new_displays { create_overlay(app, &label, &display)?; }
    {
        let mut layout = pilot.layout.lock().map_err(|e| e.to_string())?;
        layout.finish_build();
        start_helper(app, &pilot, &layout)?;
    }
    println!("Pilot display layout rebuilt");
    Ok(())
}

fn watch_displays(app: tauri::AppHandle, displays: Vec<Display>) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut watch = DisplayWatch::new(displays);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let pilot = app.state::<Pilot>();
            if pilot.exiting.load(Ordering::SeqCst) { return; }
            let current = match available_displays(&app) {
                Ok(displays) => displays,
                Err(error) => { eprintln!("Cannot refresh displays: {error}"); app.exit(1); return; },
            };
            let change = match pilot.layout.lock() {
                Ok(layout) => watch.update(&current, &layout, started.elapsed()),
                Err(error) => { eprintln!("Cannot read display layout: {error}"); app.exit(1); return; },
            };
            if change == DisplayChange::Retire || change == DisplayChange::Rebuild {
                let next = if change == DisplayChange::Retire { vec![] } else { current };
                if let Err(error) = replace_overlays(&app, next) {
                    eprintln!("Cannot rebuild overlays: {error}"); pilot.stop(); app.exit(1); return;
                }
            } else if change == DisplayChange::TimedOut {
                eprintln!("Overlay readiness timed out; leaving input untouched");
                pilot.stop(); app.exit(1); return;
            }
        }
    });
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
            if response.status() == tauri::http::StatusCode::NOT_FOUND && !request.uri().path().ends_with(".sound") {
                if let Ok(cache) = pilot.rooms.cache.lock() {
                    for name in assets::asset_names(request.uri().path()) {
                        if let Some(bytes) = cache.get(&name) {
                            *response.body_mut() = bytes; *response.status_mut() = tauri::http::StatusCode::OK;
                            response.headers_mut().insert("Content-Type", tauri::http::HeaderValue::from_static("image/webp"));
                            break;
                        }
                    }
                }
            }
            response.headers_mut().insert("Access-Control-Allow-Origin", tauri::http::HeaderValue::from_static("*"));
            response.headers_mut().insert("Cache-Control", tauri::http::HeaderValue::from_static("no-store"));
            response
        })
        .invoke_handler(tauri::generate_handler![pilot_bootstrap, pilot_snapshot, pilot_ready, pilot_save,
            pilot_enabled, pilot_capture, pilot_retry, pilot_placed, pilot_preview, pilot_idle,
            pilot_open_folder, pilot_open_project, pilot_stop, pilot_smoke_result,
            pilot_import_emote, pilot_emote_sound, pilot_remove_emote, pilot_room, pilot_room_smoke, pilot_chat, pilot_chat_smoke, pilot_panel, pilot_panel_smoke])
        .setup(|app| {
            if std::env::var_os("LOLPING_PILOT_ROOM_SMOKE").is_some()
                && (std::env::var_os("LOLPING_PILOT_SIMULATE").is_none() || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none()) {
                return Err("Room smoke requires simulated input and an isolated data directory".into());
            }
            if std::env::var_os("LOLPING_PILOT_DISPLAY_SMOKE").is_some()
                && (std::env::var_os("LOLPING_PILOT_SIMULATE").is_none() || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none()) {
                return Err("Display smoke requires simulated input and an isolated data directory".into());
            }
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
            let displays = available_displays(app.handle())?;
            if displays.is_empty() { return Err("No displays found".into()); }
            let library = EmoteLibrary { root: data_dir.join("emotes"),
                inherited: PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("lolPing/emotes") };
            let (rooms, room_requests) = rooms::Service::new();
            app.manage(Pilot { library, layout: Mutex::new(Layout::new(displays.clone())), exiting: AtomicBool::new(false), helper: Mutex::new(None),
                store: Mutex::new(SettingsState::new(settings, file)), rooms, chat: chat::Chat::default(), panels: panels::Panels::default() });
            let relays = bootstrap["relays"].as_array().ok_or("Missing relay list; rebuild the pilot frontend")?
                .iter().filter_map(Value::as_str).map(str::to_owned).collect();
            rooms::run(app.handle().clone(), room_requests, relays);
            chat::run(app.handle().clone());
            panels::run(app.handle().clone());
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
                create_overlay(app.handle(), &format!("overlay-0-{}", d.id), d)?;
            }
            {
                let pilot = app.state::<Pilot>();
                let mut layout = pilot.layout.lock().map_err(|e| e.to_string())?;
                layout.finish_build();
                start_helper(app.handle(), &pilot, &layout)?;
            }
            if std::env::var_os("LOLPING_PILOT_DISPLAY_SMOKE").is_some() {
                display_smoke::run(app.handle().clone(), displays);
            } else {
                watch_displays(app.handle().clone(), displays);
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
        if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
            // The tray host stays alive while a layout temporarily has no overlay windows.
            api.prevent_exit();
            return;
        }
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            let pilot = handle.state::<Pilot>();
            pilot.exiting.store(true, Ordering::SeqCst);
            // Serialize shutdown with a renderer that has just requested helper startup.
            { let _layout = pilot.layout.lock(); pilot.stop(); }
            pilot.rooms.stop();
        }
    });
}
