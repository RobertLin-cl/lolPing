import { HASH_RE } from './emotes';
import { sniffImage, webpSize } from './imageSniff';

/**
 * An imported emote's still names its HD still in a RIFF chunk of its own. The still's hash is the emote's ID, so the
 * still vouches for the HD: whoever verified the still can verify the HD against the hash it names. WebP decoders skip
 * chunks they don't know, and an app that predates the HD reads such a still as it always did.
 */
const LINK_ID = 'LPHD';
/** The link's payload: the 16 bytes behind the HD's 32-hex hash. */
const LINK_BYTES = 16;
/** What linking can add to a still: a VP8X header when the still had none (18 bytes), then the link chunk (24). */
export const HD_LINK_MAX_BYTES = 18 + 8 + LINK_BYTES;

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le24 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const chunk = (id: string, data: Uint8Array): number[] => [...ascii(id), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];

interface Chunk {
  id: string;
  /** Where the chunk's header starts, where its data ends, and where the next chunk starts (after the pad byte). */
  at: number;
  end: number;
  next: number;
}

/** The chunks after a WebP's RIFF header, or null when it isn't a WebP or a chunk runs past the end. */
function chunks(b: Uint8Array): Chunk[] | null {
  if (sniffImage(b) !== 'webp') return null;
  const out: Chunk[] = [];
  const stop = Math.min(b.length, 8 + u32(b, 4));
  for (let at = 12; at + 8 <= stop;) {
    const end = at + 8 + u32(b, at + 4);
    if (end > stop) return null;
    const next = end + (end - at) % 2; // a chunk with an odd size is padded to an even one
    out.push({ id: fourcc(b, at), at, end, next });
    at = next;
  }
  return out.length > 0 ? out : null;
}

/**
 * `still` with a link to the HD whose hash is `hd`, in the extended format the link needs: a lossy or lossless still
 * gets a VP8X header first, with the alpha flag a lossless one declares. Null when `still` isn't a still WebP, or links
 * an HD already.
 */
export function linkHd(still: Uint8Array, hd: string): Uint8Array | null {
  const list = chunks(still);
  const size = webpSize(still);
  if (!list || !size || !HASH_RE.test(hd) || list.some((c) => c.id === LINK_ID)) return null;
  // Every chunk as it was; a last chunk whose pad byte is missing gets it, so the link starts on an even offset.
  const body = [...still.subarray(12, list[list.length - 1].end)];
  if (body.length % 2) body.push(0);
  let head: number[] = [];
  if (list[0].id === 'VP8 ' || list[0].id === 'VP8L') {
    // A lossless still says in its own header whether it uses alpha: bit 28 after the signature byte.
    const alpha = list[0].id === 'VP8L' && still.length > 24 && (still[24] & 0x10) !== 0;
    head = chunk('VP8X', Uint8Array.from([alpha ? 0x10 : 0, 0, 0, 0, ...le24(size.width - 1), ...le24(size.height - 1)]));
  } else if (list[0].id !== 'VP8X' || (still[20] & 0x02) !== 0) {
    return null; // not a still: an animation, or no image chunk first
  }
  const link = chunk(LINK_ID, Uint8Array.from(hd.match(/../g) ?? [], (h) => parseInt(h, 16)));
  const length = 4 + head.length + body.length + link.length;
  return Uint8Array.from([...ascii('RIFF'), ...le32(length), ...ascii('WEBP'), ...head, ...body, ...link]);
}

/** The hash of the HD `still` links to, or null when it links none. */
export function linkedHd(still: Uint8Array): string | null {
  const link = chunks(still)?.find((c) => c.id === LINK_ID && c.end - c.at === 8 + LINK_BYTES);
  if (!link) return null;
  return [...still.subarray(link.at + 8, link.end)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
