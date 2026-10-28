import { linkedHd } from '../shared/hdLink';
import { EMOTE_CHUNKS_MAX, EMOTE_NEED_MAX, HD_CHUNKS_MAX, type ChunkMsg, type WantMsg } from '../shared/roomProtocol';
import { checkHd, checkStill, emoteHash } from './emoteLibrary';

/** One chunk carries this many bytes: 1,000 base64 characters, and a sealed chunk stays under the 1,200-byte packet cap. */
export const EMOTE_CHUNK_BYTES = 750;
/** Assemblies in flight at once, bytes pending in total, and how long an assembly may take. */
export const MAX_ASSEMBLIES = 16;
export const MAX_PENDING_BYTES = 256 * 1024;
export const ASSEMBLY_TIMEOUT_MS = 60_000;
/** Silence before a want for the missing indexes; at most this many re-asks, then the hash waits for the next presence. */
export const REASK_MS = 3_000;
export const REASKS_MAX = 3;
/** Chunk pacing: LAN unicast per requester per tick; over relays a chunk or a want only goes when 5 ping tokens remain. */
export const TRANSFER_TICK_MS = 100;
export const LAN_CHUNKS_PER_TICK = 2;
/** Chunks per tick across every queue and requester: the LAN egress ceiling, ~60 KB/s however many members ask. */
export const LAN_TOTAL_CHUNKS_PER_TICK = 8;
export const RELAY_KEEP_TOKENS = 5;

/** What a hash names in a room: an announced still (`still` is the hash itself), or the HD that still links to. */
interface Target {
  still: string;
  hd: boolean;
}

interface Assembly extends Target {
  /** Chunk count, from the first chunk. 0 until then: a want sent, no bytes yet. */
  n: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** The announcer our wants go to. */
  ask: string;
  /** The first want went out. Over relays it can wait for a spare ping token. */
  asked: boolean;
  reasks: number;
}

interface SendQueue extends Target {
  bytes: Uint8Array;
  n: number;
  /** LAN requesters: chunks go unicast, at most LAN_CHUNKS_PER_TICK per requester per tick. */
  lan: Map<string, Set<number>>;
  /** Chunks that must ride a relay: one broadcast reaches the whole room, gated by the ping bucket. */
  shared: Set<number>;
}

export interface EmoteTransferDeps {
  now(): number;
  /** The still for `hash` is here already: our own library, or the cache. */
  have(hash: string): boolean;
  /** Our own still for `hash`, when it is one of our announced emotes. */
  still(hash: string): Uint8Array | null;
  /** The hash of the HD that the still `hash`, which is here, links to (see hdLink), or null when it links none. */
  link(hash: string): string | null;
  /** The HD of the still `hash` is here already: our own, or the cache's. */
  haveHd(hash: string): boolean;
  /** Our own HD of the still `hash`. */
  hd(hash: string): Uint8Array | null;
  /** The hashes our presence announces right now. */
  announced(): readonly string[];
  /** The Show friends' custom emotes switch. */
  enabled(): boolean;
  /** Keeps a still that passed the hash and image checks. */
  put(hash: string, bytes: Uint8Array): void;
  /** Keeps the HD of the still `hash`, once it passed the checks against the hash that still links. */
  putHd(hash: string, bytes: Uint8Array): void;
  /** How a member is reached right now: a LAN unicast, a relay broadcast, or neither. */
  routeOf(peer: string): 'lan' | 'shared' | null;
  sendToLan(peer: string, body: Record<string, unknown>): void;
  broadcastShared(body: Record<string, unknown>): void;
  /** True when a relay chunk may go: the shared bucket keeps `keep` tokens for pings and emotes. */
  spareSharedToken(keep: number): boolean;
}

/**
 * Moves custom emote stills over a room, both ways, and after each still the HD still it links to. The ID is the
 * SHA-256 prefix of the still, and the still names its HD's, so a finished assembly that doesn't hash back to what it
 * was asked for is dropped: nobody can substitute another member's image. Bytes are only ever written to the cache as
 * `<hash>.webp` or `<hash>.hd.webp` and only ever decoded by Chromium as an image; nothing here executes them.
 *
 * RoomManager emits 'emotes' (a presence's announced hashes), 'want', 'chunk' and 'memberGone'; this class answers.
 */
export class EmoteTransfer {
  private readonly announcers = new Map<string, Set<string>>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly sends = new Map<string, SendQueue>();
  /** The HD each still we have links to (null: none). A hash names its bytes, so what is read once stays true. */
  private readonly links = new Map<string, string | null>();
  /** HDs stored this session: the cache writes in the background, so haveHd can say no for a moment after. */
  private readonly storedHds = new Set<string>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: EmoteTransferDeps) {
    this.timer = setInterval(() => this.tick(), TRANSFER_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** A presence announced `hashes`: prefetch whatever isn't here yet, on the announcer's route, then the next HD. */
  announced(peer: string, hashes: readonly string[]): void {
    this.announcers.set(peer, new Set(hashes));
    if (!this.deps.enabled()) return;
    for (const hash of hashes) {
      if (this.deps.have(hash) || this.assemblies.has(hash)) continue;
      if (this.assemblies.size >= MAX_ASSEMBLIES) return;
      this.ask(peer, hash, { still: hash, hd: false });
    }
    this.nextHd(peer);
  }

  /**
   * Another member asks for one of our stills, or for the HD one of them links. Only what our own current announcement
   * names is served.
   */
  onWant(w: WantMsg): void {
    if (!this.deps.enabled()) return; // the switch stops both directions: nothing of ours leaves either
    const announced = this.deps.announced();
    const still = announced.includes(w.h) ? w.h : announced.find((s) => this.linkOf(s) === w.h);
    if (still === undefined) return;
    const lane = this.deps.routeOf(w.peer);
    if (lane !== 'lan' && lane !== 'shared') return;
    let queue = this.sends.get(w.h);
    if (!queue) {
      const hd = still !== w.h;
      const bytes = hd ? this.deps.hd(still) : this.deps.still(w.h); // read once per queue: a flood of wants can't make it read the disk each time
      if (!bytes) return;
      queue = { still, hd, bytes, n: Math.ceil(bytes.length / EMOTE_CHUNK_BYTES), lan: new Map(), shared: new Set() };
      this.sends.set(w.h, queue);
    }
    const want = w.need.length > 0 ? w.need.filter((i) => i < queue.n) : Array.from({ length: queue.n }, (_, i) => i);
    if (want.length === 0) return;
    if (lane === 'lan') {
      const set = queue.lan.get(w.peer) ?? new Set<number>();
      for (const i of want) set.add(i);
      queue.lan.set(w.peer, set);
    } else {
      for (const i of want) queue.shared.add(i); // a broadcast reaches the requester as well as everyone else
    }
  }

  /**
   * One slice of a still or an HD, from the member that announced it. Assemblies finish into the cache once verified.
   * An HD another member asked for over the relays reaches us too, and is kept when its still is here.
   */
  onChunk(c: ChunkMsg): void {
    if (!this.deps.enabled()) return;
    const target = this.targetOf(c.peer, c.h); // only from a member who announced that hash, or the still that links it
    if (!target || c.n > (target.hd ? HD_CHUNKS_MAX : EMOTE_CHUNKS_MAX)) return;
    const part = Buffer.from(c.b, 'base64');
    let a = this.assemblies.get(c.h);
    if (!a) {
      if (this.isHere(target)) return; // already stored: a straggler chunk must not open a zombie assembly
      if (this.assemblies.size >= MAX_ASSEMBLIES || this.pendingBytes() + part.length > MAX_PENDING_BYTES) return;
      a = { ...target, n: 0, parts: new Map(), bytes: 0, firstAt: this.deps.now(), lastAt: this.deps.now(), ask: c.peer, asked: true, reasks: 0 };
      this.assemblies.set(c.h, a);
    }
    if (a.n === 0) a.n = c.n;
    else if (a.n !== c.n) {
      this.assemblies.delete(c.h); // one sender, two ideas about the length: drop and wait for the next presence
      return;
    }
    if (c.i >= a.n || a.parts.has(c.i)) return;
    a.parts.set(c.i, part);
    a.bytes += part.length;
    a.lastAt = this.deps.now();
    if (a.parts.size === a.n) this.finish(c.h, a);
  }

  memberGone(peer: string): void {
    this.announcers.delete(peer);
    for (const [hash, q] of this.sends) {
      q.lan.delete(peer);
      if (q.lan.size === 0 && q.shared.size === 0) this.sends.delete(hash);
    }
    for (const [hash, a] of this.assemblies) if (a.ask === peer) this.assemblies.delete(hash);
  }

  get stats(): { assembling: number; sending: number } {
    return { assembling: this.assemblies.size, sending: this.sends.size };
  }

  private pendingBytes(): number {
    let total = 0;
    for (const a of this.assemblies.values()) total += a.bytes;
    return total;
  }

  /**
   * The finished assembly, in chunk order: kept only when it hashes back to what was asked for and is a still (or an HD)
   * this app would import. Then the announcer's next HD can come.
   */
  private finish(hash: string, a: Assembly): void {
    this.assemblies.delete(hash);
    const full = new Uint8Array(a.bytes);
    let at = 0;
    for (let i = 0; i < a.n; i++) {
      const part = a.parts.get(i);
      if (!part) return; // finish only runs once every index is in
      full.set(part, at);
      at += part.length;
    }
    if (emoteHash(full) !== hash) return;
    if (a.hd) {
      if (checkHd(full) !== null) return;
      this.storedHds.add(hash);
      this.deps.putHd(a.still, full);
    } else {
      if (checkStill(full) !== null) return;
      this.links.set(hash, linkedHd(full));
      this.deps.put(hash, full);
    }
    this.nextHd(a.ask);
  }

  /** Opens an assembly for `hash` and asks `peer` for it. Over relays the want may wait for a spare ping token. */
  private ask(peer: string, hash: string, target: Target): void {
    const asked = this.sendWant(peer, hash, []);
    this.assemblies.set(hash, { ...target, n: 0, parts: new Map(), bytes: 0, firstAt: this.deps.now(), lastAt: this.deps.now(), ask: peer, asked, reasks: 0 });
  }

  /**
   * Asks `peer` for the next HD of a still it announced and we have, one at a time from each member: the stills come
   * first, and the room's bandwidth is spread over the members instead of spent on one member's whole wheel.
   */
  private nextHd(peer: string): void {
    const stills = this.announcers.get(peer);
    if (!stills || !this.deps.enabled()) return;
    for (const a of this.assemblies.values()) if (a.hd && a.ask === peer) return;
    for (const still of stills) {
      const hd = this.linkOf(still);
      if (hd === null || this.assemblies.has(hd) || this.isHere({ still, hd: true })) continue;
      if (this.assemblies.size < MAX_ASSEMBLIES) this.ask(peer, hd, { still, hd: true });
      return;
    }
  }

  /** What a chunk for `hash` from `peer` builds: a still that member announced, or the HD one of them links. */
  private targetOf(peer: string, hash: string): Target | null {
    const stills = this.announcers.get(peer);
    if (!stills) return null;
    if (stills.has(hash)) return { still: hash, hd: false };
    for (const still of stills) if (this.linkOf(still) === hash) return { still, hd: true };
    return null;
  }

  /** The HD the still `hash` links to, once the still is here; null before then, and when it links none. */
  private linkOf(hash: string): string | null {
    const known = this.links.get(hash);
    if (known !== undefined) return known;
    if (!this.deps.have(hash)) return null;
    const link = this.deps.link(hash);
    this.links.set(hash, link);
    return link;
  }

  private isHere(t: Target): boolean {
    if (!t.hd) return this.deps.have(t.still);
    const hd = this.linkOf(t.still);
    return (hd !== null && this.storedHds.has(hd)) || this.deps.haveHd(t.still);
  }

  /** False when it didn't go: no route, or no spare relay token (joining a room can find 9 hashes per member at once). */
  private sendWant(peer: string, hash: string, need: readonly number[]): boolean {
    const body = { t: 'want', to: peer, h: hash, need: [...need] };
    const lane = this.deps.routeOf(peer);
    if (lane === 'lan') this.deps.sendToLan(peer, body);
    else if (lane === 'shared' && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) this.deps.broadcastShared(body); // `to` addresses it, the seal protects it
    else return false;
    return true;
  }

  private chunkBody(hash: string, i: number, q: SendQueue): Record<string, unknown> {
    const slice = q.bytes.subarray(i * EMOTE_CHUNK_BYTES, Math.min((i + 1) * EMOTE_CHUNK_BYTES, q.bytes.length));
    return { t: 'chunk', h: hash, i, n: q.n, b: Buffer.from(slice).toString('base64') };
  }

  /** Sender pacing and receiver re-asks. Anything thrown is dropped: a timer must never take the app down. */
  private tick(): void {
    try {
      if (!this.deps.enabled()) {
        this.assemblies.clear(); // the switch stops both directions: pending work is dropped, not paused
        this.sends.clear();
        return;
      }
      let egress = 0; // chunks sent this tick, across every queue and requester
      const ours = new Set(this.deps.announced());
      // Stills before HDs: a friend sees every image before any of them gets sharper.
      for (const [hash, q] of [...this.sends].sort(([, a], [, b]) => Number(a.hd) - Number(b.hd))) {
        if (!ours.has(q.still)) {
          this.sends.delete(hash); // the emote left our wheel: nobody may still be served it
          continue;
        }
        for (const [peer, need] of [...q.lan]) {
          for (let k = 0; k < LAN_CHUNKS_PER_TICK && need.size > 0 && egress < LAN_TOTAL_CHUNKS_PER_TICK; k++) {
            const i = need.values().next().value as number;
            need.delete(i);
            this.deps.sendToLan(peer, this.chunkBody(hash, i, q));
            egress++;
          }
          if (need.size === 0) q.lan.delete(peer);
        }
        if (q.shared.size > 0 && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) {
          const i = q.shared.values().next().value as number;
          q.shared.delete(i);
          this.deps.broadcastShared(this.chunkBody(hash, i, q));
        }
        if (q.lan.size === 0 && q.shared.size === 0) this.sends.delete(hash);
      }
      const now = this.deps.now();
      for (const [hash, a] of [...this.assemblies]) {
        if (a.n > 0 && a.parts.size === a.n) continue; // completes inside onChunk
        if (now - a.firstAt >= ASSEMBLY_TIMEOUT_MS || !(this.announcers.get(a.ask)?.has(a.still) ?? false)) {
          this.assemblies.delete(hash);
          continue;
        }
        if (!a.asked) {
          a.asked = this.sendWant(a.ask, hash, []);
          a.lastAt = now;
          continue;
        }
        if (now - a.lastAt < REASK_MS) continue;
        if (a.reasks >= REASKS_MAX) {
          this.assemblies.delete(hash); // the next presence starts over
          continue;
        }
        // An HD can miss more indexes than one want may list: the rest are asked for once these are in.
        const need = a.n === 0 ? [] : Array.from({ length: a.n }, (_, i) => i).filter((i) => !a.parts.has(i)).slice(0, EMOTE_NEED_MAX);
        if (!this.sendWant(a.ask, hash, need)) continue; // waits for a token: not a re-ask yet
        a.reasks++;
        a.lastAt = now;
      }
    } catch {
      // a send that failed (a packet that wouldn't seal, a route that vanished) waits for the next tick
    }
  }
}
