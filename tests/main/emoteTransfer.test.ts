import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSEMBLY_TIMEOUT_MS, EMOTE_CHUNK_BYTES, EmoteTransfer, LAN_TOTAL_CHUNKS_PER_TICK, MAX_ASSEMBLIES, MAX_PENDING_BYTES,
  REASKS_MAX, type EmoteTransferDeps,
} from '../../src/main/emoteTransfer';
import { linkHd, linkedHd } from '../../src/shared/hdLink';
import { HD_CHUNKS_MAX, type ChunkMsg, type WantMsg } from '../../src/shared/roomProtocol';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A lossy WebP still whose headers are all the checks read; `size` lets a test build a multi-chunk file. */
const still = (size = 600, seed = 7, w = 160, h = 120): Uint8Array => {
  const out = new Uint8Array(size).fill(seed);
  out.set([...ascii('RIFF'), ...le32(size - 8), ...ascii('WEBPVP8 '), ...le32(size - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
  return out;
};
const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);
/** An HD still: the same headers at 512 x 384. */
const hdStill = (size = EMOTE_CHUNK_BYTES * 3, seed = 7): Uint8Array => still(size, seed, 512, 384);
/** The still that links `hd`, as an import writes it. */
const linkedStill = (hd: Uint8Array, seed = 7): Uint8Array => linkHd(still(600, seed), hashOf(hd))!;
/** `bytes` as the chunks a sender would send for `h`. */
const chunksOf = (h: string, bytes: Uint8Array, peer = ANNOUNCER): ChunkMsg[] => {
  const n = Math.ceil(bytes.length / EMOTE_CHUNK_BYTES);
  return Array.from({ length: n }, (_, i) => chunkOf(h, i, n, bytes.subarray(i * EMOTE_CHUNK_BYTES, (i + 1) * EMOTE_CHUNK_BYTES), peer));
};

/** The member whose custom emote we are receiving. */
const ANNOUNCER = 'aaaaaaaaaaaaaaaa';
/** The member receiving our still, in the serving tests. */
const REQUESTER = 'bbbbbbbbbbbbbbbb';

const chunkOf = (h: string, i: number, n: number, part: Uint8Array, peer = ANNOUNCER): ChunkMsg =>
  ({ peer, seq: 1, ts: 0, t: 'chunk', h, i, n, b: Buffer.from(part).toString('base64') });
const wantOf = (h: string, need: number[]): WantMsg =>
  ({ peer: REQUESTER, seq: 1, ts: 0, t: 'want', to: ANNOUNCER, h, need });

type Out = { kind: 'lan' | 'shared'; to?: string; body: Record<string, unknown> };

/** Fake room + library. The clock runs on vitest's fake timers, so tick() and the re-ask spacing are driven by the test. */
function harness() {
  const out: Out[] = [];
  const files = new Map<string, Uint8Array>();
  const cache = new Map<string, Uint8Array>();
  /** Our own HDs and the received ones, by the hash of the still that links each. */
  const hdFiles = new Map<string, Uint8Array>();
  const hdCache = new Map<string, Uint8Array>();
  const routes = new Map<string, 'lan' | 'shared' | null>();
  const reads = { still: 0 };
  const state = { enabled: true, tokens: 10, announced: [] as string[] };
  const deps: EmoteTransferDeps = {
    now: Date.now,
    have: (h) => files.has(h) || cache.has(h),
    still: (h) => {
      reads.still++;
      return files.get(h) ?? null;
    },
    link: (h) => {
      const b = files.get(h) ?? cache.get(h);
      return b ? linkedHd(b) : null;
    },
    haveHd: (h) => hdFiles.has(h) || hdCache.has(h),
    hd: (h) => hdFiles.get(h) ?? null,
    announced: () => state.announced,
    enabled: () => state.enabled,
    put: (h, b) => void cache.set(h, b),
    putHd: (h, b) => void hdCache.set(h, b),
    routeOf: (peer) => routes.get(peer) ?? null,
    sendToLan: (peer, body) => void out.push({ kind: 'lan', to: peer, body }),
    broadcastShared: (body) => void out.push({ kind: 'shared', body }),
    spareSharedToken: (keep) => (state.tokens >= keep + 1 ? (state.tokens--, true) : false),
  };
  const t = new EmoteTransfer(deps);
  return {
    t, out, cache, files, hdFiles, hdCache, routes, reads,
    setEnabled: (on: boolean) => (state.enabled = on),
    setTokens: (n: number) => (state.tokens = n),
    setAnnounced: (list: string[]) => (state.announced = list),
  };
}

/** The sender's chunks for `h` assembled back into whole bytes, the way a receiver would. */
function sentFile(out: Out[], h: string): Uint8Array {
  const chunks = out.filter((o) => o.body.t === 'chunk' && o.body.h === h);
  const n = chunks[0].body.n as number;
  const parts = new Map<number, Uint8Array>(chunks.map((c) => [c.body.i as number, Buffer.from(c.body.b as string, 'base64')]));
  const full = new Uint8Array(n * EMOTE_CHUNK_BYTES);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const part = parts.get(i)!;
    full.set(part, at);
    at += part.length;
  }
  return full.subarray(0, at);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EmoteTransfer: receiving', () => {
  it('prefetches an announced hash it does not have, then reassembles the still into the cache', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES + 10); // two chunks
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    expect(h.out).toEqual([{ kind: 'lan', to: ANNOUNCER, body: { t: 'want', to: ANNOUNCER, h: hash, need: [] } }]);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect([...h.cache.keys()]).toEqual([hash]);
    expect(h.cache.get(hash)).toEqual(bytes);
    expect(h.t.stats.assembling).toBe(0);
  });

  it('never asks for what is already here', () => {
    const h = harness();
    const bytes = still();
    h.files.set(hashOf(bytes), bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(bytes)]);
    expect(h.out).toHaveLength(0);
  });

  it('ignores chunks from a member that never announced the hash, and keeps only the true content', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES), 'cccccccccccccccc')); // not an announcer
    expect(h.cache.size).toBe(0);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    const wrong = still(EMOTE_CHUNK_BYTES * 2, 9);
    h.t.onChunk(chunkOf(hash, 1, 2, wrong.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.size).toBe(0); // the hash check refuses the substituted bytes, and the failed assembly is gone

    h.t.announced(ANNOUNCER, [hash]); // the next presence starts over
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.get(hash)).toEqual(bytes);
  });

  it('drops an assembly whose sender contradicts itself about the chunk count', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 3, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.t.stats.assembling).toBe(0);
    expect(h.cache.size).toBe(0);
  });

  it('ignores everything while Show friends’ custom emotes is off', () => {
    const h = harness();
    h.setEnabled(false);
    const bytes = still();
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 1, bytes));
    expect(h.out).toHaveLength(0);
    expect(h.cache.size).toBe(0);
  });

  it('stops at the assembly cap and at the pending-byte cap', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const seen = new Set<string>();
    for (let n = 0; n < MAX_ASSEMBLIES + 3 && seen.size < MAX_ASSEMBLIES + 1; n++) {
      const hash = hashOf(still(600, n + 1));
      seen.add(hash);
      h.t.announced(ANNOUNCER, [hash]);
    }
    expect(h.t.stats.assembling).toBe(MAX_ASSEMBLIES);

    const h2 = harness();
    h2.routes.set(ANNOUNCER, 'lan');
    const first = hashOf(still(400_000));
    h2.t.announced(ANNOUNCER, [first]); // waits for its second chunk, holding 200 KB of the 256 KB budget
    h2.t.onChunk(chunkOf(first, 0, 2, still(400_000).subarray(0, 200_000)));
    const other = hashOf(still(400_000, 3));
    h2.t.announced(ANNOUNCER, [other]); // an empty assembly may wait; its bytes may not
    h2.t.onChunk(chunkOf(other, 0, 2, still(400_000, 3).subarray(0, 200_000))); // 400 KB pending would pass the cap
    expect(h2.t.stats.assembling).toBe(2);
    expect(h2.cache.size).toBe(0); // nothing entered the over-budget assembly
  });

  it('re-asks three times with the missing indexes, then waits for the next presence', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 3);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.out.length = 0;
    h.t.onChunk(chunkOf(hash, 0, 3, bytes.subarray(0, EMOTE_CHUNK_BYTES)));

    await vi.advanceTimersByTimeAsync(3000);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(1);
    expect(h.out.at(-1)!.body).toMatchObject({ t: 'want', to: ANNOUNCER, h: hash, need: [1, 2] });

    for (let n = 0; n < REASKS_MAX - 1; n++) {
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.out.at(-1)!.body.t).toBe('want');
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.t.stats.assembling).toBe(0); // gave up
    h.out.length = 0;
    h.t.announced(ANNOUNCER, [hash]); // the next presence starts over
    expect(h.out.some((o) => o.body.t === 'want')).toBe(true);
  });

  it('re-asks a want that never got a chunk, then gives up the same way', async () => {
    const h = harness();
    const hash = hashOf(still());
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.out.length = 0;
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(0); // nothing for almost three seconds
    await vi.advanceTimersByTimeAsync(1);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.t.stats.assembling).toBe(0); // three re-asks, no chunks: the next presence tries again
  });

  it('sends wants over relays only while five ping tokens stay, the rest on later ticks', async () => {
    const h = harness();
    const hashes = Array.from({ length: 9 }, (_, n) => hashOf(still(600, n + 1))); // a full wheel, met on joining
    h.routes.set(ANNOUNCER, 'shared');
    h.setTokens(7); // two wants' worth above the keep mark
    h.t.announced(ANNOUNCER, hashes);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(2); // the rest wait: pings keep their five
    expect(h.t.stats.assembling).toBe(9);

    h.setTokens(100);
    await vi.advanceTimersByTimeAsync(100);
    const asked = h.out.filter((o) => o.body.t === 'want').map((o) => o.body.h);
    expect(new Set(asked)).toEqual(new Set(hashes)); // each held-back want went once, not as a re-ask
    expect(asked).toHaveLength(9);
  });

  it('drops an assembly after its timeout, and when the announcer leaves', async () => {
    const h = harness();
    const hash = hashOf(still(EMOTE_CHUNK_BYTES * 2));
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    await vi.advanceTimersByTimeAsync(ASSEMBLY_TIMEOUT_MS + 1000);
    expect(h.t.stats.assembling).toBe(0);

    h.t.announced(ANNOUNCER, [hash]);
    h.t.memberGone(ANNOUNCER);
    expect(h.t.stats.assembling).toBe(0);
  });
});

describe('EmoteTransfer: serving', () => {
  it('answers a want over LAN, chunk by chunk, until the whole still is sent', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2 + 5);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'lan')).toHaveLength(2); // two chunks per requester per tick
    await vi.advanceTimersByTimeAsync(100);
    expect(sentFile(h.out, hash)).toEqual(bytes);
    expect(h.t.stats.sending).toBe(0);
  });

  it('sends only the asked indexes', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, [2]));
    await vi.advanceTimersByTimeAsync(100);
    const chunks = h.out.filter((o) => o.body.t === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toMatchObject({ t: 'chunk', h: hash, i: 2, n: 4 });
  });

  it('never serves a hash that is not in our own current announcement', async () => {
    const h = harness();
    const bytes = still();
    h.files.set(hashOf(bytes), bytes);
    h.setAnnounced([]);
    h.t.onWant(wantOf(hashOf(bytes), []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out).toHaveLength(0);
  });

  it('broadcasts relay chunks only while five ping tokens stay, and stops when the hash leaves the wheel', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 6);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'shared');
    h.setAnnounced([hash]);
    h.setTokens(6); // one chunk's worth above the keep mark
    h.out.length = 0;

    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'shared')).toHaveLength(1); // a second would dip below the keep mark

    h.setAnnounced([]); // the emote left our wheel
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'shared')).toHaveLength(1);
    expect(h.t.stats.sending).toBe(0);
  });

  it('merges a second want for the same hash instead of resending what is queued', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, [1]));
    h.t.onWant(wantOf(hash, [1, 3]));
    await vi.advanceTimersByTimeAsync(100);
    const chunks = h.out.filter((o) => o.body.t === 'chunk');
    expect(chunks.map((c) => c.body.i).sort()).toEqual([1, 3]); // index 1 queued once
  });
});

describe('EmoteTransfer: audit regressions', () => {
  it('serves nothing while Show friends’ custom emotes is off, and drops pending work on the next tick', async () => {
    const h = harness();
    const bytes = still();
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.setEnabled(false);
    h.t.onWant(wantOf(hash, [])); // an attacker pulling at our stills while the switch is off: nothing leaves
    expect(h.out).toHaveLength(0);
    expect(h.reads.still).toBe(0);

    h.setEnabled(true);
    h.t.onWant(wantOf(hash, []));
    h.setEnabled(false);
    const announced2 = hashOf(still(EMOTE_CHUNK_BYTES * 3));
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [announced2]); // a pending assembly...
    await vi.advanceTimersByTimeAsync(100);
    expect(h.t.stats).toEqual({ assembling: 0, sending: 0 }); // ...is dropped, not paused, and no re-ask wants go out
  });

  it('a straggler chunk for a still already stored opens no zombie assembly', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.cache.set(hash, bytes); // already here
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    expect(h.t.stats.assembling).toBe(0);
  });

  it('caps the whole LAN egress at LAN_TOTAL_CHUNKS_PER_TICK, however many requesters ask', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 6);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.setAnnounced([hash]);
    for (let n = 0; n < 6; n++) {
      const peer = `${n}`.repeat(16);
      h.routes.set(peer, 'lan');
      h.t.onWant({ ...wantOf(hash, []), peer });
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.body.t === 'chunk')).toHaveLength(LAN_TOTAL_CHUNKS_PER_TICK);
  });

  it('reads the still from its source once per queue, whatever the want flood', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    for (let n = 0; n < 50; n++) h.t.onWant(wantOf(hash, []));
    expect(h.reads.still).toBe(1);
  });
});

describe('EmoteTransfer: HD stills', () => {
  const wants = (out: Out[]): unknown[] => out.filter((o) => o.body.t === 'want').map((o) => o.body.h);

  it('asks for the HD a still links once the still is here, and keeps it under the still’s hash', () => {
    const h = harness();
    const hd = hdStill();
    const s = linkedStill(hd);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(s)]);
    expect(wants(h.out)).toEqual([hashOf(s)]); // the still first: the HD's hash is only known from it

    for (const c of chunksOf(hashOf(s), s)) h.t.onChunk(c);
    expect(wants(h.out)).toEqual([hashOf(s), hashOf(hd)]);
    for (const c of chunksOf(hashOf(hd), hd)) h.t.onChunk(c);
    expect(h.hdCache.get(hashOf(s))).toEqual(hd);
    expect(h.t.stats.assembling).toBe(0);

    h.t.announced(ANNOUNCER, [hashOf(s)]); // the next presence asks for nothing: both are here
    expect(wants(h.out)).toHaveLength(2);
  });

  it('asks for no HD when the still links none', () => {
    const h = harness();
    const s = still();
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(s)]);
    for (const c of chunksOf(hashOf(s), s)) h.t.onChunk(c);
    h.t.announced(ANNOUNCER, [hashOf(s)]);
    expect(wants(h.out)).toEqual([hashOf(s)]);
  });

  it('keeps an HD only when it hashes back to the link and passes the HD checks', () => {
    const h = harness();
    const hd = hdStill();
    const s = linkedStill(hd);
    h.cache.set(hashOf(s), s);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(s)]);
    for (const c of chunksOf(hashOf(hd), hdStill(EMOTE_CHUNK_BYTES * 3, 9))) h.t.onChunk(c); // other bytes under its hash
    expect(h.hdCache.size).toBe(0);

    const big = still(EMOTE_CHUNK_BYTES * 3, 7, 513, 100); // past 512 px
    const h2 = harness();
    const s2 = linkedStill(big);
    h2.cache.set(hashOf(s2), s2);
    h2.routes.set(ANNOUNCER, 'lan');
    h2.t.announced(ANNOUNCER, [hashOf(s2)]);
    for (const c of chunksOf(hashOf(big), big)) h2.t.onChunk(c);
    expect(h2.hdCache.size).toBe(0);
  });

  it('asks each member for one HD at a time, and for the next when one is in', () => {
    const h = harness();
    const hds = [hdStill(EMOTE_CHUNK_BYTES * 3, 1), hdStill(EMOTE_CHUNK_BYTES * 3, 2)];
    const stills = hds.map((hd, i) => linkedStill(hd, i + 1));
    for (const s of stills) h.cache.set(hashOf(s), s);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, stills.map(hashOf));
    expect(wants(h.out)).toEqual([hashOf(hds[0])]);
    h.t.announced(ANNOUNCER, stills.map(hashOf)); // another presence doesn't open a second one
    expect(wants(h.out)).toEqual([hashOf(hds[0])]);

    for (const c of chunksOf(hashOf(hds[0]), hds[0])) h.t.onChunk(c);
    expect(wants(h.out)).toEqual([hashOf(hds[0]), hashOf(hds[1])]);
  });

  it('takes HD chunks only from a member whose announced still links them, and no more than an HD’s chunk count', () => {
    const h = harness();
    const hd = hdStill();
    const s = linkedStill(hd);
    h.cache.set(hashOf(s), s);
    h.routes.set(ANNOUNCER, null); // the want can't go: whatever arrives, nobody here asked for it
    h.t.announced(ANNOUNCER, [hashOf(s)]);
    for (const c of chunksOf(hashOf(hd), hd, 'cccccccccccccccc')) h.t.onChunk(c); // a member who never announced it
    expect(h.hdCache.size).toBe(0);
    h.t.onChunk(chunkOf(hashOf(hd), 0, HD_CHUNKS_MAX + 1, hd.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hashOf(s), 0, 18, s.subarray(0, 10))); // a still is at most 17 chunks
    expect(h.t.stats.assembling).toBe(1); // only the HD assembly opened at announce, still empty
    for (const c of chunksOf(hashOf(hd), hd)) h.t.onChunk(c);
    expect(h.hdCache.get(hashOf(s))).toEqual(hd);
  });

  it('serves the HD of a still we announce, after every still that is waiting', async () => {
    const h = harness();
    const hd = hdStill();
    const s = linkedStill(hd);
    const plain = still(EMOTE_CHUNK_BYTES * 2, 3);
    h.files.set(hashOf(s), s);
    h.hdFiles.set(hashOf(s), hd);
    h.files.set(hashOf(plain), plain);
    h.routes.set(REQUESTER, 'shared');
    h.setAnnounced([hashOf(s), hashOf(plain)]);
    h.out.length = 0;

    h.t.onWant(wantOf(hashOf(hd), []));
    h.t.onWant(wantOf(hashOf(plain), []));
    for (let n = 0; n < 5; n++) {
      h.setTokens(6); // one chunk a tick, as on a busy relay
      await vi.advanceTimersByTimeAsync(100);
    }
    const order = h.out.filter((o) => o.body.t === 'chunk').map((o) => o.body.h);
    expect(order).toEqual([hashOf(plain), hashOf(plain), hashOf(hd), hashOf(hd), hashOf(hd)]);
    expect(sentFile(h.out, hashOf(hd))).toEqual(hd);
  });

  it('never serves an HD whose still is not in our current announcement', async () => {
    const h = harness();
    const hd = hdStill();
    const s = linkedStill(hd);
    h.files.set(hashOf(s), s);
    h.hdFiles.set(hashOf(s), hd);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([]);
    h.t.onWant(wantOf(hashOf(hd), []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out).toHaveLength(0);
  });
});
