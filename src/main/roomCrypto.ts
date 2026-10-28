import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, scrypt,
  sign, verify, type KeyObject,
} from 'node:crypto';

/** Every room packet: format byte, nonce, AES-256-GCM ciphertext and tag. Larger packets are never sent or read. */
export const MAX_PACKET = 1200;
const FORMAT = 0x01;
const NONCE = 12;
const TAG = 16;
const OVERHEAD = 1 + NONCE + TAG;
const AAD = Buffer.from([FORMAT]);

export interface RoomKeys {
  /** Encrypts every room message. Never leaves the main process. */
  msgKey: Buffer;
  /** The relay topic: 64 hex characters that say nothing without the code. */
  relayTopic: string;
}

/** Room code → keys. scrypt makes guessing a code from a relay topic impractical; HKDF gives each key one job. */
export function deriveRoomKeys(canonical: string): Promise<RoomKeys> {
  return new Promise((resolve, reject) => {
    scrypt(canonical, 'lolping/room/v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, master) => {
      if (err) return reject(err);
      const sub = (info: string): Buffer => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
      // "sig-room" dates from a WebRTC design; kept so the keys, and the test vectors, stay the same.
      resolve({ msgKey: sub('msg'), relayTopic: sub('sig-room').toString('hex') });
    });
  });
}

export function seal(key: Buffer, plain: Uint8Array): Buffer {
  if (plain.length + OVERHEAD > MAX_PACKET) throw new Error('room message too large');
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([AAD, nonce, body, cipher.getAuthTag()]);
}

/** The plaintext, or null for anything that isn't a packet sealed with this key. */
export function open(key: Buffer, packet: Uint8Array): Buffer | null {
  if (packet.length < OVERHEAD || packet.length > MAX_PACKET || packet[0] !== FORMAT) return null;
  const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.length);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + NONCE));
    decipher.setAAD(AAD);
    decipher.setAuthTag(buf.subarray(buf.length - TAG));
    return Buffer.concat([decipher.update(buf.subarray(1 + NONCE, buf.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

/** A member's signing key for one room session: the raw Ed25519 public key, and the private key that stays here. */
export interface RoomIdentity {
  pk: Buffer;
  key: KeyObject;
}

// DER wrappers that turn a raw 32-byte Ed25519 seed or public key into what node:crypto imports.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The identity grown from a 32-byte seed; the caller passes fresh random bytes, tests a fixed seed. */
export function makeIdentity(seed: Uint8Array): RoomIdentity {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { pk: spki.subarray(SPKI_PREFIX.length), key };
}

/** A member's peer id: the first 16 hex characters of SHA-256 of their public key, so nobody else can claim it. */
export const peerIdOf = (pk: Uint8Array): string => createHash('sha256').update(pk).digest('hex').slice(0, 16);

/** The public key a presence announced, or null when it isn't one. */
export function publicKeyOf(pk: Uint8Array): KeyObject | null {
  if (pk.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The signature over an encoded message, in base64 (88 characters). */
export const signBody = (id: RoomIdentity, body: Uint8Array): string => sign(null, body, id.key).toString('base64');

export function verifyBody(pk: KeyObject, body: Uint8Array, sig: string): boolean {
  const raw = Buffer.from(sig, 'base64');
  if (raw.length !== 64) return false;
  try {
    return verify(null, body, pk, raw);
  } catch {
    return false;
  }
}

/** A member's whisper key for one room session: X25519, the raw public key their presence announces, and the private key. */
export interface WhisperKeys {
  pk: Buffer;
  key: KeyObject;
}

// The X25519 counterparts of the wrappers above.
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const WHISPER_INFO = Buffer.from('lolping/whisper/v1');
/** Inside a whisper's box: the sender's peer id, their clock, their signature, then the text. */
const FROM = 8;
const TS = 8;
const SIG = 64;
const TEXT_AT = FROM + TS + SIG;

/** The whisper key grown from a 32-byte seed: ours once per session, and a fresh one for every whisper we send. */
export function makeWhisperKeys(seed: Uint8Array): WhisperKeys {
  const key = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { pk: spki.subarray(X25519_SPKI_PREFIX.length), key };
}

/**
 * The AES key and nonce of one whisper's box: X25519 between the key made for that whisper (`e`) and the recipient's
 * (`xk`), through HKDF. Each side gets there with its own private key and the other's public one. Null for a public
 * key that isn't one, or one that makes no secret.
 */
function boxKey(priv: KeyObject, theirs: Uint8Array, e: Uint8Array, xk: Uint8Array): { key: Buffer; nonce: Buffer } | null {
  if (theirs.length !== 32) return null;
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, theirs]), format: 'der', type: 'spki' });
    const secret = diffieHellman({ privateKey: priv, publicKey });
    const okm = Buffer.from(hkdfSync('sha256', secret, Buffer.concat([e, xk]), WHISPER_INFO, 44));
    return { key: okm.subarray(0, 32), nonce: okm.subarray(32) };
  } catch {
    return null;
  }
}

/** What the sender signs: the box's contents but the signature, bound to the recipient and to the box's key. */
const signedPart = (to: Uint8Array, e: Uint8Array, fromTs: Uint8Array, text: Uint8Array): Buffer =>
  Buffer.concat([WHISPER_INFO, to, e, fromTs, text]);

/** What a whisper says inside its box. */
export interface Whisper {
  from: string;
  ts: number;
  text: string;
}

/**
 * Seals `w` for the member `to`, whose presence announced `xk`, under a key made from `seed` for this whisper alone.
 * Only they can open it: outside, the box names neither of us, and our signature inside tells them who sent it. Null
 * when `xk` isn't a key a whisper can be sealed to.
 */
export function sealWhisper(
  id: RoomIdentity, w: Whisper, to: { peer: string; xk: Uint8Array }, seed: Uint8Array,
): { e: Buffer; box: Buffer } | null {
  const once = makeWhisperKeys(seed);
  const k = boxKey(once.key, to.xk, once.pk, to.xk);
  if (!k) return null;
  const fromTs = Buffer.alloc(FROM + TS);
  fromTs.write(w.from, 'hex');
  fromTs.writeBigUInt64BE(BigInt(w.ts), FROM);
  const text = Buffer.from(w.text, 'utf8');
  const sig = sign(null, signedPart(Buffer.from(to.peer, 'hex'), once.pk, fromTs, text), id.key);
  const cipher = createCipheriv('aes-256-gcm', k.key, k.nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([fromTs, sig, text])), cipher.final()]);
  return { e: once.pk, box: Buffer.concat([body, cipher.getAuthTag()]) };
}

/**
 * The whisper in `box` when it was sealed to us (`self`, holding `ours`) and signed by the member it names; `keyOf`
 * gives a member's signing key. Null for anything else, which is most whispers: every member gets the ones that go
 * over the relays.
 */
export function openWhisper(
  ours: WhisperKeys, self: string, e: Uint8Array, box: Uint8Array, keyOf: (peer: string) => KeyObject | null,
): Whisper | null {
  if (box.length < TEXT_AT + TAG) return null;
  const k = boxKey(ours.key, e, e, ours.pk);
  if (!k) return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', k.key, k.nonce);
    decipher.setAuthTag(box.subarray(box.length - TAG));
    plain = Buffer.concat([decipher.update(box.subarray(0, box.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
  const from = plain.subarray(0, FROM).toString('hex');
  const pk = keyOf(from);
  if (!pk) return null;
  const fromTs = plain.subarray(0, FROM + TS);
  const sig = plain.subarray(FROM + TS, TEXT_AT);
  const text = plain.subarray(TEXT_AT);
  try {
    if (!verify(null, signedPart(Buffer.from(self, 'hex'), e, fromTs, text), pk, sig)) return null;
    return { from, ts: Number(plain.readBigUInt64BE(FROM)), text: new TextDecoder('utf-8', { fatal: true }).decode(text) };
  } catch {
    return null;
  }
}
