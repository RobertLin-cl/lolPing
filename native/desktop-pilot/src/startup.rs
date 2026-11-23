use std::path::Path;

pub const VALUE_NAME: &str = "lolPing Desktop Pilot";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[derive(Default)]
pub struct Startup { key: Option<String>, command: String, isolated: bool }

#[derive(Clone, Debug, PartialEq)]
pub struct Entry { kind: u32, bytes: Vec<u8> }

pub fn command(executable: &Path) -> Result<String, String> {
    let path = executable.to_str().ok_or("Startup path is not valid Unicode")?;
    if !executable.is_absolute() || path.chars().any(|c| matches!(c, '"' | '\0' | '\r' | '\n')) { return Err("Invalid startup path".into()); }
    let command = format!("\"{path}\" --hidden");
    if command.encode_utf16().count() > 260 { return Err("Startup command exceeds Windows' 260-character limit".into()); }
    Ok(command)
}

pub fn isolated() -> bool {
    ["LOLPING_PILOT_SIMULATE","LOLPING_PILOT_DATA_DIR","LOLPING_PILOT_BENCHMARK","LOLPING_PILOT_SMOKE",
        "LOLPING_PILOT_ROOM_SMOKE","LOLPING_PILOT_DISPLAY_SMOKE"].iter().any(|key| std::env::var_os(key).is_some())
}

pub fn show_settings(hidden: bool, isolated: bool, requested: bool) -> bool { requested || (!hidden && !isolated) }

impl Startup {
    pub fn for_app() -> Result<Self, String> {
        let smoke = std::env::var_os("LOLPING_PILOT_STARTUP_SMOKE").is_some();
        if smoke && (std::env::var_os("LOLPING_PILOT_SIMULATE").is_none() || std::env::var_os("LOLPING_PILOT_DATA_DIR").is_none()) {
            return Err("Startup smoke requires simulated input and isolated settings".into());
        }
        if isolated() && !smoke { return Ok(Self::default()); }
        let command = command(&std::env::current_exe().map_err(|e| e.to_string())?)?;
        Ok(Self { key: Some(if smoke { format!(r"Software\lolPingDesktopPilotTests\smoke-{}",std::process::id()) } else { RUN_KEY.into() }), command, isolated: smoke })
    }

    pub fn available(&self) -> bool { cfg!(windows) && self.key.is_some() }
    pub fn enabled(&self) -> Result<bool, String> { Ok(self.entry()? == Some(self.registration())) }
    fn registration(&self) -> Entry {
        Entry { kind: 1, bytes: self.command.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect() }
    }

    pub fn entry(&self) -> Result<Option<Entry>, String> {
        let Some(key) = &self.key else { return Ok(None); };
        registry::read(key,VALUE_NAME)
    }

    pub fn registered_command(&self) -> Result<Option<String>,String> {
        let Some(entry) = self.entry()? else { return Ok(None); };
        if entry.kind != 1 || entry.bytes.len() % 2 != 0 { return Err("Invalid startup registry value".into()); }
        let mut words: Vec<u16> = entry.bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0],p[1]])).collect();
        if words.last() == Some(&0) { words.pop(); }
        String::from_utf16(&words).map(Some).map_err(|e| e.to_string())
    }

    pub fn change(&self, before: bool, after: bool) -> Result<Option<Option<Entry>>, String> {
        if before == after { return Ok(None); }
        let key = self.key.as_ref().ok_or("Startup registration is disabled in simulation")?;
        let previous = self.entry()?;
        registry::write(key,VALUE_NAME,after.then(|| self.registration()).as_ref())?;
        Ok(Some(previous))
    }

    pub fn restore(&self, entry: &Option<Entry>) -> Result<(), String> {
        registry::write(self.key.as_ref().ok_or("Startup registration is unavailable")?,VALUE_NAME,entry.as_ref())
    }

    pub fn cleanup(&self) {
        if self.isolated {
            if let Some(key) = &self.key { let _ = registry::write(key,VALUE_NAME,None); registry::remove_empty(key); }
        }
    }
}

impl Drop for Startup { fn drop(&mut self) { self.cleanup(); } }

#[cfg(windows)]
pub struct Instance(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for Instance { fn drop(&mut self) { if !self.0.is_null() { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } } } }

#[cfg(windows)]
pub fn instance() -> Result<Option<Instance>,String> {
    use windows_sys::Win32::{Foundation::{GetLastError,ERROR_ALREADY_EXISTS},System::Threading::CreateMutexW};
    if isolated() { return Ok(Some(Instance(std::ptr::null_mut()))); }
    let name: Vec<u16> = "Local\\com.lolping.desktop-pilot".encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(),0,name.as_ptr()) };
    if handle.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
    let guard = Instance(handle);
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS { return Ok(None); }
    Ok(Some(guard))
}

#[cfg(windows)]
pub fn check_helper() -> Result<(),String> {
    use windows_sys::Win32::{Foundation::{CloseHandle,INVALID_HANDLE_VALUE},System::{Diagnostics::ToolHelp::*,RemoteDesktop::ProcessIdToSessionId}};
    if std::env::var_os("LOLPING_PILOT_SIMULATE").is_some() { return Ok(()); }
    let mut session = 0;
    if unsafe { ProcessIdToSessionId(std::process::id(),&mut session) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0) };
    if snapshot == INVALID_HANDLE_VALUE { return Err(std::io::Error::last_os_error().to_string()); }
    let mut process: PROCESSENTRY32W = unsafe { std::mem::zeroed() }; process.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = false;
    let mut next = unsafe { Process32FirstW(snapshot,&mut process) };
    while next != 0 {
        let length = process.szExeFile.iter().position(|&c| c == 0).unwrap_or(process.szExeFile.len());
        if String::from_utf16_lossy(&process.szExeFile[..length]).eq_ignore_ascii_case("hook-helper.exe") {
            let mut other_session = u32::MAX;
            if unsafe { ProcessIdToSessionId(process.th32ProcessID,&mut other_session) } != 0 && other_session == session { found = true; break; }
        }
        next = unsafe { Process32NextW(snapshot,&mut process) };
    }
    unsafe { CloseHandle(snapshot); }
    if found { Err("Another input helper is running; quit the other lolPing app first".into()) } else { Ok(()) }
}

#[cfg(not(windows))]
pub fn instance() -> Result<Option<()>,String> { Ok(Some(())) }
#[cfg(not(windows))]
pub fn check_helper() -> Result<(),String> { Ok(()) }

#[cfg(windows)]
mod registry {
    use super::Entry;
    use windows_sys::Win32::{Foundation::ERROR_FILE_NOT_FOUND, System::Registry::*};
    fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
    fn checked(code: u32) -> Result<(), String> { if code == 0 { Ok(()) } else { Err(std::io::Error::from_raw_os_error(code as i32).to_string()) } }
    struct Key(HKEY);
    impl Drop for Key { fn drop(&mut self) { unsafe { RegCloseKey(self.0); } } }

    fn open(path: &str, create: bool) -> Result<Option<Key>, String> {
        let path = wide(path); let mut handle = std::ptr::null_mut();
        let result = unsafe {
            if create { RegCreateKeyExW(HKEY_CURRENT_USER,path.as_ptr(),0,std::ptr::null(),0,KEY_QUERY_VALUE | KEY_SET_VALUE,std::ptr::null(),&mut handle,std::ptr::null_mut()) }
            else { RegOpenKeyExW(HKEY_CURRENT_USER,path.as_ptr(),0,KEY_QUERY_VALUE | KEY_SET_VALUE,&mut handle) }
        };
        if result == ERROR_FILE_NOT_FOUND { return Ok(None); }
        checked(result)?; Ok(Some(Key(handle)))
    }

    pub fn read(path: &str, name: &str) -> Result<Option<Entry>, String> {
        let Some(key) = open(path,false)? else { return Ok(None); };
        let name = wide(name); let mut kind = 0; let mut size = 0;
        let result = unsafe { RegQueryValueExW(key.0,name.as_ptr(),std::ptr::null(),&mut kind,std::ptr::null_mut(),&mut size) };
        if result == ERROR_FILE_NOT_FOUND { return Ok(None); }
        checked(result)?;
        if size > 4096 { return Err("Startup registry value is too large".into()); }
        let mut bytes = vec![0;size as usize];
        checked(unsafe { RegQueryValueExW(key.0,name.as_ptr(),std::ptr::null(),&mut kind,bytes.as_mut_ptr(),&mut size) })?;
        bytes.truncate(size as usize); Ok(Some(Entry { kind,bytes }))
    }

    pub fn write(path: &str, name: &str, entry: Option<&Entry>) -> Result<(), String> {
        let Some(key) = open(path,entry.is_some())? else { return Ok(()); };
        let name = wide(name);
        let result = unsafe {
            match entry {
                Some(entry) => RegSetValueExW(key.0,name.as_ptr(),0,entry.kind,entry.bytes.as_ptr(),entry.bytes.len() as u32),
                None => RegDeleteValueW(key.0,name.as_ptr()),
            }
        };
        if result == ERROR_FILE_NOT_FOUND { return Ok(()); } checked(result)
    }
    pub fn remove_empty(path: &str) { unsafe { RegDeleteKeyW(HKEY_CURRENT_USER,wide(path).as_ptr()); } }
}

#[cfg(not(windows))]
mod registry {
    use super::Entry;
    pub fn read(_: &str, _: &str) -> Result<Option<Entry>,String> { Ok(None) }
    pub fn write(_: &str, _: &str, _: Option<&Entry>) -> Result<(),String> { Err("Startup is only available on Windows".into()) }
    pub fn remove_empty(_: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_the_whole_executable_and_keeps_hidden_separate() {
        let path = if cfg!(windows) { r"D:\Apps\測試 app\pilot.exe" } else { "/Apps/測試 app/pilot" };
        assert_eq!(command(Path::new(path)).unwrap(),format!("\"{path}\" --hidden"));
        assert!(command(Path::new("relative.exe")).is_err());
        assert!(command(Path::new(&format!("{}\"bad",path))).is_err());
        assert!(command(Path::new(&format!("{}{}",path,"x".repeat(261)))).is_err());
    }
    #[test]
    fn shows_manual_launches_but_keeps_login_and_simulation_in_the_tray() {
        assert!(show_settings(false,false,false)); assert!(!show_settings(true,false,false));
        assert!(!show_settings(false,true,false)); assert!(show_settings(true,true,true));
        assert!(Startup::default().change(false,true).is_err());
        assert!(Startup::default().change(false,false).unwrap().is_none());
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "Writes only an isolated HKCU test key; run explicitly outside the sandbox"]
    fn round_trips_registration_rolls_back_failed_saves_and_leaves_other_values_alone() {
        use crate::settings::{SettingsState, HelperConfig};
        use serde_json::json;
        let key = format!(r"Software\lolPingDesktopPilotTests\unit-{}",std::process::id());
        let startup = Startup { key:Some(key.clone()),command:command(Path::new(r"D:\測試 app\pilot.exe")).unwrap(),isolated:true };
        let other = Entry { kind:1,bytes:vec![0,0] };
        registry::write(&key,"Unrelated",Some(&other)).unwrap();
        let previous = startup.change(false,true).unwrap().unwrap(); assert!(startup.enabled().unwrap());
        startup.restore(&previous).unwrap(); assert!(!startup.enabled().unwrap());
        let helper: HelperConfig = serde_json::from_value(serde_json::from_str::<serde_json::Value>(include_str!("../../../out/desktop-pilot/bootstrap.json")).unwrap()["config"].clone()).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/startup-rollback");
        std::fs::create_dir_all(&root).unwrap(); let blocker = root.join("not-a-directory"); std::fs::write(&blocker,b"block").unwrap();
        let settings = json!({"enabledOnStart":true,"launchAtStartup":false,"features":{}});
        let mut state = SettingsState::new(settings.clone(),blocker.join("settings.json")); state.startup = startup;
        let mut changed = settings.clone(); changed["launchAtStartup"] = true.into();
        assert!(state.save(changed,helper,0).is_err());
        assert_eq!(state.settings,settings); assert_eq!(state.revision,0); assert!(!state.startup.enabled().unwrap());
        assert_eq!(registry::read(&key,"Unrelated").unwrap(),Some(other));
        registry::write(&key,"Unrelated",None).unwrap();
    }
}
