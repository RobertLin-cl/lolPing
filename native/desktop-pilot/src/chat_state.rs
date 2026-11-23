use serde_json::{json, Value};
use std::collections::VecDeque;

#[derive(Default)]
pub struct ChatState {
    pub lines: VecDeque<Value>,
    pub revision: u64,
    pub reply_to: Option<String>,
    pub ready: bool,
    pub pending: Option<bool>,
    pub focused: bool,
    pub hovered: bool,
    pub visible: bool,
    pub deadline: Option<u64>,
    pub bounds_due: Option<u64>,
    pub at: (f64, f64),
    pub previous: Option<isize>,
    pub generation: u64,
    pub loading_since: Option<u64>,
}

impl ChatState {
    pub fn snapshot(&self) -> Value { json!({"revision":self.revision,"lines":self.lines,"replyTo":self.reply_to}) }

    pub fn push(&mut self, line: Value) {
        self.lines.push_back(line);
        while self.lines.len() > 500 { self.lines.pop_front(); }
        self.revision += 1;
    }

    pub fn clear(&mut self) {
        self.generation += 1;
        self.ready = false;
        self.loading_since = None;
        self.lines.clear(); self.reply_to = None; self.revision += 1;
        self.pending = None; self.deadline = None;
    }

    pub fn request(&mut self, focus: bool) { self.pending = Some(focus || self.pending == Some(true)); }

    pub fn restart(&mut self, now: u64, seconds: u64) {
        self.deadline = if self.visible && !self.focused && !self.hovered && seconds != 0 {
            Some(now.saturating_add(seconds.min(60) * 1000))
        } else { None };
    }

    pub fn hidden(&mut self) {
        self.visible = false; self.focused = false; self.hovered = false; self.pending = None; self.deadline = None;
    }
}

pub fn text_on(settings: &Value) -> bool { settings["features"]["rooms"] == true && settings["features"]["roomText"] == true }

pub fn visible(line: &Value, settings: &Value) -> bool {
    let category = match line["kind"].as_str() {
        Some("note") => return true,
        Some("text") => "text", Some("ping") => "ping", Some("alive" | "spell") => "scoreboard",
        Some("whisperTo" | "whisperFrom") => "whisper", Some("vote") => "vote", _ => return false,
    };
    settings["chatFilter"][category] != false
}

pub fn runtime_config(config: &Value, settings: &Value, enabled: bool, active: bool) -> Value {
    let mut config = config.clone();
    config["enabled"] = enabled.into();
    config["textVk"] = 0.into();
    config["panelVk"] = 0.into(); config["summonerKeys"] = false.into();
    if active && enabled && settings["features"]["rooms"] == true {
        if settings["features"]["roomPanel"] == true {
            if let Some(vk) = settings["panelKey"].as_u64().filter(|n| (1..=255).contains(n)) { config["panelVk"] = vk.into(); }
        }
        config["summonerKeys"] = (settings["features"]["roomSpells"] == true).into();
    }
    if active && enabled && text_on(settings) {
        if let (Some(vk), Some(mods)) = (settings["textHotkey"]["vk"].as_u64(), settings["textHotkey"]["mods"].as_u64()) {
            if (1..=255).contains(&vk) && (1..=15).contains(&mods) { config["textVk"] = vk.into(); config["textMods"] = mods.into(); }
        }
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_only_this_sessions_last_five_hundred_lines_and_reply_target() {
        let mut state = ChatState::default();
        for i in 0..600 { state.push(json!({"text":i})); }
        assert_eq!(state.lines.len(), 500);
        assert_eq!(state.lines[0]["text"], 100);
        state.reply_to = Some("alice".into());
        state.ready = true;
        let generation = state.generation;
        state.clear();
        assert!(state.lines.is_empty()); assert!(state.reply_to.is_none());
        assert!(!state.ready); assert!(state.generation > generation);
    }

    #[test]
    fn never_hides_while_focused_or_hovered_and_restarts_after_they_leave() {
        let mut state = ChatState { visible: true, ..ChatState::default() };
        state.restart(1000, 8); assert_eq!(state.deadline, Some(9000));
        state.focused = true; state.restart(2000, 8); assert_eq!(state.deadline, None);
        state.focused = false; state.hovered = true; state.restart(3000, 8); assert_eq!(state.deadline, None);
        state.hovered = false; state.restart(4000, 8); assert_eq!(state.deadline, Some(12000));
        state.restart(5000, 0); assert_eq!(state.deadline, None);
        state.request(true); state.request(false); assert_eq!(state.pending, Some(true));
        state.hidden(); assert_eq!(state.pending, None);
    }

    #[test]
    fn only_enables_the_chat_shortcut_in_an_enabled_active_room_and_keeps_filtered_lines_quiet() {
        let settings = json!({"features":{"rooms":true,"roomText":true},"textHotkey":{"vk":13,"mods":2},"chatFilter":{"text":false}});
        let config = json!({"textVk":13});
        assert_eq!(runtime_config(&config, &settings, true, true)["textVk"], 13);
        assert_eq!(runtime_config(&config, &settings, true, false)["textVk"], 0);
        assert_eq!(runtime_config(&config, &settings, false, true)["textVk"], 0);
        assert!(!visible(&json!({"kind":"text"}), &settings));
        assert!(visible(&json!({"kind":"note"}), &settings));
        assert!(visible(&json!({"kind":"whisperFrom"}), &settings));
    }
}
