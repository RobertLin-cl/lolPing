use crate::{displays::Display, replace_overlays, Pilot};
use std::time::{Duration, Instant};
use tauri::Manager;

fn wait_ready(app: &tauri::AppHandle) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let pilot = app.state::<Pilot>();
        if pilot.exiting.load(std::sync::atomic::Ordering::SeqCst) { return Err("App exited during display smoke".into()); }
        let (ready, displays) = {
            let layout = pilot.layout.lock().map_err(|e| e.to_string())?;
            (layout.is_ready(), layout.displays.iter().map(|d| (layout.label(d.id), d.clone())).collect::<Vec<_>>())
        };
        if ready && pilot.store.lock().map_err(|e| e.to_string())?.helper_status == "running" {
            let windows = app.webview_windows();
            if windows.keys().filter(|label| label.starts_with("overlay-")).count() != displays.len() {
                return Err("Retired overlay windows remain".into());
            }
            for (label, d) in &displays {
                let window = windows.get(label).ok_or("Missing overlay")?;
                let size = window.inner_size().map_err(|e| e.to_string())?;
                if size.width != d.phys.width as u32 || size.height != (d.phys.height - d.scale) as u32 {
                    return Err(format!("Overlay size mismatch: {size:?}"));
                }
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("Display smoke readiness timed out".into())
}

fn check(app: &tauri::AppHandle, displays: Vec<Display>) -> Result<(), String> {
    wait_ready(app)?;
    let pilot = app.state::<Pilot>();
    let (settings, revision) = {
        let mut store = pilot.store.lock().map_err(|e| e.to_string())?;
        store.enabled = false;
        store.suspended = true;
        (store.settings.clone(), store.revision)
    };
    let mut resized = displays.clone();
    for d in &mut resized {
        d.phys.width -= 64.0;
        d.phys.height -= 64.0;
        d.scale += 0.25;
        d.dip.width = d.phys.width / d.scale;
        d.dip.height = d.phys.height / d.scale;
        d.dip.x = d.phys.x / d.scale;
        d.dip.y = d.phys.y / d.scale;
    }
    replace_overlays(app, resized)?;
    wait_ready(app)?;
    replace_overlays(app, vec![displays[0].clone()])?;
    wait_ready(app)?;
    replace_overlays(app, vec![])?;
    if pilot.helper.lock().map_err(|e| e.to_string())?.is_some() { return Err("Helper survived an empty layout".into()); }
    replace_overlays(app, displays)?;
    wait_ready(app)?;
    let store = pilot.store.lock().map_err(|e| e.to_string())?;
    if store.enabled || !store.suspended || store.settings != settings || store.revision != revision {
        return Err("Display rebuild changed runtime state or settings".into());
    }
    Ok(())
}

pub fn run(app: tauri::AppHandle, displays: Vec<Display>) {
    std::thread::spawn(move || {
        match check(&app, displays) {
            Ok(()) => { println!("Pilot display smoke: passed"); app.exit(0); },
            Err(error) => { eprintln!("Pilot display smoke: failed: {error}"); app.exit(1); },
        }
    });
}
