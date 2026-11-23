use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
#[serde(transparent)]
pub struct HelperConfig(pub Value);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsUpdate {
    pub settings: Value,
    pub config: HelperConfig,
    pub revision: u64,
}

impl<'de> Deserialize<'de> for HelperConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        validate_config(&value).map_err(serde::de::Error::custom)?;
        Ok(Self(value))
    }
}

fn validate_config(value: &Value) -> Result<(), String> {
    let fields = value.as_object().ok_or("Expected helper configuration")?;
    let boolean_fields = ["clickPing", "gameCheck", "emoteClick", "askClick", "askDoubleTap", "summonerKeys", "enabled"];
    let integer_fields = ["triggerVk", "emoteTriggerVk", "askTriggerVk", "toggleVk", "textVk", "panelVk", "toggleMods", "textMods", "dragThresholdPx"];
    if fields.len() != boolean_fields.len() + integer_fields.len() + 4 { return Err("Unknown helper fields".into()); }
    for field in boolean_fields {
        if !value[field].is_boolean() { return Err(format!("Invalid {field}")); }
    }
    for field in integer_fields {
        let number = value[field].as_u64().ok_or_else(|| format!("Invalid {field}"))?;
        let max = if field.ends_with("Mods") { 15 } else { 255 };
        if number > max || (field == "dragThresholdPx" && number == 0) { return Err(format!("Invalid {field}")); }
    }
    let trigger = |v: &Value| matches!(v.as_str(), Some("alt" | "ctrl" | "shift" | "win" | "capslock" | "mouse4" | "mouse5" | "vk"));
    if value["type"] != "config" || !trigger(&value["trigger"])
        || !(value["emoteTrigger"] == "off" || trigger(&value["emoteTrigger"])) { return Err("Invalid trigger".into()); }
    // Live chat keys come from host room state, not from renderer configuration.
    if value["askTrigger"] != "off" || value["askClick"] != false || value["askDoubleTap"] != false
        || value["textVk"] != 0 || value["panelVk"] != 0 || value["summonerKeys"] != false {
        return Err("Desktop service has not been migrated".into());
    }
    Ok(())
}

pub struct SettingsState {
    pub settings: Value,
    pub revision: u64,
    pub enabled: bool,
    pub helper_status: &'static str,
    pub suspended: bool,
    pub chat_focused: bool,
    pub sent_config: Option<Value>,
    pub sent_suspended: Option<bool>,
    pub config: Option<HelperConfig>,
    pub file: PathBuf,
}

impl SettingsState {
    pub fn new(settings: Value, file: PathBuf) -> Self {
        let enabled = settings["enabledOnStart"].as_bool().unwrap_or(true);
        Self { settings, revision: 0, enabled, helper_status: "starting", suspended: false, chat_focused: false,
            sent_config: None, sent_suspended: None, config: None, file }
    }

    pub fn snapshot(&self) -> Value {
        serde_json::json!({ "settings": self.settings, "revision": self.revision,
            "status": { "enabled": self.enabled, "helper": self.helper_status } })
    }

    pub fn save(&mut self, settings: Value, mut config: HelperConfig, revision: u64) -> Result<(), String> {
        self.check_update(&settings, revision)?;
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        write_settings(&self.file, &bytes).map_err(|e| e.to_string())?;
        config.0["enabled"] = Value::Bool(self.enabled);
        self.settings = settings;
        self.config = Some(config);
        self.revision += 1;
        Ok(())
    }

    pub fn check_update(&self, settings: &Value, revision: u64) -> Result<(), String> {
        if revision != self.revision { return Err("Settings changed; reload before saving".into()); }
        validate_settings(settings)
    }

    pub fn remember_room(&mut self, code: Option<&str>) -> Result<(), String> {
        let value = code.map(Value::from).unwrap_or(Value::Null);
        if self.settings["lastRoomCode"] == value { return Ok(()); }
        let mut settings = self.settings.clone(); settings["lastRoomCode"] = value;
        write_settings(&self.file, &serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        self.settings = settings; self.revision += 1;
        Ok(())
    }

    pub fn save_chat_bounds(&mut self, bounds: Value) -> Result<(), String> {
        if self.settings["chatBounds"] == bounds { return Ok(()); }
        let mut settings = self.settings.clone(); settings["chatBounds"] = bounds;
        write_settings(&self.file, &serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        self.settings = settings; self.revision += 1;
        Ok(())
    }
}

fn validate_settings(settings: &Value) -> Result<(), String> {
    if !settings.is_object() || settings.to_string().len() > 262_144 || !settings["enabledOnStart"].is_boolean() {
        return Err("Invalid settings".into());
    }
    if settings["launchAtStartup"] != false { return Err("Startup service has not been migrated".into()); }
    let features = settings["features"].as_object().ok_or("Invalid features")?;
    if features.iter().any(|(key, value)| !value.is_boolean() || (!matches!(key.as_str(), "emotes" | "rooms" | "roomText" | "roomPanel" | "roomVotes" | "roomSpells") && value != false)) {
        return Err("Desktop service has not been migrated".into());
    }
    Ok(())
}

fn write_settings(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = file.parent().ok_or_else(|| std::io::Error::other("Missing settings directory"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)?;
    if let Err(error) = std::fs::rename(&temporary, file) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Value {
        serde_json::from_str::<Value>(include_str!("../../../out/desktop-pilot/bootstrap.json"))
            .expect("bootstrap fixture")["config"].clone()
    }

    #[test]
    fn rejects_room_keys_and_malformed_helper_fields() {
        let mut input = config();
        input["textVk"] = 13.into();
        assert!(serde_json::from_value::<HelperConfig>(input).is_err());
        let mut input = config();
        input["toggleVk"] = (-1).into();
        assert!(serde_json::from_value::<HelperConfig>(input).is_err());
        let mut input = config();
        input["enabled"] = "true".into();
        assert!(serde_json::from_value::<HelperConfig>(input).is_err());
        assert!(serde_json::from_value::<HelperConfig>(config()).is_ok());
    }

    #[test]
    fn refuses_stale_settings_without_writing_a_file() {
        let mut state = SettingsState::new(serde_json::json!({}), PathBuf::from("unused-settings.json"));
        let helper = serde_json::from_value::<HelperConfig>(config()).expect("valid config");
        assert!(state.save(serde_json::json!({}), helper, 1).is_err());
        assert_eq!(state.revision, 0);
    }

    #[test]
    fn replaces_saved_settings_and_preserves_the_runtime_pause() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/settings-test");
        let file = dir.join("settings.json");
        let settings = serde_json::json!({ "enabledOnStart": true, "launchAtStartup": false, "features": { "emotes": true } });
        let mut state = SettingsState::new(settings.clone(), file.clone());
        state.enabled = false;
        for revision in 0..2 {
            state.save(settings.clone(), serde_json::from_value::<HelperConfig>(config()).expect("valid config"), revision)
                .expect("save settings");
        }
        assert_eq!(state.config.as_ref().expect("config").0["enabled"], false);
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&file).expect("saved file")).expect("json"), settings);
        std::fs::remove_file(file).expect("remove test file");
    }
}
