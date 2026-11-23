use crate::{update_protocol::{self,Asset,Policy,Release},Pilot};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{io::{Read,Write},path::{Path,PathBuf},sync::{Mutex,mpsc::{self,Receiver,SyncSender},atomic::{AtomicBool,Ordering}},time::Duration};
use tauri::{Emitter,Manager};

#[derive(Clone,Copy)]
pub enum Operation { Check { tray: bool }, Start { tray: bool } }
type Tray = (tauri::menu::MenuItem<tauri::Wry>,tauri::menu::MenuItem<tauri::Wry>,Value);
pub struct Service { sender:SyncSender<Operation>,state:Mutex<Value>,pending:AtomicBool,pub notes:Mutex<Option<String>>,pub tray:Mutex<Option<Tray>>,pub available:bool,pub smoke:bool,policy:Policy,directory:PathBuf }

impl Service {
    pub fn new(executable: &Path,data: &Path) -> Result<(Self,Receiver<Operation>),String> {
        let smoke = std::env::var_os("LOLPING_PILOT_UPDATE_SMOKE").is_some();
        if smoke && (std::env::var_os("LOLPING_PILOT_SIMULATE").is_none() || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none()) { return Err("Update smoke requires simulation and isolated data".into()); }
        let policy = if smoke { Policy::test(&std::env::var("LOLPING_PILOT_UPDATE_ORIGIN").map_err(|e| e.to_string())?)? } else { Policy::default() };
        let available = smoke || (!crate::startup::isolated() && crate::runtime_files::installed_at(executable));
        let (sender,receiver) = mpsc::sync_channel(8);
        Ok((Self {sender,state:Mutex::new(json!({"phase":"idle","lastCheck":null,"revision":0})),pending:AtomicBool::new(false),notes:Mutex::new(None),tray:Mutex::new(None),available,smoke,policy,directory:data.join("updates")},receiver))
    }
    pub fn snapshot(&self) -> Result<Value,String> {
        if !self.available { return Ok(Value::Null); }
        Ok(self.state.lock().map_err(|e| e.to_string())?.clone())
    }
    pub fn request(&self,operation: Operation) -> Result<(),String> {
        if !self.available { return Err("Updates require an installed Rust desktop build".into()); }
        let state = self.snapshot()?;
        if matches!(state["phase"].as_str(),Some("checking" | "downloading" | "installing")) { return Ok(()); }
        if self.pending.swap(true,Ordering::SeqCst) { return Ok(()); }
        self.sender.try_send(operation).map_err(|_| { self.pending.store(false,Ordering::SeqCst); "Update service is busy".into() })
    }
    fn publish(&self,app: &tauri::AppHandle,mut state: Value) {
        if let Ok(mut current) = self.state.lock() {
            state["revision"] = (current["revision"].as_u64().unwrap_or(0) + 1).into(); *current = state.clone();
        }
        if let Ok(tray) = self.tray.lock() {
            if let Some((check,start,labels)) = tray.as_ref() {
                let phase = state["phase"].as_str().unwrap_or("idle");
                let busy = ["checking","downloading","installing"].contains(&phase);
                let _ = check.set_enabled(!busy);
                let _ = check.set_text(labels[if phase == "checking" {"checking"} else {"check"}].as_str().unwrap_or(""));
                let enabled = phase == "available" || (phase == "error" && state["retry"] == "download");
                let _ = start.set_enabled(enabled);
                let key = match phase {"downloading" => "downloading","installing" => "installing",_ => "start"};
                let label = labels[key].as_str().unwrap_or("").replace("{version}",state["version"].as_str().unwrap_or(""))
                    .replace("{percent}",&state["percent"].as_u64().unwrap_or(0).to_string());
                let _ = start.set_text(label);
            }
        }
        let _ = app.emit("pilot-update",state.to_string());
    }
}

fn error(app: &tauri::AppHandle,kind: &str,reason: String,retry: &str,tray: bool) {
    let state = json!({"phase":"error","kind":kind,"reason":reason,"retry":retry});
    app.state::<Pilot>().updater.publish(app,state.clone());
    if tray { let _ = app.emit("pilot-update-notice",json!({"kind":"error","error":state}).to_string()); }
}

fn bytes(app: &tauri::AppHandle,url: &str,limit: u64) -> Result<Option<Vec<u8>>,String> {
    let pilot = app.state::<Pilot>(); let mut bytes = vec![];
    let (status,_) = crate::update_http::stream(url,&pilot.updater.policy,limit,&pilot.exiting,|chunk| { bytes.extend_from_slice(chunk); Ok(()) })?;
    if status == 404 { return Ok(None); }
    if status != 200 { return Err(format!("GitHub returned HTTP {status}")); }
    Ok(Some(bytes))
}

fn checked_bytes(app: &tauri::AppHandle,asset: &Asset) -> Result<Vec<u8>,String> {
    let bytes = bytes(app,&asset.url,asset.size)?.ok_or("Rust update asset is missing")?;
    if bytes.len() as u64 != asset.size || hex(&Sha256::digest(&bytes)) != asset.hash { return Err("Rust update asset failed SHA-256 verification".into()); }
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

fn check(app: &tauri::AppHandle) -> Result<Option<Release>,String> {
    let pilot = app.state::<Pilot>();
    let Some(bytes) = bytes(app,&pilot.updater.policy.api(),1024 * 1024)? else { return Ok(None); };
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let current = if pilot.updater.smoke { "0.0.0" } else { env!("LOLPING_APP_VERSION") };
    let Some(release) = update_protocol::release(&value,current,&pilot.updater.policy)? else { return Ok(None); };
    update_protocol::verify_manifest(&checked_bytes(app,&release.manifest)?,&release)?;
    Ok(Some(release))
}

struct Partial(PathBuf);
impl Drop for Partial { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

fn download(app: &tauri::AppHandle,release: &Release) -> Result<PathBuf,String> {
    let pilot = app.state::<Pilot>();
    std::fs::create_dir_all(&pilot.updater.directory).map_err(|e| e.to_string())?;
    if std::fs::symlink_metadata(&pilot.updater.directory).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Update cache cannot be a symlink".into()); }
    let temporary = Partial(pilot.updater.directory.join(format!("{}-{}.part",release.version,std::process::id())));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary.0).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new(); let mut count = 0u64; let mut percent = 0u64; let mut magic = vec![];
    let result = crate::update_http::stream(&release.installer.url,&pilot.updater.policy,release.installer.size,&pilot.exiting,|chunk| {
        if magic.len() < 2 { magic.extend_from_slice(&chunk[..(2 - magic.len()).min(chunk.len())]); }
        file.write_all(chunk).map_err(|e| e.to_string())?; hash.update(chunk); count += chunk.len() as u64;
        let next = count * 100 / release.installer.size;
        if next != percent { percent = next; pilot.updater.publish(app,json!({"phase":"downloading","version":release.version,"percent":percent})); }
        Ok(())
    });
    file.sync_all().map_err(|e| e.to_string())?; drop(file);
    let (status,_) = result?;
    if status != 200 || count != release.installer.size || magic != b"MZ" || hex(&hash.finalize()) != release.installer.hash {
        return Err("Downloaded Rust installer failed size or SHA-256 verification".into());
    }
    let final_path = pilot.updater.directory.join(&release.installer.name);
    if let Ok(metadata) = std::fs::symlink_metadata(&final_path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("Invalid update destination".into()); }
        std::fs::remove_file(&final_path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temporary.0,&final_path).map_err(|e| e.to_string())?;
    Ok(final_path)
}

fn verify_file(path: &Path,asset: &Asset) -> Result<(),String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != asset.size { return Err("Installer changed before execution".into()); }
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new(); let mut buffer = [0;65536]; let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        total += count as u64; if total > asset.size { return Err("Installer grew before execution".into()); }
        hash.update(&buffer[..count]);
    }
    if total != asset.size || hex(&hash.finalize()) != asset.hash { return Err("Installer changed before execution".into()); }
    Ok(())
}

fn install(app: &tauri::AppHandle,path: &Path,asset: &Asset) -> Result<(),String> {
    let pilot = app.state::<Pilot>();
    if pilot.exiting.load(Ordering::SeqCst) { return Err("Update canceled".into()); }
    verify_file(path,asset)?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let destination = if pilot.updater.smoke {
        let root = PathBuf::from(std::env::var_os("LOLPING_PILOT_DATA_DIR").ok_or("Missing smoke data")?);
        root.join("installed")
    } else { executable.parent().ok_or("Missing install directory")?.to_owned() };
    if !pilot.updater.smoke && !crate::runtime_files::installed_at(&executable) { return Err("Rust installation marker is missing".into()); }
    let mut command = std::process::Command::new(path);
    command.arg("/S").arg(format!("/PID={}",std::process::id()));
    if pilot.updater.smoke { command.arg("/TEST"); } else { command.arg("/RESTART"); }
    // NSIS /D must be the final argument and is not quoted inside that argument.
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("/D={}",destination.display())).creation_flags(0x08000000);
    }
    #[cfg(not(windows))] { command.arg(format!("/D={}",destination.display())); }
    if pilot.exiting.load(Ordering::SeqCst) { return Err("Update canceled".into()); }
    command.spawn().map_err(|e| e.to_string())?;
    app.exit(0); Ok(())
}

pub fn run(app: tauri::AppHandle,requests: Receiver<Operation>) {
    std::thread::spawn(move || {
        let pilot = app.state::<Pilot>(); if !pilot.updater.available { return; }
        let mut schedule = update_protocol::Schedule::default(); let mut release: Option<Release> = None; let mut last_check = Value::Null;
        while !pilot.exiting.load(Ordering::SeqCst) {
            let on = pilot.store.lock().map(|s| s.settings["autoUpdateCheck"] == true).unwrap_or(false);
            let now = crate::rooms::now();
            schedule.configure(on,now);
            let request = requests.recv_timeout(Duration::from_millis(250)).ok();
            let scheduled = schedule.ready(now);
            if request.is_none() && !scheduled { continue; }
            struct Pending<'a>(&'a AtomicBool);
            impl Drop for Pending<'_> { fn drop(&mut self) { self.0.store(false,Ordering::SeqCst); } }
            let _pending = Pending(&pilot.updater.pending);
            let state = pilot.updater.snapshot().unwrap_or(Value::Null);
            if let Some(Operation::Start { tray }) = request {
                let can_start = state["phase"] == "available" || (state["phase"] == "error" && state["retry"] == "download");
                let Some(info) = release.as_ref().filter(|_| can_start) else { continue; };
                pilot.updater.publish(&app,json!({"phase":"downloading","version":info.version,"percent":0}));
                match download(&app,info) {
                    Ok(path) => {
                        pilot.updater.publish(&app,json!({"phase":"installing","version":info.version}));
                        let _ = app.emit("pilot-update-notice",json!({"kind":"installing","version":info.version}).to_string());
                        std::thread::sleep(Duration::from_millis(1500));
                        if let Err(reason) = install(&app,&path,&info.installer) { error(&app,"install",reason,"download",tray); }
                    },
                    Err(reason) => {
                        let kind = if reason.contains("verification") { "damaged" } else { "download" };
                        error(&app,kind,reason,"download",tray);
                    },
                }
                continue;
            }
            schedule.finished(now);
            let manual = matches!(request,Some(Operation::Check { .. }));
            let tray = matches!(request,Some(Operation::Check { tray:true }));
            if !manual && (state["phase"] == "available" || (state["phase"] == "error" && state["retry"] == "download")) { continue; }
            pilot.updater.publish(&app,json!({"phase":"checking","manual":manual}));
            match check(&app) {
                Ok(found) => {
                    last_check = crate::rooms::now().into(); release = found;
                    if let Ok(mut notes) = pilot.updater.notes.lock() { *notes = release.as_ref().map(|r| r.notes.clone()); }
                    if let Some(info) = &release {
                        pilot.updater.publish(&app,json!({"phase":"available","version":info.version,"notesUrl":info.notes}));
                        let notify = if let Ok(mut store) = pilot.store.lock() {
                            let notify = store.settings["updateNotifiedVersion"] != info.version;
                            notify && store.remember_update(&info.version).is_ok()
                        } else { false };
                        if notify { let _ = app.emit("pilot-update-notice",json!({"kind":"available","version":info.version}).to_string()); let _ = pilot.emit_snapshot(&app,"pilot-settings"); }
                    } else {
                        pilot.updater.publish(&app,json!({"phase":"idle","lastCheck":last_check}));
                        if tray { let _ = app.emit("pilot-update-notice",json!({"kind":"checked"}).to_string()); }
                    }
                },
                Err(reason) => {
                    eprintln!("Rust update check: {reason}");
                    if manual { error(&app,"check",reason,"check",tray); }
                    else { pilot.updater.publish(&app,json!({"phase":"idle","lastCheck":last_check})); }
                },
            }
            schedule.finished(crate::rooms::now());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rechecks_the_staged_installer_before_execution() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-staging-test");
        std::fs::create_dir_all(&directory).unwrap(); let path = directory.join("update.exe");
        let bytes = b"MZfixture"; std::fs::write(&path,bytes).unwrap();
        let asset = Asset {name:"update.exe".into(),url:"unused".into(),hash:hex(&Sha256::digest(bytes)),size:bytes.len() as u64};
        assert!(verify_file(&path,&asset).is_ok());
        std::fs::write(&path,b"MZchanged").unwrap(); assert!(verify_file(&path,&asset).is_err());
    }
}

pub fn smoke_fixture(app: &tauri::AppHandle,scenario: &str) -> Result<(),String> {
    let pilot = app.state::<Pilot>();
    if !pilot.updater.smoke || !["empty","available","bad-manifest","bad-installer","redirect","healthy"].contains(&scenario) {
        return Err("Invalid update smoke fixture".into());
    }
    let origin = pilot.updater.policy.test_origin.as_ref().ok_or("Missing update test origin")?;
    bytes(app,&format!("{origin}scenario/{scenario}"),1024)?.ok_or("Fixture server is unavailable")?;
    Ok(())
}
