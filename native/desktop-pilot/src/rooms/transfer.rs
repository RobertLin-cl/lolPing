use super::{core::{announced, Room, Route}, crypto::{b64, unb64}, protocol::is_hex};
use crate::{assets, emote_format, emote_library::EmoteLibrary};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, VecDeque}, sync::{Arc, Mutex}};

#[derive(Default)]
pub struct Cache { files: HashMap<String, Vec<u8>>, order: VecDeque<String>, bytes: usize }

impl Cache {
    pub fn get(&self, name: &str) -> Option<Vec<u8>> { self.files.get(name).cloned() }
    pub fn put(&mut self, name: String, bytes: Vec<u8>) {
        if let Some(old) = self.files.remove(&name) { self.bytes -= old.len(); }
        self.order.retain(|n| n != &name);
        self.bytes += bytes.len(); self.order.push_back(name.clone()); self.files.insert(name, bytes);
        while self.files.len() > 400 || self.bytes > 14 * 1024 * 1024 {
            let Some(name) = self.order.pop_front() else { break; };
            if let Some(bytes) = self.files.remove(&name) { self.bytes -= bytes.len(); }
        }
    }
}

struct Assembly {
    peer: String, still: String, hd: bool, first: u64, last: u64, tries: usize,
    n: usize, parts: BTreeMap<usize, Vec<u8>>,
}
struct Send { peer: String, hash: String, bytes: Arc<Vec<u8>>, indexes: VecDeque<usize> }

pub struct Transfer {
    cache: Arc<Mutex<Cache>>,
    assemblies: HashMap<String, Assembly>,
    sends: Vec<Send>,
    next_tick: u64,
}

impl Transfer {
    pub fn new(cache: Arc<Mutex<Cache>>) -> Self { Self { cache, assemblies: HashMap::new(), sends: vec![], next_tick: 0 } }
    pub fn clear(&mut self) { self.assemblies.clear(); self.sends.clear(); }
    pub fn gone(&mut self, peer: &str) { self.assemblies.retain(|_, a| a.peer != peer); self.sends.retain(|s| s.peer != peer); }

    pub fn file(&self, library: &EmoteLibrary, hash: &str, hd: bool) -> Option<Vec<u8>> {
        if !is_hex(hash, 32) { return None; }
        let name = format!("{hash}{}", if hd { ".hd.webp" } else { ".webp" });
        let path = format!("/emotes/{hash}{}", if hd { ".hd" } else { ".webp" });
        let own = assets::find_library_asset(&library.root, &library.inherited, &path)
            .filter(|p| p.file_name().and_then(|n| n.to_str()) == Some(name.as_str())).and_then(|p| std::fs::read(p).ok());
        own.or_else(|| self.cache.lock().ok()?.get(&name))
    }

    pub fn presence(&mut self, peer: &str, hashes: &[String], library: &EmoteLibrary, now: u64) {
        for hash in hashes {
            if let Some(still) = self.file(library, hash, false) {
                if let Some(link) = emote_format::linked_hd(&still) {
                    if !self.file(library, hash, true).is_some_and(|bytes| emote_format::hash(&bytes) == link) {
                        self.ask(peer, &link, hash, true, now);
                    }
                }
            } else { self.ask(peer, hash, hash, false, now); }
        }
    }

    fn ask(&mut self, peer: &str, hash: &str, still: &str, hd: bool, now: u64) {
        if self.assemblies.len() >= 16 || self.assemblies.contains_key(hash) { return; }
        self.assemblies.insert(hash.into(), Assembly { peer: peer.into(), still: still.into(), hd,
            first: now, last: 0, tries: 0, n: 0, parts: BTreeMap::new() });
    }

    pub fn want(&mut self, m: &Value, settings: &Value, library: &EmoteLibrary) {
        let Some(hash) = m["h"].as_str() else { return; };
        let Some(peer) = m["peer"].as_str() else { return; };
        let announced = announced(settings);
        let target = announced.iter().find_map(|still| {
            if still == hash { return Some((still, false)); }
            let bytes = self.file(library, still, false)?;
            (emote_format::linked_hd(&bytes).as_deref() == Some(hash)).then_some((still, true))
        });
        let Some((still, hd)) = target else { return; };
        if self.sends.iter().any(|s| s.peer == peer && s.hash == hash) || self.sends.len() >= 16 { return; }
        let Some(bytes) = self.file(library, still, hd) else { return; };
        if bytes.len() > if hd { 49_152 } else { 12_288 } { return; }
        let n = bytes.len().div_ceil(750);
        let need = m["need"].as_array();
        let indexes = if need.is_none_or(|need| need.is_empty()) { (0..n).collect() }
            else { need.into_iter().flatten().filter_map(Value::as_u64).map(|i| i as usize).filter(|&i| i < n).collect() };
        self.sends.push(Send { peer: peer.into(), hash: hash.into(), bytes: Arc::new(bytes), indexes });
    }

    pub fn chunk(&mut self, m: &Value) {
        let Some(hash) = m["h"].as_str() else { return; };
        let pending: usize = self.assemblies.values().flat_map(|a| a.parts.values()).map(Vec::len).sum();
        let Some(a) = self.assemblies.get_mut(hash) else { return; };
        if m["peer"] != a.peer { return; }
        let (Some(n), Some(i), Some(bytes)) = (m["n"].as_u64(), m["i"].as_u64(), m["b"].as_str().and_then(unb64)) else { return; };
        let (n, i) = (n as usize, i as usize);
        if n == 0 || n > if a.hd { 66 } else { 17 } || i >= n || bytes.len() > 750 || (a.n != 0 && a.n != n)
            || pending + bytes.len() > 256 * 1024 { return; }
        a.n = n; a.parts.entry(i).or_insert(bytes);
        if a.parts.len() != n { return; }
        let bytes: Vec<u8> = a.parts.values().flatten().copied().collect();
        let (limit, side) = if a.hd { (49_152, 512) } else { (12_288, 160) };
        if emote_format::hash(&bytes) == hash && emote_format::check_still(&bytes, limit, side).is_ok() {
            if let Ok(mut cache) = self.cache.lock() {
                cache.put(format!("{}{}", a.still, if a.hd { ".hd.webp" } else { ".webp" }), bytes);
            }
        }
        self.assemblies.remove(hash);
    }

    pub fn tick(&mut self, room: &mut Room, now: u64) -> Vec<(Route, Value)> {
        if now < self.next_tick { return vec![]; }
        self.next_tick = now + 100;
        self.assemblies.retain(|_, a| now.saturating_sub(a.first) < 60_000
            && !(a.tries >= 4 && now.saturating_sub(a.last) >= 3000));
        let mut outgoing = vec![];
        for (hash, a) in &mut self.assemblies {
            if a.tries >= 4 { continue; }
            if a.last != 0 && now.saturating_sub(a.last) < 3000 { continue; }
            let Some(route) = room.members.iter().find(|m| m.peer == a.peer).and_then(|m| m.route(now)) else { continue; };
            if route == Route::Internet && !room.relay_token(now, true) { continue; }
            let missing: Vec<usize> = (0..a.n).filter(|i| !a.parts.contains_key(i)).take(64).collect();
            outgoing.push((route, json!({"t":"want","to":a.peer,"h":hash,"need":missing})));
            a.last = now; a.tries += 1;
        }
        let mut total_lan = 0;
        for send in &mut self.sends {
            let Some(route) = room.members.iter().find(|m| m.peer == send.peer).and_then(|m| m.route(now)) else { continue; };
            let count = if route == Route::Internet {
                if room.relay_token(now, true) { 1 } else { 0 }
            } else { 2.min(8 - total_lan) };
            for _ in 0..count {
                let Some(i) = send.indexes.pop_front() else { break; };
                let bytes = &send.bytes[i * 750..((i + 1) * 750).min(send.bytes.len())];
                outgoing.push((route, json!({"t":"chunk","h":send.hash,"i":i,"n":send.bytes.len().div_ceil(750),"b":b64(bytes)})));
                if route != Route::Internet { total_lan += 1; }
            }
        }
        self.sends.retain(|send| !send.indexes.is_empty());
        outgoing
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_received_images_under_a_fixed_memory_cap() {
        let mut cache = Cache::default();
        for i in 0..500 { cache.put(format!("{i}.webp"), vec![1; 49_152]); }
        assert!(cache.files.len() <= 400);
        assert!(cache.bytes <= 14 * 1024 * 1024);
        assert!(cache.get("0.webp").is_none());
        assert!(cache.get("499.webp").is_some());
    }

    #[test]
    fn assembles_only_requested_bounded_images_from_the_expected_sender_and_hash() {
        let cache = Arc::new(Mutex::new(Cache::default()));
        let mut transfer = Transfer::new(cache.clone());
        let bytes = crate::emote_format::fixtures::still(160, 120, 1100);
        let hash = emote_format::hash(&bytes);
        transfer.ask("alice", &hash, &hash, false, 1000);
        let chunk = |peer: &str, i: usize, bytes: &[u8]| json!({"peer":peer,"h":hash,"i":i,"n":2,"b":b64(bytes)});
        transfer.chunk(&chunk("mallory", 0, &bytes[..750]));
        assert!(transfer.assemblies[&hash].parts.is_empty());
        transfer.chunk(&chunk("alice", 1, &bytes[750..]));
        transfer.chunk(&chunk("alice", 1, &bytes[750..]));
        assert_eq!(transfer.assemblies[&hash].parts.len(), 1);
        transfer.chunk(&chunk("alice", 0, &bytes[..750]));
        assert_eq!(cache.lock().unwrap().get(&format!("{hash}.webp")), Some(bytes.clone()));
        transfer.ask("alice", &hash, &hash, false, 1000);
        let mut tampered = bytes.clone(); tampered[50] ^= 1;
        transfer.chunk(&chunk("alice", 0, &tampered[..750]));
        transfer.chunk(&chunk("alice", 1, &tampered[750..]));
        assert_eq!(cache.lock().unwrap().get(&format!("{hash}.webp")), Some(bytes));
        assert!(transfer.assemblies.is_empty());
    }
}
