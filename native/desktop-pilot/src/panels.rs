use crate::Pilot;
use serde_json::Value;
use std::{collections::HashSet, sync::Mutex, time::Duration};
use tauri::Manager;

#[derive(Default)]
pub struct Panels { pub held_since: Mutex<Option<u64>>, pub ready: Mutex<HashSet<String>>, pub smoke: Mutex<Value> }

pub fn valid_action(action: &Value, roster: bool) -> bool {
    let kind = action["t"].as_str().unwrap_or("");
    let peer = action["peer"].as_str().is_some_and(|p| p.len() == 16 && p.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    if !roster { return kind == "ballot" && action["yes"].is_boolean() && action["voteId"].as_str().is_some_and(|id| id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())); }
    match kind {
        "spell" | "clearSpell" => peer && ["d","f"].contains(&action["slot"].as_str().unwrap_or("")),
        "alive" | "kick" => peer,
        "mute" => peer && action["on"].is_boolean(),
        "vote" => ["ff","ready"].contains(&action["kind"].as_str().unwrap_or("")),
        "chatCategory" => ["text","ping","scoreboard","vote","whisper"].contains(&action["category"].as_str().unwrap_or("")) && action["on"].is_boolean(),
        _ => false,
    }
}

pub fn held(app: &tauri::AppHandle, on: bool) {
    if let Ok(mut at) = app.state::<Pilot>().panels.held_since.lock() { *at = on.then(crate::rooms::now); }
}

pub fn snapshot(app: &tauri::AppHandle, label: &str) -> Result<Value, String> {
    let pilot = app.state::<Pilot>();
    let mut snapshot = pilot.store.lock().map_err(|e| e.to_string())?.snapshot();
    snapshot["room"] = pilot.rooms.snapshot()?;
    snapshot["history"] = pilot.chat.state.lock().map_err(|e| e.to_string())?.snapshot();
    snapshot["view"] = if label == "roster" { "roster" } else { "vote" }.into();
    snapshot["panelSmoke"] = std::env::var_os("LOLPING_PILOT_PANEL_SMOKE").is_some().into();
    Ok(snapshot)
}

pub fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0 as _, windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
        Ok(())
    }
    #[cfg(not(windows))]
    { window.show().map_err(|e| e.to_string()) }
}

pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        // A native non-activating show bypasses winit's visibility cache, so its hide may be a no-op.
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0 as _, windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE); }
    }
    Ok(())
}

fn ensure(app: &tauri::AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) { return Ok(window); }
    app.state::<Pilot>().panels.ready.lock().map_err(|e| e.to_string())?.remove(label);
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("panel/index.html".into()))
        .title("lolPing").decorations(false).resizable(false).transparent(true).shadow(false)
        .minimizable(false).maximizable(false).skip_taskbar(label == "roster").always_on_top(label == "roster")
        .focusable(label != "roster").focused(false).visible(false)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required")
        .on_navigation(|url| url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri")
        .build().map_err(|e| e.to_string())?;
    Ok(window)
}

fn place(app: &tauri::AppHandle, window: &tauri::WebviewWindow, ready: bool) -> Result<(), String> {
    let roster = window.label() == "roster";
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary = app.primary_monitor().map_err(|e| e.to_string())?.ok_or("No primary monitor")?;
    let monitor = if roster { monitors.iter().find(|m| {
        let p = m.position(); let s = m.size();
        cursor.x >= p.x as f64 && cursor.x < p.x as f64 + s.width as f64 && cursor.y >= p.y as f64 && cursor.y < p.y as f64 + s.height as f64
    }).unwrap_or(&primary) } else { &primary };
    let scale = monitor.scale_factor(); let area = monitor.work_area();
    let (width,height) = if roster { (720.0,470.0) } else if ready { (442.0,452.0) } else { (223.0,113.0) };
    let width = (width * scale).min(area.size.width as f64); let height = (height * scale).min(area.size.height as f64);
    let x = area.position.x as f64 + if roster || ready { (area.size.width as f64 - width) / 2.0 } else { area.size.width as f64 - width - 16.0 * scale };
    let y = area.position.y as f64 + if roster || ready { (area.size.height as f64 - height) / 2.0 } else { area.size.height as f64 * 0.4 };
    window.set_size(tauri::PhysicalSize::new(width.round() as u32,height.round() as u32)).map_err(|e| e.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(x.round() as i32,y.round() as i32)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut shown_vote = String::new();
        loop {
            std::thread::sleep(Duration::from_millis(25));
            let pilot = app.state::<Pilot>();
            if pilot.exiting.load(std::sync::atomic::Ordering::SeqCst) { return; }
            let (settings, enabled, suspended) = match pilot.store.lock() { Ok(s) => (s.settings.clone(),s.enabled,s.suspended || s.chat_focused), Err(_) => return };
            let room = pilot.rooms.snapshot().unwrap_or(Value::Null);
            let active = room["phase"] == "active" && settings["features"]["rooms"] == true;
            let panel_on = active && enabled && !suspended && settings["features"]["roomPanel"] == true;
            if !panel_on { held(&app, false); }
            let due = pilot.panels.held_since.lock().ok().and_then(|at| *at).is_some_and(|at| crate::rooms::now().saturating_sub(at) >= (settings["panelHoldS"].as_f64().unwrap_or(0.5).clamp(0.0,1.5) * 1000.0) as u64);
            if due {
                match ensure(&app,"roster") {
                    Ok(window) => if pilot.panels.ready.lock().map(|r| r.contains("roster")).unwrap_or(false) && !window.is_visible().unwrap_or(false) {
                        let _ = place(&app,&window,false); let _ = window.set_always_on_top(true); let _ = show_inactive(&window);
                    },
                    Err(e) => { eprintln!("Cannot open roster: {e}"); held(&app,false); },
                }
            } else if let Some(window) = app.get_webview_window("roster") { let _ = hide(&window); }
            let vote = &room["vote"];
            let id = if active && settings["features"]["roomVotes"] == true { vote["id"].as_str().unwrap_or("") } else { "" };
            if id.is_empty() {
                if let Some(window) = app.get_webview_window("vote") { let _ = hide(&window); let _ = window.request_user_attention(None); }
                shown_vote.clear();
            } else if shown_vote != id {
                match ensure(&app,"vote") {
                    Ok(window) => {
                        if pilot.panels.ready.lock().map(|r| r.contains("vote")).unwrap_or(false) && place(&app,&window,vote["kind"] == "ready").is_ok() {
                            let _ = window.set_always_on_top(true); let _ = window.set_always_on_top(false); let _ = show_inactive(&window);
                            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational)); shown_vote = id.into();
                        }
                    },
                    Err(e) => eprintln!("Cannot open vote: {e}"),
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn limits_vote_windows_to_ballots_and_validates_roster_fields() {
        let vote = json!({"t":"ballot","voteId":"1234abcd","yes":false});
        assert!(valid_action(&vote,false)); assert!(!valid_action(&vote,true));
        let mute = json!({"t":"mute","peer":"0011223344556677","on":true});
        assert!(valid_action(&mute,true)); assert!(!valid_action(&mute,false));
        assert!(!valid_action(&json!({"t":"mute","peer":"0011223344556677","on":"false"}),true));
        assert!(!valid_action(&json!({"t":"spell","peer":"bad","slot":"d"}),true));
    }
}

pub fn category(app: &tauri::AppHandle, action: &Value) -> Result<(), String> {
    let category = action["category"].as_str().ok_or("Missing category")?;
    if !["text","ping","scoreboard","vote","whisper"].contains(&category) || !action["on"].is_boolean() { return Err("Invalid category".into()); }
    let pilot = app.state::<Pilot>();
    {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        let mut settings = store.settings.clone(); settings["chatFilter"][category] = action["on"].clone();
        let config = store.config.clone().ok_or("Missing config")?; let revision = store.revision;
        store.save(settings, config, revision)?;
    }
    pilot.emit_snapshot(app,"pilot-settings")
}
