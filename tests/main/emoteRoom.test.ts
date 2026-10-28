import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EmoteCache, HD_CACHE } from '../../src/main/emoteCache';
import { EmoteTransfer } from '../../src/main/emoteTransfer';
import { LanTransport } from '../../src/main/lanTransport';
import { deriveRoomKeys } from '../../src/main/roomCrypto';
import { RoomManager } from '../../src/main/roomManager';
import { linkHd, linkedHd } from '../../src/shared/hdLink';
import { makeRoomCode } from '../../src/shared/roomCode';

// Two rooms on loopback, as the lanRoom test does: no broadcast, so each transport seeds the other's port.
// One side owns an imported emote; the other must end up with the verified still in its cache — the whole
// announce → want → chunks → hash-check path over real UDP, which is the report of issue #57/#49's fix.
const A_PORT = 47_521;
const B_PORT = 47_522;
const CODE = makeRoomCode(randomBytes(9));

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const still = (size = 3000, seed = 7, w = 160, h = 120): Uint8Array => {
  const out = new Uint8Array(size).fill(seed);
  out.set([...ascii('RIFF'), ...le32(size - 8), ...ascii('WEBPVP8 '), ...le32(size - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
  return out;
};
const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Side {
  room: RoomManager;
  transfer: EmoteTransfer;
  cache: EmoteCache;
  hdCache: EmoteCache;
  dir: string;
  files: Map<string, Uint8Array>;
}

function side(port: number, other: number, name: string, announced: () => string[]): Side {
  const dir = mkdtempSync(join(tmpdir(), 'lolping-room-emotes-'));
  const libraryDir = join(dir, 'emotes');
  const cache = new EmoteCache(join(dir, 'emote-cache'), Date.now);
  const hdCache = new EmoteCache(cache.dir, Date.now, HD_CACHE);
  const files = new Map<string, Uint8Array>();
  const read = (file: string): Uint8Array | null => {
    try {
      return new Uint8Array(readFileSync(file));
    } catch {
      return null;
    }
  };
  const lan = new LanTransport({ port, bindAddress: '127.0.0.1', broadcast: false, seeds: [{ host: '127.0.0.1', port: other }] });
  const room = new RoomManager({
    transports: [lan],
    now: Date.now,
    randomBytes: (n) => randomBytes(n),
    deriveKeys: deriveRoomKeys,
    appVersion: '0.5.2',
    profile: () => ({ name, color: 1, rgb: null, limit: 0, nf: [] }),
    resolveTarget: () => ({ displayId: 1, width: 1000, height: 500 }),
    announceEmotes: announced,
  });
  const transfer = new EmoteTransfer({
    now: Date.now,
    enabled: () => true,
    have: (h) => files.has(h) || existsSync(join(libraryDir, `${h}.webp`)) || cache.has(h), // the library, as in the app
    still: (h) => read(join(libraryDir, `${h}.webp`)),
    link: (h) => {
      const s = read(join(libraryDir, `${h}.webp`)) ?? read(join(cache.dir, `${h}.webp`));
      return s && linkedHd(s);
    },
    haveHd: (h) => hdCache.has(h),
    hd: (h) => read(join(libraryDir, `${h}.hd.webp`)),
    announced,
    put: (h, b) => void cache.put(h, b),
    putHd: (h, b) => void hdCache.put(h, b),
    routeOf: (peer) => room.routeKind(peer),
    sendToLan: (peer, body) => room.sendToLan(peer, body),
    broadcastShared: (body) => room.broadcastShared(body),
    spareSharedToken: () => true,
  });
  room.on('emotes', (peer: string, hashes: string[]) => transfer.announced(peer, hashes));
  room.on('want', (w: Parameters<EmoteTransfer['onWant']>[0]) => transfer.onWant(w));
  room.on('chunk', (c: Parameters<EmoteTransfer['onChunk']>[0]) => transfer.onChunk(c));
  room.on('memberGone', (peer: string) => transfer.memberGone(peer));
  return { room, transfer, cache, hdCache, dir, files };
}

let open: Side[] = [];
afterEach(() => {
  for (const s of open) {
    s.transfer.stop();
    s.room.quit();
    rmSync(s.dir, { recursive: true, force: true });
  }
  open = [];
});

describe('a custom emote still travels over real UDP', () => {
  it('announces, is asked, and lands verified in the other side’s cache', async () => {
    const bytes = still(3000);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const a = side(A_PORT, B_PORT, 'Ana', () => [hash]);
    mkdirSync(join(a.dir, 'emotes'), { recursive: true }); // Ana's import: the still in her library
    writeFileSync(join(a.dir, 'emotes', `${hash}.webp`), bytes);
    const b = side(B_PORT, A_PORT, 'Ben', () => []);
    open.push(a, b);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);
    await until(() => a.room.state().members.length === 2 && b.room.state().members.length === 2);

    // Ben's presence announced nothing; Ana's announced the hash: Ben prefetches it without anyone sending an emote.
    await until(() => b.cache.has(hash));
    const got = join(b.dir, 'emote-cache', `${hash}.webp`);
    expect(existsSync(got)).toBe(true);
    expect(new Uint8Array(readFileSync(got))).toEqual(bytes);
  }, 20_000);

  it('brings the HD the still links after it, verified, into the HD cache', async () => {
    const hd = still(30_000, 9, 512, 384); // 40 chunks: more than a still may have
    const bytes = linkHd(still(3000), hashOf(hd))!;
    const hash = hashOf(bytes);
    const a = side(A_PORT, B_PORT, 'Ana', () => [hash]);
    mkdirSync(join(a.dir, 'emotes'), { recursive: true });
    writeFileSync(join(a.dir, 'emotes', `${hash}.webp`), bytes);
    writeFileSync(join(a.dir, 'emotes', `${hash}.hd.webp`), hd);
    const b = side(B_PORT, A_PORT, 'Ben', () => []);
    open.push(a, b);
    await Promise.all([a.room.join(CODE), b.room.join(CODE)]);

    await until(() => b.hdCache.has(hash));
    expect(new Uint8Array(readFileSync(join(b.dir, 'emote-cache', `${hash}.hd.webp`)))).toEqual(hd);
    expect(b.cache.has(hash)).toBe(true); // the still came first
  }, 20_000);
});
