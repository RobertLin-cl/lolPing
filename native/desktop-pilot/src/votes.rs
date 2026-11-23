use serde_json::{json, Value};

#[derive(Default)]
pub struct Votes {
    pub view: Option<Value>,
    pub over: bool,
    close_at: u64,
    repeat_at: u64,
    names: serde_json::Map<String, Value>,
}

impl Votes {
    pub fn start(&mut self, id: &str, kind: &str, starter: &str, target: Option<&str>, members: &[Value], now: u64) -> bool {
        if self.view.is_some() && !self.over { return false; }
        let voters: Vec<&str> = members.iter().filter(|m| m["self"] == true || (m["noChat"] != true && m["votesOff"] != true && m["needsUpdate"] != true))
            .filter_map(|m| m["peer"].as_str()).filter(|p| Some(*p) != target).collect();
        let mut ballots = json!({});
        if voters.contains(&starter) { ballots[starter] = true.into(); }
        let mut view = json!({"id":id,"kind":kind,"starter":starter,"voters":voters,"ballots":ballots,"endsAt":now + if kind == "ready" {15_000} else {60_000}});
        if let Some(target) = target { view["target"] = target.into(); }
        self.view = Some(view); self.over = false; self.repeat_at = now + 3000;
        self.names = members.iter().filter_map(|m| Some((m["peer"].as_str()?.to_owned(), m["name"].clone()))).collect();
        true
    }

    pub fn ballot(&mut self, peer: &str, id: &str, yes: bool) -> bool {
        let Some(v) = self.view.as_mut() else { return false; };
        if self.over || v["id"] != id || !v["voters"].as_array().is_some_and(|a| a.iter().any(|p| p == peer)) || !v["ballots"][peer].is_null() { return false; }
        v["ballots"][peer] = yes.into(); true
    }

    pub fn repeat(&mut self, peer: &str, now: u64) -> Option<Value> {
        if self.over || now < self.repeat_at { return None; }
        self.repeat_at = now + 3000;
        let v = self.view.as_ref()?;
        Some(json!({"t":"ballot","id":v["id"],"yes":v["ballots"][peer].as_bool()?}))
    }

    pub fn tick(&mut self, members: &[Value], now: u64) -> Option<Value> {
        for member in members {
            if let Some(peer) = member["peer"].as_str().filter(|p| self.names.contains_key(*p)) { self.names.insert(peer.into(),member["name"].clone()); }
        }
        if self.over {
            if now >= self.close_at { self.view = None; self.over = false; }
            return None;
        }
        let v = self.view.as_mut()?;
        let voters = v["voters"].as_array()?.clone();
        for p in &voters {
            let p = p.as_str()?;
            if !members.iter().any(|m| m["peer"] == p) && v["ballots"][p].is_null() { v["ballots"][p] = false.into(); }
        }
        let yes = voters.iter().filter(|p| v["ballots"][p.as_str().unwrap_or("")] == true).count();
        let missing: Vec<Value> = voters.iter().filter(|p| v["ballots"][p.as_str().unwrap_or("")].is_null()).cloned().collect();
        let need = match v["kind"].as_str() { Some("ff") => (voters.len() * 7).div_ceil(10), Some("ready") => voters.len(), _ => voters.len() / 2 + 1 };
        let passed = yes >= need;
        if !passed && yes + missing.len() >= need && now < v["endsAt"].as_u64()? { return None; }
        self.over = true; self.close_at = now + 3000;
        let declined: Vec<Value> = voters.iter().filter(|p| v["ballots"][p.as_str().unwrap_or("")] == false).cloned().collect();
        Some(json!({"id":v["id"],"kind":v["kind"],"target":v["target"],"passed":passed,"yes":yes,"voters":voters.len(),"declined":declined,"missing":missing,"names":self.names}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn members() -> Vec<Value> { ["a","b","c"].iter().map(|p| json!({"peer":p,"name":p.to_uppercase()})).collect() }
    #[test]
    fn fixes_voters_excludes_kick_target_and_keeps_the_first_ballot() {
        let mut v = Votes::default();
        assert!(v.start("id","kick","a",Some("c"), &members(), 0));
        assert!(!v.ballot("c","id",true)); assert!(v.ballot("b","id",true)); assert!(!v.ballot("b","id",false));
        assert_eq!(v.tick(&members(), 1).unwrap()["passed"], true);
        assert!(v.over); assert!(v.tick(&members(), 3001).is_none()); assert!(v.view.is_none());
    }
    #[test]
    fn counts_departures_as_no_and_expires_missing_ready_answers() {
        let mut v = Votes::default(); v.start("id","ready","a",None,&members(),0);
        assert!(v.tick(&members(),14999).is_none());
        assert_eq!(v.tick(&members(),15000).unwrap()["missing"],json!(["b","c"]));
        v.start("next","ff","a",None,&members(),20000);
        let result = v.tick(&members()[..2],20001).unwrap(); assert_eq!(result["passed"],false); assert_eq!(result["declined"],json!(["c"]));
        assert_eq!(result["names"]["c"], "C");
    }
}
