use aes_gcm::{aead::{Aead, Payload}, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2_10::{Digest, Sha256};

pub const MAX_PACKET: usize = 1200;

pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
pub fn hash(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }
pub fn b64(bytes: &[u8]) -> String { STANDARD.encode(bytes) }
pub fn unb64(text: &str) -> Option<Vec<u8>> { STANDARD.decode(text).ok() }

pub struct Keys { pub message: [u8; 32], pub topic: String }

impl Keys {
    pub fn derive(code: &str) -> Result<Self, String> {
        let mut master = [0; 32];
        let params = scrypt::Params::new(15, 8, 1, 32).map_err(|e| e.to_string())?;
        scrypt::scrypt(code.as_bytes(), b"lolping/room/v1", &params, &mut master).map_err(|e| e.to_string())?;
        let hkdf = Hkdf::<Sha256>::new(None, &master);
        let (mut message, mut topic) = ([0; 32], [0; 32]);
        hkdf.expand(b"msg", &mut message).map_err(|e| e.to_string())?;
        hkdf.expand(b"sig-room", &mut topic).map_err(|e| e.to_string())?;
        Ok(Self { message, topic: hex(&topic) })
    }
}

pub struct Identity { key: SigningKey, pub peer: String }

impl Identity {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        let key = SigningKey::from_bytes(&seed);
        let peer = hash(&key.verifying_key().to_bytes())[..16].to_owned();
        Self { key, peer }
    }
    pub fn public(&self) -> String { b64(&self.key.verifying_key().to_bytes()) }
    pub fn sign(&self, bytes: &[u8]) -> [u8; 64] { self.key.sign(bytes).to_bytes() }
    pub fn signed(&self, body: &str) -> String {
        let signature = b64(&self.key.sign(body.as_bytes()).to_bytes());
        format!("{},\"sg\":\"{signature}\"}}", &body[..body.len() - 1])
    }
}

pub struct WhisperKey { seed: [u8; 32], pub public: [u8; 32] }

impl WhisperKey {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self { seed, public: curve25519_dalek::montgomery::MontgomeryPoint::mul_base_clamped(seed).to_bytes() }
    }

    fn box_key(&self, theirs: [u8; 32], ephemeral: &[u8; 32], recipient: &[u8; 32]) -> Option<([u8; 32], [u8; 12])> {
        let secret = curve25519_dalek::montgomery::MontgomeryPoint(theirs).mul_clamped(self.seed).to_bytes();
        if secret == [0; 32] { return None; }
        let salt = [ephemeral.as_slice(), recipient.as_slice()].concat();
        let mut output = [0; 44];
        Hkdf::<Sha256>::new(Some(&salt), &secret).expand(b"lolping/whisper/v1", &mut output).ok()?;
        Some((output[..32].try_into().ok()?, output[32..].try_into().ok()?))
    }

    pub fn seal(identity: &Identity, recipient: &str, public: [u8; 32], text: &str, now: u64) -> Option<(String, String)> {
        let once = Self::from_seed(random().ok()?);
        let (key, nonce) = once.box_key(public, &once.public, &public)?;
        let from = from_hex(&identity.peer)?;
        let to = from_hex(recipient)?;
        let header = [from.as_slice(), &now.to_be_bytes()].concat();
        let signed = [b"lolping/whisper/v1".as_slice(), &to, &once.public, &header, text.as_bytes()].concat();
        let plain = [header.as_slice(), &identity.sign(&signed), text.as_bytes()].concat();
        let body = Aes256Gcm::new((&key).into()).encrypt(Nonce::from_slice(&nonce), plain.as_slice()).ok()?;
        Some((b64(&once.public), b64(&body)))
    }

    pub fn open(&self, recipient: &str, ephemeral: &str, body: &str, key_of: impl Fn(&str) -> Option<String>) -> Option<(String, u64, String)> {
        let e: [u8; 32] = unb64(ephemeral)?.try_into().ok()?;
        let (key, nonce) = self.box_key(e, &e, &self.public)?;
        let plain = Aes256Gcm::new((&key).into()).decrypt(Nonce::from_slice(&nonce), unb64(body)?.as_slice()).ok()?;
        if plain.len() < 80 { return None; }
        let from = hex(&plain[..8]);
        let to = from_hex(recipient)?;
        let signed = [b"lolping/whisper/v1".as_slice(), &to, &e, &plain[..16], &plain[80..]].concat();
        let pk: [u8; 32] = unb64(&key_of(&from)?)?.try_into().ok()?;
        let sig = Signature::from_slice(&plain[16..80]).ok()?;
        VerifyingKey::from_bytes(&pk).ok()?.verify_strict(&signed, &sig).ok()?;
        let ts = u64::from_be_bytes(plain[8..16].try_into().ok()?);
        Some((from, ts, std::str::from_utf8(&plain[80..]).ok()?.to_owned()))
    }
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 16 || !text.is_ascii() { return None; }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok()).collect()
}

pub fn verify(public: &str, body: &str, signature: &str) -> bool {
    let Some(pk) = unb64(public).and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false; };
    let Some(sig) = unb64(signature).and_then(|b| Signature::from_slice(&b).ok()) else { return false; };
    VerifyingKey::from_bytes(&pk).is_ok_and(|key| key.verify_strict(body.as_bytes(), &sig).is_ok())
}

pub fn seal(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    if plain.len() + 29 > MAX_PACKET { return Err("Room packet too large".into()); }
    let nonce = random::<12>()?;
    let cipher = Aes256Gcm::new(key.into());
    let body = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: &[1] }).map_err(|e| e.to_string())?;
    Ok([&[1], nonce.as_slice(), &body].concat())
}

pub fn open(key: &[u8; 32], packet: &[u8]) -> Option<Vec<u8>> {
    if !(29..=MAX_PACKET).contains(&packet.len()) || packet[0] != 1 { return None; }
    Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&packet[1..13]), Payload { msg: &packet[13..], aad: &[1] }).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_original_scrypt_hkdf_vectors() {
        let keys = Keys::derive("0000000000").unwrap();
        assert_eq!(hex(&keys.message), "2b8ef59047332409e1662fe75774f9383fcd16b655fcb3db975f0e80ad2043da");
        assert_eq!(keys.topic, "0381782f350540d4639958bed594ae3b2b1a3d11683146e542edb34db89b6910");
    }

    #[test]
    fn rejects_tampering_wrong_keys_and_oversized_packets() {
        let packet = seal(&[7; 32], b"hello").unwrap();
        assert_eq!(open(&[7; 32], &packet).unwrap(), b"hello");
        for i in 0..packet.len() {
            let mut changed = packet.clone(); changed[i] ^= 1;
            assert!(open(&[7; 32], &changed).is_none());
        }
        assert!(open(&[8; 32], &packet).is_none());
        assert!(open(&[7; 32], &[1; 1201]).is_none());
        assert!(seal(&[7; 32], &[0; 1172]).is_err());
        assert_ne!(packet, seal(&[7; 32], b"hello").unwrap());
    }

    #[test]
    fn verifies_only_the_original_identity_and_bytes() {
        let id = Identity::from_seed([1; 32]);
        let body = "{\"t\":\"bye\"}";
        let signed = id.signed(body);
        let value: serde_json::Value = serde_json::from_str(&signed).unwrap();
        let signature = value["sg"].as_str().unwrap();
        assert!(verify(&id.public(), body, signature));
        assert!(!verify(&Identity::from_seed([2; 32]).public(), body, signature));
        assert!(!verify(&id.public(), "{}", signature));
    }

    #[test]
    fn opens_whispers_only_for_the_named_recipient_with_the_proven_senders_signature() {
        let alice = Identity::from_seed([1; 32]);
        let bob = WhisperKey::from_seed([2; 32]);
        let spy = WhisperKey::from_seed([3; 32]);
        let recipient = "00112233445566ff";
        let (e, body) = WhisperKey::seal(&alice, recipient, bob.public, "gank mid 小心", 1000).unwrap();
        let key_of = |peer: &str| (peer == alice.peer).then(|| alice.public());
        assert_eq!(bob.open(recipient, &e, &body, key_of), Some((alice.peer.clone(), 1000, "gank mid 小心".into())));
        assert!(spy.open(recipient, &e, &body, key_of).is_none());
        assert!(bob.open("0011223344556600", &e, &body, key_of).is_none());
        assert!(bob.open(recipient, &e, &body, |_| Some(Identity::from_seed([4; 32]).public())).is_none());
        let mut changed = unb64(&body).unwrap(); changed[20] ^= 1;
        assert!(bob.open(recipient, &e, &b64(&changed), key_of).is_none());
        assert!(WhisperKey::seal(&alice, recipient, [0; 32], "hello", 1000).is_none());
        let (next, _) = WhisperKey::seal(&alice, recipient, bob.public, "gank mid 小心", 1000).unwrap();
        assert_ne!(e, next);
    }
}
