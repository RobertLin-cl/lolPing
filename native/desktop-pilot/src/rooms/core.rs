use super::{crypto::{self, Identity, Keys}, guards::{Budget, ReplayGuard}, protocol::{self, Decoded}};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, net::SocketAddr};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Route { Lan(SocketAddr), Internet }

pub struct Member {
    pub peer: String,
    pub presence: Value,
    pub muted: bool,
    pub public: Option<String>,
    pub lan: Option<(SocketAddr, u64)>,
    pub internet: Option<u64>,
    via_internet: bool,
    seen: u64,
    spell_seq: Option<u64>,
}

impl Member {
    pub fn route(&self, now: u64) -> Option<Route> {
        if let Some((address, at)) = self.lan { if now.saturating_sub(at) < 6000 { return Some(Route::Lan(address)); } }
        if self.internet.is_some_and(|at| now.saturating_sub(at) < 25_000) { return Some(Route::Internet); }
        None
    }

    fn heard(&mut self, route: Route, now: u64) {
        self.seen = now;
        match route { Route::Lan(address) => self.lan = Some((address, now)), Route::Internet => { self.internet = Some(now); self.via_internet = true; } }
    }
}

pub enum Received { Presence(String, Vec<String>, bool), Shared(Value, Value), Whisper(String, String, Value), Want(Value), Chunk(Value), Gone(String, String) }

pub struct Room {
    pub code: String,
    pub identity: Identity,
    pub keys: Keys,
    pub members: Vec<Member>,
    pub phase: &'static str,
    pub joined: u64,
    pub settle_at: Option<u64>,
    pub last_lan: u64,
    pub last_internet: u64,
    pub alone_since: Option<u64>,
    seq: u64,
    signed: ReplayGuard,
    unsigned: ReplayGuard,
    bound: HashSet<String>,
    timed_out: HashSet<String>,
    stale: HashMap<String, (usize, u64)>,
    budget: Budget,
    transfer: Budget,
    relay_budget: Budget,
    last_tick: u64,
    woke: u64,
    whisper: crypto::WhisperKey,
    seen_whispers: HashMap<String, u64>,
    whisper_budget: Budget,
    ballot_budget: Budget,
    pub spells: Value,
    pub blocked: HashSet<String>,
}

impl Room {
    pub fn join(code: &str, now: u64) -> Result<Self, String> {
        if !protocol::canonical(code) { return Err("Invalid room code".into()); }
        Ok(Self { code: code.into(), identity: Identity::from_seed(crypto::random()?), keys: Keys::derive(code)?,
            members: vec![], phase: "joining", joined: now, settle_at: None, last_lan: 0, last_internet: 0,
            alone_since: Some(now), seq: 0, signed: ReplayGuard::default(), unsigned: ReplayGuard::default(),
            bound: HashSet::new(), timed_out: HashSet::new(), stale: HashMap::new(), budget: Budget::default(), transfer: Budget::default(),
            relay_budget: Budget::default(), last_tick: now, woke: now, whisper: crypto::WhisperKey::from_seed(crypto::random()?),
            seen_whispers: HashMap::new(), whisper_budget: Budget::default(), ballot_budget: Budget::default(), spells: Value::Null, blocked: HashSet::new() })
    }

    pub fn packet(&mut self, mut body: Value, now: u64) -> Result<Vec<u8>, String> {
        self.seq += 1;
        body["peer"] = self.identity.peer.clone().into();
        body["seq"] = self.seq.into(); body["ts"] = now.into();
        let text = body.to_string();
        let signed = if body["t"] == "chunk" { text } else { self.identity.signed(&text) };
        crypto::seal(&self.keys.message, signed.as_bytes())
    }

    pub fn presence(&mut self, settings: &Value, enabled: bool, now: u64, version: &str) -> Result<Vec<u8>, String> {
        let mut off = vec![];
        if settings["features"]["roomText"] != true { off.push("text"); }
        if settings["features"]["roomVotes"] != true { off.push("votes"); }
        let mut body = json!({"t":"presence","proto":1,"app":version,"name":protocol::safe_name(settings["displayName"].as_str().unwrap_or("Player")),
            "color":settings["tagColor"].as_u64().unwrap_or(0).min(7),"status":status(settings, enabled),
            "pk":self.identity.public(),"xk":crypto::b64(&self.whisper.public),"nf":off,"em":announced(settings)});
        if !self.spells.is_null() { body["spells"] = self.spells.clone(); }
        let rgb = protocol::rgb(&settings["tagColorCustom"]);
        if !rgb.is_null() { body["rgb"] = rgb; }
        self.packet(body, now)
    }

    pub fn receive(&mut self, packet: &[u8], route: Route, settings: &Value, enabled: bool, now: u64) -> Vec<Received> {
        let Some(plain) = crypto::open(&self.keys.message, packet) else { return vec![]; };
        let Some(Decoded { message: m, body, signature }) = protocol::decode(&plain) else { return vec![]; };
        let peer = m["peer"].as_str().unwrap_or("");
        if self.blocked.contains(peer) { return vec![]; }
        if peer == self.identity.peer { return vec![]; }
        let existing = self.members.iter().position(|member| member.peer == peer);
        let seq = m["seq"].as_u64().unwrap_or(0);
        let ts = m["ts"].as_u64().unwrap_or(0);
        let paused = !enabled;
        if m["t"] == "whisper" { return self.receive_whisper(&m, settings, enabled, now); }
        if m["t"] == "chunk" {
            let Some(i) = existing else { return vec![]; };
            if paused || self.members[i].muted || self.members[i].presence["proto"] != 1
                || !self.transfer.allow(peer, 60.0, 60.0, now) { return vec![]; }
            return vec![Received::Chunk(m)];
        }
        let public = if m["t"] == "presence" { protocol::proven_key(&m) }
            else { existing.and_then(|i| self.members[i].public.clone()) };
        if let Some(signature) = &signature {
            if !public.as_ref().is_some_and(|pk| crypto::verify(pk, &body, signature)) { return vec![]; }
        } else if self.bound.contains(peer) { return vec![]; }
        if ts.abs_diff(now) > 600_000 {
            if m["t"] == "presence" && (self.stale.len() < 128 || self.stale.contains_key(peer)) {
                let strike = self.stale.entry(peer.into()).or_insert((0, now)); strike.0 += 1; strike.1 = now;
            }
            return vec![];
        }
        // Keep replay and identity tables bounded even when a room-key holder invents senders.
        if existing.is_none() && (m["t"] != "presence" || self.members.len() >= 16
            || (self.phase == "active" && self.members.len() >= 15)) { return vec![]; }
        let guard = if signature.is_some() { &mut self.signed } else { &mut self.unsigned };
        if !guard.accept(peer, seq, ts, now) { return vec![]; }
        self.stale.remove(peer);
        if m["t"] == "bye" {
            guard.mark_gone(peer);
            let name = existing.and_then(|i| self.members[i].presence["name"].as_str()).unwrap_or("Player").to_owned();
            self.members.retain(|member| member.peer != peer);
            if self.members.is_empty() { self.alone_since = Some(now); }
            return vec![Received::Gone(peer.into(), name)];
        }
        if m["t"] == "presence" {
            let i = if let Some(i) = existing { i } else {
                if let Route::Lan(address) = route {
                    if self.members.iter().filter(|member| member.lan.is_some_and(|(a, _)| a == address)).count() >= 2 { return vec![]; }
                }
                self.members.push(Member { peer: peer.into(), presence: m.clone(), muted: false, public: None,
                    lan: None, internet: None, via_internet: false, seen: now, spell_seq: None });
                self.alone_since = None;
                self.members.len() - 1
            };
            if signature.is_some() {
                self.members[i].public = public;
                if self.bound.len() < 1024 { self.bound.insert(peer.into()); }
            }
            let previous = self.members[i].presence["spells"].clone();
            self.members[i].presence = m.clone();
            if self.members[i].spell_seq.is_none_or(|last| seq > last) { self.members[i].spell_seq = Some(seq); }
            else { self.members[i].presence["spells"] = previous; }
            self.members[i].heard(route, now);
            let hashes = m["em"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            return vec![Received::Presence(peer.into(), hashes, existing.is_none() && self.phase == "active" && !self.timed_out.contains(peer))];
        }
        let Some(i) = existing else { return vec![]; };
        self.members[i].heard(route, now);
        if m["t"] == "ballot" {
            return if self.members[i].presence["proto"] == 1 && settings["features"]["roomVotes"] == true && self.ballot_budget.allow(peer, 0.5, 1.0, now) {
                vec![Received::Shared(m, Value::Null)]
            } else { vec![] };
        }
        if paused || self.members[i].muted || self.members[i].presence["proto"] != 1 { return vec![]; }
        if m["t"] == "want" {
            if m["to"] == self.identity.peer && self.transfer.allow(peer, 60.0, 60.0, now) { return vec![Received::Want(m)]; }
            return vec![];
        }
        let limit = settings["incomingPingLimit"].as_f64().unwrap_or(5.0).clamp(0.0, 20.0);
        if settings["roomMuted"] == true || (limit > 0.0 && !self.budget.allow(peer, limit, limit, now)) { return vec![]; }
        if ["text","alive","spell"].contains(&m["t"].as_str().unwrap_or("")) && settings["features"]["roomText"] != true { return vec![]; }
        if m["t"] == "vote" && settings["features"]["roomVotes"] != true { return vec![]; }
        if (m["t"] == "alive" || m["t"] == "spell") && m["who"] != self.identity.peer && !self.members.iter().any(|member| m["who"] == member.peer) { return vec![]; }
        let member = &self.members[i].presence;
        let tag = json!({"name":member["name"],"color":member["color"],"rgb":member["rgb"]});
        vec![Received::Shared(m, tag)]
    }

    fn receive_whisper(&mut self, m: &Value, settings: &Value, enabled: bool, now: u64) -> Vec<Received> {
        if !self.whisper_budget.allow("all", 20.0, 20.0, now) { return vec![]; }
        let (Some(e), Some(body)) = (m["e"].as_str(), m["b"].as_str()) else { return vec![]; };
        if self.seen_whispers.contains_key(e) { return vec![]; }
        let Some((peer, ts, text)) = self.whisper.open(&self.identity.peer, e, body,
            |peer| self.members.iter().find(|m| m.peer == peer).and_then(|m| m.public.clone())) else { return vec![]; };
        if ts.abs_diff(now) > 600_000 || self.seen_whispers.len() >= 32_768 { return vec![]; }
        self.seen_whispers.insert(e.into(), ts);
        let Some(member) = self.members.iter().find(|m| m.peer == peer) else { return vec![]; };
        let limit = settings["incomingPingLimit"].as_f64().unwrap_or(5.0).clamp(0.0, 20.0);
        if !enabled || settings["roomMuted"] == true || settings["features"]["roomText"] != true || member.muted
            || member.presence["proto"] != 1 || (limit > 0.0 && !self.budget.allow(&peer, limit, limit, now)) { return vec![]; }
        let text = protocol::safe_text(&text, 120);
        if text.is_empty() { return vec![]; }
        let p = &member.presence;
        vec![Received::Whisper(peer, text, json!({"name":p["name"],"color":p["color"],"rgb":p["rgb"]}))]
    }

    pub fn whisper_packet(&self, peer: &str, text: &str, now: u64) -> Option<Vec<u8>> {
        let member = self.members.iter().find(|m| m.peer == peer)?;
        if member.public.is_none() || member.presence["proto"] != 1
            || member.presence["nf"].as_array().is_some_and(|nf| nf.iter().any(|v| v == "text")) { return None; }
        let public: [u8; 32] = crypto::unb64(member.presence["xk"].as_str()?)?.try_into().ok()?;
        let (e, body) = crypto::WhisperKey::seal(&self.identity, peer, public, text, now)?;
        let outer = json!({"t":"whisper","peer":crypto::hex(&crypto::random::<8>().ok()?),"seq":1,"ts":now,"e":e,"b":body});
        crypto::seal(&self.keys.message, outer.to_string().as_bytes()).ok()
    }

    pub fn tick(&mut self, now: u64, internet: &str) -> Vec<(String, Option<String>)> {
        if now.saturating_sub(self.last_tick) > 5000 { self.woke = now; }
        self.last_tick = now;
        self.seen_whispers.retain(|_, ts| ts.abs_diff(now) <= 600_000);
        if self.phase == "joining" {
            if self.settle_at.is_none() && internet != "starting" { self.settle_at = Some((now + 3000).min(self.joined + 15_000)); }
            if now >= self.settle_at.unwrap_or(self.joined + 15_000) { self.phase = if self.members.len() >= 16 { "full" } else { "active" }; }
        }
        let mut gone = vec![];
        self.members.retain(|member| {
            let keep = now.saturating_sub(member.seen.max(self.woke)) < if member.via_internet { 30_000 } else { 15_000 };
            if !keep {
                let notify = !self.timed_out.contains(&member.peer);
                if self.timed_out.len() < 1024 { self.timed_out.insert(member.peer.clone()); }
                gone.push((member.peer.clone(), notify.then(|| member.presence["name"].as_str().unwrap_or("Player").to_owned())));
            } keep
        });
        if self.members.is_empty() && self.alone_since.is_none() { self.alone_since = Some(now); }
        gone
    }

    pub fn relay_token(&mut self, now: u64, transfer: bool) -> bool {
        if transfer && self.relay_budget.available("shared", 5.0, 10.0, now) < 6.0 { return false; }
        self.relay_budget.allow("shared", 5.0, 10.0, now)
    }

    pub fn state(&self, settings: &Value, enabled: bool, lan: &str, internet: &str, now: u64) -> Value {
        let mut members = vec![json!({"peer":self.identity.peer,"name":protocol::safe_name(settings["displayName"].as_str().unwrap_or("Player")),
            "color":settings["tagColor"].as_u64().unwrap_or(0).min(7),"rgb":protocol::rgb(&settings["tagColorCustom"]),
            "path":"lan","status":status(settings, enabled),"needsUpdate":false,"noEmotes":false,"noChat":false,
            "textOff":settings["features"]["roomText"] != true,"votesOff":settings["features"]["roomVotes"] != true,"muted":false,"self":true})];
        if !self.spells.is_null() { members[0]["spells"] = self.spells.clone(); }
        for m in &self.members {
            let p = &m.presence;
            let off = |feature: &str| p["nf"].as_array().is_some_and(|nf| nf.iter().any(|v| v == feature));
            let path = match m.route(now) { Some(Route::Lan(_)) => "lan", Some(Route::Internet) => "internet", None => "unreachable" };
            members.push(json!({"peer":m.peer,"name":p["name"],"color":p["color"],"rgb":p["rgb"],"path":path,
                "status":p["status"],"needsUpdate":p["proto"] != 1,"noEmotes":older(&p["app"], [0,5,0]),
                "noChat":older(&p["app"], [0,5,2]),"textOff":off("text"),"votesOff":off("votes"),"muted":m.muted,"self":false}));
            if !p["spells"].is_null() { if let Some(m) = members.last_mut() { m["spells"] = p["spells"].clone(); } }
        }
        json!({"phase":self.phase,"code":protocol::formatted(&self.code),"members":members,"lan":lan,"internet":internet,
            "lonely":self.alone_since.is_some_and(|at| now.saturating_sub(at) >= 20_000),
            "clockSkew":self.stale.values().any(|(count, at)| *count >= 3 && now.saturating_sub(*at) < 30_000)})
    }
}

pub fn announced(settings: &Value) -> Vec<String> {
    if settings["features"]["emotes"] != true { return vec![]; }
    let mut hashes = vec![];
    let refs = std::iter::once(&settings["clickEmoteId"]).chain(settings["emoteWheel"].as_array().into_iter().flatten());
    for value in refs {
        if let Some(hash) = value.as_str().and_then(|s| s.strip_prefix("c:")).filter(|s| protocol::is_hex(s, 32)) {
            if !hashes.iter().any(|h| h == hash) && hashes.len() < 9 { hashes.push(hash.to_owned()); }
        }
    }
    hashes
}

fn status(settings: &Value, enabled: bool) -> &'static str {
    if !enabled { "paused" } else if settings["roomMuted"] == true { "muted" } else { "on" }
}

fn older(value: &Value, version: [u64; 3]) -> bool {
    let Some(text) = value.as_str() else { return false; };
    let parts: Option<Vec<u64>> = text.split('.').map(|part| part.parse().ok()).collect();
    parts.is_some_and(|parts| parts.len() == 3 && parts.as_slice() < version.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_signed_identities_and_blocks_replays_forged_byes_pause_and_member_mute() {
        let mut sender = Room::join("0000000000", 1000).unwrap();
        let mut receiver = Room::join("0000000000", 1000).unwrap();
        let settings = json!({"displayName":"Alice","tagColor":0,"incomingPingLimit":5,"features":{"emotes":true,"roomText":true}});
        let route = Route::Lan("127.0.0.1:12345".parse().unwrap());
        let presence = sender.presence(&settings, true, 1000, "0.6.7").unwrap();
        assert!(matches!(receiver.receive(&presence, route, &settings, true, 1000).as_slice(), [Received::Presence(_, _, _)]));
        assert!(receiver.receive(&presence, route, &settings, true, 1000).is_empty());
        let forged = crypto::seal(&sender.keys.message, json!({"t":"bye","peer":sender.identity.peer,"seq":99999,"ts":1000}).to_string().as_bytes()).unwrap();
        assert!(receiver.receive(&forged, route, &settings, true, 1000).is_empty());
        assert_eq!(receiver.members.len(), 1);
        let ping = json!({"t":"ping","ping":"danger","d":1,"x":0.25,"y":0.5});
        let packet = sender.packet(ping.clone(), 1000).unwrap();
        assert!(matches!(receiver.receive(&packet, route, &settings, true, 1000).as_slice(), [Received::Shared(_, _)]));
        assert!(receiver.receive(&packet, route, &settings, true, 1000).is_empty());
        assert!(receiver.receive(&sender.packet(ping.clone(), 1000).unwrap(), route, &settings, false, 1000).is_empty());
        receiver.members[0].muted = true;
        assert!(receiver.receive(&sender.packet(ping, 1000).unwrap(), route, &settings, true, 1000).is_empty());
        receiver.members[0].muted = false;
        let mut text_off = settings.clone(); text_off["features"]["roomText"] = false.into();
        let text = json!({"t":"text","text":"hello","d":1,"x":0.5,"y":0.5});
        assert!(receiver.receive(&sender.packet(text.clone(), 1000).unwrap(), route, &text_off, true, 1000).is_empty());
        assert!(matches!(receiver.receive(&sender.packet(text, 1000).unwrap(), route, &settings, true, 1000).as_slice(), [Received::Shared(_, _)]));
        let presence = receiver.presence(&settings, true, 1000, "0.6.7").unwrap();
        sender.receive(&presence, route, &settings, true, 1000);
        let whisper = sender.whisper_packet(&receiver.identity.peer, "private", 1000).unwrap();
        assert!(matches!(receiver.receive(&whisper, route, &settings, true, 1000).as_slice(), [Received::Whisper(_, _, _)]));
        assert!(receiver.receive(&whisper, route, &settings, true, 1000).is_empty());
        let bye = sender.packet(json!({"t":"bye"}), 1000).unwrap();
        assert!(matches!(receiver.receive(&bye, route, &settings, true, 1000).as_slice(), [Received::Gone(_, _)]));
        assert!(receiver.members.is_empty());
        let presence = sender.presence(&settings, true, 1000, "0.6.7").unwrap();
        assert!(receiver.receive(&presence, route, &settings, true, 1000).is_empty());
    }

    #[test]
    fn keeps_newest_spell_presence_and_accepts_ballots_even_when_paused_and_muted() {
        let mut sender = Room::join("0000000000", 1000).unwrap();
        let mut receiver = Room::join("0000000000", 1000).unwrap();
        let settings = json!({"displayName":"Alice","incomingPingLimit":0,"features":{"roomText":true,"roomVotes":true}});
        let route = Route::Internet;
        sender.spells = crate::spells::defaults();
        let old = sender.presence(&settings,true,1000,"0.6.7").unwrap();
        crate::spells::cast(&mut sender.spells["f"],1000);
        let new = sender.presence(&settings,true,1000,"0.6.7").unwrap();
        receiver.receive(&new,route,&settings,true,1000);
        receiver.receive(&old,route,&settings,true,1000);
        assert_eq!(receiver.members[0].presence["spells"]["f"]["rechargeEndsAt"],json!([301000]));
        let vote = sender.packet(json!({"t":"vote","kind":"ready","id":"1234abcd"}),1000).unwrap();
        assert!(matches!(receiver.receive(&vote,route,&settings,true,1000).as_slice(),[Received::Shared(_, _)]));
        receiver.members[0].muted = true;
        let mut muted = settings.clone(); muted["roomMuted"] = true.into();
        let ballot = json!({"t":"ballot","id":"1234abcd","yes":true});
        assert!(matches!(receiver.receive(&sender.packet(ballot.clone(),1000).unwrap(),route,&muted,false,1000).as_slice(),[Received::Shared(_, _)]));
        assert!(receiver.receive(&sender.packet(ballot.clone(),1001).unwrap(),route,&muted,false,1001).is_empty());
        muted["features"]["roomVotes"] = false.into();
        assert!(receiver.receive(&sender.packet(ballot,4000).unwrap(),route,&muted,false,4000).is_empty());
    }

    #[test]
    fn prefers_a_live_lan_path_then_relays_and_never_uses_an_expired_path() {
        let address = "127.0.0.1:12345".parse().unwrap();
        let mut member = Member { peer: "alice".into(), presence: Value::Null, muted: false, public: None,
            lan: Some((address, 1000)), internet: Some(1000), seen: 1000, via_internet: true, spell_seq: None };
        assert_eq!(member.route(1000), Some(Route::Lan(address)));
        assert_eq!(member.route(7000), Some(Route::Internet));
        assert_eq!(member.route(26_000), None);
        member.heard(Route::Lan(address), 27_000);
        assert_eq!(member.route(27_000), Some(Route::Lan(address)));
    }
}
