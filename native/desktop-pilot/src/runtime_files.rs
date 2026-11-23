use std::path::{Path, PathBuf};
use serde_json::Value;

pub const APP_ID: &str = "com.lolping.desktop-pilot";

pub fn installed_at(executable: &Path) -> bool {
    let Some(parent) = executable.parent() else { return false; };
    let path = parent.join("desktop-pilot.json");
    let Ok(metadata) = std::fs::symlink_metadata(&path) else { return false; };
    if !metadata.is_file() || metadata.len() > 4096 { return false; }
    let Ok(bytes) = std::fs::read(path) else { return false; };
    let Ok(marker) = serde_json::from_slice::<Value>(&bytes) else { return false; };
    marker["schema"] == 1 && marker["appId"] == APP_ID && marker["runtime"] == "tauri" && marker["installed"] == true && marker["test"] == 0
}

pub fn helper_at(executable: &Path) -> Result<PathBuf,String> {
    let parent = executable.parent().ok_or("Executable has no parent directory")?;
    let bundled = parent.join("hook-helper.exe");
    if let Ok(metadata) = std::fs::symlink_metadata(&bundled) {
        if metadata.is_file() && !metadata.file_type().is_symlink() { return Ok(bundled); }
        return Err("Bundled input helper is not a regular file".into());
    }
    // Only a repository build can use its build-tree helper; installed copies never reach back into a checkout.
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
    if parent == target.join("release") || parent == target.join("debug") {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../hook-helper/build/hook-helper.exe"));
    }
    Err("The input helper is missing from this installation".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_the_sibling_helper_and_never_falls_back_from_an_installed_copy() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/runtime-files-test");
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("pilot.exe"); let helper = root.join("hook-helper.exe");
        let _ = std::fs::remove_file(&helper);
        assert!(helper_at(&exe).is_err());
        std::fs::write(&helper,b"fixture").unwrap(); assert_eq!(helper_at(&exe).unwrap(),helper);
        let marker = root.join("desktop-pilot.json");
        std::fs::write(&marker,br#"{"schema":1,"appId":"com.lolping.desktop-pilot","runtime":"tauri","installed":true,"test":0}"#).unwrap();
        assert!(installed_at(&exe));
        std::fs::write(&marker,br#"{"schema":1,"appId":"com.lolping.app","runtime":"electron","installed":true,"test":0}"#).unwrap();
        assert!(!installed_at(&exe));
    }
}
