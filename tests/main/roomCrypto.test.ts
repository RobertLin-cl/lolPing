import { describe, expect, it } from 'vitest';
import {
  deriveRoomKeys, makeIdentity, makeWhisperKeys, MAX_PACKET, open, openWhisper, peerIdOf, publicKeyOf, seal, sealWhisper, signBody,
  verifyBody,
} from '../../src/main/roomCrypto';
import { PEER_RE } from '../../src/shared/roomProtocol';

describe('deriveRoomKeys', () => {
  // Computed once with plain node:crypto (scrypt N=2^15 r=8 p=1, then HKDF-SHA256). Every OS must derive the same keys.
  it('matches the known-answer vectors', async () => {
    const k = await deriveRoomKeys('0000000000');
    expect(k.msgKey.toString('hex')).toBe('2b8ef59047332409e1662fe75774f9383fcd16b655fcb3db975f0e80ad2043da');
    expect(k.relayTopic).toBe('0381782f350540d4639958bed594ae3b2b1a3d11683146e542edb34db89b6910');
    expect(Object.keys(k).sort()).toEqual(['msgKey', 'relayTopic']);
  });

  it('gives different codes different keys', async () => {
    const [a, b] = await Promise.all([deriveRoomKeys('0000000000'), deriveRoomKeys('0000000011')]);
    expect(a.msgKey.equals(b.msgKey)).toBe(false);
  });
});

describe('seal / open', () => {
  const key = Buffer.alloc(32, 7);
  const msg = new TextEncoder().encode('{"t":"bye"}');

  it('round-trips', () => {
    expect(open(key, seal(key, msg))).toEqual(Buffer.from(msg));
  });

  it('uses a fresh nonce every time', () => {
    expect(seal(key, msg).equals(seal(key, msg))).toBe(false);
  });

  it('rejects any flipped byte', () => {
    const packet = seal(key, msg);
    for (let i = 0; i < packet.length; i++) {
      const bad = Buffer.from(packet);
      bad[i] ^= 1;
      expect(open(key, bad)).toBeNull();
    }
  });

  it('rejects a wrong key, a truncated packet and an oversize packet', () => {
    const packet = seal(key, msg);
    expect(open(Buffer.alloc(32, 8), packet)).toBeNull();
    expect(open(key, packet.subarray(0, 20))).toBeNull();
    expect(open(key, new Uint8Array(0))).toBeNull();
    expect(open(key, Buffer.concat([packet, Buffer.alloc(MAX_PACKET)]))).toBeNull();
  });

  it('refuses to seal more than fits in a packet', () => {
    expect(() => seal(key, new Uint8Array(MAX_PACKET))).toThrow();
  });
});

describe('room signatures', () => {
  const seed = (v: number): Uint8Array => new Uint8Array(32).fill(v);
  const body = new TextEncoder().encode('{"t":"bye"}');

  it('derives the same key and peer id from the same seed', () => {
    const a = makeIdentity(seed(1));
    expect(a.pk).toHaveLength(32);
    expect(makeIdentity(seed(1)).pk.equals(a.pk)).toBe(true);
    expect(peerIdOf(a.pk)).toMatch(PEER_RE);
    expect(peerIdOf(makeIdentity(seed(1)).pk)).toBe(peerIdOf(a.pk));
    expect(peerIdOf(makeIdentity(seed(2)).pk)).not.toBe(peerIdOf(a.pk));
  });

  it('verifies a signature only for the same bytes and the same key', () => {
    const a = makeIdentity(seed(1));
    const sig = signBody(a, body);
    expect(sig).toHaveLength(88);
    const key = publicKeyOf(a.pk);
    expect(key).not.toBeNull();
    if (!key) return;
    expect(verifyBody(key, body, sig)).toBe(true);
    const changed = Uint8Array.from(body);
    changed[3] ^= 1;
    expect(verifyBody(key, changed, sig)).toBe(false);
    expect(verifyBody(key, body, signBody(makeIdentity(seed(2)), body))).toBe(false);
  });

  it('rejects malformed signatures and keys without throwing', () => {
    const a = makeIdentity(seed(1));
    const key = publicKeyOf(a.pk);
    if (!key) throw new Error('no key');
    expect(verifyBody(key, body, Buffer.alloc(63).toString('base64'))).toBe(false);
    expect(verifyBody(key, body, '!!!')).toBe(false);
    expect(publicKeyOf(Buffer.alloc(31))).toBeNull();
  });
});

describe('whispers', () => {
  const alex = makeIdentity(new Uint8Array(32).fill(1));
  const alexId = peerIdOf(alex.pk);
  const kim = makeWhisperKeys(new Uint8Array(32).fill(2));
  const kimId = '00112233445566ff';
  const sam = makeWhisperKeys(new Uint8Array(32).fill(3));
  const samId = '0011223344556677';
  const keyOf = (peer: string) => (peer === alexId ? publicKeyOf(alex.pk) : null);
  const whisper = { from: alexId, ts: 1_780_000_000_000, text: 'gank mid 小心' };
  const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
  const sealed = sealWhisper(alex, whisper, { peer: kimId, xk: kim.pk }, seed(9));
  if (!sealed) throw new Error('could not seal');

  it('opens for the member it was sealed to, signed by the member it names', () => {
    expect(openWhisper(kim, kimId, sealed.e, sealed.box, keyOf)).toEqual(whisper);
  });

  it('names neither end outside the box', () => {
    for (const id of [alexId, kimId]) {
      expect(sealed.box.includes(Buffer.from(id, 'hex'))).toBe(false);
      expect(sealed.e.includes(Buffer.from(id, 'hex'))).toBe(false);
    }
    expect(sealed.e.equals(kim.pk)).toBe(false);
  });

  it('makes a new key for every whisper, so two of them look unrelated', () => {
    const again = sealWhisper(alex, whisper, { peer: kimId, xk: kim.pk }, seed(10));
    expect(again?.e.equals(sealed.e)).toBe(false);
    expect(again?.box.equals(sealed.box)).toBe(false);
  });

  it('stays shut for anyone else, even one who has the box and claims to be the recipient', () => {
    expect(openWhisper(sam, samId, sealed.e, sealed.box, keyOf)).toBeNull();
    expect(openWhisper(sam, kimId, sealed.e, sealed.box, keyOf)).toBeNull();
  });

  it('refuses a box opened as someone it was not signed for', () => {
    // Kim's key with another peer id: the signature names the member it was meant for.
    expect(openWhisper(kim, samId, sealed.e, sealed.box, keyOf)).toBeNull();
  });

  it('refuses a whisper from someone who is not the member it names', () => {
    const mallory = makeIdentity(new Uint8Array(32).fill(4));
    const forged = sealWhisper(mallory, whisper, { peer: kimId, xk: kim.pk }, seed(11));
    if (!forged) throw new Error('could not seal');
    expect(openWhisper(kim, kimId, forged.e, forged.box, keyOf)).toBeNull();
    expect(openWhisper(kim, kimId, sealed.e, sealed.box, () => null)).toBeNull(); // a sender we don't know
  });

  it('refuses any flipped byte, in the box or its key', () => {
    for (const i of [0, 40, sealed.box.length - 1]) {
      const box = Buffer.from(sealed.box);
      box[i] ^= 1;
      expect(openWhisper(kim, kimId, sealed.e, box, keyOf)).toBeNull();
    }
    const e = Buffer.from(sealed.e);
    e[0] ^= 1;
    expect(openWhisper(kim, kimId, e, sealed.box, keyOf)).toBeNull();
  });

  it('refuses keys that make no secret, and short boxes, without throwing', () => {
    expect(sealWhisper(alex, whisper, { peer: kimId, xk: Buffer.alloc(32) }, seed(12))).toBeNull();
    expect(sealWhisper(alex, whisper, { peer: kimId, xk: Buffer.alloc(31) }, seed(12))).toBeNull();
    expect(openWhisper(kim, kimId, Buffer.alloc(32), sealed.box, keyOf)).toBeNull();
    expect(openWhisper(kim, kimId, sealed.e, sealed.box.subarray(0, 95), keyOf)).toBeNull();
  });
});
