mod crypto;
mod protocol;
mod guards;
mod core;
mod network;
mod transfer;
pub mod clipboard;

use core::{Received, Room, Route};
use network::{Lan, Relays, RelayInput};
use serde_json::{json, Value};
use std::{collections::{HashSet, VecDeque}, net::SocketAddr, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}}, time::Duration};
use tauri::{Emitter, Manager};
use transfer::{Cache, Transfer};
use crate::Pilot;

pub enum Operation {
    Create, Join(String), Leave, Mute(String, bool), Retry,
    Share { display: usize, kind: String, reference: String, x: f64, y: f64 },
    Chat(u64, crate::chat::Command),
    Panel(String, Value), Cast(String),
}
pub struct Request { operation: Operation, reply: Option<mpsc::Sender<Result<Value, String>>> }

pub struct Service {
    sender: SyncSender<Request>,
    stopped: Arc<AtomicBool>,
    state: Mutex<Value>,
    pub cache: Arc<Mutex<Cache>>,
    finished: Mutex<Option<mpsc::Receiver<()>>>,
}

impl Service {
    pub fn enqueue(&self, operation: Operation) { let _ = self.sender.try_send(Request { operation, reply: None }); }
    pub fn new() -> (Self, Receiver<Request>) {
        let (sender, receiver) = mpsc::sync_channel(128);
        (Self { sender, stopped: Arc::new(AtomicBool::new(false)), state: Mutex::new(idle()),
            cache: Arc::new(Mutex::new(Cache::default())), finished: Mutex::new(None) }, receiver)
    }

    pub fn snapshot(&self) -> Result<Value, String> { Ok(self.state.lock().map_err(|e| e.to_string())?.clone()) }

    pub fn call(&self, operation: Operation) -> Result<Value, String> {
        let (reply, receiver) = mpsc::channel();
        self.sender.try_send(Request { operation, reply: Some(reply) }).map_err(|_| "Room service is busy".to_owned())?;
        receiver.recv_timeout(Duration::from_secs(15)).map_err(|_| "Room service did not answer".to_owned())?
    }

    pub fn share(&self, display: usize, kind: String, reference: String, x: f64, y: f64) {
        let _ = self.sender.try_send(Request { operation: Operation::Share { display, kind, reference, x, y }, reply: None });
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Ok(mut finished) = self.finished.lock() {
            if let Some(receiver) = finished.take() { let _ = receiver.recv_timeout(Duration::from_millis(750)); }
        }
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn idle() -> Value { json!({"phase":"idle","code":null,"members":[],"lan":"off","internet":"off","lonely":false,"clockSkew":false,"displays":[]}) }

struct Runtime {
    room: Option<Room>, lan: Option<Lan>, relays: Option<Relays>,
    relay_status: Vec<&'static str>, relay_started: u64,
    urls: Vec<String>, port: u16, seeds: Vec<SocketAddr>, broadcast: bool,
    transfer: Transfer, flood: guards::Budget, seen: HashSet<String>, ring: VecDeque<String>,
    last_profile: Value, last_enabled: bool, saved: bool,
    pending_presence: bool,
    votes: crate::votes::Votes,
}

impl Runtime {
    fn broadcast(&mut self, body: Value, enabled: bool, now: u64) {
        if !enabled { return; }
        let Some(room) = self.room.as_mut() else { return; };
        let routes: Vec<Route> = room.members.iter().filter_map(|m| m.route(now)).collect();
        let Ok(packet) = room.packet(body, now) else { return; };
        let internet = routes.contains(&Route::Internet) && room.relay_token(now, false);
        for route in routes { if route != Route::Internet { self.send(route, &packet, now); } }
        if internet { self.send(Route::Internet, &packet, now); }
    }

    fn start_vote(&mut self, kind: &str, target: Option<&str>, settings: &Value, enabled: bool, now: u64) -> Result<(), String> {
        if settings["features"]["roomVotes"] != true { return Ok(()); }
        let Some(room) = &self.room else { return Ok(()); };
        if room.phase != "active" || (kind == "kick" && !target.is_some_and(|p| p != room.identity.peer && room.members.iter().any(|m| m.peer == p))) { return Ok(()); }
        let state = room.state(settings, enabled, "off", "off", now);
        let id = crypto::hex(&crypto::random::<4>()?);
        let Some(members) = state["members"].as_array() else { return Ok(()); };
        if self.votes.start(&id, kind, &room.identity.peer, target, members, now) {
            let mut body = json!({"t":"vote","id":id,"kind":kind});
            if let Some(target) = target { body["target"] = target.into(); }
            self.broadcast(body, enabled, now);
        }
        Ok(())
    }

    fn answer(&mut self, yes: bool, enabled: bool, now: u64) {
        let Some(room) = &self.room else { return; };
        let Some(id) = self.votes.view.as_ref().and_then(|v| v["id"].as_str()).map(str::to_owned) else { return; };
        if self.votes.ballot(&room.identity.peer, &id, yes) { self.broadcast(json!({"t":"ballot","id":id,"yes":yes}), enabled, now); }
    }

    fn panel_action(&mut self, app: &tauri::AppHandle, action: Value, settings: &Value, enabled: bool, now: u64) -> Result<(), String> {
        if ["vote","kick"].contains(&action["t"].as_str().unwrap_or("")) && self.votes.view.is_some() && !self.votes.over {
            let _ = app.emit("pilot-room-notice", json!({"kind":"voteBusy"}).to_string()); return Ok(());
        }
        let peer = action["peer"].as_str().unwrap_or("");
        match action["t"].as_str().unwrap_or("") {
            "ballot" => {
                if self.votes.view.as_ref().is_some_and(|v| v["id"] == action["voteId"]) { self.answer(action["yes"] == true, enabled, now); }
            },
            "vote" => if let Some(kind) = action["kind"].as_str().filter(|k| ["ff","ready"].contains(k)) { self.start_vote(kind, None, settings, enabled, now)?; },
            "kick" => self.start_vote("kick", Some(peer), settings, enabled, now)?,
            "mute" => if let Some(room) = &mut self.room { if let Some(m) = room.members.iter_mut().find(|m| m.peer == peer) { m.muted = action["on"] == true; } },
            "clearSpell" => {
                let slot = action["slot"].as_str().unwrap_or("");
                if settings["features"]["roomSpells"] == true && ["d","f"].contains(&slot) {
                    if let Some(room) = self.room.as_mut().filter(|r| r.identity.peer == peer && !r.spells.is_null()) {
                        let spell = room.spells[slot]["spell"].as_str().unwrap_or("heal").to_owned();
                        room.spells[slot] = crate::spells::fresh(&spell);
                        self.announce(settings, enabled, now, true, true);
                    }
                }
            },
            "alive" | "spell" => {
                if !crate::chat_state::text_on(settings) { return Ok(()); }
                let Some(room) = &self.room else { return Ok(()); };
                let state = room.state(settings, enabled, "off", "off", now);
                let Some(member) = state["members"].as_array().and_then(|m| m.iter().find(|m| m["peer"] == peer)) else { return Ok(()); };
                if let Ok(at) = app.cursor_position() { if let Ok(mut s) = app.state::<Pilot>().chat.state.lock() { s.at = (at.x, at.y); } }
                let mut body = crate::chat::location(app);
                body["t"] = action["t"].clone(); body["who"] = peer.into();
                if action["t"] == "spell" {
                    let slot = action["slot"].as_str().unwrap_or("");
                    if !["d","f"].contains(&slot) { return Ok(()); }
                    body["slot"] = slot.into();
                    let spells = if member["spells"].is_null() { crate::spells::defaults() } else { member["spells"].clone() };
                    body["cooldown"] = spells[slot].clone();
                }
                let mut line = body.clone(); line["kind"] = body["t"].clone(); line["tag"] = self_tag(settings);
                line["at"] = now.into(); line["whoName"] = member["name"].clone(); line["ownWho"] = member["self"].clone(); line["owner"] = "self".into();
                crate::chat::post(app, line, settings, enabled);
                self.broadcast(body, enabled, now);
            },
            _ => {},
        }
        Ok(())
    }

    fn tick_votes(&mut self, app: &tauri::AppHandle, settings: &Value, enabled: bool, now: u64) {
        if settings["features"]["roomVotes"] != true { self.votes = crate::votes::Votes::default(); return; }
        let Some(room) = &self.room else { return; };
        let state = room.state(settings, enabled, "off", "off", now);
        let Some(members) = state["members"].as_array() else { return; };
        let own = room.identity.peer.clone();
        if let Some(body) = self.votes.repeat(&own, now) { self.broadcast(body, enabled, now); }
        if let Some(result) = self.votes.tick(members, now) {
            crate::chat::post(app, json!({"kind":"vote","at":now,"tag":null,"outcome":result,"owner":"vote","d":1,"x":0.5,"y":0.2}), settings, enabled);
            if result["kind"] == "kick" && result["passed"] == true {
                if result["target"] == own {
                    crate::chat::reset(app); self.quit(now); let _ = remember(app, None);
                    let _ = app.emit("pilot-room-notice", json!({"kind":"kickedYou"}).to_string());
                }
                else if let Some(room) = self.room.as_mut() {
                    if let Some(peer) = result["target"].as_str() {
                        room.members.retain(|m| m.peer != peer); if room.blocked.len() < 1024 { room.blocked.insert(peer.into()); }
                        self.transfer.gone(peer); let _ = app.emit("pilot-room-gone", peer);
                    }
                }
            }
        }
    }

    fn internet_status(&self, now: u64) -> &'static str {
        if self.relays.is_none() { "off" }
        else if self.relay_status.contains(&"ok") { "ok" }
        else if now.saturating_sub(self.relay_started) >= 15_000 || self.relay_status.iter().all(|&s| s == "unavailable") { "unavailable" }
        else { "starting" }
    }

    fn quit(&mut self, now: u64) {
        if let Some(room) = self.room.as_mut() {
            if let Ok(packet) = room.packet(json!({"t":"bye"}), now) {
                if let Some(lan) = self.lan.as_mut() {
                    lan.broadcast(&packet, now);
                    for member in &room.members { if let Some((address, _)) = member.lan { lan.send(address, &packet); } }
                }
                if let Some(relays) = &self.relays { relays.publish(&packet, now); }
            }
        }
        self.relays = None; self.lan = None; self.room = None;
        self.transfer.clear(); self.seen.clear(); self.ring.clear(); self.saved = false; self.pending_presence = false;
        self.flood = guards::Budget::default();
        self.votes = crate::votes::Votes::default();
    }

    fn join(&mut self, code: &str, now: u64, settings: &Value) -> Result<(), String> {
        let room = Room::join(code, now)?;
        self.quit(now);
        self.room = Some(room);
        self.lan = Lan::open(self.port, self.seeds.clone(), self.broadcast).ok();
        self.set_internet(settings["allowInternet"] == true, now)?;
        self.announce(settings, self.last_enabled, now, true, true);
        Ok(())
    }

    fn set_internet(&mut self, enabled: bool, now: u64) -> Result<(), String> {
        if !enabled {
            self.relays = None; self.relay_status.clear();
            if let Some(room) = &mut self.room { for member in &mut room.members { member.internet = None; } }
        }
        else if self.relays.is_none() {
            if let Some(room) = &self.room {
                self.relays = Some(Relays::start(&self.urls, &room.keys.topic)?);
                self.relay_status = vec!["starting"; self.urls.len()]; self.relay_started = now;
            }
        }
        Ok(())
    }

    fn announce(&mut self, settings: &Value, enabled: bool, now: u64, lan_now: bool, relay_now: bool) {
        let Some(room) = self.room.as_mut() else { return; };
        self.pending_presence |= relay_now;
        let send_lan = lan_now || now.saturating_sub(room.last_lan) >= 2000;
        let send_internet = (self.pending_presence || now.saturating_sub(room.last_internet) >= 10_000)
            && now.saturating_sub(room.last_internet) >= 1000;
        if !send_lan && !send_internet { return; }
        let Ok(packet) = room.presence(settings, enabled, now, env!("LOLPING_APP_VERSION")) else { return; };
        if send_lan {
            if let Some(lan) = self.lan.as_mut() {
                lan.broadcast(&packet, now);
                for member in &room.members { if let Some((address, _)) = member.lan { lan.send(address, &packet); } }
            }
            room.last_lan = now;
        }
        if send_internet {
            if let Some(relays) = &self.relays { relays.publish(&packet, now); }
            room.last_internet = now;
            self.pending_presence = false;
        }
    }

    fn send(&self, route: Route, packet: &[u8], now: u64) {
        match route {
            Route::Lan(address) => if let Some(lan) = &self.lan { lan.send(address, packet); },
            Route::Internet => if let Some(relays) = &self.relays { relays.publish(packet, now); },
        }
    }

    fn operation(&mut self, app: &tauri::AppHandle, operation: Operation, settings: &Value, enabled: bool, now: u64) -> Result<Value, String> {
        if settings["features"]["rooms"] != true && !matches!(operation, Operation::Leave) { return Err("Rooms are disabled".into()); }
        match operation {
            Operation::Create => { crate::chat::reset(app); self.join(&protocol::make_code(crypto::random()?), now, settings)?; },
            Operation::Join(code) => { crate::chat::reset(app); self.join(&code, now, settings)?; },
            Operation::Leave => { crate::chat::reset(app); self.quit(now); remember(app, None)?; },
            Operation::Chat(generation, command) => {
                if !app.state::<Pilot>().chat.state.lock().map(|s| s.generation == generation).unwrap_or(false) { return Ok(json!("unknown")); }
                return self.chat(app, command, settings, enabled, now);
            },
            Operation::Panel(session, action) => {
                let allowed = if action["t"] == "ballot" { settings["features"]["roomVotes"] == true } else { settings["features"]["roomPanel"] == true };
                if allowed && self.room.as_ref().is_some_and(|r| r.identity.peer == session && r.phase == "active") {
                    self.panel_action(app, action, settings, enabled, now)?;
                }
            },
            Operation::Cast(slot) => {
                let suspended = app.state::<Pilot>().store.lock().map(|s| s.suspended).unwrap_or(true);
                if enabled && !suspended && ["d","f"].contains(&slot.as_str()) && settings["features"]["roomSpells"] == true {
                    if let Some(room) = self.room.as_mut().filter(|r| r.phase == "active") {
                        if crate::spells::cast(&mut room.spells[&slot], now) {
                            let _ = app.emit("pilot-summoner", room.spells[&slot]["spell"].to_string());
                            self.announce(settings, enabled, now, true, true);
                        }
                    }
                }
            },
            Operation::Mute(peer, on) => if let Some(room) = &mut self.room {
                if let Some(member) = room.members.iter_mut().find(|m| m.peer == peer) { member.muted = on; }
            },
            Operation::Retry => {
                if let Some(relays) = &self.relays { relays.retry(); }
                if self.room.is_some() && self.lan.is_none() { self.lan = Lan::open(self.port, self.seeds.clone(), self.broadcast).ok(); }
            },
            Operation::Share { display, kind, reference, x, y } => {
                if !enabled || !x.is_finite() || !y.is_finite() { return Ok(Value::Null); }
                let pilot = app.state::<Pilot>();
                let layout = pilot.layout.lock().map_err(|e| e.to_string())?;
                let Some(d) = layout.displays.iter().find(|d| d.id == display) else { return Ok(Value::Null); };
                let mut body = json!({"t":kind,"d":display + 1,"x":((x / d.dip.width).clamp(0.0, 1.0) * 10000.0).round() / 10000.0,
                    "y":((y / d.dip.height).clamp(0.0, 1.0) * 10000.0).round() / 10000.0});
                drop(layout);
                if kind == "ping" && protocol::PINGS.contains(&reference.as_str()) { body["ping"] = reference.into(); }
                else if kind == "emote" && protocol::emote(&reference) && settings["features"]["emotes"] == true {
                    body["e"] = reference.clone().into();
                    if let Some(entry) = settings["customEmotes"].as_array().into_iter().flatten().find(|c| c["id"] == reference) {
                        if entry["fx"].as_u64().is_some_and(|fx| fx <= 5) { body["fx"] = entry["fx"].clone(); }
                    }
                } else { return Err("Invalid room placement".into()); }
                let Some(room) = self.room.as_mut() else { return Ok(Value::Null); };
                if body["t"] == "ping" && body["ping"] != "generic" {
                    crate::chat::post(app, json!({"kind":"ping","ping":body["ping"],"at":now,"tag":self_tag(settings)}), settings, enabled);
                }
                let routes: Vec<Route> = room.members.iter().filter_map(|m| m.route(now)).collect();
                let packet = room.packet(body, now)?;
                let internet = routes.contains(&Route::Internet) && room.relay_token(now, false);
                for route in routes { if route != Route::Internet { self.send(route, &packet, now); } }
                if internet { self.send(Route::Internet, &packet, now); }
            },
        }
        Ok(json!({"ok":true}))
    }

    fn chat(&mut self, app: &tauri::AppHandle, command: crate::chat::Command, settings: &Value, enabled: bool, now: u64) -> Result<Value, String> {
        if !crate::chat_state::text_on(settings) || self.room.is_none() { return Ok(json!("unknown")); }
        match command {
            crate::chat::Command::Vote { kind } => {
                if settings["features"]["roomVotes"] != true { return Ok(json!("votesOff")); }
                if !["ff","ready","noff"].contains(&kind.as_str()) { return Ok(json!("unknown")); }
                let current = self.votes.view.as_ref().filter(|_| !self.votes.over).map(|v| v["kind"].as_str().unwrap_or("").to_owned());
                if current.as_deref() == Some(if kind == "noff" { "ff" } else { &kind }) { self.answer(kind != "noff", enabled, now); }
                else if kind != "noff" {
                    if current.is_some() { let _ = app.emit("pilot-room-notice", json!({"kind":"voteBusy"}).to_string()); }
                    else { self.start_vote(&kind, None, settings, enabled, now)?; }
                }
            },
            crate::chat::Command::Text { text } => {
                let text = protocol::safe_text(&text, 120);
                if text.is_empty() { return Ok(json!("sent")); }
                let mut body = crate::chat::location(app);
                body["t"] = "text".into(); body["text"] = text.clone().into();
                let mut line = body.clone(); line["kind"] = "text".into(); line["at"] = now.into();
                line["tag"] = self_tag(settings); line["owner"] = "self".into();
                crate::chat::post(app, line, settings, enabled);
                if enabled {
                    let Some(room) = self.room.as_mut() else { return Ok(json!("unknown")); };
                    let routes: Vec<Route> = room.members.iter().filter_map(|m| m.route(now)).collect();
                    let packet = room.packet(body, now)?;
                    let internet = routes.contains(&Route::Internet) && room.relay_token(now, false);
                    for route in routes { if route != Route::Internet { self.send(route, &packet, now); } }
                    if internet { self.send(Route::Internet, &packet, now); }
                }
            },
            crate::chat::Command::Mute { peers, on, all } => {
                if peers.len() > 16 { return Ok(json!("noMember")); }
                let Some(room) = self.room.as_mut() else { return Ok(json!("noMember")); };
                let mut names = vec![];
                for member in &mut room.members {
                    if peers.contains(&member.peer) {
                        member.muted = on;
                        names.push(member.presence["name"].as_str().unwrap_or("Player").to_owned());
                    }
                }
                if names.is_empty() { return Ok(json!("noMember")); }
                let name = if all && names.len() == room.members.len() { Value::Null } else { json!(names[0]) };
                crate::chat::post(app, json!({"kind":"note","at":now,"tag":null,"note":{"name":name,"on":on}}), settings, enabled);
            },
            crate::chat::Command::Whisper { peers, text } => {
                if peers.len() > 16 { return Ok(json!("noMember")); }
                let text = protocol::safe_text(&text, 120);
                if text.is_empty() { return Ok(json!("noMessage")); }
                let Some(room) = self.room.as_mut() else { return Ok(json!("noMember")); };
                let mut sent = None;
                for peer in peers {
                    let Some(packet) = room.whisper_packet(&peer, &text, now) else { continue; };
                    let Some(member) = room.members.iter().find(|m| m.peer == peer) else { continue; };
                    if sent.is_none() { sent = Some(member.presence.clone()); }
                    let route = member.route(now);
                    if !enabled { continue; }
                    match route {
                        Some(Route::Lan(address)) => if let Some(lan) = &self.lan { lan.send(address, &packet); },
                        Some(Route::Internet) => if room.relay_token(now, false) {
                            if let Some(relays) = &self.relays { relays.publish_unlinked(&packet, now); }
                        },
                        None => {},
                    }
                }
                let Some(p) = sent else { return Ok(json!("cantWhisper")); };
                crate::chat::post(app, json!({"kind":"whisperTo","at":now,"text":text,
                    "tag":{"name":p["name"],"color":p["color"],"rgb":p["rgb"]}}), settings, enabled);
            },
        }
        Ok(json!("sent"))
    }

    fn receive(&mut self, app: &tauri::AppHandle, route: Route, packet: &[u8], settings: &Value, enabled: bool, now: u64) {
        let Some(room) = &mut self.room else { return; };
        let received = room.receive(packet, route, settings, enabled, now);
        for event in received {
            match event {
                Received::Presence(peer, hashes, notify) => {
                    let pilot = app.state::<Pilot>();
                    if notify {
                        if let Some(member) = self.room.as_ref().and_then(|r| r.members.iter().find(|m| m.peer == peer)) {
                            let _ = app.emit("pilot-room-notice", json!({"kind":"joined","name":member.presence["name"]}).to_string());
                        }
                    }
                    if enabled && settings["friendEmotes"] == true && settings["features"]["emotes"] == true {
                        self.transfer.presence(&peer, &hashes, &pilot.library, now);
                    }
                    // Direct reply helps a peer behind a Wi-Fi router that drops broadcasts.
                    if let (Route::Lan(address), Some(room), Some(lan)) = (route, self.room.as_mut(), &self.lan) {
                        if self.flood.allow(&format!("reply:{address}"), 0.5, 1.0, now) {
                            if let Ok(packet) = room.presence(settings, enabled, now, env!("LOLPING_APP_VERSION")) { lan.send(address, &packet); }
                        }
                    }
                },
                Received::Shared(message, tag) => {
                    if message["t"] == "ping" && message["ping"] != "generic" {
                        crate::chat::post(app, json!({"kind":"ping","at":now,"ping":message["ping"],"tag":tag}), settings, enabled);
                    } else if ["vote","ballot"].contains(&message["t"].as_str().unwrap_or("")) {
                        if message["t"] == "ballot" {
                            self.votes.ballot(message["peer"].as_str().unwrap_or(""), message["id"].as_str().unwrap_or(""), message["yes"] == true);
                        } else if let Some(room) = &self.room {
                            let kind = message["kind"].as_str().unwrap_or(""); let peer = message["peer"].as_str().unwrap_or("");
                            let target = message["target"].as_str();
                            if kind != "kick" || target.is_some_and(|p| p != peer && (p == room.identity.peer || room.members.iter().any(|m| m.peer == p))) {
                                let state = room.state(settings, enabled, "off", "off", now);
                                if let Some(members) = state["members"].as_array() { self.votes.start(message["id"].as_str().unwrap_or(""), kind, peer, target, members, now); }
                            }
                        }
                        continue;
                    } else if ["text","alive","spell"].contains(&message["t"].as_str().unwrap_or("")) {
                        let mut line = message.clone(); line["kind"] = message["t"].clone(); line["at"] = now.into(); line["tag"] = tag.clone();
                        line["cooldownAt"] = message["ts"].clone();
                        if message["t"] == "alive" || message["t"] == "spell" {
                            let name = self.room.as_ref().and_then(|room| room.members.iter().find(|m| message["who"] == m.peer))
                                .map(|m| m.presence["name"].clone()).unwrap_or_else(|| settings["displayName"].clone());
                            line["whoName"] = name;
                            line["ownWho"] = (message["who"] == message["peer"]).into();
                        }
                        crate::chat::post(app, line, settings, enabled);
                    }
                    let pilot = app.state::<Pilot>();
                    let available = message["e"].as_str().and_then(|e| e.strip_prefix("c:"))
                        .is_some_and(|hash| self.transfer.file(&pilot.library, hash, false).is_some());
                    let _ = app.emit("pilot-room-input", json!({"message":message,"tag":tag,"available":available}).to_string());
                },
                Received::Whisper(peer, text, tag) => crate::chat::post(app, json!({"kind":"whisperFrom","at":now,"peer":peer,"text":text,"tag":tag}), settings, enabled),
                Received::Want(message) => if settings["friendEmotes"] == true && settings["features"]["emotes"] == true {
                    self.transfer.want(&message, settings, &app.state::<Pilot>().library);
                },
                Received::Chunk(message) => if settings["friendEmotes"] == true && settings["features"]["emotes"] == true { self.transfer.chunk(&message); },
                Received::Gone(peer, name) => {
                    self.transfer.gone(&peer); let _ = app.emit("pilot-room-gone", peer);
                    let _ = app.emit("pilot-room-notice", json!({"kind":"left","name":name}).to_string());
                },
            }
        }
    }

    fn network(&mut self, app: &tauri::AppHandle, settings: &Value, enabled: bool, now: u64) {
        let mut buffer = [0; 1201];
        for _ in 0..128 {
            let result = self.lan.as_ref().and_then(|lan| lan.receive(&mut buffer).ok());
            let Some((length, address)) = result else { break; };
            if length > 1200 || !self.flood.allow(&format!("ip:{}", address.ip()), 100.0, 100.0, now)
                || !self.flood.allow("lan-total", 800.0, 800.0, now) { continue; }
            self.receive(app, Route::Lan(address), &buffer[..length], settings, enabled, now);
        }
        for _ in 0..256 {
            let input = self.relays.as_ref().and_then(|r| r.input.try_recv().ok());
            let Some(input) = input else { break; };
            match input {
                RelayInput::Status(index, status) => if let Some(s) = self.relay_status.get_mut(index) { *s = status; },
                RelayInput::LinkUp => self.announce(settings, enabled, now, false, true),
                RelayInput::Packet(id, packet) => {
                    if !self.seen.insert(id.clone()) { continue; }
                    self.ring.push_back(id);
                    if self.ring.len() > 512 { if let Some(id) = self.ring.pop_front() { self.seen.remove(&id); } }
                    if self.flood.allow("relay-total", 200.0, 200.0, now) { self.receive(app, Route::Internet, &packet, settings, enabled, now); }
                },
            }
        }
    }
}

fn remember(app: &tauri::AppHandle, code: Option<&str>) -> Result<(), String> {
    let pilot = app.state::<Pilot>();
    pilot.store.lock().map_err(|e| e.to_string())?.remember_room(code)?;
    pilot.emit_snapshot(app, "pilot-settings")
}

fn self_tag(settings: &Value) -> Value {
    json!({"name":protocol::safe_name(settings["displayName"].as_str().unwrap_or("Player")),
        "color":settings["tagColor"].as_u64().unwrap_or(0).min(7),"rgb":protocol::rgb(&settings["tagColorCustom"])})
}

pub fn run(app: tauri::AppHandle, requests: Receiver<Request>, urls: Vec<String>) {
    let (finished, done) = mpsc::channel();
    if let Ok(mut result) = app.state::<Pilot>().rooms.finished.lock() { *result = Some(done); }
    std::thread::spawn(move || {
        let pilot = app.state::<Pilot>();
        let smoke = std::env::var_os("LOLPING_PILOT_ROOM_SMOKE").is_some()
            && std::env::var_os("LOLPING_PILOT_SIMULATE").is_some() && std::env::var_os("LOLPING_PILOT_DATA_DIR").is_some();
        let mut runtime = Runtime { room: None, lan: None, relays: None, relay_status: vec![], relay_started: 0, urls,
            port: 47474, seeds: vec![], broadcast: true, transfer: Transfer::new(pilot.rooms.cache.clone()),
            flood: guards::Budget::default(), seen: HashSet::new(), ring: VecDeque::new(), last_profile: Value::Null,
            last_enabled: true, saved: false, pending_presence: false, votes: crate::votes::Votes::default() };
        if smoke {
            runtime.port = std::env::var("LOLPING_PILOT_ROOM_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            runtime.seeds = std::env::var("LOLPING_PILOT_ROOM_SEED").ok().and_then(|s| s.parse().ok()).into_iter().collect();
            runtime.broadcast = false;
            runtime.urls = std::env::var("LOLPING_PILOT_ROOM_RELAY").ok().into_iter().collect();
        }
        let mut initial = true;
        let mut last_state = Value::Null;
        let mut pending = None;
        while !pilot.rooms.stopped.load(Ordering::SeqCst) && !pilot.exiting.load(Ordering::SeqCst) {
            let (settings, enabled, initialized) = match pilot.store.lock() {
                Ok(store) => (store.settings.clone(), store.enabled, store.config.is_some()), Err(_) => break,
            };
            let now = now();
            if initial && initialized {
                initial = false;
                let isolated = smoke || ["LOLPING_PILOT_SMOKE", "LOLPING_PILOT_DISPLAY_SMOKE", "LOLPING_PILOT_BENCHMARK"].iter().any(|key| std::env::var_os(key).is_some());
                if !isolated && settings["features"]["rooms"] == true && settings["rejoinRoom"] == true {
                    if let Some(code) = settings["lastRoomCode"].as_str() { let _ = runtime.join(code, now, &settings); }
                }
            }
            let mut replies = vec![];
            for request in pending.take().into_iter().chain(requests.try_iter()).take(128) {
                let result = runtime.operation(&app, request.operation, &settings, enabled, now);
                if let Some(reply) = request.reply { replies.push((reply, result)); }
            }
            if settings["features"]["rooms"] != true && runtime.room.is_some() {
                crate::chat::reset(&app); runtime.quit(now); let _ = remember(&app, None);
            }
            if runtime.room.is_some() {
                if let Some(room) = runtime.room.as_mut() {
                    let mut spells = Value::Null;
                    if room.phase == "active" && settings["features"]["roomSpells"] == true {
                        let d = settings["summonerD"].as_str().filter(|s| crate::spells::duration(s).is_some()).unwrap_or("heal");
                        let f = settings["summonerF"].as_str().filter(|s| crate::spells::duration(s).is_some() && *s != d).unwrap_or(if d == "flash" {"heal"} else {"flash"});
                        spells = if room.spells["d"]["spell"] == d && room.spells["f"]["spell"] == f { room.spells.clone() }
                            else { json!({"d":crate::spells::fresh(d),"f":crate::spells::fresh(f)}) };
                    }
                    if room.spells != spells { room.spells = spells; runtime.pending_presence = true; }
                }
                let _ = runtime.set_internet(settings["allowInternet"] == true, now);
                let changed = runtime.last_profile != settings || runtime.last_enabled != enabled;
                runtime.announce(&settings, enabled, now, changed, changed);
                runtime.network(&app, &settings, enabled, now);
                let internet = runtime.internet_status(now);
                if let Some(room) = &mut runtime.room {
                    for (peer, name) in room.tick(now, internet) {
                        runtime.transfer.gone(&peer); let _ = app.emit("pilot-room-gone", peer);
                        if let Some(name) = name { let _ = app.emit("pilot-room-notice", json!({"kind":"lost","name":name}).to_string()); }
                    }
                    if room.phase == "active" && !runtime.saved {
                        if let Err(error) = remember(&app, Some(&room.code)) { eprintln!("Cannot remember room: {error}"); }
                        runtime.saved = true;
                        let _ = app.emit("pilot-room-notice", json!({"kind":"joinedRoom","code":protocol::formatted(&room.code)}).to_string());
                    }
                    if !enabled || settings["friendEmotes"] != true || settings["features"]["emotes"] != true { runtime.transfer.clear(); }
                    else {
                        let outgoing = runtime.transfer.tick(room, now);
                        for (route, body) in outgoing {
                            if let Some(room) = &mut runtime.room {
                                if let Ok(packet) = room.packet(body, now) { runtime.send(route, &packet, now); }
                            }
                        }
                    }
                }
                if runtime.room.as_ref().is_some_and(|room| room.phase == "full") {
                    let _ = app.emit("pilot-room-notice", json!({"kind":"full"}).to_string()); runtime.quit(now);
                }
            }
            runtime.last_profile = settings.clone(); runtime.last_enabled = enabled;
            runtime.tick_votes(&app, &settings, enabled, now);
            let internet = runtime.internet_status(now);
            let mut state = runtime.room.as_ref().map(|room| room.state(&settings, enabled,
                if runtime.lan.is_some() { "ok" } else { "unavailable" }, internet, now)).unwrap_or_else(idle);
            if let Ok(layout) = pilot.layout.lock() {
                state["displays"] = json!(layout.displays.iter().map(|d| json!({"number":d.id + 1,"width":d.dip.width.round(),
                    "height":d.dip.height.round(),"primary":d.id == 0})).collect::<Vec<_>>());
            }
            state["vote"] = runtime.votes.view.clone().unwrap_or(Value::Null);
            state["voteOver"] = runtime.votes.over.into();
            if state != last_state {
                if let Ok(mut current) = pilot.rooms.state.lock() { *current = state.clone(); }
                let _ = app.emit("pilot-room", state.to_string()); last_state = state;
                let _ = pilot.sync_input();
            }
            for (reply, result) in replies { let _ = reply.send(result); }
            pending = requests.recv_timeout(Duration::from_millis(if runtime.room.is_some() { 25 } else { 250 })).ok();
        }
        runtime.quit(now());
        let _ = finished.send(());
    });
}
