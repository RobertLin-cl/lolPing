use serde_json::{json, Value};
use super::crypto::{hash, unb64};

pub const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const PINGS: &[&str] = &["danger", "push", "omw", "allin", "assist", "needvision", "missing", "enemyvision", "generic", "bait", "visioncleared", "missingflip"];

pub fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn emote(text: &str) -> bool {
    if let Some(hash) = text.strip_prefix("c:") { return is_hex(hash, 32); }
    !text.is_empty() && text.len() <= 40 && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

pub fn safe_name(text: &str) -> String {
    let name = safe_text(text, 16);
    if name.is_empty() { "Player".into() } else { name }
}

pub fn safe_text(text: &str, max: usize) -> String {
    let text: String = text.chars().filter(|&c| !matches!(c as u32,
        0..=31 | 127..=159 | 0xad | 0x34f | 0x61c | 0x115f | 0x1160 | 0x180e | 0x200b..=0x200f |
        0x2028..=0x202e | 0x2060..=0x2069 | 0x3164 | 0xfeff | 0xffa0)).take(2000).collect();
    text.trim().chars().take(max).collect::<String>().trim().to_owned()
}

pub fn rgb(value: &Value) -> Value {
    if value.as_array().is_some_and(|a| a.len() == 3 && a.iter().all(|v| v.as_u64().is_some_and(|v| v <= 255))) {
        value.clone()
    } else { Value::Null }
}

pub fn check_char(nine: &str) -> char {
    let (mut factor, mut sum) = (2, 0);
    for b in nine.bytes().rev() {
        let n = ALPHABET.iter().position(|&c| c == b).unwrap_or(0) * factor;
        factor = 3 - factor;
        sum += n / 32 + n % 32;
    }
    ALPHABET[(32 - sum % 32) % 32] as char
}

pub fn make_code(bytes: [u8; 9]) -> String {
    let mut code: String = bytes.iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect();
    code.push(check_char(&code)); code
}

pub fn canonical(code: &str) -> bool {
    code.len() == 10 && code.bytes().all(|b| ALPHABET.contains(&b)) && check_char(&code[..9]) == code.as_bytes()[9] as char
}

pub fn formatted(code: &str) -> String { format!("PING-{}-{}", &code[..5], &code[5..]) }

pub struct Decoded { pub message: Value, pub body: String, pub signature: Option<String> }

pub fn decode(bytes: &[u8]) -> Option<Decoded> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut body = text.to_owned();
    let mut signature = None;
    if let Some(at) = text.rfind(",\"sg\":\"") {
        let tail = text[at + 7..].strip_suffix("\"}")?;
        if tail.len() == 88 && unb64(tail).is_some_and(|s| s.len() == 64) {
            body = format!("{}}}", &text[..at]); signature = Some(tail.to_owned());
        }
    }
    let mut m: Value = serde_json::from_str(&body).ok()?;
    if !m.is_object() || !is_hex(m["peer"].as_str()?, 16) { return None; }
    for key in ["seq", "ts"] { if m[key].as_u64()? > 9_007_199_254_740_991 { return None; } }
    match m["t"].as_str()? {
        "presence" => {
            if m["proto"].as_u64()? > 9_007_199_254_740_991 || m["app"].as_str()?.len() > 64
                || m["color"].as_u64()? >= 8 || !["on", "paused", "muted"].contains(&m["status"].as_str()?) { return None; }
            m["name"] = safe_name(m["name"].as_str()?).into();
            m["rgb"] = rgb(&m["rgb"]);
            let mut hashes = Vec::<String>::new();
            for h in m["em"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if is_hex(h, 32) && !hashes.iter().any(|v| v == h) && hashes.len() < 9 { hashes.push(h.into()); }
            }
            m["em"] = json!(hashes);
            if !crate::spells::valid_pair(&m["spells"], m["ts"].as_u64()?) { m.as_object_mut()?.remove("spells"); }
        },
        "ping" | "emote" | "text" | "alive" | "spell" => {
            if !(1..=16).contains(&m["d"].as_u64()?) || !(0.0..=1.0).contains(&m["x"].as_f64()?)
                || !(0.0..=1.0).contains(&m["y"].as_f64()?) { return None; }
            if m["t"] == "ping" { if !PINGS.contains(&m["ping"].as_str()?) { return None; } }
            else if m["t"] == "emote" && !emote(m["e"].as_str()?) { return None; }
            else if m["t"] == "text" {
                let text = safe_text(m["text"].as_str()?, 120);
                if text.is_empty() { return None; } m["text"] = text.into();
            } else if m["t"] == "alive" && !is_hex(m["who"].as_str()?, 16) { return None; }
            if m["t"] == "spell" && (!is_hex(m["who"].as_str()?, 16) || !["d","f"].contains(&m["slot"].as_str()?)
                || !crate::spells::valid(&m["cooldown"], m["ts"].as_u64()?)) { return None; }
            if !m["fx"].as_u64().is_some_and(|n| n <= 5) { m.as_object_mut()?.remove("fx"); }
        },
        "want" => {
            if !is_hex(m["to"].as_str()?, 16) || !is_hex(m["h"].as_str()?, 32) { return None; }
            let need = m["need"].as_array()?;
            if need.len() > 64 || need.iter().any(|v| !v.as_u64().is_some_and(|n| n < 66)) { return None; }
        },
        "chunk" => {
            if !is_hex(m["h"].as_str()?, 32) { return None; }
            let n = m["n"].as_u64()?;
            if !(1..=66).contains(&n) || m["i"].as_u64()? >= n { return None; }
            let b = m["b"].as_str()?;
            if b.len() > 1000 || unb64(b).is_none() { return None; }
        },
        "vote" => {
            if !is_hex(m["id"].as_str()?, 8) || !["ff","ready","kick"].contains(&m["kind"].as_str()?) { return None; }
            if m["kind"] == "kick" { if !is_hex(m["target"].as_str()?, 16) { return None; } }
            else if m.get("target").is_some() { return None; }
        },
        "ballot" => { if !is_hex(m["id"].as_str()?, 8) || !m["yes"].is_boolean() { return None; } },
        "bye" => {},
        "whisper" => {
            if unb64(m["e"].as_str()?).is_none_or(|bytes| bytes.len() != 32) { return None; }
            let body = m["b"].as_str()?;
            if body.len() > 768 || unb64(body).is_none() { return None; }
        },
        _ => return None,
    }
    Some(Decoded { message: m, body, signature })
}

pub fn proven_key(message: &Value) -> Option<String> {
    let pk = message["pk"].as_str()?;
    let bytes = unb64(pk)?;
    (bytes.len() == 32 && hash(&bytes)[..16] == *message["peer"].as_str()?).then(|| pk.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rooms::crypto::Identity;

    #[test]
    fn reads_original_signed_bytes_and_sanitizes_only_after_signature_extraction() {
        let id = Identity::from_seed([1; 32]);
        let body = json!({"t":"presence","peer":id.peer,"seq":1,"ts":100,"proto":1,"app":"0.6.7",
            "name":"\u{202e}Alice","color":0,"status":"on","pk":id.public(),"em":["a".repeat(32),"bad"]}).to_string();
        let decoded = decode(id.signed(&body).as_bytes()).unwrap();
        assert_eq!(decoded.body, body);
        assert_eq!(decoded.message["name"], "Alice");
        assert_eq!(decoded.message["em"].as_array().unwrap().len(), 1);
        assert_eq!(proven_key(&decoded.message), Some(id.public()));
        assert!(super::super::crypto::verify(&id.public(), &decoded.body, decoded.signature.as_deref().unwrap()));
    }

    #[test]
    fn rejects_invalid_coordinates_refs_and_transfer_indexes() {
        let base = json!({"peer":"0011223344556677","seq":1,"ts":100,"t":"ping","ping":"danger","d":1,"x":0.5,"y":0.5});
        assert!(decode(base.to_string().as_bytes()).is_some());
        for (key, value) in [("x", json!(1.1)), ("d", json!(0)), ("ping", json!("bad")), ("seq", json!(-1))] {
            let mut bad = base.clone(); bad[key] = value;
            assert!(decode(bad.to_string().as_bytes()).is_none());
        }
        assert!(!emote("../escape"));
        assert!(canonical("0000000000"));
        assert!(!canonical("0000000001"));
        assert!(canonical(&make_code([7; 9])));
    }
}
