use std::path::{Path, PathBuf};

pub fn asset_names(path: &str) -> Vec<String> {
    let Some(name) = path.strip_prefix("/emotes/") else { return Vec::new(); };
    let Some((hash, kind)) = name.split_once('.') else { return Vec::new(); };
    if hash.len() != 32 || !hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) { return Vec::new(); }
    match kind {
        "webp" => vec![format!("{hash}.webp")],
        "hd" => vec![format!("{hash}.hd.webp"), format!("{hash}.webp")],
        "anim" => vec![format!("{hash}.anim.gif"), format!("{hash}.anim.webp"), format!("{hash}.webp")],
        "sound" => ["ogg", "mp3", "wav"].iter().map(|ext| format!("{hash}.sound.{ext}")).collect(),
        _ => Vec::new(),
    }
}

pub fn find_asset(dir: &Path, path: &str) -> Option<PathBuf> {
    asset_names(path).iter().map(|name| dir.join(name)).find(|file| {
        std::fs::symlink_metadata(file).is_ok_and(|m| m.is_file() && !m.is_symlink() && m.len() <= 5_242_880)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_known_names_and_never_accepts_paths() {
        let hash = "a".repeat(32);
        assert_eq!(asset_names(&format!("/emotes/{hash}.hd")), vec![format!("{hash}.hd.webp"), format!("{hash}.webp")]);
        for path in ["/emotes/../settings.json", "/emotes/%2e%2e/settings.json", "/emotes/a.webp", "/settings.json"] {
            assert!(asset_names(path).is_empty());
        }
        assert!(asset_names(&format!("/emotes/{hash}.hd/../settings.json")).is_empty());
    }
}
