use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct ReplayGuard {
    peers: HashMap<String, (u64, u64)>,
    gone: HashSet<String>,
}

impl ReplayGuard {
    pub fn accept(&mut self, peer: &str, seq: u64, ts: u64, now: u64) -> bool {
        if self.gone.contains(peer) || ts.abs_diff(now) > 600_000 { return false; }
        if !self.peers.contains_key(peer) && self.peers.len() >= 1024 { return false; }
        let Some((max, bits)) = self.peers.get_mut(peer) else {
            self.peers.insert(peer.into(), (seq, 1)); return true;
        };
        if seq > *max {
            *bits = bits.checked_shl((seq - *max).min(64) as u32).unwrap_or(0) | 1;
            *max = seq; return true;
        }
        let back = *max - seq;
        if back >= 64 || *bits & (1 << back) != 0 { return false; }
        *bits |= 1 << back; true
    }

    pub fn mark_gone(&mut self, peer: &str) {
        if self.gone.len() < 1024 { self.gone.insert(peer.into()); }
        self.peers.remove(peer);
    }
}

#[derive(Default)]
pub struct Budget { entries: HashMap<String, (f64, u64)> }

impl Budget {
    pub fn available(&mut self, key: &str, rate: f64, burst: f64, now: u64) -> f64 {
        if self.entries.len() >= 1024 && !self.entries.contains_key(key) { return 0.0; }
        let (tokens, at) = self.entries.entry(key.into()).or_insert((burst, now));
        *tokens = (*tokens + now.saturating_sub(*at) as f64 * rate / 1000.0).min(burst);
        *at = now;
        *tokens
    }

    pub fn allow(&mut self, key: &str, rate: f64, burst: f64, now: u64) -> bool {
        if self.available(key, rate, burst, now) < 1.0 { return false; }
        if let Some((tokens, _)) = self.entries.get_mut(key) { *tokens -= 1.0; }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_reordered_packets_once_and_rejects_replays_stale_and_departed_peers() {
        let mut guard = ReplayGuard::default();
        assert!(guard.accept("alice", 100, 1000, 1000));
        assert!(guard.accept("alice", 98, 1000, 1000));
        assert!(!guard.accept("alice", 98, 1000, 1000));
        assert!(!guard.accept("alice", 36, 1000, 1000));
        assert!(!guard.accept("bob", 100, 0, 600001));
        assert!(guard.accept("alice", 1000, 1000, 1000));
        guard.mark_gone("alice");
        assert!(!guard.accept("alice", 1001, 1000, 1000));
    }

    #[test]
    fn caps_aggregate_floods_and_refills_only_with_elapsed_time() {
        let mut budget = Budget::default();
        for _ in 0..10 { assert!(budget.allow("all", 5.0, 10.0, 1000)); }
        assert!(!budget.allow("all", 5.0, 10.0, 1000));
        assert!(!budget.allow("all", 5.0, 10.0, 1199));
        assert!(budget.allow("all", 5.0, 10.0, 1200));
        for i in 0..1023 { assert!(budget.allow(&i.to_string(), 1.0, 1.0, 1200)); }
        assert!(!budget.allow("overflow", 1.0, 1.0, 1200));
    }
}
