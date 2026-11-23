use serde_json::{json, Value};

pub fn duration(spell: &str) -> Option<u64> {
    Some(match spell {
        "flash" | "teleport" => 300_000,
        "ignite" | "barrier" => 180_000,
        "heal" | "exhaust" | "cleanse" | "ghost" | "clarity" => 240_000,
        "smite" => 90_000, "mark" => 80_000, _ => return None,
    })
}

pub fn fresh(spell: &str) -> Value { json!({"spell":spell,"rechargeEndsAt":[],"castEndsAt":0}) }
pub fn defaults() -> Value { json!({"d":fresh("heal"),"f":fresh("flash")}) }

pub fn valid(value: &Value, at: u64) -> bool {
    let Some(spell) = value["spell"].as_str() else { return false; };
    let Some(duration) = duration(spell) else { return false; };
    let Some(ends) = value["rechargeEndsAt"].as_array() else { return false; };
    let Some(gap) = value["castEndsAt"].as_u64() else { return false; };
    let charges = if spell == "smite" { 2 } else { 1 };
    ends.len() <= charges && ends.iter().all(|v| v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991 && n <= at.saturating_add(charges as u64 * duration)))
        && ends.windows(2).all(|pair| pair[1].as_u64().zip(pair[0].as_u64()).is_some_and(|(b,a)| b.checked_sub(a) == Some(duration)))
        && if spell == "smite" { gap <= at.saturating_add(15_000) } else { gap == 0 }
}

pub fn valid_pair(value: &Value, at: u64) -> bool {
    valid(&value["d"], at) && valid(&value["f"], at) && value["d"]["spell"] != value["f"]["spell"]
}

pub fn cast(value: &mut Value, now: u64) -> bool {
    let Some(spell) = value["spell"].as_str().map(str::to_owned) else { return false; };
    let Some(duration) = duration(&spell) else { return false; };
    let mut pending: Vec<u64> = value["rechargeEndsAt"].as_array().into_iter().flatten().filter_map(Value::as_u64).filter(|&end| end > now).collect();
    if pending.len() >= if spell == "smite" { 2 } else { 1 } || value["castEndsAt"].as_u64().unwrap_or(0) > now { return false; }
    pending.push(pending.last().copied().unwrap_or(now).max(now) + duration);
    value["rechargeEndsAt"] = json!(pending);
    value["castEndsAt"] = json!(if spell == "smite" { now + 15_000 } else { 0 });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_smite_in_order_and_keeps_the_gap_between_casts() {
        let mut state = fresh("smite");
        assert!(cast(&mut state, 1000)); assert!(!cast(&mut state, 2000));
        assert!(cast(&mut state, 16_000));
        assert_eq!(state["rechargeEndsAt"], json!([91_000,181_000]));
        assert!(!cast(&mut state, 90_000)); assert!(cast(&mut state, 91_000));
        assert_eq!(state["rechargeEndsAt"], json!([181_000,271_000]));
        assert!(valid(&state, 91_000));
    }
    #[test]
    fn rejects_unknown_spells_duplicate_pairs_and_impossible_queues() {
        assert!(valid_pair(&defaults(), 1000));
        assert!(!valid_pair(&json!({"d":fresh("heal"),"f":fresh("heal")}), 1000));
        let mut state = fresh("flash"); assert!(cast(&mut state, 1000));
        assert!(!cast(&mut state, 2000)); assert!(valid(&state, 1000));
        assert!(!valid(&state, 0)); assert!(!valid(&fresh("unknown"), 1000));
    }
}
