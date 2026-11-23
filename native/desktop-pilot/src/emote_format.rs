use crate::settings::SettingsUpdate;
use serde::{Deserialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

pub const STILL_LIMIT: usize = 12_288;
pub const HD_LIMIT: usize = 49_152;
pub const ANIMATION_LIMIT: usize = 5_242_880;
pub const SOUND_LIMIT: usize = 1_048_576;
const HEADER_LIMIT: usize = 264_192;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageHeader {
    pub live: SettingsUpdate,
    pub name: String,
    pub still_length: usize,
    pub hd_length: Option<usize>,
    pub anim_length: Option<usize>,
}

pub struct ImageUpload<'a> {
    pub header: ImageHeader,
    pub still: &'a [u8],
    pub hd: Option<&'a [u8]>,
    pub anim: Option<&'a [u8]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SoundHeader {
    pub live: SettingsUpdate,
    pub id: String,
    pub length: Option<usize>,
}

pub fn decode_packet<T: DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<(T, &[u8]), &'static str> {
    if bytes.len() > HEADER_LIMIT + 4 + limit { return Err("size"); }
    let length = little_endian(bytes, 0, 4).ok_or("type")?;
    if length == 0 || length > HEADER_LIMIT { return Err("type"); }
    let header = bytes.get(4..4 + length).ok_or("type")?;
    let value = serde_json::from_slice(header).map_err(|_| "type")?;
    Ok((value, &bytes[4 + length..]))
}

pub fn image_upload(bytes: &[u8]) -> Result<ImageUpload<'_>, &'static str> {
    let (header, tail): (ImageHeader, _) = decode_packet(bytes, STILL_LIMIT + HD_LIMIT + ANIMATION_LIMIT)?;
    if header.still_length > STILL_LIMIT || header.hd_length.is_some_and(|n| n > HD_LIMIT) { return Err("size"); }
    if header.anim_length.is_some_and(|n| n > ANIMATION_LIMIT) { return Err("animSize"); }
    let hd_end = header.still_length + header.hd_length.unwrap_or(0);
    if hd_end + header.anim_length.unwrap_or(0) != tail.len() { return Err("type"); }
    let still = &tail[..header.still_length];
    let hd = header.hd_length.map(|_| &tail[header.still_length..hd_end]);
    let anim = header.anim_length.map(|_| &tail[hd_end..]);
    check_still(still, STILL_LIMIT, 160)?;
    if let Some(bytes) = hd { check_still(bytes, HD_LIMIT, 512)?; }
    if let Some(bytes) = anim { check_animation(bytes)?; }
    if linked_hd(still) != hd.map(hash) { return Err("type"); }
    Ok(ImageUpload { header, still, hd, anim })
}

pub fn sound_upload(bytes: &[u8]) -> Result<(SoundHeader, Option<&[u8]>), &'static str> {
    let (header, tail): (SoundHeader, _) = decode_packet(bytes, SOUND_LIMIT)?;
    if header.length.is_some_and(|n| n > SOUND_LIMIT) { return Err("size"); }
    if header.length.unwrap_or(0) != tail.len() { return Err("type"); }
    if header.length.is_none() { return Ok((header, None)); }
    if audio_type(tail).is_none() { return Err("type"); }
    Ok((header, Some(tail)))
}

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn custom_hash(id: &str) -> Option<&str> {
    let hash = id.strip_prefix("c:")?;
    (hash.len() == 32 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(hash)
}

pub fn clean_name(raw: &str, hash: &str) -> String {
    // Match the existing name filter, including invisible characters that can reorder nearby UI text.
    let prefix = String::from_utf16_lossy(&raw.encode_utf16().take(256).collect::<Vec<_>>());
    let filtered: String = prefix.chars().filter(|c| !c.is_control() && !matches!(*c as u32,
        0x00ad | 0x034f | 0x061c | 0x115f | 0x1160 | 0x180e | 0x200b..=0x200f |
        0x2028..=0x202e | 0x2060..=0x2069 | 0x3164 | 0xfeff | 0xffa0)).collect();
    let name: String = filtered.trim().chars().take(24).collect();
    let name = name.trim();
    if name.is_empty() { hash[..6].to_owned() } else { name.to_owned() }
}

pub fn audio_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"OggS") { return Some("ogg"); }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE".as_slice()) { return Some("wav"); }
    if bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0 && bytes[1] & 6 != 0) {
        return Some("mp3");
    }
    None
}

pub fn animation_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { return Some("gif"); }
    if is_webp(bytes) { return Some("webp"); }
    None
}

fn little_endian(bytes: &[u8], at: usize, length: usize) -> Option<usize> {
    Some(bytes.get(at..at.checked_add(length)?)?.iter().enumerate().fold(0, |value, (i, b)| value | ((*b as usize) << (i * 8))))
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice())
}

fn webp_size(bytes: &[u8]) -> Option<(usize, usize)> {
    if !is_webp(bytes) { return None; }
    let kind = bytes.get(12..16)?;
    let size = if kind == b"VP8 " && bytes.get(23..26) == Some([0x9d, 1, 0x2a].as_slice()) {
        (little_endian(bytes, 26, 2)? & 0x3fff, little_endian(bytes, 28, 2)? & 0x3fff)
    } else if kind == b"VP8L" && bytes.get(20) == Some(&0x2f) {
        let bits = little_endian(bytes, 21, 4)?;
        ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    } else if kind == b"VP8X" {
        (little_endian(bytes, 24, 3)? + 1, little_endian(bytes, 27, 3)? + 1)
    } else { return None; };
    (size.0 > 0 && size.1 > 0).then_some(size)
}

pub fn check_still(bytes: &[u8], limit: usize, side: usize) -> Result<(), &'static str> {
    if !is_webp(bytes) || (bytes.get(12..16) == Some(b"VP8X".as_slice()) && bytes.get(20).is_some_and(|b| b & 2 != 0)) {
        return Err("type");
    }
    if bytes.len() > limit { return Err("size"); }
    if webp_size(bytes).is_some_and(|(w, h)| w <= side && h <= side) { Ok(()) } else { Err("type") }
}

fn check_animation(bytes: &[u8]) -> Result<(), &'static str> {
    let kind = animation_type(bytes).ok_or("type")?;
    if bytes.len() > ANIMATION_LIMIT { return Err("animSize"); }
    let (w, h) = if kind == "gif" { gif_extent(bytes) } else { webp_size(bytes) }.ok_or("type")?;
    if w > 1024 || h > 1024 { Err("animSize") } else { Ok(()) }
}

fn skip_blocks(bytes: &[u8], mut at: usize) -> usize {
    while let Some(length) = bytes.get(at) {
        at += 1 + *length as usize;
        if *length == 0 { break; }
    }
    at
}

fn gif_extent(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut width = little_endian(bytes, 6, 2)?;
    let mut height = little_endian(bytes, 8, 2)?;
    let mut at = 13;
    if let Some(packed) = bytes.get(10) { if packed & 0x80 != 0 { at += 3 << ((packed & 7) + 1); } }
    while let Some(block) = bytes.get(at) {
        if *block == 0x21 { at = skip_blocks(bytes, at + 2); }
        else if *block == 0x2c {
            let Some(frame) = bytes.get(at..at + 10) else { break; };
            width = width.max(little_endian(frame, 1, 2)? + little_endian(frame, 5, 2)?);
            height = height.max(little_endian(frame, 3, 2)? + little_endian(frame, 7, 2)?);
            let packed = frame[9];
            at += 10;
            if packed & 0x80 != 0 { at += 3 << ((packed & 7) + 1); }
            at = skip_blocks(bytes, at + 1);
        } else { break; }
    }
    (width > 0 && height > 0).then_some((width, height))
}

pub fn linked_hd(bytes: &[u8]) -> Option<String> {
    let stop = bytes.len().min(8 + little_endian(bytes, 4, 4)?);
    let mut at = 12;
    let mut link = None;
    while at + 8 <= stop {
        let length = little_endian(bytes, at + 4, 4)?;
        let end = at + 8 + length;
        if end > stop { return None; }
        if bytes.get(at..at + 4) == Some(b"LPHD".as_slice()) && length == 16 && link.is_none() {
            link = Some(bytes[at + 8..end].iter().map(|b| format!("{b:02x}")).collect());
        }
        at = end + length % 2;
    }
    link
}

#[cfg(test)]
pub mod fixtures {
    use super::*;
    use serde_json::{json, Value};

    pub fn live(revision: u64) -> Value {
        let bootstrap: Value = serde_json::from_str(include_str!("../../../out/desktop-pilot/bootstrap.json")).expect("bootstrap");
        let mut settings = bootstrap["settings"].clone();
        settings["customEmotes"] = json!([]);
        json!({ "settings": settings, "config": bootstrap["config"], "revision": revision })
    }

    pub fn still(width: u16, height: u16, length: usize) -> Vec<u8> {
        let mut bytes = vec![7; length.max(30)];
        let length = bytes.len();
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&((length - 8) as u32).to_le_bytes());
        bytes[8..16].copy_from_slice(b"WEBPVP8 ");
        bytes[16..20].copy_from_slice(&((length - 20) as u32).to_le_bytes());
        bytes[23..26].copy_from_slice(&[0x9d, 1, 0x2a]);
        bytes[26..28].copy_from_slice(&width.to_le_bytes());
        bytes[28..30].copy_from_slice(&height.to_le_bytes());
        bytes
    }

    pub fn packet(header: Value, parts: &[&[u8]]) -> Vec<u8> {
        let header = serde_json::to_vec(&header).expect("header");
        let mut bytes = (header.len() as u32).to_le_bytes().to_vec();
        bytes.extend(header);
        for part in parts { bytes.extend_from_slice(part); }
        bytes
    }

    pub fn image(live: Value, still: &[u8], hd: Option<&[u8]>, anim: Option<&[u8]>) -> Vec<u8> {
        let header = json!({ "live": live, "name": "Test", "stillLength": still.len(),
            "hdLength": hd.map(<[u8]>::len), "animLength": anim.map(<[u8]>::len) });
        packet(header, &[still, hd.unwrap_or_default(), anim.unwrap_or_default()])
    }

    pub fn sound(live: Value, id: &str, sound: Option<&[u8]>) -> Vec<u8> {
        packet(json!({ "live": live, "id": id, "length": sound.map(<[u8]>::len) }), &[sound.unwrap_or_default()])
    }

    #[test]
    fn accepts_bounded_stills_and_rejects_animated_or_oversized_stills() {
        assert!(image_upload(&image(live(0), &still(160, 120, STILL_LIMIT), None, None)).is_ok());
        for (bytes, expected) in [(still(161, 120, 600), "type"), (still(160, 120, STILL_LIMIT + 1), "size")] {
            assert_eq!(image_upload(&image(live(0), &bytes, None, None)).err(), Some(expected));
        }
        let mut animated = still(160, 120, 600);
        animated[12..16].copy_from_slice(b"VP8X");
        animated[20] = 2;
        assert_eq!(image_upload(&image(live(0), &animated, None, None)).err(), Some("type"));
    }

    #[test]
    fn verifies_the_hd_against_the_hash_inside_the_still() {
        let hd = still(512, 384, 2000);
        let mut linked = still(160, 120, 600);
        linked.extend_from_slice(b"LPHD");
        linked.extend_from_slice(&16_u32.to_le_bytes());
        linked.extend_from_slice(&Sha256::digest(&hd)[..16]);
        let length = linked.len() - 8;
        linked[4..8].copy_from_slice(&(length as u32).to_le_bytes());
        assert!(image_upload(&image(live(0), &linked, Some(&hd), None)).is_ok());
        assert_eq!(image_upload(&image(live(0), &linked, None, None)).err(), Some("type"));
        assert_eq!(image_upload(&image(live(0), &linked, Some(&still(500, 300, 2000)), None)).err(), Some("type"));
        assert_eq!(image_upload(&image(live(0), &still(160, 120, 600), Some(&hd), None)).err(), Some("type"));
    }

    #[test]
    fn refuses_gif_frames_that_extend_beyond_the_animation_limit() {
        let mut gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00".to_vec();
        gif.extend_from_slice(&1025_u16.to_le_bytes());
        gif.extend_from_slice(&10_u16.to_le_bytes());
        gif.extend_from_slice(&[0, 2, 1, 7, 0, 0x3b]);
        let still = still(160, 120, 600);
        assert_eq!(image_upload(&image(live(0), &still, None, Some(&gif))).err(), Some("animSize"));
        gif[18..20].copy_from_slice(&1024_u16.to_le_bytes());
        assert!(image_upload(&image(live(0), &still, None, Some(&gif))).is_ok());
    }

    #[test]
    fn rejects_truncated_or_forged_binary_packets_without_slicing_past_the_body() {
        let bytes = image(live(0), &still(160, 120, 600), None, None);
        assert_eq!(image_upload(&bytes[..bytes.len() - 1]).err(), Some("type"));
        assert_eq!(image_upload(&[255, 255, 255, 255]).err(), Some("type"));
        assert_eq!(image_upload(&packet(json!({ "live": live(0), "name": "x", "stillLength": 12_289 }), &[])).err(), Some("size"));
    }

    #[test]
    fn checks_sound_types_sizes_and_explicit_removal() {
        let id = format!("c:{}", "a".repeat(32));
        for sound_bytes in [b"OggSdata".as_slice(), b"ID3data".as_slice(), b"RIFFxxxxWAVEdata".as_slice(), &[0xff, 0xfb]] {
            assert!(sound_upload(&sound(live(0), &id, Some(sound_bytes))).is_ok());
        }
        assert!(sound_upload(&sound(live(0), &id, None)).expect("clear").1.is_none());
        assert_eq!(sound_upload(&sound(live(0), &id, Some(b"not audio"))).err(), Some("type"));
        assert_eq!(sound_upload(&sound(live(0), &id, Some(&vec![0; SOUND_LIMIT + 1]))).err(), Some("size"));
    }

    #[test]
    fn keeps_hashes_and_unicode_names_compatible_with_the_existing_library() {
        assert_eq!(hash(b"abc"), "ba7816bf8f01cfea414140de5dae2223");
        assert_eq!(clean_name(" \u{202e}玩家\u{200b}😀 ", &"a".repeat(32)), "玩家😀");
        assert_eq!(clean_name("\u{200b}", &"a".repeat(32)), "aaaaaa");
        assert_eq!(clean_name(&"😀".repeat(40), &"a".repeat(32)).chars().count(), 24);
        assert!(custom_hash("../settings").is_none());
    }
}
