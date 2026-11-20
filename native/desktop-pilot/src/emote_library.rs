use crate::{emote_format::{self, ImageUpload, SoundHeader}, settings::{SettingsState, SettingsUpdate}};
use serde_json::{json, Value};
use std::{io, path::{Path, PathBuf}};

pub struct EmoteLibrary {
    pub root: PathBuf,
    pub inherited: PathBuf,
}

impl EmoteLibrary {
    pub fn import(&self, store: &mut SettingsState, upload: ImageUpload<'_>) -> Result<String, &'static str> {
        let ImageUpload { header, still, hd, anim } = upload;
        let SettingsUpdate { mut settings, config, revision } = header.live;
        store.check_update(&settings, revision).map_err(|_| "disk")?;
        let hash = emote_format::hash(still);
        let id = format!("c:{hash}");
        let entries = settings["customEmotes"].as_array_mut().ok_or("type")?;
        if entries.iter().any(|e| e["id"] == id) || store.settings["customEmotes"].as_array().is_some_and(|list| list.iter().any(|e| e["id"] == id)) {
            return Err("duplicate");
        }
        if entries.len() >= 24 { return Err("full"); }
        entries.push(json!({ "id": id, "name": emote_format::clean_name(&header.name, &hash), "animated": anim.is_some() }));

        let mut files = FileChanges::new(&self.root);
        let result = (|| -> io::Result<()> {
            files.write(&format!("{hash}.webp"), still)?;
            if let Some(bytes) = hd { files.write(&format!("{hash}.hd.webp"), bytes)?; }
            else { files.remove(&format!("{hash}.hd.webp"))?; }
            let format = anim.and_then(emote_format::animation_type);
            for extension in ["gif", "webp"] {
                let name = format!("{hash}.anim.{extension}");
                if format == Some(extension) { files.write(&name, anim.unwrap_or_default())?; }
                else { files.remove(&name)?; }
            }
            // A new import never inherits an earlier copy's local sound.
            for extension in ["ogg", "mp3", "wav"] { files.remove(&format!("{hash}.sound.{extension}"))?; }
            files.write(&format!("{hash}.sound.override"), &[])?;
            Ok(())
        })();
        result.map_err(|_| "disk")?;
        store.save(settings, config, revision).map_err(|_| "disk")?;
        files.commit();
        Ok(id)
    }

    pub fn sound(&self, store: &mut SettingsState, header: SoundHeader, bytes: Option<&[u8]>) -> Result<(), &'static str> {
        let SoundHeader { live, id, .. } = header;
        let hash = emote_format::custom_hash(&id).ok_or("type")?;
        let SettingsUpdate { mut settings, config, revision } = live;
        store.check_update(&settings, revision).map_err(|_| "disk")?;
        if !has_emote(&store.settings, &id) { return Err("type"); }
        let entries = settings["customEmotes"].as_array_mut().ok_or("type")?;
        let entry = entries.iter_mut().find(|e| e["id"] == id).and_then(Value::as_object_mut).ok_or("type")?;
        if bytes.is_some() { entry.insert("sound".into(), true.into()); }
        else { entry.remove("sound"); }

        let extension = bytes.and_then(emote_format::audio_type);
        if bytes.is_some() && extension.is_none() { return Err("type"); }
        let mut files = FileChanges::new(&self.root);
        for kind in ["ogg", "mp3", "wav"] {
            let name = format!("{hash}.sound.{kind}");
            if extension == Some(kind) { files.write(&name, bytes.unwrap_or_default()).map_err(|_| "disk")?; }
            else { files.remove(&name).map_err(|_| "disk")?; }
        }
        files.write(&format!("{hash}.sound.override"), &[]).map_err(|_| "disk")?;
        store.save(settings, config, revision).map_err(|_| "disk")?;
        files.commit();
        Ok(())
    }

    pub fn remove(&self, store: &mut SettingsState, id: &str, live: SettingsUpdate) -> Result<(), &'static str> {
        let hash = emote_format::custom_hash(id).ok_or("type")?;
        store.check_update(&live.settings, live.revision).map_err(|_| "disk")?;
        if has_emote(&live.settings, id) { return Err("type"); }
        if !has_emote(&store.settings, id) { return Ok(()); }
        let mut files = FileChanges::new(&self.root);
        for extension in ["webp", "hd.webp", "anim.gif", "anim.webp", "sound.ogg", "sound.mp3", "sound.wav", "sound.override"] {
            files.remove(&format!("{hash}.{extension}")).map_err(|_| "disk")?;
        }
        store.save(live.settings, live.config, live.revision).map_err(|_| "disk")?;
        files.commit();
        Ok(())
    }
}

pub fn has_emote(settings: &Value, id: &str) -> bool {
    settings["customEmotes"].as_array().is_some_and(|entries| entries.iter().any(|e| e["id"] == id))
}

/** Restore the previous files if any write or the settings save fails. The caller serializes mutations. */
struct FileChanges {
    root: PathBuf,
    written: Vec<PathBuf>,
    temporary: Vec<PathBuf>,
    backups: Vec<(PathBuf, PathBuf)>,
    committed: bool,
}

impl FileChanges {
    fn new(root: &Path) -> Self {
        Self { root: root.to_owned(), written: Vec::new(), temporary: Vec::new(), backups: Vec::new(), committed: false }
    }

    fn write(&mut self, name: &str, bytes: &[u8]) -> io::Result<()> {
        match std::fs::symlink_metadata(&self.root) {
            Ok(meta) if !meta.is_dir() || meta.is_symlink() => return Err(io::Error::other("Invalid asset directory")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => std::fs::create_dir_all(&self.root)?,
            Err(error) => return Err(error),
            _ => {},
        }
        let temporary = self.root.join(format!("{name}.tmp"));
        regular_file(&temporary)?;
        self.temporary.push(temporary.clone());
        std::fs::write(&temporary, bytes)?;
        self.remove(name)?;
        let target = self.root.join(name);
        std::fs::rename(temporary, &target)?;
        self.written.push(target);
        Ok(())
    }

    fn remove(&mut self, name: &str) -> io::Result<()> {
        match std::fs::symlink_metadata(&self.root) {
            Ok(meta) if !meta.is_dir() || meta.is_symlink() => return Err(io::Error::other("Invalid asset directory")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
            _ => {},
        }
        let target = self.root.join(name);
        if !regular_file(&target)? { return Ok(()); }
        let backup = self.root.join(format!("{name}.bak"));
        if regular_file(&backup)? { std::fs::remove_file(&backup)?; }
        std::fs::rename(&target, &backup)?;
        self.backups.push((target, backup));
        Ok(())
    }

    fn commit(mut self) { self.committed = true; }
}

impl Drop for FileChanges {
    fn drop(&mut self) {
        if !self.committed {
            for file in &self.written { let _ = std::fs::remove_file(file); }
            for (target, backup) in self.backups.iter().rev() { let _ = std::fs::rename(backup, target); }
        } else {
            for (_, backup) in &self.backups { let _ = std::fs::remove_file(backup); }
        }
        for file in &self.temporary { let _ = std::fs::remove_file(file); }
    }
}

fn regular_file(path: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.is_symlink() => Ok(true),
        Ok(_) => Err(io::Error::other("Asset path is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emote_format::{fixtures, image_upload, sound_upload};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/emote-library-tests");
            std::fs::create_dir_all(&base).expect("test root");
            loop {
                let dir = base.join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
                match std::fs::create_dir(&dir) {
                    Ok(()) => return Self(dir),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
                    Err(error) => panic!("Cannot create test directory: {error}"),
                }
            }
        }

        fn library(&self) -> EmoteLibrary { EmoteLibrary { root: self.0.join("local"), inherited: self.0.join("inherited") } }
        fn store(&self) -> SettingsState { SettingsState::new(fixtures::live(0)["settings"].clone(), self.0.join("settings.json")) }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/emote-library-tests");
            assert!(self.0.is_absolute() && self.0.starts_with(base));
            std::fs::remove_dir_all(&self.0).expect("remove isolated test directory");
        }
    }

    fn live(store: &SettingsState) -> Value {
        let mut live = fixtures::live(store.revision);
        live["settings"] = store.settings.clone();
        live
    }

    fn import(library: &EmoteLibrary, store: &mut SettingsState) -> String {
        let bytes = fixtures::image(live(store), &fixtures::still(160, 120, 600), None, None);
        library.import(store, image_upload(&bytes).expect("valid image")).expect("import")
    }

    fn sound(library: &EmoteLibrary, store: &mut SettingsState, id: &str, bytes: Option<&[u8]>) -> Result<(), &'static str> {
        let packet = fixtures::sound(live(store), id, bytes);
        let (header, bytes) = sound_upload(&packet)?;
        library.sound(store, header, bytes)
    }

    #[test]
    fn imports_replaces_sound_and_deletes_all_local_files() {
        let folder = Folder::new();
        let library = folder.library();
        let mut store = folder.store();
        let id = import(&library, &mut store);
        let hash = emote_format::custom_hash(&id).expect("id");
        assert_eq!(std::fs::read(library.root.join(format!("{hash}.webp"))).expect("still"), fixtures::still(160, 120, 600));
        sound(&library, &mut store, &id, Some(b"OggS old")).expect("ogg");
        sound(&library, &mut store, &id, Some(b"ID3 new")).expect("mp3");
        assert!(!library.root.join(format!("{hash}.sound.ogg")).exists());
        assert_eq!(store.settings["customEmotes"][0]["sound"], true);
        sound(&library, &mut store, &id, None).expect("clear");
        assert!(store.settings["customEmotes"][0].get("sound").is_none());
        assert!(crate::assets::find_library_asset(&library.root, &library.inherited, &format!("/emotes/{hash}.sound")).is_none());
        let mut update = live(&store);
        update["settings"]["customEmotes"] = json!([]);
        library.remove(&mut store, &id, serde_json::from_value(update).expect("update")).expect("remove");
        assert_eq!(std::fs::read_dir(&library.root).expect("local files").count(), 0);
        assert_eq!(store.settings["customEmotes"], json!([]));
    }

    #[test]
    fn refuses_duplicate_full_and_stale_imports_before_writing_any_files() {
        let folder = Folder::new();
        let library = folder.library();
        let mut store = folder.store();
        let id = import(&library, &mut store);
        let packet = fixtures::image(live(&store), &fixtures::still(160, 120, 600), None, None);
        assert_eq!(library.import(&mut store, image_upload(&packet).expect("image")), Err("duplicate"));
        let packet = fixtures::image(fixtures::live(0), &fixtures::still(100, 100, 600), None, None);
        assert_eq!(library.import(&mut store, image_upload(&packet).expect("image")), Err("disk"));
        assert!(has_emote(&store.settings, &id));
        store.settings["customEmotes"] = Value::Array((0..24).map(|i| json!({ "id": format!("c:{i:032x}"), "name": "x", "animated": false })).collect());
        let packet = fixtures::image(live(&store), &fixtures::still(100, 100, 600), None, None);
        assert_eq!(library.import(&mut store, image_upload(&packet).expect("image")), Err("full"));
    }

    #[test]
    fn rolls_back_import_files_when_settings_cannot_be_saved() {
        let folder = Folder::new();
        let library = folder.library();
        let mut store = folder.store();
        std::fs::create_dir(&store.file).expect("block settings replacement");
        let packet = fixtures::image(live(&store), &fixtures::still(160, 120, 600), None, None);
        assert_eq!(library.import(&mut store, image_upload(&packet).expect("image")), Err("disk"));
        assert_eq!(store.revision, 0);
        assert_eq!(store.settings["customEmotes"], json!([]));
        assert_eq!(std::fs::read_dir(&library.root).expect("local files").count(), 0);
    }

    #[test]
    fn restores_the_previous_sound_when_a_later_file_write_fails() {
        let folder = Folder::new();
        let library = folder.library();
        let mut store = folder.store();
        let id = import(&library, &mut store);
        let hash = emote_format::custom_hash(&id).expect("id");
        sound(&library, &mut store, &id, Some(b"OggS old")).expect("old sound");
        let revision = store.revision;
        std::fs::create_dir(library.root.join(format!("{hash}.sound.mp3.tmp"))).expect("block new sound");
        assert_eq!(sound(&library, &mut store, &id, Some(b"ID3 new")), Err("disk"));
        assert_eq!(std::fs::read(library.root.join(format!("{hash}.sound.ogg"))).expect("old sound"), b"OggS old");
        assert_eq!(store.revision, revision);
        assert!(!library.root.join(format!("{hash}.sound.mp3")).exists());
        assert!(!library.root.join(format!("{hash}.sound.ogg.bak")).exists());
    }

    #[test]
    fn restores_the_previous_sound_when_settings_cannot_be_saved() {
        let folder = Folder::new();
        let library = folder.library();
        let mut store = folder.store();
        let id = import(&library, &mut store);
        let hash = emote_format::custom_hash(&id).expect("id");
        sound(&library, &mut store, &id, Some(b"OggS old")).expect("old sound");
        std::fs::remove_file(&store.file).expect("remove test settings");
        std::fs::create_dir(&store.file).expect("block settings replacement");
        assert_eq!(sound(&library, &mut store, &id, Some(b"ID3 new")), Err("disk"));
        assert_eq!(std::fs::read(library.root.join(format!("{hash}.sound.ogg"))).expect("old sound"), b"OggS old");
        assert!(!library.root.join(format!("{hash}.sound.mp3")).exists());
    }

    #[test]
    fn overrides_and_removes_inherited_sounds_without_touching_the_original_files() {
        let folder = Folder::new();
        let library = folder.library();
        let mut store = folder.store();
        let still = fixtures::still(160, 120, 600);
        let hash = emote_format::hash(&still);
        let id = format!("c:{hash}");
        std::fs::create_dir_all(&library.inherited).expect("original directory");
        std::fs::write(library.inherited.join(format!("{hash}.webp")), &still).expect("original still");
        std::fs::write(library.inherited.join(format!("{hash}.sound.ogg")), b"OggS original").expect("original sound");
        store.settings["customEmotes"] = json!([{ "id": id, "name": "Original", "animated": false, "sound": true }]);
        sound(&library, &mut store, &id, Some(b"ID3 local")).expect("override");
        let url = format!("/emotes/{hash}.sound");
        assert_eq!(crate::assets::find_library_asset(&library.root, &library.inherited, &url), Some(library.root.join(format!("{hash}.sound.mp3"))));
        sound(&library, &mut store, &id, None).expect("clear");
        assert!(crate::assets::find_library_asset(&library.root, &library.inherited, &url).is_none());
        let mut update = live(&store);
        update["settings"]["customEmotes"] = json!([]);
        library.remove(&mut store, &id, serde_json::from_value(update).expect("update")).expect("remove");
        assert_eq!(std::fs::read(library.inherited.join(format!("{hash}.sound.ogg"))).expect("original survives"), b"OggS original");
        assert_eq!(std::fs::read(library.inherited.join(format!("{hash}.webp"))).expect("still survives"), still);
    }
}
